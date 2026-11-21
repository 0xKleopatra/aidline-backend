import type { FastifyReply } from 'fastify';

/**
 * A tiny in-memory cache for the read endpoints the frontend calls on every
 * page load (`/stats` and `/releases`). The home page can be refreshed often,
 * so a short TTL keeps repeated visits cheap without making data stale for
 * long. Indexer writes clear it immediately.
 */
export const CACHE_TTL_MS = 10_000;
export const CACHE_MAX_AGE = Math.floor(CACHE_TTL_MS / 1000);

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class ResponseCache {
  private readonly entries = new Map<string, Entry<unknown>>();

  constructor(private readonly ttlMs: number = CACHE_TTL_MS) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Called after every indexer write so reads never serve stale aggregates. */
  clear(): void {
    this.entries.clear();
  }
}

/** Cache headers for both a hit and a miss, so clients can avoid revalidating. */
export function setCacheHeaders(reply: FastifyReply, hit: boolean): void {
  reply.header('cache-control', `public, max-age=${CACHE_MAX_AGE}`);
  reply.header('x-cache', hit ? 'HIT' : 'MISS');
}
