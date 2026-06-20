export type PoolType = 'static' | 'ephemeral';

export type AccountStatus = 'active' | 'cooldown' | 'banned';

export interface AccountMeta {
  pool_type: PoolType;
  status: AccountStatus;
  fail_count: number;
  created_at: number;
  updated_at: number;
  cooldown_until?: number;
  banned_at?: number;
}

export interface InjectAccountsBody {
  pool_type: PoolType;
  keys: string[];
}

export interface BatchInjectResult {
  injected: number;
  duplicates: number;
  invalid: number;
}

export interface RedisConfig {
  url: string;
}
