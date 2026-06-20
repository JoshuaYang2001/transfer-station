import Fastify from 'fastify';
import { config } from './config/index.js';
import { connectRedis } from './redis/client.js';
import adminRoutes from './routes/admin.js';
import proxyRoutes from './routes/proxy.js';
import { startJanitor } from './janitor/index.js';

async function bootstrap() {
  // Connect to Redis
  await connectRedis();
  console.log('[redis] Connection established');

  const fastify = Fastify({
    logger: {
      level: 'info',
    },
    // Critical for streaming: do not buffer responses
    disableRequestLogging: false,
    // Increase body size limit for large payloads (e.g., image inputs)
    bodyLimit: 50 * 1024 * 1024, // 50MB
  });

  // Add raw body to all requests, preserve as Buffer for proxying
  // This is critical for correct forwarding
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, function (req, body, done) {
    done(null, body);
  });

  // Register routes
  await fastify.register(adminRoutes, { prefix: '/' });
  await fastify.register(proxyRoutes, { prefix: '/' });

  // Health check endpoint (no auth needed)
  fastify.get('/health', async () => {
    return { status: 'ok', service: 'haps-proxy' };
  });

  // Start janitor tasks
  startJanitor();

  // Start listening
  await fastify.listen({
    port: config.port,
    host: config.host,
  });

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   HAPS Proxy - Hybrid Account Pool Proxy for LLM APIs     ║
║                                                           ║
║   Listening on: http://${config.host}:${config.port}                          ║
║   Upstream:     ${config.upstream.baseUrl.padEnd(47)}║
║                                                           ║
║   Admin API:    POST /admin/accounts/batch-inject         ║
║   Proxy:        POST /*                                   ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
}

bootstrap().catch((err) => {
  console.error('Fatal error during bootstrap:', err);
  process.exit(1);
});
