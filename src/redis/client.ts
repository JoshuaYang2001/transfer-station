import Redis from 'ioredis';
import { config } from '../config/index.js';

let redis: Redis;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });

    redis.on('error', (err) => {
      console.error('[redis] Client error:', err.message);
    });

    redis.on('connect', () => {
      console.log('[redis] Connected successfully');
    });
  }
  return redis;
}

export async function connectRedis(): Promise<Redis> {
  const client = getRedis();
  if (client.status === 'wait') {
    await client.connect();
  }
  return client;
}
