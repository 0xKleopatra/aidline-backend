import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { contentTypeFor, createStorage } from '../src/storage/index.js';

afterEach(() => vi.unstubAllGlobals());

describe('local storage driver', () => {
  it('is the default and round-trips a file with a stable content type', async () => {
    const config = loadConfig({ UPLOAD_DIR: mkdtempSync(join(tmpdir(), 'aidline-store-')) });
    const storage = createStorage(config);
    expect(storage.name).toBe('local');

    const key = 'proofs/abc/0.png';
    await storage.put(key, Buffer.from('image bytes'), 'image/png');
    const object = await storage.get(key);
    expect(object?.body.toString()).toBe('image bytes');
    expect(object?.contentType).toBe('image/png');
    expect(await storage.get('proofs/abc/missing.png')).toBeNull();

    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
  });

  it('rejects traversal keys before reading or writing any file', async () => {
    const storage = createStorage(
      loadConfig({ UPLOAD_DIR: mkdtempSync(join(tmpdir(), 'aidline-store-')) }),
    );
    await expect(storage.get('../secret')).rejects.toThrow('invalid storage key');
    await expect(
      storage.put('proofs/../../secret', Buffer.from('x'), 'text/plain'),
    ).rejects.toThrow('invalid storage key');
    expect(contentTypeFor('proofs/id/0.thumb.png')).toBe('image/png');
  });
});

describe('S3 compatible storage driver', () => {
  const baseEnv = {
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'proofs',
    S3_ACCESS_KEY_ID: 'test-key',
    S3_SECRET_ACCESS_KEY: 'test-secret',
    S3_ENDPOINT: 'http://minio.test:9000',
  } as const;

  it('requires credentials and a bucket at config load', () => {
    expect(() => loadConfig({ STORAGE_DRIVER: 's3' })).toThrow('S3_BUCKET');
    expect(() => loadConfig(baseEnv)).not.toThrow();
  });

  it('signs and uploads with AWS Signature V4, then reads the object back', async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('stored bytes', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const storage = createStorage(loadConfig(baseEnv));
    expect(storage.name).toBe('s3');
    await storage.put('proofs/id/0.png', Buffer.from('stored bytes'), 'image/png');

    const put = calls[0];
    expect(put?.url.toString()).toBe('http://minio.test:9000/proofs/proofs/id/0.png');
    expect(put?.init.method).toBe('PUT');
    const headers = put?.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=test-key\//);
    expect(headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['content-type']).toBe('image/png');

    const object = await storage.get('proofs/id/0.png');
    expect(object?.body.toString()).toBe('stored bytes');
    expect(object?.contentType).toBe('image/png');
    expect(calls[1]?.init.method).toBe('GET');
  });

  it('supports virtual-host style for providers that prefer it', async () => {
    const calls: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) => {
        calls.push(url);
        return new Response('', { status: 200 });
      }),
    );
    const storage = createStorage(loadConfig({ ...baseEnv, S3_FORCE_PATH_STYLE: 'false' }));
    await storage.get('proofs/id/0.png');
    expect(calls[0]?.host).toBe('proofs.minio.test:9000');
    expect(calls[0]?.pathname).toBe('/proofs/id/0.png');
  });
});
