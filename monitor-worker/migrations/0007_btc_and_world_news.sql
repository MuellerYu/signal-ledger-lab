PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS btc_market_snapshots (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL DEFAULT 'BTC-USD',
  observed_at TEXT NOT NULL UNIQUE,
  price REAL NOT NULL CHECK (price > 0),
  open_24h REAL,
  high_24h REAL,
  low_24h REAL,
  change_24h_pct REAL,
  volume_24h_btc REAL,
  volume_24h_usd REAL,
  volume_30d_btc REAL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS btc_market_snapshots_observed_idx
  ON btc_market_snapshots (observed_at DESC);

CREATE TABLE IF NOT EXISTS btc_daily_candles (
  day TEXT PRIMARY KEY,
  product_id TEXT NOT NULL DEFAULT 'BTC-USD',
  open REAL NOT NULL CHECK (open > 0),
  high REAL NOT NULL CHECK (high > 0),
  low REAL NOT NULL CHECK (low > 0),
  close REAL NOT NULL CHECK (close > 0),
  volume_btc REAL NOT NULL CHECK (volume_btc >= 0),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS btc_daily_candles_day_idx
  ON btc_daily_candles (day DESC);

CREATE TABLE IF NOT EXISTS btc_30d_forecasts (
  id TEXT PRIMARY KEY,
  forecast_date TEXT NOT NULL UNIQUE,
  baseline_price REAL NOT NULL CHECK (baseline_price > 0),
  target_date TEXT NOT NULL,
  target_price REAL NOT NULL CHECK (target_price > 0),
  predicted_return_pct REAL NOT NULL,
  research_low REAL NOT NULL CHECK (research_low > 0),
  research_high REAL NOT NULL CHECK (research_high > 0),
  stance TEXT NOT NULL CHECK (stance IN ('bullish', 'neutral', 'bearish')),
  thesis TEXT NOT NULL,
  drivers_json TEXT NOT NULL,
  invalidation_condition TEXT NOT NULL,
  feature_snapshot_json TEXT NOT NULL,
  model_version TEXT NOT NULL,
  source_json TEXT NOT NULL,
  information_cutoff_at TEXT NOT NULL,
  frozen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS btc_30d_forecasts_target_idx
  ON btc_30d_forecasts (target_date, frozen_at DESC);

CREATE TABLE IF NOT EXISTS btc_forecast_path (
  id TEXT PRIMARY KEY,
  forecast_id TEXT NOT NULL,
  target_date TEXT NOT NULL,
  day_offset INTEGER NOT NULL CHECK (day_offset BETWEEN 0 AND 30),
  predicted_price REAL NOT NULL CHECK (predicted_price > 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (forecast_id)
    REFERENCES btc_30d_forecasts(id) ON DELETE RESTRICT,
  UNIQUE (forecast_id, target_date)
);

CREATE INDEX IF NOT EXISTS btc_forecast_path_target_idx
  ON btc_forecast_path (forecast_id, target_date);

CREATE TABLE IF NOT EXISTS btc_forecast_actuals (
  id TEXT PRIMARY KEY,
  forecast_id TEXT NOT NULL,
  target_date TEXT NOT NULL,
  actual_close REAL NOT NULL CHECK (actual_close > 0),
  error_amount REAL NOT NULL,
  error_pct REAL NOT NULL,
  absolute_error_pct REAL NOT NULL CHECK (absolute_error_pct >= 0),
  direction_hit INTEGER CHECK (direction_hit IN (0, 1)),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (forecast_id)
    REFERENCES btc_30d_forecasts(id) ON DELETE RESTRICT,
  UNIQUE (forecast_id, target_date)
);

CREATE INDEX IF NOT EXISTS btc_forecast_actuals_forecast_idx
  ON btc_forecast_actuals (forecast_id, target_date);

CREATE TABLE IF NOT EXISTS world_news (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL UNIQUE,
  region TEXT NOT NULL
    CHECK (region IN ('US', 'JP', 'KR', 'CN', 'GLOBAL')),
  market_scope TEXT NOT NULL,
  category TEXT NOT NULL,
  importance_score INTEGER NOT NULL
    CHECK (importance_score BETWEEN 1 AND 100),
  headline TEXT NOT NULL,
  fact_summary_zh TEXT NOT NULL,
  commentary_zh TEXT NOT NULL,
  impact_path_zh TEXT NOT NULL,
  verification_zh TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS world_news_region_published_idx
  ON world_news (region, published_at DESC);

CREATE INDEX IF NOT EXISTS world_news_importance_idx
  ON world_news (importance_score DESC, published_at DESC);

CREATE TRIGGER IF NOT EXISTS btc_30d_forecasts_prevent_update
BEFORE UPDATE ON btc_30d_forecasts
BEGIN
  SELECT RAISE(ABORT, 'frozen BTC forecast is immutable');
END;

CREATE TRIGGER IF NOT EXISTS btc_30d_forecasts_prevent_delete
BEFORE DELETE ON btc_30d_forecasts
BEGIN
  SELECT RAISE(ABORT, 'BTC forecast is append-only');
END;

CREATE TRIGGER IF NOT EXISTS btc_forecast_path_prevent_update
BEFORE UPDATE ON btc_forecast_path
BEGIN
  SELECT RAISE(ABORT, 'BTC forecast path is immutable');
END;

CREATE TRIGGER IF NOT EXISTS btc_forecast_path_prevent_delete
BEFORE DELETE ON btc_forecast_path
BEGIN
  SELECT RAISE(ABORT, 'BTC forecast path is append-only');
END;

CREATE TRIGGER IF NOT EXISTS btc_forecast_actuals_prevent_update
BEFORE UPDATE ON btc_forecast_actuals
BEGIN
  SELECT RAISE(ABORT, 'BTC forecast actual is append-only');
END;

CREATE TRIGGER IF NOT EXISTS btc_forecast_actuals_prevent_delete
BEFORE DELETE ON btc_forecast_actuals
BEGIN
  SELECT RAISE(ABORT, 'BTC forecast actual is append-only');
END;
