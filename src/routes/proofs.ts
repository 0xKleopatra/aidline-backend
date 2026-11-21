import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { verifySignedRequest } from '../lib/auth.js';
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
 * URI is passed to `approve_milestone` and emitted on chain.
 */
export async function proofRoutes(app: FastifyInstance) {
  app.post('/proofs', async (req, reply) => {
    // #7: the signer must be the verifier assigned to this campaign on chain.
    // The campaign id is bound into the signed message, so a signature for one
    // campaign cannot be reused for another.
    const identity = verifySignedRequest(req, reply, 'proof:upload', { requireCampaign: true });
    if (!identity) return reply;
    const campaignId = identity.campaignId ?? '';
    const { rows: campaigns } = await app.db.query<{ verifier: string }>(
      'SELECT verifier FROM campaigns WHERE id = $1',
      [campaignId],
    );
    if (!campaigns[0]) return notFound(reply, 'campaign');
    if (campaigns[0].verifier !== identity.address) {
      return reply
        .code(403)
        .send({ error: 'forbidden', message: 'Only the campaign verifier may upload proofs' });
    }

    const id = randomUUID();
    const dir = join(app.config.UPLOAD_DIR, 'proofs', id);
    const raw: Record<string, string> = {};
    const files: { name: string; url: string; type: string }[] = [];
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
        await mkdir(dir, { recursive: true });
        const name = `${files.length}${extension}`;
        const path = join(dir, name);
        await pipeline(part.file, createWriteStream(path));
        written.push(path);
        files.push({
          name: part.filename,
          type: part.mimetype,
          url: `${app.config.PUBLIC_BASE_URL}/uploads/proofs/${id}/${name}`,
        });
      }

      const f = fields.parse(raw);
      if (f.campaignId.toString() !== campaignId) {
        return reply
          .code(403)
          .send({ error: 'forbidden', message: 'Signed campaign id does not match the upload' });
      }
      await app.db.query(
        `INSERT INTO proofs (id, campaign_id, milestone_index, note, files)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, f.campaignId.toString(), f.milestoneIndex, f.note, JSON.stringify(files)],
      );
      written.length = 0;
      return reply.code(201).send({ id, uri: `${app.config.PUBLIC_BASE_URL}/proofs/${id}`, files });
    } finally {
      // Anything still listed here belongs to a rejected upload.
      await Promise.all(written.map((p) => unlink(p).catch(() => {})));
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
