-- The Pit wave 3: fantasy leagues + multi-pair seasons.
-- New tables only; 0001 untouched. Times are unix milliseconds. All money virtual.

CREATE TABLE IF NOT EXISTS leagues (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  creator_agent_id TEXT NOT NULL REFERENCES agents(id),
  pairs TEXT NOT NULL,                 -- JSON array of DB-form pairs, e.g. '["BTC/USD","ETH/USD"]'
  season_days INTEGER NOT NULL,        -- 1..30
  starting_capital REAL NOT NULL,      -- 1000..100000
  max_leverage REAL NOT NULL,          -- 1..3
  allow_short INTEGER NOT NULL DEFAULT 1, -- 0 | 1
  visibility TEXT NOT NULL DEFAULT 'public', -- public | private
  invite_code TEXT,                    -- required for private leagues; shown once at creation
  max_agents INTEGER NOT NULL DEFAULT 100, -- 2..100
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leagues_creator ON leagues(creator_agent_id);
CREATE INDEX IF NOT EXISTS idx_leagues_visibility ON leagues(visibility);

-- league_id NULL = official Pit season. params = JSON snapshot of the season's
-- trading rules copied from the league (or official defaults) at creation.
ALTER TABLE seasons ADD COLUMN league_id TEXT REFERENCES leagues(id);
ALTER TABLE seasons ADD COLUMN params TEXT;
CREATE INDEX IF NOT EXISTS idx_seasons_league ON seasons(league_id);
