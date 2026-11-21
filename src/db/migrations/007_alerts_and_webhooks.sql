-- Migration 007: GDACS alerts and milestone-release webhooks.
--
-- Both features store their state in Postgres. Alerts are deduplicated by the
-- feed's stable <guid>, and webhook deliveries are deduplicated by the pair
-- (subscription, chain event id) so one milestone release can only ever fire
-- one delivery per subscriber, even if the indexer replays an event.

CREATE TABLE gdacs_alerts (
  id           TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('orange', 'red')),
  title        TEXT NOT NULL,
  location     TEXT,
  country      TEXT,
  url          TEXT,
  description  TEXT,
  published_at TIMESTAMPTZ,
  raw          JSONB NOT NULL DEFAULT '{}',
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX gdacs_alerts_recent_idx ON gdacs_alerts (published_at DESC NULLS LAST);

CREATE TABLE webhook_subscriptions (
  id          UUID PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, url)
);
CREATE INDEX webhook_subscriptions_campaign_idx ON webhook_subscriptions (campaign_id);

CREATE TABLE webhook_deliveries (
  id              UUID PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
  event_id        TEXT NOT NULL,
  campaign_id     BIGINT NOT NULL,
  payload         JSONB NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'delivered', 'failed')),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, event_id)
);
CREATE INDEX webhook_deliveries_due_idx
  ON webhook_deliveries (status, next_attempt_at);
