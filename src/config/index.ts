import 'dotenv/config';

const required = ['PROXY_BEARER_TOKEN', 'ADMIN_API_KEY'];

for (const key of required) {
  if (!process.env[key]) {
    console.warn(`[config] Warning: ${key} not set in environment`);
  }
}

export const config = {
  port: parseInt(process.env.PORT || '8787', 10),
  host: process.env.HOST || '0.0.0.0',

  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379/0',
  },

  security: {
    proxyBearerToken: process.env.PROXY_BEARER_TOKEN || 'change-me-proxy-token',
    adminApiKey: process.env.ADMIN_API_KEY || 'change-me-admin-key',
  },

  upstream: {
    baseUrl: process.env.UPSTREAM_BASE_URL || 'https://api.openai.com',
  },

  retry: {
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
  },

  janitor: {
    cooldownTtlHours: parseInt(process.env.COOLDOWN_TTL_HOURS || '1', 10),
  },
} as const;

// Redis Key Prefixes
export const REDIS_KEYS = {
  ACCOUNTS_HASH: 'haps:accounts',
  POOL_EPHEMERAL_ACTIVE: 'haps:pool:ephemeral:active',
  POOL_STATIC_ACTIVE: 'haps:pool:static:active',
} as const;
