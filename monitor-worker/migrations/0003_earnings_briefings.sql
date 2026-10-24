PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS earnings_forecasts (
  id TEXT PRIMARY KEY,
  forecast_key TEXT NOT NULL UNIQUE,
  ticker TEXT NOT NULL,
  cik TEXT NOT NULL,
  fiscal_period TEXT NOT NULL,
  expected_window_start TEXT NOT NULL,
  expected_window_end TEXT NOT NULL,
  window_confidence REAL NOT NULL CHECK (window_confidence >= 0 AND window_confidence <= 1),
  information_cutoff_at TEXT NOT NULL,
  forecast_method TEXT NOT NULL,
  revenue_estimate REAL,
  revenue_unit TEXT,
  eps_estimate REAL,
  eps_unit TEXT,
  basis_json TEXT NOT NULL,
  source_quality TEXT NOT NULL,
  notes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'awaiting_actual', 'resolved', 'expired')),
  actual_event_id TEXT,
  actual_accession TEXT,
  actual_filed_at TEXT,
  actual_revenue REAL,
  actual_eps REAL,
  revenue_error_pct REAL,
  eps_error REAL,
  resolution_notes TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (actual_event_id) REFERENCES events(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS earnings_forecasts_ticker_status_idx
  ON earnings_forecasts (ticker, status, expected_window_end);

CREATE INDEX IF NOT EXISTS earnings_forecasts_created_idx
  ON earnings_forecasts (created_at DESC);

CREATE TABLE IF NOT EXISTS earnings_forecast_evidence (
  id TEXT PRIMARY KEY,
  forecast_id TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  accession TEXT NOT NULL,
  form TEXT NOT NULL,
  filed_at TEXT NOT NULL,
  report_period TEXT NOT NULL,
  fiscal_year INTEGER,
  fiscal_period TEXT,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  metric_unit TEXT NOT NULL,
  source_url TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (forecast_id, evidence_key),
  FOREIGN KEY (forecast_id) REFERENCES earnings_forecasts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS earnings_forecast_evidence_forecast_idx
  ON earnings_forecast_evidence (forecast_id, metric_name, filed_at);

CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  briefing_key TEXT NOT NULL UNIQUE,
  briefing_type TEXT NOT NULL CHECK (briefing_type IN ('morning', 'after_close')),
  session_date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  information_cutoff_at TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated',
  event_count INTEGER NOT NULL DEFAULT 0,
  p0_count INTEGER NOT NULL DEFAULT 0,
  p1_count INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS briefings_session_idx
  ON briefings (session_date DESC, briefing_type);

CREATE TABLE IF NOT EXISTS briefing_outbox (
  id TEXT PRIMARY KEY,
  briefing_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (briefing_id, channel, recipient),
  FOREIGN KEY (briefing_id) REFERENCES briefings(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS briefing_outbox_delivery_idx
  ON briefing_outbox (status, next_attempt_at, scheduled_for, created_at);

CREATE TRIGGER IF NOT EXISTS earnings_forecasts_prevent_delete
BEFORE DELETE ON earnings_forecasts
BEGIN
  SELECT RAISE(ABORT, 'earnings forecast ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS earnings_forecasts_protect_frozen_input
BEFORE UPDATE ON earnings_forecasts
WHEN
  NEW.id IS NOT OLD.id OR
  NEW.forecast_key IS NOT OLD.forecast_key OR
  NEW.ticker IS NOT OLD.ticker OR
  NEW.cik IS NOT OLD.cik OR
  NEW.fiscal_period IS NOT OLD.fiscal_period OR
  NEW.expected_window_start IS NOT OLD.expected_window_start OR
  NEW.expected_window_end IS NOT OLD.expected_window_end OR
  NEW.window_confidence IS NOT OLD.window_confidence OR
  NEW.information_cutoff_at IS NOT OLD.information_cutoff_at OR
  NEW.forecast_method IS NOT OLD.forecast_method OR
  NEW.revenue_estimate IS NOT OLD.revenue_estimate OR
  NEW.revenue_unit IS NOT OLD.revenue_unit OR
  NEW.eps_estimate IS NOT OLD.eps_estimate OR
  NEW.eps_unit IS NOT OLD.eps_unit OR
  NEW.basis_json IS NOT OLD.basis_json OR
  NEW.source_quality IS NOT OLD.source_quality OR
  NEW.notes IS NOT OLD.notes OR
  NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'frozen earnings forecast input is immutable');
END;

CREATE TRIGGER IF NOT EXISTS earnings_forecasts_protect_resolution
BEFORE UPDATE ON earnings_forecasts
WHEN OLD.status = 'resolved'
BEGIN
  SELECT RAISE(ABORT, 'resolved earnings forecast is immutable');
END;

CREATE TRIGGER IF NOT EXISTS earnings_forecasts_status_transition
BEFORE UPDATE OF status ON earnings_forecasts
WHEN NOT (
  NEW.status = OLD.status OR
  (OLD.status = 'open' AND NEW.status IN ('awaiting_actual', 'resolved', 'expired')) OR
  (OLD.status = 'awaiting_actual' AND NEW.status IN ('resolved', 'expired'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid earnings forecast status transition');
END;

CREATE TRIGGER IF NOT EXISTS earnings_forecast_evidence_prevent_delete
BEFORE DELETE ON earnings_forecast_evidence
BEGIN
  SELECT RAISE(ABORT, 'earnings forecast evidence is append-only');
END;

CREATE TRIGGER IF NOT EXISTS earnings_forecast_evidence_prevent_update
BEFORE UPDATE ON earnings_forecast_evidence
BEGIN
  SELECT RAISE(ABORT, 'earnings forecast evidence is immutable');
END;

CREATE TRIGGER IF NOT EXISTS briefings_prevent_delete
BEFORE DELETE ON briefings
BEGIN
  SELECT RAISE(ABORT, 'briefing ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS briefings_prevent_update
BEFORE UPDATE ON briefings
BEGIN
  SELECT RAISE(ABORT, 'briefing record is immutable');
END;

CREATE TRIGGER IF NOT EXISTS briefing_outbox_prevent_delete
BEFORE DELETE ON briefing_outbox
BEGIN
  SELECT RAISE(ABORT, 'briefing outbox is append-only');
END;

CREATE TRIGGER IF NOT EXISTS briefing_outbox_protect_frozen_input
BEFORE UPDATE ON briefing_outbox
WHEN
  NEW.id IS NOT OLD.id OR
  NEW.briefing_id IS NOT OLD.briefing_id OR
  NEW.channel IS NOT OLD.channel OR
  NEW.recipient IS NOT OLD.recipient OR
  NEW.subject IS NOT OLD.subject OR
  NEW.text_body IS NOT OLD.text_body OR
  NEW.html_body IS NOT OLD.html_body OR
  NEW.scheduled_for IS NOT OLD.scheduled_for OR
  NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'frozen briefing email input is immutable');
END;
