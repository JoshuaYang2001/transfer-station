import { Redis } from 'ioredis';
import { getRedis } from '../redis/client.js';
import { REDIS_KEYS, config } from '../config/index.js';
import type { AccountMeta, BatchInjectResult, PoolType } from '../types/index.js';

const BATCH_INJECT_SCRIPT = `
local injected = 0

for index = 2, #ARGV do
  local accountKey = ARGV[index]
  if redis.call('HEXISTS', KEYS[1], accountKey) == 0 then
    redis.call('HSET', KEYS[1], accountKey, ARGV[1])
    redis.call('RPUSH', KEYS[2], accountKey)
    injected = injected + 1
  end
end

return { injected, (#ARGV - 1) - injected }
`;

export class AccountPool {
  private redis: Redis;

  constructor(redis?: Redis) {
    this.redis = redis || getRedis();
  }

  /**
   * Get the active list key for a pool type
   */
  private getActiveListKey(poolType: PoolType): string {
    return poolType === 'ephemeral'
      ? REDIS_KEYS.POOL_EPHEMERAL_ACTIVE
      : REDIS_KEYS.POOL_STATIC_ACTIVE;
  }

  /**
   * Validate API key format (basic sanity check)
   */
  private normalizeKey(key: string): string | null {
    if (!key || typeof key !== 'string') return null;
    const trimmed = key.trim();
    if (!trimmed.startsWith('sk-') || trimmed.length < 20) return null;
    return trimmed;
  }

  /**
   * Batch inject accounts into the pool
   * Returns summary of injected/skipped/duplicate counts
   */
  async batchInject(
    poolType: PoolType,
    keys: string[]
  ): Promise<BatchInjectResult> {
    const now = Date.now();
    const activeListKey = this.getActiveListKey(poolType);
    const uniqueKeys = new Set<string>();
    let invalid = 0;
    let requestDuplicates = 0;

    for (const rawKey of keys) {
      const key = this.normalizeKey(rawKey);
      if (!key) {
        invalid++;
        continue;
      }

      if (uniqueKeys.has(key)) {
        requestDuplicates++;
        continue;
      }

      uniqueKeys.add(key);
    }

    if (uniqueKeys.size === 0) {
      return { injected: 0, duplicates: requestDuplicates, invalid };
    }

    const meta: AccountMeta = {
      pool_type: poolType,
      status: 'active',
      fail_count: 0,
      created_at: now,
      updated_at: now,
    };

    const scriptResult: unknown = await this.redis.eval(
      BATCH_INJECT_SCRIPT,
      2,
      REDIS_KEYS.ACCOUNTS_HASH,
      activeListKey,
      JSON.stringify(meta),
      ...uniqueKeys
    );

    if (!Array.isArray(scriptResult) || scriptResult.length !== 2) {
      throw new Error('Unexpected Redis batch injection result');
    }

    const injected = Number(scriptResult[0]);
    const existingDuplicates = Number(scriptResult[1]);

    if (!Number.isInteger(injected) || !Number.isInteger(existingDuplicates)) {
      throw new Error('Invalid Redis batch injection counters');
    }

    return {
      injected,
      duplicates: requestDuplicates + existingDuplicates,
      invalid,
    };
  }

  /**
   * Round-robin pop a key from the active pool
   * Uses LPOP + (later RPUSH) pattern for load balancing
   * Priority: ephemeral first, then static
   * Returns [key, poolType] or null if no keys available
   */
  async popActiveKey(): Promise<[string, PoolType] | null> {
    // Try ephemeral first
    let key = await this.redis.lpop(REDIS_KEYS.POOL_EPHEMERAL_ACTIVE);
    if (key) {
      return [key, 'ephemeral'];
    }

    // Fallback to static
    key = await this.redis.lpop(REDIS_KEYS.POOL_STATIC_ACTIVE);
    if (key) {
      return [key, 'static'];
    }

    return null;
  }

  /**
   * Return a key back to its active queue (after successful use)
   * Uses RPUSH to maintain round-robin order
   */
  async returnKey(key: string, poolType: PoolType): Promise<void> {
    const activeListKey = this.getActiveListKey(poolType);
    await this.redis.rpush(activeListKey, key);
  }

  /**
   * Get account metadata
   */
  async getAccountMeta(key: string): Promise<AccountMeta | null> {
    const raw = await this.redis.hget(REDIS_KEYS.ACCOUNTS_HASH, key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AccountMeta;
    } catch {
      return null;
    }
  }

  /**
   * Update account metadata
   */
  private async updateAccountMeta(key: string, meta: AccountMeta): Promise<void> {
    meta.updated_at = Date.now();
    await this.redis.hset(REDIS_KEYS.ACCOUNTS_HASH, key, JSON.stringify(meta));
  }

