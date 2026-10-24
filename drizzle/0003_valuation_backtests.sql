-- Minimal persistent store for future model validation. No dashboard reads it
-- yet: it exists so every published valuation can be graded later against the
-- forward price it actually produced.
CREATE TABLE IF NOT EXISTS valuation_backtests (
  snapshot_id TEXT PRIMARY KEY NOT NULL,
  ticker TEXT NOT NULL,
  sector TEXT,
  model_family TEXT NOT NULL,
  valuation_date TEXT NOT NULL,
  predicted_fair_value REAL,
  market_price_at_valuation REAL,
  price_12m_forward REAL,
  price_24m_forward REAL,
  absolute_error REAL,
  direction_correct INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS valuation_backtests_ticker_date_idx ON valuation_backtests (ticker, valuation_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS valuation_backtests_family_idx ON valuation_backtests (model_family);
