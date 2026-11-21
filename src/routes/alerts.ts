import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { pagination } from '../lib/http.js';

const query = pagination.extend({
  severity: z.enum(['orange', 'red']).optional(),
});

/** Recent disaster alerts from GDACS, newest first. */
export async function alertRoutes(app: FastifyInstance) {
  app.get('/alerts', { schema: { tags: ['alerts'] } }, async (req) => {
    const q = query.parse(req.query);
    const { rows } = await app.db.query(
      `SELECT id, event_type AS "eventType", severity, title, location, country, url,
              published_at AS "publishedAt", fetched_at AS "fetchedAt"
       FROM gdacs_alerts
       WHERE ($1::text IS NULL OR severity = $1)
       ORDER BY published_at DESC NULLS LAST, fetched_at DESC
       LIMIT $2 OFFSET $3`,
      [q.severity ?? null, q.limit, q.offset],
    );
    return { items: rows };
  });
}
