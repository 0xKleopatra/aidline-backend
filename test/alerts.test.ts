import { readFileSync } from 'node:fs';

import type { rpc } from '@stellar/stellar-sdk';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../src/db/pool.js';
import { Indexer, type EventSource } from '../src/indexer/indexer.js';
import { parseGdacsFeed, pollGdacs, startGdacsScheduler } from '../src/jobs/gdacs.js';
import type { ChainCampaign } from '../src/stellar/contract.js';
import { account, chainCampaign, CONTRACT_ID, events, resetDb, setupApp } from './helpers.js';

const fixture = readFileSync(new URL('./fixtures/gdacs-rss.xml', import.meta.url), 'utf8');

const { app, db } = (await setupApp()) as { app: FastifyInstance; db: Db };

const fakeFetch = (body: string, status = 200) =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

class FakeChain implements EventSource {
  pages: rpc.Api.EventResponse[][] = [];
  campaigns = new Map<bigint, ChainCampaign>();
  async getEvents() {
    return { events: this.pages.shift() ?? [], cursor: 'cursor', latestLedger: 500 } as never;
  }
  async getHealth() {
    return { oldestLedger: 50, latestLedger: 500 };
  }
  async getCampaign(id: bigint) {
    const campaign = this.campaigns.get(id);
    if (!campaign) throw new Error(`no campaign ${id}`);
    return campaign;
  }
}

describe('GDACS alerts', () => {
  beforeEach(() => resetDb(db));
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('parses only orange and red alerts from a recorded feed', () => {
    const alerts = parseGdacsFeed(fixture);
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.id)).toEqual(['gdacs-fl-1001', 'gdacs-tc-1002']);
    expect(alerts[0]).toMatchObject({
      severity: 'red',
      eventType: 'flood',
      title: 'Flood in Bangladesh',
      location: 'Sylhet Division',
      country: 'Bangladesh',
    });
    expect(alerts[1]).toMatchObject({
      severity: 'orange',
      eventType: 'cyclone',
      location: 'Mozambique',
    });
    expect(alerts[0]?.publishedAt?.toISOString()).toBe('2026-11-20T08:00:00.000Z');
  });

  it('deduplicates alerts across polls and exposes them with location and severity', async () => {
    expect(await pollGdacs(db, 'https://feed.test', fakeFetch(fixture))).toBe(2);
    expect(await pollGdacs(db, 'https://feed.test', fakeFetch(fixture))).toBe(0);

    const all = (await app.inject({ url: '/alerts' })).json();
    expect(all.items).toHaveLength(2);
    expect(all.items[0]).toMatchObject({
      id: 'gdacs-fl-1001',
      severity: 'red',
      location: 'Sylhet Division',
      country: 'Bangladesh',
    });

    const orange = (await app.inject({ url: '/alerts?severity=orange' })).json();
    expect(orange.items).toHaveLength(1);
    expect(orange.items[0].id).toBe('gdacs-tc-1002');
  });

  it('surfaces a failing feed as an error from a single poll', async () => {
    await expect(pollGdacs(db, 'https://feed.test', fakeFetch('nope', 503))).rejects.toThrow(
      'HTTP 503',
    );
  });

  it('keeps the indexer running when the feed job fails', async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error('feed unreachable');
    }) as unknown as typeof fetch;
    const timer = startGdacsScheduler(
      db,
      'https://feed.test',
      60_000,
      { info: () => {}, error: () => {} },
      failingFetch,
    );
    try {
      // The job swallows its own failure; the indexer below must still commit.
      const chain = new FakeChain();
      const campaign = chainCampaign({ id: 1n, raised: 100n, released: 0n });
      chain.campaigns.set(1n, campaign);
      chain.pages.push([events.created(1n, campaign.creator), events.donated(1n, account(), 100n)]);
      const indexer = new Indexer({
        db,
        source: chain,
        contract: chain,
        contractId: CONTRACT_ID,
        pollMs: 60_000,
        log: app.log,
      });
      await indexer.syncOnce();
      expect((await db.query('SELECT count(*)::int AS n FROM donations')).rows[0].n).toBe(1);
    } finally {
      clearInterval(timer);
    }
  });
});
