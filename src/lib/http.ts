import type { FastifyReply } from 'fastify';
import { z } from 'zod';

export const stellarAddress = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, 'must be a Stellar account address');

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Tighter limits for the write routes. The global limit is generous because reads are cheap,
 * but these endpoints insert rows and, for proofs, accept multipart file uploads. They are
 * passed as per-route `config.rateLimit` so they replace (rather than add to) the global limit.
 */
export const writeRateLimits = {
  metadata: { max: 50, timeWindow: '1 minute' },
  proofs: { max: 10, timeWindow: '1 minute' },
  verifierApplications: { max: 10, timeWindow: '1 minute' },
};

export function notFound(reply: FastifyReply, what: string) {
  return reply.code(404).send({ error: 'not_found', message: `${what} not found` });
}