  /**
   * Mark a key as banned (401 - invalid/revoked) and remove from active pool
   */
  async markBanned(key: string): Promise<void> {
    const meta = await this.getAccountMeta(key);
    if (!meta) return;

    meta.status = 'banned';
    meta.fail_count = meta.fail_count + 1;
    meta.banned_at = Date.now();
    await this.updateAccountMeta(key, meta);

    // Remove from active list (LREM count=0 removes all occurrences)
    const activeListKey = this.getActiveListKey(meta.pool_type);
    await this.redis.lrem(activeListKey, 0, key);
  }

  /**
   * Mark a key as cooldown (429 - rate limited) and remove from active pool
   */
  async markCooldown(key: string): Promise<void> {
    const meta = await this.getAccountMeta(key);
    if (!meta) return;

    meta.status = 'cooldown';
    meta.fail_count = meta.fail_count + 1;
    meta.cooldown_until = Date.now() + config.janitor.cooldownTtlHours * 3600 * 1000;
    await this.updateAccountMeta(key, meta);

    // Remove from active list
    const activeListKey = this.getActiveListKey(meta.pool_type);
    await this.redis.lrem(activeListKey, 0, key);
  }

  /**
   * Restore a key from cooldown back to active pool
   */
  async restoreFromCooldown(key: string): Promise<boolean> {
    const meta = await this.getAccountMeta(key);
    if (!meta || meta.status !== 'cooldown') return false;

    const now = Date.now();
    if (meta.cooldown_until && now < meta.cooldown_until) {
      return false; // Still cooling down
    }

    meta.status = 'active';
    meta.cooldown_until = undefined;
    await this.updateAccountMeta(key, meta);

    const activeListKey = this.getActiveListKey(meta.pool_type);
    await this.redis.rpush(activeListKey, key);
    return true;
  }

  /**
   * Janitor: scan and restore expired cooldown keys
   * Uses HSCAN to iterate keys efficiently
   */
  async janitorRestoreCooldown(): Promise<{ restored: number }> {
    let cursor = '0';
    let restored = 0;

    do {
      const [nextCursor, entries] = await this.redis.hscan(
        REDIS_KEYS.ACCOUNTS_HASH,
        cursor,
        'COUNT', 100
      );
      cursor = nextCursor;

      for (let i = 0; i < entries.length; i += 2) {
        const key = entries[i];
        const rawMeta = entries[i + 1];
        try {
          const meta = JSON.parse(rawMeta) as AccountMeta;
          if (meta.status === 'cooldown') {
            const ok = await this.restoreFromCooldown(key);
            if (ok) restored++;
          }
        } catch {
          // skip corrupt entries
        }
      }
    } while (cursor !== '0');

    return { restored };
  }

  /**
   * Janitor: clean up banned keys to free memory
   */
  async janitorPurgeBanned(): Promise<{ purged: number }> {
    let cursor = '0';
    let purged = 0;
    const toDelete: string[] = [];

    do {
      const [nextCursor, entries] = await this.redis.hscan(
        REDIS_KEYS.ACCOUNTS_HASH,
        cursor,
        'COUNT', 100
      );
      cursor = nextCursor;

      for (let i = 0; i < entries.length; i += 2) {
        const key = entries[i];
        const rawMeta = entries[i + 1];
        try {
          const meta = JSON.parse(rawMeta) as AccountMeta;
          if (meta.status === 'banned') {
            toDelete.push(key);
            purged++;
          }
        } catch {
          // corrupt entry, also clean up
          toDelete.push(key);
          purged++;
        }
      }
    } while (cursor !== '0');

    if (toDelete.length > 0) {
      await this.redis.hdel(REDIS_KEYS.ACCOUNTS_HASH, ...toDelete);
    }

    return { purged };
  }

  /**
   * Get pool statistics
   */
  async getStats(): Promise<{
    ephemeralActive: number;
    staticActive: number;
    totalAccounts: number;
  }> {
    const results = await this.redis.multi()
      .llen(REDIS_KEYS.POOL_EPHEMERAL_ACTIVE)
      .llen(REDIS_KEYS.POOL_STATIC_ACTIVE)
      .hlen(REDIS_KEYS.ACCOUNTS_HASH)
      .exec();

    const getResult = (index: number): number => {
      if (!results) return 0;
      const entry = results[index];
      if (!entry || entry[0]) return 0;
      return (entry[1] as number) || 0;
    };

    return {
      ephemeralActive: getResult(0),
      staticActive: getResult(1),
      totalAccounts: getResult(2),
    };
  }
}

// Singleton instance
let accountPool: AccountPool | null = null;

export function getAccountPool(): AccountPool {
  if (!accountPool) {
    accountPool = new AccountPool();
  }
  return accountPool;
}
