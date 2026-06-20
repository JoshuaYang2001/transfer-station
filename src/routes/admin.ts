import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getAccountPool } from '../services/account-pool.js';
import { verifyAdminApiKey } from '../plugins/auth.js';
import type { InjectAccountsBody } from '../types/index.js';

const injectSchema = z.object({
  pool_type: z.enum(['static', 'ephemeral']),
  keys: z.array(z.string()).min(1).max(10000),
});

const adminRoutes: FastifyPluginAsync = async (fastify) => {
  const pool = getAccountPool();

  // Add pre-handler hook for all admin routes
  fastify.addHook('preHandler', verifyAdminApiKey);

  /**
   * Batch inject accounts from codex-console
   * POST /admin/accounts/batch-inject
   * Headers: X-Admin-Api-Key: <key>
   * Body: { pool_type: 'ephemeral' | 'static', keys: string[] }
   */
  fastify.post<{ Body: InjectAccountsBody }>(
    '/admin/accounts/batch-inject',
    {
      schema: {
        body: {
          type: 'object',
          required: ['pool_type', 'keys'],
          additionalProperties: false,
          properties: {
            pool_type: { type: 'string', enum: ['static', 'ephemeral'] },
            keys: {
              type: 'array',
              minItems: 1,
              maxItems: 10000,
              items: { type: 'string' },
            },
          },
        },
      } as const,
    },
    async (request, reply) => {
      const parseResult = injectSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: 'Invalid request body',
          details: parseResult.error.errors,
        });
      }

      const { pool_type, keys } = parseResult.data;

      fastify.log.info(
        `[admin] Injecting ${keys.length} keys into ${pool_type} pool`
      );

      const result = await pool.batchInject(pool_type, keys);

      fastify.log.info(
        `[admin] Inject result: ${result.injected} injected, ${result.duplicates} duplicates, ${result.invalid} invalid`
      );

      return {
        success: true,
        pool_type,
        ...result,
      };
    }
  );

  /**
   * Get pool statistics
   * GET /admin/stats
   */
  fastify.get('/admin/stats', async () => {
    const stats = await pool.getStats();
    return {
      success: true,
      ...stats,
    };
  });
};

export default adminRoutes;
