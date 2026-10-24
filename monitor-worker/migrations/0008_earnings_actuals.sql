PRAGMA foreign_keys = ON;

-- Earnings actuals are facts, not forecast outputs.  Keeping them in a
-- separate table lets the dashboard update as soon as SEC Company Facts is
-- available even when a forecast is ineligible for scoring (for example, it
-- was frozen after the filing was already public).
CREATE TABLE IF NOT EXISTS earnings_actuals (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  fiscal_period TEXT NOT NULL,
  accession TEXT NOT NULL,
  event_id TEXT,
  available_at TEXT NOT NULL,
  revenue REAL,
  revenue_unit TEXT,
  eps REAL,
  eps_unit TEXT,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_quality TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (ticker, fiscal_period, accession),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS earnings_actuals_ticker_period_idx
  ON earnings_actuals (ticker, fiscal_period, available_at DESC);

CREATE INDEX IF NOT EXISTS earnings_actuals_accession_idx
  ON earnings_actuals (ticker, accession);
