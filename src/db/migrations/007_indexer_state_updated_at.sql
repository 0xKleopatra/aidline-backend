-- Readiness checks need to know when the indexer last committed a page.
-- No default: a row that has never been written by the indexer stays NULL.
ALTER TABLE indexer_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
