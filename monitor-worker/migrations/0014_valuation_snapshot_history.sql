-- Valuation snapshot history (append-only).
--
-- The canonical valuation engine stays the single producer of fair values and
-- lives with the Pages app; this table only records what the monitor worker
-- actually saw when it read the canonical endpoint after a session closed.
-- Nothing here computes a valuation, so there is never a second engine.
--
-- It exists so a session can be compared against a real prior session. Before
-- it, the brief compared a snapshot against itself and printed a flat +0.00%,
-- which claimed a comparison that had not happened.
--
-- Nothing stock prices: price lives in `events` and the market-data sources,
-- and the columns below are the valuation view only.
CREATE TABLE IF NOT EXISTS valuation_snapshot_history (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  session_date TEXT NOT NULL,
  captured_at TEXT NOT NULL,

  fair_value REAL,
  fair_value_low REAL,
  fair_value_high REAL,
  current_price REAL,

  rating TEXT,
  confidence REAL,
  model_family TEXT,
  model_version TEXT,

  model_input_hash TEXT,
  thesis_hash TEXT,
  valuation_updated_at TEXT,

  -- The canonical endpoint's own result, verbatim, so an input change can be
  -- explained later without re-running the engine.
  snapshot_json TEXT NOT NULL,

  -- One snapshot per instrument per session: a retry of the same session is
  -- the same observation, and INSERT OR IGNORE keeps it that way.
  UNIQUE (ticker, session_date)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS valuation_snapshot_history_ticker_session_idx
  ON valuation_snapshot_history (ticker, session_date DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS valuation_snapshot_history_session_idx
  ON valuation_snapshot_history (session_date DESC);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS valuation_snapshot_history_prevent_update
BEFORE UPDATE ON valuation_snapshot_history
BEGIN
  SELECT RAISE(ABORT, 'valuation snapshot history is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS valuation_snapshot_history_prevent_delete
BEFORE DELETE ON valuation_snapshot_history
BEGIN
  SELECT RAISE(ABORT, 'valuation snapshot history is append-only');
END;
