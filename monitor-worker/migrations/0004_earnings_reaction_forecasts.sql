PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS earnings_consensus_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_key TEXT NOT NULL UNIQUE,
  ticker TEXT NOT NULL,
  fiscal_period TEXT NOT NULL,
  provider TEXT NOT NULL,
  as_of_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  revenue_consensus REAL,
  revenue_unit TEXT,
  eps_consensus REAL,
  eps_unit TEXT,
  analyst_count INTEGER,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS earnings_consensus_ticker_period_idx
  ON earnings_consensus_snapshots (ticker, fiscal_period, as_of_at DESC);

CREATE TABLE IF NOT EXISTS earnings_reaction_forecasts (
  id TEXT PRIMARY KEY,
  forecast_key TEXT NOT NULL UNIQUE,
  financial_forecast_id TEXT NOT NULL,
  consensus_snapshot_id TEXT,
  ticker TEXT NOT NULL,
  fiscal_period TEXT NOT NULL,
  release_window_start TEXT NOT NULL,
  release_window_end TEXT NOT NULL,
  release_window_basis TEXT NOT NULL,
  information_cutoff_at TEXT NOT NULL,
  target_definition TEXT NOT NULL,
  threshold_up REAL NOT NULL,
  threshold_down REAL NOT NULL,
  benchmark TEXT NOT NULL,
  probability_up REAL NOT NULL CHECK (probability_up >= 0 AND probability_up <= 1),
  probability_base REAL NOT NULL CHECK (probability_base >= 0 AND probability_base <= 1),
  probability_down REAL NOT NULL CHECK (probability_down >= 0 AND probability_down <= 1),
  predicted_direction TEXT NOT NULL
    CHECK (predicted_direction IN ('up', 'down', 'uncertain')),
  expected_relative_return REAL,
  reaction_low REAL,
  reaction_high REAL,
  reaction_range_basis TEXT NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
  model_confidence TEXT NOT NULL CHECK (model_confidence IN ('low', 'medium', 'high')),
  model_version TEXT NOT NULL,
  consensus_status TEXT NOT NULL
    CHECK (consensus_status IN ('available', 'unavailable')),
  key_drivers_json TEXT NOT NULL,
  invalidation_condition TEXT NOT NULL,
  feature_snapshot_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'expired')),
  actual_event_id TEXT,
  actual_relative_return REAL,
  actual_outcome TEXT CHECK (actual_outcome IN ('up', 'base', 'down')),
  brier_score REAL,
  direction_hit INTEGER CHECK (direction_hit IN (0, 1)),
  interval_hit INTEGER CHECK (interval_hit IN (0, 1)),
  resolution_notes TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (ABS(probability_up + probability_base + probability_down - 1.0) < 0.000001),
  CHECK (threshold_down < threshold_up),
  CHECK (reaction_low IS NULL OR reaction_high IS NULL OR reaction_low <= reaction_high),
  FOREIGN KEY (financial_forecast_id) REFERENCES earnings_forecasts(id) ON DELETE RESTRICT,
  FOREIGN KEY (consensus_snapshot_id) REFERENCES earnings_consensus_snapshots(id) ON DELETE RESTRICT,
  FOREIGN KEY (actual_event_id) REFERENCES events(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS earnings_reaction_ticker_status_idx
  ON earnings_reaction_forecasts (ticker, status, release_window_end);

CREATE INDEX IF NOT EXISTS earnings_reaction_financial_idx
  ON earnings_reaction_forecasts (financial_forecast_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS earnings_consensus_prevent_delete
BEFORE DELETE ON earnings_consensus_snapshots
BEGIN
  SELECT RAISE(ABORT, 'earnings consensus snapshot is append-only');
END;

CREATE TRIGGER IF NOT EXISTS earnings_consensus_prevent_update
BEFORE UPDATE ON earnings_consensus_snapshots
BEGIN
  SELECT RAISE(ABORT, 'earnings consensus snapshot is immutable');
END;

CREATE TRIGGER IF NOT EXISTS earnings_reaction_prevent_delete
BEFORE DELETE ON earnings_reaction_forecasts
BEGIN
  SELECT RAISE(ABORT, 'earnings reaction forecast is append-only');
END;

CREATE TRIGGER IF NOT EXISTS earnings_reaction_protect_frozen_input
BEFORE UPDATE ON earnings_reaction_forecasts
WHEN
  NEW.id IS NOT OLD.id OR
  NEW.forecast_key IS NOT OLD.forecast_key OR
  NEW.financial_forecast_id IS NOT OLD.financial_forecast_id OR
  NEW.consensus_snapshot_id IS NOT OLD.consensus_snapshot_id OR
  NEW.ticker IS NOT OLD.ticker OR
  NEW.fiscal_period IS NOT OLD.fiscal_period OR
  NEW.release_window_start IS NOT OLD.release_window_start OR
  NEW.release_window_end IS NOT OLD.release_window_end OR
  NEW.release_window_basis IS NOT OLD.release_window_basis OR
  NEW.information_cutoff_at IS NOT OLD.information_cutoff_at OR
  NEW.target_definition IS NOT OLD.target_definition OR
  NEW.threshold_up IS NOT OLD.threshold_up OR
  NEW.threshold_down IS NOT OLD.threshold_down OR
  NEW.benchmark IS NOT OLD.benchmark OR
  NEW.probability_up IS NOT OLD.probability_up OR
  NEW.probability_base IS NOT OLD.probability_base OR
  NEW.probability_down IS NOT OLD.probability_down OR
  NEW.predicted_direction IS NOT OLD.predicted_direction OR
  NEW.expected_relative_return IS NOT OLD.expected_relative_return OR
  NEW.reaction_low IS NOT OLD.reaction_low OR
  NEW.reaction_high IS NOT OLD.reaction_high OR
  NEW.reaction_range_basis IS NOT OLD.reaction_range_basis OR
  NEW.sample_size IS NOT OLD.sample_size OR
  NEW.model_confidence IS NOT OLD.model_confidence OR
  NEW.model_version IS NOT OLD.model_version OR
  NEW.consensus_status IS NOT OLD.consensus_status OR
  NEW.key_drivers_json IS NOT OLD.key_drivers_json OR
  NEW.invalidation_condition IS NOT OLD.invalidation_condition OR
  NEW.feature_snapshot_json IS NOT OLD.feature_snapshot_json OR
  NEW.input_hash IS NOT OLD.input_hash OR
  NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'frozen earnings reaction input is immutable');
END;

CREATE TRIGGER IF NOT EXISTS earnings_reaction_protect_resolution
BEFORE UPDATE ON earnings_reaction_forecasts
WHEN OLD.status = 'resolved'
BEGIN
  SELECT RAISE(ABORT, 'resolved earnings reaction forecast is immutable');
END;

CREATE TRIGGER IF NOT EXISTS earnings_reaction_status_transition
BEFORE UPDATE OF status ON earnings_reaction_forecasts
WHEN NOT (
  NEW.status = OLD.status OR
  (OLD.status = 'open' AND NEW.status IN ('resolved', 'expired'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid earnings reaction status transition');
END;
