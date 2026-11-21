import type { Db } from '../db/pool.js';

/**
 * Delivery worker for campaign webhooks. It runs on its own timer and only
 * touches `webhook_deliveries`, so a slow or failing receiver can never stall
 * the chain indexer or an API request.
 */

const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 5 * 60_000;
const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 5000;

export interface DeliveryLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(obj: unknown, msg: string): void;
}

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export type SendFn = (url: string, payload: unknown) => Promise<SendResult>;

interface DueDelivery {
  id: string;
  url: string;
  attempts: number;
  payload: unknown;
}

/** Default sender: one JSON POST per delivery with a bounded timeout. */
export async function httpSend(url: string, payload: unknown): Promise<SendResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'aidline-webhook/1.0',
        'x-aidline-event': 'milestone_released',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ProcessResult {
  attempted: number;
  delivered: number;
  retried: number;
  failed: number;
}

/**
 * Claims due deliveries, sends them, and records the outcome. Claims happen
 * with `FOR UPDATE SKIP LOCKED` so two instances never send the same row at
 * once. Failures are retried with capped exponential backoff and finally
 * marked `failed` after `maxAttempts`, always keeping the last error for the
 * operator to inspect.
 */
async function claimDue(db: Db): Promise<DueDelivery[]> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<DueDelivery>(
      `SELECT d.id, s.url, d.attempts, d.payload
       FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.subscription_id
       WHERE d.status = 'pending' AND d.next_attempt_at <= now()
       ORDER BY d.next_attempt_at
       LIMIT $1
       FOR UPDATE OF d SKIP LOCKED`,
      [BATCH_SIZE],
    );
    if (rows.length) {
      // Claim by advancing the attempt counter before sending. If this process
      // dies mid-batch the row stays pending and is retried on a later tick.
      await client.query(
        `UPDATE webhook_deliveries
         SET attempts = attempts + 1, next_attempt_at = now() + ($2::int * interval '1 millisecond')
         WHERE id = ANY($1::uuid[])`,
        [rows.map((d) => d.id), MAX_RETRY_MS],
      );
    }
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function processDueDeliveries(
  db: Db,
  send: SendFn,
  log: DeliveryLogger,
  maxAttempts: number,
): Promise<ProcessResult> {
  const result: ProcessResult = { attempted: 0, delivered: 0, retried: 0, failed: 0 };
  const due = await claimDue(db);

  for (const delivery of due) {
    result.attempted++;
    const attempt = delivery.attempts + 1;
    let outcome: SendResult;
    try {
      outcome = await send(delivery.url, delivery.payload);
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (outcome.ok) {
      await db.query(
        "UPDATE webhook_deliveries SET status = 'delivered', last_error = NULL WHERE id = $1",
        [delivery.id],
      );
      result.delivered++;
      log.info(`webhook delivered to ${delivery.url}`);
      continue;
    }

    const message = outcome.error ?? `HTTP ${outcome.status ?? 'unknown'}`;
    const terminal = attempt >= maxAttempts;
    const delay = Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
    await db.query(
      `UPDATE webhook_deliveries
       SET status = $2,
           next_attempt_at = now() + ($3::int * interval '1 millisecond'),
           last_error = $4
       WHERE id = $1`,
      [delivery.id, terminal ? 'failed' : 'pending', terminal ? 0 : delay, message.slice(0, 2000)],
    );
    if (terminal) {
      result.failed++;
      log.error({ url: delivery.url, error: message }, 'webhook failed after all retries');
    } else {
      result.retried++;
      log.warn(`webhook to ${delivery.url} failed (attempt ${attempt}), retrying in ${delay}ms`);
    }
  }
  return result;
}

/** Starts the delivery worker. Like the GDACS job, all errors are contained. */
export function startWebhookDispatcher(
  db: Db,
  log: DeliveryLogger,
  maxAttempts: number,
  pollMs: number,
  send: SendFn = httpSend,
): NodeJS.Timeout {
  const tick = async () => {
    try {
      const result = await processDueDeliveries(db, send, log, maxAttempts);
      if (result.attempted) {
        log.info(
          `webhook batch: ${result.delivered} delivered, ${result.retried} retried, ${result.failed} failed`,
        );
      }
    } catch (err) {
      log.error({ err }, 'webhook dispatcher tick failed; will retry');
    }
  };

  void tick();
  return setInterval(() => void tick(), pollMs);
}
