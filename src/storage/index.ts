import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';

import type { Config } from '../config.js';

/**
 * Proof files outlive any single host, so uploads go through this small
 * interface. Both drivers expose the same keys and the same stable public
 * URLs (`${PUBLIC_BASE_URL}/uploads/<key>`); the HTTP layer proxies reads, so
 * switching drivers never changes a URI that was already written on chain.
 */

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface StorageDriver {
  readonly name: 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream';
}

/** Keys come from URLs on reads, so reject traversal before touching any path. */
function assertValidKey(key: string): void {
  if (!key || key.includes('\0') || key.includes('\\')) throw new Error('invalid storage key');
  const parts = key.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error('invalid storage key');
}

function localPath(root: string, key: string): string {
  assertValidKey(key);
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(root + sep)) throw new Error('invalid storage key');
  return path;
}

class LocalStorage implements StorageDriver {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(config: Config) {
    this.root = resolve(config.UPLOAD_DIR);
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const path = localPath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = localPath(this.root, key);
    try {
      return { body: await readFile(path), contentType: contentTypeFor(key) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await unlink(localPath(this.root, key)).catch(() => {});
  }
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Minimal AWS Signature V4, enough for PUT/GET/DELETE against any S3 compatible service. */
function signedHeaders(
  config: Config,
  url: URL,
  method: string,
  contentType: string | null,
  body: Buffer = Buffer.alloc(0),
) {
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hash(body);

  const headers: [string, string][] = [
    ['host', url.host],
    ['x-amz-content-sha256', payloadHash],
    ['x-amz-date', amzDate],
  ];
  if (config.S3_SESSION_TOKEN) headers.push(['x-amz-security-token', config.S3_SESSION_TOKEN]);
  if (contentType) headers.push(['content-type', contentType]);
  headers.sort(([a], [b]) => a.localeCompare(b));

  const canonical = [
    method,
    url.pathname,
    url.searchParams.toString(),
    headers.map(([k, v]) => `${k}:${v.trim()}\n`).join(''),
    headers.map(([k]) => k).join(';'),
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${config.S3_REGION}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${config.S3_SECRET_ACCESS_KEY}`, dateStamp), config.S3_REGION), 's3'),
    'aws4_request',
  );

  return {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(config.S3_SESSION_TOKEN ? { 'x-amz-security-token': config.S3_SESSION_TOKEN } : {}),
    ...(contentType ? { 'content-type': contentType } : {}),
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${headers.map(([k]) => k).join(';')}, Signature=${hmac(key, toSign).toString('hex')}`,
  };
}

class S3Storage implements StorageDriver {
  readonly name = 's3' as const;

  constructor(private readonly config: Config) {}

  private url(key: string): URL {
    assertValidKey(key);
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    if (this.config.S3_ENDPOINT) {
      const url = new URL(this.config.S3_ENDPOINT);
      url.pathname = this.config.S3_FORCE_PATH_STYLE
        ? `/${this.config.S3_BUCKET}/${encoded}`
        : `/${encoded}`;
      if (!this.config.S3_FORCE_PATH_STYLE) url.host = `${this.config.S3_BUCKET}.${url.host}`;
      return url;
    }
    return new URL(
      `https://${this.config.S3_BUCKET}.s3.${this.config.S3_REGION}.amazonaws.com/${encoded}`,
    );
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const url = this.url(key);
    const res = await fetch(url, {
      method: 'PUT',
      headers: signedHeaders(this.config, url, 'PUT', contentType, body),
      body: new Uint8Array(body),
    });
    if (!res.ok) throw new Error(`S3 put failed for ${key}: HTTP ${res.status}`);
  }

  async get(key: string): Promise<StoredObject | null> {
    const url = this.url(key);
    const res = await fetch(url, {
      method: 'GET',
      headers: signedHeaders(this.config, url, 'GET', null),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 get failed for ${key}: HTTP ${res.status}`);
    return {
      body: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? contentTypeFor(key),
    };
  }

  async delete(key: string): Promise<void> {
    const url = this.url(key);
    const res = await fetch(url, {
      method: 'DELETE',
      headers: signedHeaders(this.config, url, 'DELETE', null),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 delete failed for ${key}: HTTP ${res.status}`);
    }
  }
}

export function createStorage(config: Config): StorageDriver {
  return config.STORAGE_DRIVER === 's3' ? new S3Storage(config) : new LocalStorage(config);
}
