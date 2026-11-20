import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createThumbnail } from '../lib/images.js';
import { notFound } from '../lib/http.js';

/**
 * Allowed upload types and the file extension each is stored with. The extension comes from this
 * table, never from the uploaded filename: the static file server picks the response content type
 * from the extension, so a file named `x.html` sent as `image/png` would otherwise be served as
 * HTML from this origin.
 */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};
const MAX_FILES = 5;

const fields = z.object({
  campaignId: z.coerce.bigint().nonnegative(),
  milestoneIndex: z.coerce.number().int().min(0),
  note: z.string().trim().min(10).max(2000),
});

/**
 * Verifiers upload evidence here before approving a milestone. The returned
 * URI is passed to `approve_milestone` and emitted on chain. Files go through
 * the configured storage driver; the original is always kept alongside an
 * optional smaller thumbnail for mobile clients.
 */
export async function proofRoutes(app: FastifyInstance) {
  app.post('/proofs', async (req, reply) => {
    const id = randomUUID();
    const raw: Record<string, string> = {};
    const files: { name: string; url: string; thumbnailUrl: string; type: string }[] = [];
    const written: string[] = [];

    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          raw[part.fieldname] = String(part.value);
          continue;
        }
        const extension = EXTENSIONS[part.mimetype];
        if (!extension || files.length >= MAX_FILES) {
          part.file.resume();
          return reply.code(400).send({
            error: 'invalid_file',
            message: `Up to ${MAX_FILES} JPEG, PNG, WebP or PDF files are allowed`,
          });
        }

        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);

        const name = `${files.length}${extension}`;
        const key = `proofs/${id}/${name}`;
        await app.storage.put(key, body, part.mimetype);
        written.push(key);

        const url = `${app.config.PUBLIC_BASE_URL}/uploads/${key}`;
        let thumbnailUrl = url;
        const thumbnail = await createThumbnail(body);
        if (thumbnail) {
          const thumbKey = `proofs/${id}/${files.length}.thumb.png`;
          await app.storage.put(thumbKey, thumbnail, 'image/png');
          written.push(thumbKey);
          thumbnailUrl = `${app.config.PUBLIC_BASE_URL}/uploads/${thumbKey}`;
        }

        files.push({ name: part.filename, type: part.mimetype, url, thumbnailUrl });
      }

      const f = fields.parse(raw);
      await app.db.query(
        `INSERT INTO proofs (id, campaign_id, milestone_index, note, files)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, f.campaignId.toString(), f.milestoneIndex, f.note, JSON.stringify(files)],
      );
      written.length = 0;
      return reply.code(201).send({ id, uri: `${app.config.PUBLIC_BASE_URL}/proofs/${id}`, files });
    } finally {
      // Anything still listed here belongs to a rejected upload.
      await Promise.all(written.map((key) => app.storage.delete(key)));
    }
  });

  app.get('/proofs/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { rows } = await app.db.query(
      `SELECT id, campaign_id AS "campaignId", milestone_index AS "milestoneIndex", note, files,
              created_at AS "createdAt"
       FROM proofs WHERE id = $1`,
      [id],
    );
    return rows[0] ?? notFound(reply, 'proof');
  });
}
