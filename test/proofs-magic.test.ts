import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { detectMimeType } from '../src/lib/magic.js';
import type { Db } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';
import { MAGIC, multipartBody, resetDb, setupApp } from './helpers.js';

const { app, db, config } = (await setupApp()) as {
  app: FastifyInstance;
  db: Db;
  config: ReturnType<typeof loadConfig>;
};

afterAll(async () => {
  await app.close();
  await db.end();
});

beforeEach(async () => {
  await resetDb(db);
  rmSync(join(config.UPLOAD_DIR, 'proofs'), { recursive: true, force: true });
});

const fields = [
  { name: 'campaignId', value: '0' },
  { name: 'milestoneIndex', value: '0' },
  { name: 'note', value: 'Water tanks delivered to 3 camps' },
];

function upload(type: string, content: Buffer, filename = 'evidence.bin') {
  return multipartBody([...fields, { name: 'files', filename, contentType: type, content }]);
}

describe('detectMimeType', () => {
  it.each(Object.entries(MAGIC))('recognises %s magic bytes', (type, magic) => {
    expect(detectMimeType(magic)).toBe(type);
    // Extra bytes after the signature are fine: real files are larger than the header.
    expect(detectMimeType(Buffer.concat([magic, Buffer.from('rest of the file')]))).toBe(type);
  });

  it('returns null for empty, truncated or unknown bytes', () => {
    expect(detectMimeType(Buffer.alloc(0))).toBeNull();
    expect(detectMimeType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectMimeType(Buffer.from('MZ\x90\x00'))).toBeNull();
    expect(detectMimeType(Buffer.from('<script>alert(1)</script>'))).toBeNull();
  });

  it('does not mistake a truncated WebP header for a valid one', () => {
    expect(detectMimeType(Buffer.from('RIFF\x00\x00\x00\x00WEB'))).toBeNull();
  });
});

describe('POST /proofs magic byte checks', () => {
  it.each(Object.entries(MAGIC))('accepts a real %s file', async (type, magic) => {
    const { payload, headers } = upload(type, Buffer.concat([magic, Buffer.from('DATA')]));
    const res = await app.inject({ method: 'POST', url: '/proofs', payload, headers });
    expect(res.statusCode).toBe(201);
    expect(res.json().files[0].type).toBe(type);
    expect(existsSync(join(config.UPLOAD_DIR, 'proofs'))).toBe(true);
  });

  it.each([
    ['image/png', Buffer.concat([MAGIC['application/pdf'], Buffer.from('fake')])],
    ['image/jpeg', Buffer.from('MZ\x90\x00 this is an executable')],
    ['image/webp', Buffer.from('RIFF\x00\x00\x00\x00JUNK not webp')],
    ['application/pdf', Buffer.concat([MAGIC['image/png'], Buffer.from('fake')])],
  ])('rejects a %s upload whose bytes are something else', async (type, content) => {
    const { payload, headers } = upload(type, content, 'photo.png');
    const res = await app.inject({ method: 'POST', url: '/proofs', payload, headers });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_file' });
  });

  it('rejects an empty file', async () => {
    const { payload, headers } = upload('image/png', Buffer.alloc(0));
    const res = await app.inject({ method: 'POST', url: '/proofs', payload, headers });
    expect(res.statusCode).toBe(400);
  });

  it('does not persist a proof or a file for a rejected upload', async () => {
    const { payload, headers } = upload('image/png', Buffer.from('<script>alert(1)</script>'));
    await app.inject({ method: 'POST', url: '/proofs', payload, headers });

    const proofs = await db.query('SELECT count(*)::int AS n FROM proofs');
    expect(proofs.rows[0].n).toBe(0);
    expect(existsSync(join(config.UPLOAD_DIR, 'proofs'))).toBe(false);
  });
});
