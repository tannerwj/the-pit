-- The Pit v0.1: initial D1 schema (paper-trading league)
-- All money is virtual. Times are unix milliseconds.

CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pair TEXT NOT NULL DEFAULT 'BTC/USD',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',        -- open | live | closed | settled
  market_type TEXT NOT NULL DEFAULT 'real',   -- real | synthetic(v0.2+)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seasons_status ON seasons(status, starts_at);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,          -- sha256 hex of the raw key; raw key shown once at registration
  status TEXT NOT NULL DEFAULT 'active',      -- active | banned
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_key ON agents(api_key_hash);

CREATE TABLE IF NOT EXISTS season_entries (
  id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  starting_capital REAL NOT NULL DEFAULT 10000,
  cash REAL NOT NULL DEFAULT 10000,
  status TEXT NOT NULL DEFAULT 'active',      -- active | liquidated | closed | banned
  entered_at INTEGER NOT NULL,
  UNIQUE(season_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_entries_season ON season_entries(season_id, status);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair TEXT NOT NULL,
  ts INTEGER NOT NULL,
  bid REAL NOT NULL,
  ask REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'coinbase'
);
CREATE INDEX IF NOT EXISTS idx_quotes_pair_ts ON quotes(pair, ts DESC);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL REFERENCES season_entries(id),
  pair TEXT NOT NULL,
  side TEXT NOT NULL,                         -- buy | sell
  qty REAL NOT NULL,                          -- base units (BTC), always positive
  type TEXT NOT NULL,                         -- market | limit
  limit_price REAL,                           -- required when type='limit'
  rationale TEXT NOT NULL,                    -- trade journal; empty => order rejected
  status TEXT NOT NULL DEFAULT 'open',        -- open | filled | cancelled
  created_at INTEGER NOT NULL,
  filled_at INTEGER,
  fill_price REAL,
  realized_pnl REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_orders_entry ON orders(entry_id, status, created_at);

CREATE TABLE IF NOT EXISTS positions (
  entry_id TEXT NOT NULL REFERENCES season_entries(id),
  pair TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,                -- signed base units; +long / -short
  avg_price REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entry_id, pair)
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL REFERENCES season_entries(id),
  ts INTEGER NOT NULL,
  equity REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equity_entry_ts ON equity_snapshots(entry_id, ts);

CREATE TABLE IF NOT EXISTS scores (
  entry_id TEXT PRIMARY KEY REFERENCES season_entries(id),
  total_return REAL NOT NULL,
  sharpe REAL NOT NULL,
  max_drawdown REAL NOT NULL,
  win_rate REAL NOT NULL,
  profit_factor REAL NOT NULL,
  alpha_score REAL NOT NULL,                  -- 0..100, see docs/ALPHA_SCORE.md
  rank INTEGER,
  computed_at INTEGER NOT NULL
);
