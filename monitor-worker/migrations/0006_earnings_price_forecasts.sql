PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS latest_quotes (
  ticker TEXT PRIMARY KEY,
  price REAL NOT NULL CHECK (price > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  quote_as_of_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_url TEXT NOT NULL,
  market_status TEXT NOT NULL,
  is_real_time INTEGER NOT NULL CHECK (is_real_time IN (0, 1)),
  delay_minutes INTEGER NOT NULL CHECK (delay_minutes >= 0),
  timestamp_basis TEXT NOT NULL,
  net_change REAL,
  percentage_change REAL,
  bid_price REAL,
  ask_price REAL,
  volume REAL,
  raw_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS latest_quotes_as_of_idx
  ON latest_quotes (quote_as_of_at DESC);

CREATE TABLE IF NOT EXISTS earnings_price_forecasts (
  id TEXT PRIMARY KEY,
  forecast_key TEXT NOT NULL UNIQUE,
  financial_forecast_id TEXT NOT NULL,
  reaction_forecast_id TEXT NOT NULL,
  supersedes_forecast_id TEXT,
  ticker TEXT NOT NULL,
  fiscal_period TEXT NOT NULL,
  earnings_date TEXT NOT NULL,
  release_timing TEXT NOT NULL
    CHECK (release_timing IN ('after_market_close', 'before_market_open')),
  target_session TEXT NOT NULL,
  settlement_due_at TEXT NOT NULL,
  reference_price REAL NOT NULL CHECK (reference_price > 0),
  reference_price_at TEXT NOT NULL,
  reference_quote_provider TEXT NOT NULL,
  reference_quote_is_real_time INTEGER NOT NULL
    CHECK (reference_quote_is_real_time IN (0, 1)),
  reference_quote_delay_minutes INTEGER NOT NULL
    CHECK (reference_quote_delay_minutes >= 0),
  predicted_post_price REAL NOT NULL CHECK (predicted_post_price > 0),
  predicted_change_pct REAL NOT NULL,
  forecast_stance TEXT NOT NULL
    CHECK (forecast_stance IN ('bullish', 'neutral', 'bearish')),
  forecast_role TEXT NOT NULL
    CHECK (forecast_role IN ('initial', 'revision', 'final')),
  thesis TEXT NOT NULL,
  key_drivers_json TEXT NOT NULL,
  information_cutoff_at TEXT NOT NULL,
  model_version TEXT NOT NULL,
  source_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (financial_forecast_id)
    REFERENCES earnings_forecasts(id) ON DELETE RESTRICT,
  FOREIGN KEY (reaction_forecast_id)
    REFERENCES earnings_reaction_forecasts(id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_forecast_id)
    REFERENCES earnings_price_forecasts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS earnings_price_forecasts_ticker_date_idx
  ON earnings_price_forecasts (ticker, earnings_date DESC);

CREATE INDEX IF NOT EXISTS earnings_price_forecasts_financial_idx
  ON earnings_price_forecasts
    (financial_forecast_id, information_cutoff_at DESC);

CREATE INDEX IF NOT EXISTS earnings_price_forecasts_due_idx
  ON earnings_price_forecasts (settlement_due_at);

CREATE TABLE IF NOT EXISTS earnings_price_forecast_settlements (
  id TEXT PRIMARY KEY,
  price_forecast_id TEXT NOT NULL UNIQUE,
  actual_post_price REAL NOT NULL CHECK (actual_post_price > 0),
  actual_price_at TEXT NOT NULL,
  actual_price_provider TEXT NOT NULL,
  actual_change_pct REAL NOT NULL,
  error_amount REAL NOT NULL,
  error_pct REAL NOT NULL,
  absolute_error_pct REAL NOT NULL CHECK (absolute_error_pct >= 0),
  direction_hit INTEGER NOT NULL CHECK (direction_hit IN (0, 1)),
  evaluated_at TEXT NOT NULL,
  quality_flag TEXT NOT NULL,
  source_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (price_forecast_id)
    REFERENCES earnings_price_forecasts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS earnings_price_settlements_evaluated_idx
  ON earnings_price_forecast_settlements (evaluated_at DESC);

CREATE TRIGGER IF NOT EXISTS earnings_price_forecasts_prevent_delete
BEFORE DELETE ON earnings_price_forecasts
BEGIN
  SELECT RAISE(ABORT, 'earnings price forecast is append-only');
END;

CREATE TRIGGER IF NOT EXISTS earnings_price_forecasts_prevent_update
BEFORE UPDATE ON earnings_price_forecasts
BEGIN
  SELECT RAISE(ABORT, 'frozen earnings price forecast is immutable');
END;

CREATE TRIGGER IF NOT EXISTS earnings_price_settlements_prevent_delete
BEFORE DELETE ON earnings_price_forecast_settlements
BEGIN
  SELECT RAISE(ABORT, 'earnings price settlement is append-only');
END;

CREATE TRIGGER IF NOT EXISTS earnings_price_settlements_prevent_update
BEFORE UPDATE ON earnings_price_forecast_settlements
BEGIN
  SELECT RAISE(ABORT, 'earnings price settlement is immutable');
END;
