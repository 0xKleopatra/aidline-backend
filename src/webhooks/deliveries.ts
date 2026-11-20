import type { PoolClient } from 'pg';

import { proofIdFromUri } from '../lib/uris.js';
import type { AidlineEvent } from '../stellar/events.js';

type ReleaseEvent = Extract<AidlineEvent, { type: 'milestone_released' }>;

/**
 * Enqueues one delivery per subscriber inside the indexer's transaction. The
 * (subscription_id, event_id) unique constraint makes this idempotent: a
 * replayed chain event can never fire the same webhook twice.
 */
export async function enqueueReleaseWebhook(client: PoolClient, ev: ReleaseEvent): Promise<void> {
  const proofId = proofIdFromUri(ev.proofUri);
  let proof: Record<string, unknown> | null = null;
  if (proofId) {
    const { rows } = await client.query<Record<string, unknown>>(
      'SELECT id, note, files FROM proofs WHERE id = $1',
      [proofId],
    );
    if (rows[0]) proof = rows[0];
  }

  const payload = {
    event: 'milestone_released',
    eventId: ev.eventId,
    campaignId: ev.campaignId.toString(),
    milestoneIndex: ev.index,
    amount: ev.amount.toString(),
    txHash: ev.txHash,
    releasedAt: ev.closedAt,
    proof: { uri: ev.proofUri, ...(proof ?? {}) },
  };

  await client.query(
    `INSERT INTO webhook_deliveries (id, subscription_id, event_id, campaign_id, payload)
     SELECT gen_random_uuid(), s.id, $2, $3, $4::jsonb
     FROM webhook_subscriptions s
     WHERE s.campaign_id = $1
     ON CONFLICT (subscription_id, event_id) DO NOTHING`,
    [ev.campaignId.toString(), ev.eventId, ev.campaignId.toString(), JSON.stringify(payload)],
  );
}
