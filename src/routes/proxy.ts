import { FastifyPluginAsync } from 'fastify';
import { getAccountPool } from '../services/account-pool.js';
import { verifyProxyBearer } from '../plugins/auth.js';
import { config } from '../config/index.js';
import { request as undiciRequest, Agent } from 'undici';
import type { PoolType } from '../types/index.js';

// Create a keep-alive agent for connection pooling
const agent = new Agent({
  connections: 128,
  pipelining: 10,
  keepAliveTimeout: 30_000,
});

interface KeyContext {
  key: string;
  poolType: PoolType;
}

/**
 * Attempt to forward a request using a specific key.
 * Returns the upstream response. On 401/429 we will retry.
 */
async function forwardRequest(
  key: string,
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer | string | null
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: any }> {
  const upstreamUrl = new URL(path, config.upstream.baseUrl).toString();

  // Replace Authorization header with the real key
  const upstreamHeaders: Record<string, string | string[]> = {};

  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (k.toLowerCase() === 'host') continue; // let undici handle host
    if (k.toLowerCase() === 'connection') continue;
    if (k.toLowerCase() === 'content-length') continue;
    if (k.toLowerCase() === 'authorization') {
      upstreamHeaders['authorization'] = `Bearer ${key}`;
    } else {
      upstreamHeaders[k] = v;
    }
  }

  const { statusCode, headers: respHeaders, body: respBody } = await undiciRequest(upstreamUrl, {
    method: method as any,
    headers: upstreamHeaders,
    body: body || undefined,
    dispatcher: agent,
  });

  return { statusCode, headers: respHeaders as any, body: respBody };
}

const proxyRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getAccountPool();

  // All proxy routes require bearer token auth from new-api
  fastify.addHook('preHandler', verifyProxyBearer);

  // Catch-all route: POST /*
  fastify.all('/*', async (request, reply) => {
    const method = request.method;
    const path = request.url;
    const rawHeaders = request.headers as Record<string, string | string[] | undefined>;

    // Read the raw body
    let body: Buffer | string | null = null;
    if (request.body) {
      body = request.body as Buffer;
    }

    let lastError: Error | null = null;
    const usedKeys = new Set<string>();

    for (let attempt = 0; attempt <= config.retry.maxRetries; attempt++) {
      // Pop a key from the pool
      const keyCtx = await pool.popActiveKey();
      if (!keyCtx) {
        return reply.code(503).send({
          error: 'No available API keys in pool',
          error_code: 'pool_exhausted',
        });
      }

      const [key, poolType] = keyCtx;

      // If we already tried this key (shouldn't happen with LPOP but safety first)
      if (usedKeys.has(key)) {
        // Return it and continue popping
        await pool.returnKey(key, poolType);
        continue;
      }
      usedKeys.add(key);

      try {
        fastify.log.debug(
          `[proxy] Attempt ${attempt + 1}: using ${poolType} key ${key.slice(0, 12)}... -> ${method} ${path}`
        );

        const response = await forwardRequest(key, method, path, rawHeaders, body);

        // Handle retryable errors
        if (response.statusCode === 401) {
          fastify.log.warn(`[proxy] Key ${key.slice(0, 12)}... returned 401 (banned), marking banned`);
          await pool.markBanned(key);
          // Don't return it, try next key
          continue;
        }

        if (response.statusCode === 429) {
          fastify.log.warn(`[proxy] Key ${key.slice(0, 12)}... returned 429 (rate limited), marking cooldown`);
          await pool.markCooldown(key);
          // Don't return it, try next key
          continue;
        }

        // Success or non-retryable error: return key to pool and forward response
        await pool.returnKey(key, poolType);

        // Copy response headers
        for (const [k, v] of Object.entries(response.headers)) {
          if (v === undefined) continue;
          // Skip hop-by-hop headers
          if (['transfer-encoding', 'connection'].includes(k.toLowerCase())) continue;
          reply.header(k, v as string);
        }

        reply.code(response.statusCode);
        // Send stream directly for SSE streaming support
        reply.send(response.body);
        return;

      } catch (err: any) {
        lastError = err;
        // Network error - return the key and retry
        await pool.returnKey(key, poolType);
        fastify.log.error(`[proxy] Network error on attempt ${attempt + 1}:`, err.message);
        continue;
      }
    }

    // All retries exhausted
    fastify.log.error(`[proxy] All ${config.retry.maxRetries + 1} attempts failed`);
    return reply.code(502).send({
      error: 'Upstream request failed after retries',
      error_code: 'upstream_error',
      details: lastError?.message,
    });
  });
};

export default proxyRoutes;
