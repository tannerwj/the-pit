-- Backfilled hourly history shares the quotes table with source='coinbase-backfill'.
-- Unique (pair, ts, source) makes the backfill INSERT OR IGNORE idempotent:
-- re-running never duplicates rows, and backfilled rows can never collide with
-- live 1-minute quotes (source='coinbase').
CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_pair_ts_source ON quotes(pair, ts, source);
