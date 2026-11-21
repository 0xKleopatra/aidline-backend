# Indexer runbook

Operational procedures for the Aidline backend when the indexer falls behind or stops. The backend is one Node.js process: it serves the API and runs the Soroban event indexer against Postgres. If you have not deployed it yet, read [DEPLOYMENT.md](DEPLOYMENT.md) first.

## Tools you will use

| Where                 | What it tells you                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`         | `indexedLedger`, `latestLedger` and `lagLedgers` (the difference). Both ledgers are `null` before the first sync. A liveness check for the host.                    |
| `GET /metrics`        | `aidline_indexed_ledger`, `aidline_latest_ledger`, `aidline_indexer_lag_ledgers` (`0` means caught up), plus HTTP counters. Set `METRICS_ENABLED=false` to disable. |
| `GET /stats`          | Platform totals. A quick way to see whether writes are landing.                                                                                                     |
| Process logs          | `indexed events`, `indexer sync failed`, and the gap-recovery messages quoted below.                                                                                |
| `indexer_state` table | Single row `id = 1`: `cursor`, `last_ledger`, `latest_ledger`. The cursor is the source of truth for where indexing resumes.                                        |
| RPC health            | `getHealth` reports `oldestLedger` and `latestLedger`; the indexer clamps its start ledger to `oldestLedger`.                                                       |

A brief RPC failure heals itself: a failed page writes nothing, the cursor is not advanced, and the next poll retries. Most of the procedures below start with "confirm it is not just a brief outage."

## 1. Indexer lag

**Symptoms**

- `/health` shows `lagLedgers` growing, or `/metrics` shows `aidline_indexer_lag_ledgers` above 0 for more than a few minutes.
- New donations or campaigns are slow to appear, but they do eventually appear.
- Logs contain `indexed events` lines, so the indexer is making progress.

**Steps**

1. Read `/health` and note `indexedLedger`, `latestLedger` and `lagLedgers`. Check `/metrics` for the trend.
2. Confirm the indexer is draining: while catching up, a full page (100 events) sets the poll delay to 0, so it should consume a backlog quickly. Watch for `indexed events` log lines with increasing counts.
3. If the lag is steady rather than shrinking, check whether the chain tip is simply moving faster than the indexer (unusually high event volume) or whether RPC responses are slow. Look for repeated `indexer sync failed` lines.
4. Check `INDEXER_POLL_MS`. The default is 5 seconds (minimum 1 second). A value near the maximum makes the indexer slower to catch up; lower it if the RPC can take the load.
5. Check the database: slow queries or a saturated connection pool slow every page down, because each page is one transaction that also updates campaign rows from the contract.
6. If lag keeps growing with no errors, restart the process (see "Stalled indexer") and keep watching `/health`. A clean restart resumes from the stored cursor and does not skip events.

## 2. Stalled indexer

**Symptoms**

- `lagLedgers` stays high and does not decrease.
- No `indexed events` lines in the logs for several minutes while the process is still up.
- `indexer_state.last_ledger` stops changing.

**Steps**

1. Look for `indexer sync failed` in the logs and read the error. The loop logs the error and retries on the next tick; a persistent error means an underlying problem.
2. Query `SELECT * FROM indexer_state WHERE id = 1;`. Note the cursor and `last_ledger` before changing anything.
3. Check the database is reachable and not suspended: run `/health` and `/stats`. If the server still reports `DB not ready` or hangs, follow "Lost database".
4. Check RPC health and reachability from the host. If the RPC is down, follow "RPC outage".
5. Check the error is not a cursor-retention error (see "Gap recovery"). If it is, recovery is automatic.
6. Restart the process so the poll loop starts fresh. It resumes from the stored cursor. Verify that `indexed events` lines resume and that `last_ledger` advances in `indexer_state`.
7. If it stalls again immediately, capture the full error and the cursor value, and escalate with the `X-Request-Id` header from any failing API call and the relevant log lines.

## 3. Gap recovery (cursor outside RPC retention)

**Symptoms**

- Logs show `indexer cursor has fallen out of RPC retention, starting gap recovery`, then `gap recovery: determined oldest available ledger from RPC`, `gap recovery: resynchronising known campaigns`, and finally `gap recovery complete, indexer will resume from oldest available ledger`.
- `/health` may show a sudden change in `last_ledger` to the RPC's oldest available ledger.

**What it does**

This is automatic and needs no operator action. `syncOnce` recognises retention errors from `getEvents`, re-fetches `get_campaign` for every campaign in the `campaigns` table, resets the cursor to `NULL`, and stores the RPC's oldest ledger as `last_ledger`. The next poll starts from that oldest ledger. Recovery is idempotent: campaign upserts update in place and history rows are inserted with `ON CONFLICT DO NOTHING`.

**Steps**

1. Let it finish; do not restart midway. On success the indexer resumes normal polling on its own.
2. Confirm with `/health` that `lagLedgers` settles back toward 0 and that `indexed events` lines resume.
3. Know the cost: events in the gap cannot be replayed, so `donations`, `refunds` and `milestone_releases` have a hole. Campaign totals are correct because they were copied from the contract. See [ADR 0004](adr/0004-contract-totals-not-event-sums.md).
4. A campaign created entirely during the gap is not in the `campaigns` table and will not be discovered until a later indexed event touches it. The RPC cannot supply its old events.
5. If you see `gap recovery failed; cursor has not been reset`, the cursor was deliberately left untouched so the next poll retries. Fix the underlying cause (RPC unreachable, database error) and the next tick will try again. Do not manually clear the cursor unless you understand that doing so discards the recovery position.

## 4. RPC outage

**Symptoms**

- `indexer sync failed` lines with network, timeout or 5xx errors from the RPC endpoint.
- `/health` shows `latestLedger` stopped advancing.
- Lag grows while the RPC is unavailable, then drains once it returns.

**Steps**

1. Confirm it is the RPC, not the database or the process: `/stats` still works, but `getEvents`/`getHealth` calls fail. Brief outages self-heal — wait one or two poll intervals before acting.
2. Check `AIDLINE_RPC_URL` and the network selection (`AIDLINE_NETWORK`). `/config` shows the `rpcUrl` and `networkPassphrase` the process is using; confirm both are correct.
3. Verify the endpoint from the host (for example, call `getHealth` directly) and check the provider's status page. Consider switching to a healthy RPC endpoint if the configured one is down.
4. When the RPC returns, the indexer resumes from the stored cursor with no data loss, because no page was committed during the outage. Watch `/health` as the backlog drains.
5. If the outage outlasted the RPC's history window, gap recovery kicks in instead (see above). Check the logs for the recovery messages and verify campaign totals afterwards.

## 5. Lost or empty database

**Symptoms**

- The server exits at startup, or logs `DB not ready` and waits before listening.
- `/campaigns` is empty even though the contract has activity.
- `SELECT count(*) FROM campaigns;` returns 0.

**Steps**

1. Check `DATABASE_URL` in the environment and confirm the database is reachable from the host. For hosted Postgres (for example Neon), a suspended or expired database is a common cause. Check the provider dashboard.
2. Migrations run automatically on startup, so a fresh database needs no manual migration step. Confirm the tables exist; if the database was replaced, restart the process to run migrations.
3. Restore from a backup if one exists. Restoring the database including `indexer_state` preserves the cursor, so no events are skipped.
4. If there is no backup, note the hard limit: Soroban RPC keeps only about a week of testnet history. A brand-new database cannot rebuild campaigns whose activity is outside that window. Set `INDEXER_START_LEDGER` to a ledger inside the window (or leave it empty to start roughly 1000 ledgers back) and let the indexer populate what it can.
5. If you need demo content back, run the seeding script once with the contract admin key as described in [DEPLOYMENT.md](DEPLOYMENT.md#starting-over-with-an-empty-database). Use a testnet admin key only; never commit it.
6. Verify with `/health`, `/stats` and `/campaigns` after the process restarts.

## 6. Contract redeploy or upgrade

**Symptoms**

- `/campaigns` is empty or frozen after a new contract is deployed, while `/health` shows the indexer caught up.
- Events from the new contract do not appear in the indexer logs.
- `/config` still shows the old `contractId`.

**Steps**

1. Update `AIDLINE_CONTRACT_ID` (and `AIDLINE_TOKEN_ID` if the token changed) in the deployment environment, then restart the process. `/config` should show the new `contractId`.
2. Decide how to handle state. The indexer filters events by contract id, so a new contract means a new event stream:
   - **Preferable:** use a fresh database and set `INDEXER_START_LEDGER` to the new deployment ledger so all of its events are indexed from the start.
   - If you must reuse the database, be aware that history rows from the old contract remain and `campaign_id` values may collide with the new contract's campaigns. Plan a data migration rather than pointing the old database at the new contract blindly.
3. Confirm `INDEXER_START_LEDGER` is within the RPC retention window (or empty). A deployment ledger older than the window will be clamped to the oldest ledger the RPC holds, and earlier events cannot be recovered.
4. If the contract added new event types, the indexer ignores them until `decodeEvent` and `recordEvent` are updated. Follow [EVENTS.md](EVENTS.md#adding-a-new-event) and keep it in step with `events.rs`.
5. Update any frontend or client that caches `/config`, and re-run the demo seed only if you intentionally started with an empty database. Verify with `/health`, `/stats` and a known new-campaign lookup.

## Escalating

If a procedure does not resolve the issue, collect the following before asking for help:

- `GET /health` and the relevant `GET /metrics` values.
- The row from `indexer_state` (`cursor`, `last_ledger`, `latest_ledger`).
- Log lines around the first failure, including any `X-Request-Id` header from a failing request.
- `AIDLINE_NETWORK`, the RPC host portion of `AIDLINE_RPC_URL` (not any secret), the contract id, and the approximate time the problem started.

Never include database passwords, wallet secrets, seed phrases or private keys when sharing logs or configuration.
