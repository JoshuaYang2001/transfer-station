import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config/index.js';

// Proxy auth: validates the Bearer token from new-api
export async function verifyProxyBearer(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  const expected = config.security.proxyBearerToken;

  if (token !== expected) {
    reply.code(403).send({ error: 'Invalid proxy token' });
  }
}

// Admin auth: validates admin API key for management endpoints
export async function verifyAdminApiKey(request: FastifyRequest, reply: FastifyReply) {
  const apiKey = request.headers['x-admin-api-key'];
  const expected = config.security.adminApiKey;

  if (!apiKey || apiKey !== expected) {
    reply.code(403).send({ error: 'Invalid or missing admin API key' });
  }
}

// Register as a plugin if needed
const authPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate('verifyProxyBearer', verifyProxyBearer);
  fastify.decorate('verifyAdminApiKey', verifyAdminApiKey);
};

export default fp(authPlugin, {
  name: 'auth',
});
