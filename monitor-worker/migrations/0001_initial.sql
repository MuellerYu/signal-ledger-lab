PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS watchlist (
  symbol TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  cik TEXT,
  tier INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sec_forms TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS watchlist_active_tier_idx
  ON watchlist (active, tier, symbol);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  tier INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'starting',
  cursor TEXT,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_latency_ms INTEGER,
  items_seen INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sources_status_idx
  ON sources (enabled, required, status);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  sources_total INTEGER NOT NULL DEFAULT 0,
  sources_succeeded INTEGER NOT NULL DEFAULT 0,
  sources_failed INTEGER NOT NULL DEFAULT 0,
  events_seen INTEGER NOT NULL DEFAULT 0,
  events_new INTEGER NOT NULL DEFAULT 0,
  alerts_queued INTEGER NOT NULL DEFAULT 0,
  alerts_sent INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS runs_started_at_idx
  ON runs (started_at DESC);

CREATE TABLE IF NOT EXISTS run_sources (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  items_seen INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS run_sources_run_idx
  ON run_sources (run_id, started_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  event_type TEXT NOT NULL,
  headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  priority TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_tier INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  url TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence REAL NOT NULL,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (source_key, source_event_id)
);

CREATE INDEX IF NOT EXISTS events_detected_at_idx
  ON events (detected_at DESC);

CREATE INDEX IF NOT EXISTS events_ticker_published_idx
  ON events (ticker, published_at DESC);

CREATE INDEX IF NOT EXISTS events_priority_published_idx
  ON events (priority, published_at DESC);

CREATE TABLE IF NOT EXISTS forecasts (
  id TEXT PRIMARY KEY,
  event_id TEXT UNIQUE,
  forecast_key TEXT NOT NULL UNIQUE,
  ticker TEXT NOT NULL,
  forecast_type TEXT NOT NULL,
  target_definition TEXT NOT NULL,
  horizon TEXT NOT NULL,
  probability_up REAL NOT NULL,
  probability_base REAL NOT NULL,
  probability_down REAL NOT NULL,
  return_low REAL,
  return_high REAL,
  benchmark TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  information_cutoff_at TEXT NOT NULL,
  resolution_at TEXT NOT NULL,
  actual_outcome TEXT,
  relative_return REAL,
  brier_score REAL,
  direction_hit INTEGER,
  quality_flag TEXT,
  resolved_at TEXT,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS forecasts_status_created_idx
  ON forecasts (status, created_at DESC);

CREATE INDEX IF NOT EXISTS forecasts_resolution_idx
  ON forecasts (status, resolution_at);

CREATE TABLE IF NOT EXISTS forecast_evaluations (
  id TEXT PRIMARY KEY,
  forecast_id TEXT NOT NULL UNIQUE,
  evaluation_type TEXT NOT NULL,
  ticker_entry_price REAL,
  ticker_exit_price REAL,
  benchmark_entry_price REAL,
  benchmark_exit_price REAL,
  ticker_return REAL,
  benchmark_return REAL,
  relative_return REAL,
  actual_outcome TEXT NOT NULL,
  brier_score REAL NOT NULL,
  direction_hit INTEGER NOT NULL,
  event_count INTEGER,
  entry_session TEXT,
  exit_session TEXT,
  quality_flag TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  raw_json TEXT,
  FOREIGN KEY (forecast_id) REFERENCES forecasts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS forecast_evaluations_evaluated_idx
  ON forecast_evaluations (evaluated_at DESC);

CREATE TABLE IF NOT EXISTS alert_outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE (event_id, channel, recipient),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS alert_outbox_delivery_idx
  ON alert_outbox (status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS worker_locks (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO watchlist
  (symbol, company_name, cik, tier, active, sec_forms, keywords, created_at, updated_at)
VALUES
  ('ORCL', 'Oracle Corporation', '0001341439', 1, 1, '["8-K","10-K","10-Q","DEF 14A","SC 13D","SC 13G"]', '["cloud","AI","database","guidance"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('MSTR', 'Strategy Inc', '0001050446', 1, 1, '["8-K","10-K","10-Q","S-3","424B5","DEF 14A"]', '["bitcoin","BTC","convertible","offering"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('NVDA', 'NVIDIA Corporation', '0001045810', 1, 1, '["8-K","10-K","10-Q","DEF 14A","SC 13D","SC 13G"]', '["AI","GPU","data center","export controls"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('AMD', 'Advanced Micro Devices, Inc.', '0000002488', 1, 1, '["8-K","10-K","10-Q","DEF 14A","SC 13D","SC 13G"]', '["AI","GPU","CPU","data center"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('AVGO', 'Broadcom Inc.', '0001730168', 1, 1, '["8-K","10-K","10-Q","DEF 14A","SC 13D","SC 13G"]', '["AI","networking","VMware","semiconductor"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('TSM', 'Taiwan Semiconductor Manufacturing Company Limited', '0001046179', 1, 1, '["6-K","20-F","SC 13D","SC 13G"]', '["foundry","AI","capacity","geopolitical"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('MSFT', 'Microsoft Corporation', '0000789019', 1, 1, '["8-K","10-K","10-Q","DEF 14A","SC 13D","SC 13G"]', '["Azure","AI","OpenAI","cloud"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('GOOGL', 'Alphabet Inc.', '0001652044', 1, 1, '["8-K","10-K","10-Q","DEF 14A","SC 13D","SC 13G"]', '["AI","search","cloud","antitrust"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('AMZN', 'Amazon.com, Inc.', '0001018724', 1, 1, '["8-K","10-K","10-Q","DEF 14A","SC 13D","SC 13G"]', '["AWS","AI","cloud","retail"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('META', 'Meta Platforms, Inc.', '0001326801', 1, 1, '["8-K","10-K","10-Q","DEF 14A","SC 13D","SC 13G"]', '["AI","advertising","capex","regulation"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('SMCI', 'Super Micro Computer, Inc.', '0001375365', 1, 1, '["8-K","10-K","10-Q","NT 10-K","NT 10-Q","DEF 14A"]', '["AI server","auditor","restatement","filing delay"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('COIN', 'Coinbase Global, Inc.', '0001679788', 1, 1, '["8-K","10-K","10-Q","DEF 14A","SC 13D","SC 13G"]', '["crypto","bitcoin","SEC","regulation"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('AAPL', 'Apple Inc.', '0000320193', 2, 1, '["8-K","10-K","10-Q","DEF 14A"]', '["AI","iPhone","services","China"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('TSLA', 'Tesla, Inc.', '0001318605', 2, 1, '["8-K","10-K","10-Q","DEF 14A"]', '["deliveries","autonomy","robotaxi","margin"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('MU', 'Micron Technology, Inc.', '0000723125', 2, 1, '["8-K","10-K","10-Q","DEF 14A"]', '["HBM","memory","AI","pricing"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ARM', 'Arm Holdings plc', '0001973239', 2, 1, '["6-K","20-F","F-1","424B4"]', '["AI","CPU","royalty","mobile"]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
