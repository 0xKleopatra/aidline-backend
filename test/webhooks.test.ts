import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { rpc } from '@stellar/stellar-sdk';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db/pool.js';
import { Indexer, type EventSource } from '../src/indexer/indexer.js';
import type { ChainCampaign } from '../src/stellar/contract.js';
import { httpSend, processDueDeliveries, type SendResult } from '../src/webhooks/dispatcher.js';
import { chainCampaign, CONTRACT_ID, events, resetDb, setupApp } from './helpers.js';

const { app, db } = (await setupApp()) as {
  app: Awaited<ReturnType<typeof buildApp>>;
  db: Db;
};

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

async function seedCampaign(id = 7n) {
  const campaign = chainCampaign({ id });
  await db.query(
    `INSERT INTO campaigns (id, creator, beneficiary, verifier, kind, metadata_uri, goal,
       deadline, milestones, status, created_ledger, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), $9, $10, $11, now())
     ON CONFLICT (id) DO NOTHING`,
    [
      id.toString(),
      campaign.creator,
      campaign.beneficiary,
      campaign.verifier,
      campaign.kind,
      campaign.metadataUri,
      campaign.goal.toString(),
      campaign.deadline.toString(),
      campaign.milestones.map((m) => m.toString()),
      campaign.status,
      100,
    ],
  );
  return campaign;
}

async function indexRelease(
  campaign: ChainCampaign,
  release = events.released(
    campaign.id,
    0,
    300n,
    'http://api.test/proofs/00000000-0000-4000-8000-000000000001',
  ),
) {
  const chain = new FakeChain();
  chain.campaigns.set(campaign.id, campaign);
  chain.pages.push([release]);
  await new Indexer({
    db,
    source: chain,
    contract: chain,
    contractId: CONTRACT_ID,
    pollMs: 60_000,
    log: app.log,
  }).syncOnce();
}

const log = { info: () => {}, warn: () => {}, error: () => {} };

describe('webhook subscriptions', () => {
  beforeEach(async () => {
    await resetDb(db);
    await seedCampaign();
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it('subscribes, lists and unsubscribes, rejecting private and duplicate URLs', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/campaigns/7/webhooks',
      payload: { url: 'https://example.org/hook' },
    });
    expect(created.statusCode).toBe(201);
    const subscription = created.json();
    expect(subscription).toMatchObject({ campaignId: '7', url: 'https://example.org/hook' });

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/campaigns/7/webhooks',
          payload: { url: 'https://example.org/hook' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/campaigns/7/webhooks',
          payload: { url: 'http://127.0.0.1:8080/hook' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/campaigns/999/webhooks',
          payload: { url: 'https://example.org/hook' },
        })
      ).statusCode,
    ).toBe(404);

    const list = (await app.inject({ url: '/campaigns/7/webhooks' })).json();
    expect(list.items).toHaveLength(1);

    const removed = await app.inject({ method: 'DELETE', url: `/webhooks/${subscription.id}` });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ url: '/campaigns/7/webhooks' })).json().items).toHaveLength(0);
  });

  it('enqueues exactly one delivery per release, even when the event is replayed', async () => {
    await app.inject({
      method: 'POST',
      url: '/campaigns/7/webhooks',
      payload: { url: 'https://example.org/hook' },
    });
    const campaign = chainCampaign({ id: 7n });
    const release = events.released(
      7n,
      0,
      300n,
      'http://api.test/proofs/00000000-0000-4000-8000-000000000001',
    );
    await indexRelease(campaign, release);
    await indexRelease(campaign, release);

    const { rows } = await db.query('SELECT payload, attempts, status FROM webhook_deliveries');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 0, status: 'pending' });
    expect(rows[0].payload).toMatchObject({
      event: 'milestone_released',
      campaignId: '7',
      amount: '300',
      milestoneIndex: 0,
      txHash: release.txHash,
      proof: { uri: 'http://api.test/proofs/00000000-0000-4000-8000-000000000001' },
    });
  });

  it('retries failures with backoff and logs the last error', async () => {
    await app.inject({
      method: 'POST',
      url: '/campaigns/7/webhooks',
      payload: { url: 'https://example.org/hook' },
    });
    await indexRelease(chainCampaign({ id: 7n }));

    const failing: SendResult = { ok: false, status: 500, error: 'HTTP 500' };
    const first = await processDueDeliveries(db, async () => failing, log, 3);
    expect(first).toMatchObject({ attempted: 1, delivered: 0, retried: 1, failed: 0 });

    let row = (await db.query('SELECT * FROM webhook_deliveries')).rows[0];
    expect(row).toMatchObject({ attempts: 1, status: 'pending', last_error: 'HTTP 500' });
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // Nothing is due while the backoff is pending.
    expect((await processDueDeliveries(db, async () => failing, log, 3)).attempted).toBe(0);

    await db.query(
      "UPDATE webhook_deliveries SET next_attempt_at = now() WHERE status = 'pending'",
    );
    const second = await processDueDeliveries(db, async () => ({ ok: true, status: 200 }), log, 3);
    expect(second).toMatchObject({ attempted: 1, delivered: 1 });
    row = (await db.query('SELECT * FROM webhook_deliveries')).rows[0];
    expect(row).toMatchObject({ status: 'delivered', attempts: 2, last_error: null });
  });

  it('marks a delivery failed after the last attempt', async () => {
    await app.inject({
      method: 'POST',
      url: '/campaigns/7/webhooks',
      payload: { url: 'https://example.org/hook' },
    });
    await indexRelease(chainCampaign({ id: 7n }));
    await processDueDeliveries(db, async () => ({ ok: false, error: 'down' }), log, 1);
    const row = (await db.query('SELECT status, attempts FROM webhook_deliveries')).rows[0];
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect(
      (
        await app.inject({
          url: `/webhooks/${(await db.query('SELECT subscription_id FROM webhook_deliveries')).rows[0].subscription_id}/deliveries`,
        })
      ).json().items[0].lastError,
    ).toBe('down');
  });

  it('posts the payload to a fake local receiver when private URLs are allowed', async () => {
    const received: { body: string; event: string | string[] | undefined }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        received.push({
          body: Buffer.concat(chunks).toString(),
          event: req.headers['x-aidline-event'],
        });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const localApp = await buildApp(
      loadConfig({
        WEBHOOK_ALLOW_PRIVATE_URLS: 'true',
        DATABASE_URL: app.config.DATABASE_URL,
        PUBLIC_BASE_URL: app.config.PUBLIC_BASE_URL,
        UPLOAD_DIR: app.config.UPLOAD_DIR,
      }),
      db,
      { logger: false },
    );
    try {
      const sub = await localApp.inject({
        method: 'POST',
        url: '/campaigns/7/webhooks',
        payload: { url: `http://127.0.0.1:${port}/hook` },
      });
      expect(sub.statusCode).toBe(201);
      await indexRelease(chainCampaign({ id: 7n }));
      const result = await processDueDeliveries(db, httpSend, log, 3);
      expect(result.delivered).toBe(1);
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0]?.body ?? '{}')).toMatchObject({
        event: 'milestone_released',
        campaignId: '7',
      });
      expect(received[0]?.event).toBe('milestone_released');
      void sub;
    } finally {
      await localApp.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
