import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../src/db/pool.js';
import { Indexer } from '../src/indexer/indexer.js';
import { CACHE_MAX_AGE, ResponseCache } from '../src/lib/cache.js';
import { account, chainCampaign, CONTRACT_ID, events, resetDb, setupApp } from './helpers.js';

const { app, db } = (await setupApp()) as { app: FastifyInstance; db: Db };

beforeEach(async () => {
  await resetDb(db);
  app.cache.clear();
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe('ResponseCache', () => {
  it('serves entries until the TTL expires', () => {
    vi.useFakeTimers();
    try {
      const cache = new ResponseCache(1000);
      cache.set('key', { value: 1 });
      expect(cache.get('key')).toEqual({ value: 1 });
      vi.advanceTimersByTime(999);
      expect(cache.get('key')).toEqual({ value: 1 });
      vi.advanceTimersByTime(1);
      expect(cache.get('key')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears every entry', () => {
    const cache = new ResponseCache(1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});

describe('cached read endpoints', () => {
  it('serves repeated /stats calls from cache with cache headers', async () => {
    const first = await app.inject({ url: '/stats' });
    expect(first.headers['x-cache']).toBe('MISS');
    expect(first.headers['cache-control']).toBe(`public, max-age=${CACHE_MAX_AGE}`);
    expect(first.json()).toMatchObject({ campaigns: 0, verifiers: 0 });

    // Change data behind the cache: reads must still see the cached value.
    await db.query('INSERT INTO verifiers (address, active) VALUES ($1, true)', [account()]);
    const hit = await app.inject({ url: '/stats' });
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(hit.headers['cache-control']).toBe(`public, max-age=${CACHE_MAX_AGE}`);
    expect(hit.json().verifiers).toBe(0);

    app.cache.clear();
    const fresh = await app.inject({ url: '/stats' });
    expect(fresh.headers['x-cache']).toBe('MISS');
    expect(fresh.json().verifiers).toBe(1);
  });

  it('caches /releases per pagination', async () => {
    const first = await app.inject({ url: '/releases?limit=1' });
    expect(first.headers['x-cache']).toBe('MISS');
    expect(first.headers['cache-control']).toBe(`public, max-age=${CACHE_MAX_AGE}`);

    const hit = await app.inject({ url: '/releases?limit=1' });
    expect(hit.headers['x-cache']).toBe('HIT');

    const otherPage = await app.inject({ url: '/releases?limit=2' });
    expect(otherPage.headers['x-cache']).toBe('MISS');
  });

  it('invalidates both caches when the indexer commits a page', async () => {
    const statsBefore = await app.inject({ url: '/stats' });
    const releasesBefore = await app.inject({ url: '/releases' });
    expect(statsBefore.json()).toMatchObject({ campaigns: 0, milestonesVerified: 0 });
    expect(releasesBefore.json().items).toEqual([]);

    const campaign = chainCampaign({ raised: 300n, released: 300n, milestonesReleased: 1 });
    const indexer = new Indexer({
      db,
      cache: app.cache,
      contractId: CONTRACT_ID,
      pollMs: 1000,
      log: app.log,
      source: {
        getEvents: async () =>
          ({
            events: [
              events.created(0n, campaign.creator),
              events.released(0n, 0, 300n, 'ipfs://proof'),
            ],
            cursor: 'c',
            latestLedger: 1,
          }) as never,
        getHealth: async () => ({ oldestLedger: 1, latestLedger: 1 }),
      },
      contract: { getCampaign: async () => campaign },
    });
    await indexer.syncOnce();

    const statsAfter = await app.inject({ url: '/stats' });
    expect(statsAfter.headers['x-cache']).toBe('MISS');
    expect(statsAfter.json()).toMatchObject({ campaigns: 1, milestonesVerified: 1 });

    const releasesAfter = await app.inject({ url: '/releases' });
    expect(releasesAfter.headers['x-cache']).toBe('MISS');
    expect(releasesAfter.json().items).toHaveLength(1);
  });
});
