# 0004: Copy `raised` and `released` from the contract, do not sum events

Status: Accepted

## Context

The indexer sees a `donated` event for every gift and a `milestone_released` event for every payout, and it stores those events in the `donations`, `refunds` and `milestone_releases` history tables. It is tempting to keep the campaign totals `raised` and `released` by adding up those rows. ADR 0001 settled the broader question: the contract is the source of truth. This record applies it to the two fields most likely to be "helpfully" recomputed in the database.

The relevant code is `fetchCampaigns` and `upsertCampaign`: for every campaign touched by a page of events, the indexer calls `get_campaign` on the contract and copies `raised`, `released`, `milestones_released`, `milestones`, `status`, `goal` and identity fields into `campaigns`. The history tables are never summed into those columns.

## Decision

- `campaigns.raised`, `campaigns.released`, `campaigns.milestones_released` and `campaigns.status` are copied from the contract on every update. Do not compute them from `donations`, `refunds` or `milestone_releases`, in SQL or in application code.
- The history tables exist for timelines and the CSV export, not for balances. `/stats` sums them only for platform-wide activity counts, where the contract has no equivalent aggregate.
- A donation or release event is a signal that a campaign changed, not the bookkeeping entry for the total. The indexer re-reads the campaign whenever such an event arrives and persists the contract's answer.

## Benefits

- A missed, duplicated or reordered event cannot make the displayed total drift from the chain. Replaying a page is harmless because `upsertCampaign` uses `ON CONFLICT DO UPDATE`.
- The numbers match what the contract reports even for activity that happened before this indexer started, as long as the campaign is re-read.
- Gap recovery (see [the runbook](../RUNBOOK.md)) restores current totals by re-fetching `get_campaign` for every known campaign, without having to reconstruct arithmetic from partial history.
- There is one definition of a campaign's balance — the contract's — so the API and any other client cannot disagree about how to sum events, treat refunds, or handle a milestone paid by an emergency advance.

## Known gaps

- **History can have holes after gap recovery.** When the stored cursor falls out of RPC retention, missed events cannot be replayed. Recovery restores current campaign state but cannot recreate the individual `donations`, `refunds` or `milestone_releases` rows from the gap. Totals are right; timelines and CSV export for that period are not.
- **Only campaigns already in the `campaigns` table are resynchronised during recovery.** A campaign created entirely inside the gap is unknown to the database and is not discovered until a later indexed event touches it.
- **A failed per-campaign lookup during recovery is skipped**, logged, and corrected only when a later event touches that campaign. Until then its stored totals may be stale.
- **Totals lag the chain by up to one poll.** They reflect the last successful `get_campaign` read, so immediately after an on-chain action `/health` and `/stats` can briefly show the previous values.
- **Corrupted contract totals are reproduced faithfully.** If the contract itself reports a wrong value, the backend will show it. Fixing that requires a contract change, not an indexer change.
- **RPC history is finite.** Campaigns whose only activity lies outside the RPC retention window cannot be rebuilt into a fresh database at all. See [DEPLOYMENT.md](../DEPLOYMENT.md) for seeding options.

## Consequences

- Every page with events costs one contract simulation per touched campaign. That is acceptable at current volume and buys correctness that event arithmetic cannot provide.
- Contributors must not "fix" a total that looks wrong by adding up history rows. Investigate the contract read and the indexer logs instead.
