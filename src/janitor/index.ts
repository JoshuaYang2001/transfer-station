import cron from 'node-cron';
import { getAccountPool } from '../services/account-pool.js';

export function startJanitor(): void {
  const pool = getAccountPool();

  // Every hour: restore keys from cooldown
  cron.schedule('0 * * * *', async () => {
    console.log('[janitor] Running hourly cooldown restore...');
    try {
      const { restored } = await pool.janitorRestoreCooldown();
      console.log(`[janitor] Restored ${restored} keys from cooldown`);
    } catch (err) {
      console.error('[janitor] Error restoring cooldown:', err);
    }
  });

  // Daily at 00:00: purge banned keys
  cron.schedule('0 0 * * *', async () => {
    console.log('[janitor] Running daily banned key purge...');
    try {
      const { purged } = await pool.janitorPurgeBanned();
      console.log(`[janitor] Purged ${purged} banned keys`);
    } catch (err) {
      console.error('[janitor] Error purging banned keys:', err);
    }
  });

  console.log('[janitor] Scheduled tasks registered:');
  console.log('  - Hourly cooldown restore (:00 every hour)');
  console.log('  - Daily banned purge (00:00 daily)');
}
