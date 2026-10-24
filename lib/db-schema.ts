/**
 * Runtime D1 bootstrap statements.
 *
 * Sites applies checked-in Drizzle migrations in hosted environments. These
 * idempotent statements keep local/preview D1 bindings usable before a formal
 * deployment migration has run. Each string is exactly one SQL statement.
 */
export const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS securities (
    id TEXT PRIMARY KEY NOT NULL,
    ticker TEXT NOT NULL,
    issuer_name TEXT NOT NULL,
    exchange TEXT,
    asset_type TEXT NOT NULL DEFAULT 'equity',
    cik TEXT,
    sector TEXT,
    theme TEXT,
    watch_tier INTEGER NOT NULL DEFAULT 2 CHECK (watch_tier BETWEEN 0 AND 3),
    benchmark TEXT NOT NULL DEFAULT 'SPY',
    factors_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS securities_ticker_unique
    ON securities (ticker)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS securities_cik_unique
    ON securities (cik)`,
  `CREATE INDEX IF NOT EXISTS securities_tier_enabled_idx
    ON securities (watch_tier, enabled)`,
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    reliability_tier INTEGER NOT NULL CHECK (reliability_tier BETWEEN 1 AND 4),
    base_url TEXT,
    poll_interval_sec INTEGER NOT NULL DEFAULT 300,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'needs_refresh',
    last_success_at_ms INTEGER,
    last_error TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sources_enabled_idx
    ON sources (enabled)`,
  `CREATE TABLE IF NOT EXISTS collector_states (
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    stream_key TEXT NOT NULL,
    cursor TEXT,
    etag TEXT,
    last_modified TEXT,
    last_seen_source_at_ms INTEGER,
    last_success_at_ms INTEGER,
    locked_until_ms INTEGER,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    UNIQUE (source_id, stream_key)
  )`,
  `CREATE INDEX IF NOT EXISTS collector_states_due_idx
    ON collector_states (locked_until_ms, last_success_at_ms)`,
  `CREATE TABLE IF NOT EXISTS ingestion_runs (
    id TEXT PRIMARY KEY NOT NULL,
    collector_key TEXT NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'running',
    started_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    fetched_count INTEGER NOT NULL DEFAULT 0,
    new_events INTEGER NOT NULL DEFAULT 0,
    alerts_queued INTEGER NOT NULL DEFAULT 0,
    alerts_sent INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    message TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS ingestion_runs_started_idx
    ON ingestion_runs (started_at_ms)`,
  `CREATE INDEX IF NOT EXISTS ingestion_runs_status_idx
    ON ingestion_runs (status)`,
  `CREATE TABLE IF NOT EXISTS raw_items (
    id TEXT PRIMARY KEY NOT NULL,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    external_id TEXT NOT NULL,
    canonical_url TEXT,
    canonical_url_hash TEXT,
    title TEXT NOT NULL,
    excerpt TEXT,
    source_published_at_ms INTEGER,
    source_updated_at_ms INTEGER,
    first_seen_at_ms INTEGER NOT NULL,
    last_seen_at_ms INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE (source_id, external_id)
  )`,
  `CREATE INDEX IF NOT EXISTS raw_items_published_idx
    ON raw_items (source_published_at_ms)`,
  `CREATE INDEX IF NOT EXISTS raw_items_content_hash_idx
    ON raw_items (content_hash)`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY NOT NULL,
    event_fingerprint TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    raw_item_id TEXT REFERENCES raw_items(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'P2',
    headline TEXT NOT NULL,
    summary TEXT,
    source_url TEXT,
    effective_at_ms INTEGER,
    first_published_at_ms INTEGER,
    first_seen_at_ms INTEGER NOT NULL,
    last_material_update_at_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    fact_status TEXT NOT NULL DEFAULT 'confirmed',
    materiality INTEGER NOT NULL DEFAULT 3 CHECK (materiality BETWEEN 1 AND 5),
    confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence BETWEEN 0 AND 1),
    novelty REAL NOT NULL DEFAULT 1 CHECK (novelty BETWEEN 0 AND 1),
    material_revision INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_seen_priority_idx
    ON events (first_seen_at_ms, priority)`,
  `CREATE INDEX IF NOT EXISTS events_type_idx
    ON events (event_type)`,
  `CREATE TABLE IF NOT EXISTS event_securities (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
    security_id TEXT NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,
    relationship TEXT NOT NULL DEFAULT 'direct',
    directness REAL NOT NULL DEFAULT 1,
    impact_direction TEXT NOT NULL DEFAULT 'unknown',
    mapping_confidence REAL NOT NULL DEFAULT 1,
    UNIQUE (event_id, security_id, relationship)
  )`,
  `CREATE INDEX IF NOT EXISTS event_securities_security_idx
    ON event_securities (security_id, event_id)`,
  `CREATE TABLE IF NOT EXISTS forecasts (
    id TEXT PRIMARY KEY NOT NULL,
    ledger_seq INTEGER NOT NULL UNIQUE,
    security_id TEXT NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,
    ticker TEXT NOT NULL,
    event_id TEXT REFERENCES events(id) ON DELETE RESTRICT,
    forecast_type TEXT NOT NULL DEFAULT 'pre_event',
    target_definition TEXT NOT NULL,
    hypothesis TEXT,
    direction TEXT NOT NULL,
    probability_up REAL NOT NULL CHECK (probability_up BETWEEN 0 AND 1),
    probability_base REAL NOT NULL CHECK (probability_base BETWEEN 0 AND 1),
    probability_down REAL NOT NULL CHECK (probability_down BETWEEN 0 AND 1),
    probabilities_json TEXT NOT NULL,
    horizon TEXT NOT NULL,
    resolution_at_ms INTEGER,
    resolution_criteria TEXT,
    benchmark TEXT NOT NULL DEFAULT 'SPY',
    return_low REAL,
    return_high REAL,
    rationale TEXT,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    invalidation_condition TEXT,
    model_version TEXT NOT NULL DEFAULT 'manual-v1',
    slot_code TEXT NOT NULL DEFAULT 'MANUAL',
    eligibility TEXT NOT NULL DEFAULT 'official',
    status TEXT NOT NULL DEFAULT 'open',
    created_at_ms INTEGER NOT NULL,
    frozen_at_ms INTEGER NOT NULL,
    information_cutoff_at_ms INTEGER NOT NULL,
    prev_chain_hash TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    chain_hash TEXT NOT NULL UNIQUE,
    CHECK (abs(probability_up + probability_base + probability_down - 1.0) < 0.000001)
  )`,
  `CREATE INDEX IF NOT EXISTS forecasts_ticker_status_idx
    ON forecasts (ticker, status)`,
  `CREATE INDEX IF NOT EXISTS forecasts_frozen_idx
    ON forecasts (frozen_at_ms)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS forecasts_official_slot_unique
    ON forecasts (security_id, event_id, slot_code)
    WHERE eligibility = 'official' AND event_id IS NOT NULL`,
  `CREATE TRIGGER IF NOT EXISTS forecasts_prevent_update
    BEFORE UPDATE ON forecasts
    BEGIN
      SELECT RAISE(ABORT, 'forecast ledger is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS forecasts_prevent_delete
    BEFORE DELETE ON forecasts
    BEGIN
      SELECT RAISE(ABORT, 'forecast ledger is immutable');
    END`,
  `CREATE TABLE IF NOT EXISTS actuals (
    id TEXT PRIMARY KEY NOT NULL,
    forecast_id TEXT NOT NULL REFERENCES forecasts(id) ON DELETE RESTRICT,
    outcome_key TEXT,
    actual_value REAL,
    actual_return REAL,
    benchmark_return REAL,
    relative_return REAL,
    observed_at_ms INTEGER NOT NULL,
    available_at_ms INTEGER NOT NULL,
    source_id TEXT REFERENCES sources(id) ON DELETE RESTRICT,
    source_url TEXT,
    revision_no INTEGER NOT NULL DEFAULT 1,
    basis TEXT NOT NULL DEFAULT 'first_reported',
    created_at_ms INTEGER NOT NULL,
    UNIQUE (forecast_id, revision_no)
  )`,
  `CREATE INDEX IF NOT EXISTS actuals_available_idx
    ON actuals (available_at_ms)`,
  `CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY NOT NULL,
    forecast_id TEXT NOT NULL REFERENCES forecasts(id) ON DELETE RESTRICT,
    actual_id TEXT NOT NULL REFERENCES actuals(id) ON DELETE RESTRICT,
    evaluation_version TEXT NOT NULL DEFAULT 'v1',
    brier_score REAL,
    log_loss REAL,
    mae REAL,
    interval_covered INTEGER,
    direction_hit INTEGER,
    baseline_brier REAL,
    brier_skill REAL,
    evaluated_at_ms INTEGER NOT NULL,
    UNIQUE (forecast_id, evaluation_version)
  )`,
  `CREATE INDEX IF NOT EXISTS evaluations_evaluated_idx
    ON evaluations (evaluated_at_ms)`,
  `CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY NOT NULL,
    event_id TEXT REFERENCES events(id) ON DELETE RESTRICT,
    recipient TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'email',
    priority TEXT NOT NULL,
    policy_version TEXT NOT NULL DEFAULT 'alert-v1',
    material_revision INTEGER NOT NULL DEFAULT 1,
    dedupe_key TEXT NOT NULL UNIQUE,
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER,
    provider_id TEXT,
    source_to_seen_ms INTEGER,
    seen_to_send_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    sent_at_ms INTEGER,
    last_error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS alerts_status_next_attempt_idx
    ON alerts (status, next_attempt_at_ms)`,
  `CREATE INDEX IF NOT EXISTS alerts_created_idx
    ON alerts (created_at_ms)`,
  `CREATE TABLE IF NOT EXISTS site_access_requests (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
    approval_token_hash TEXT NOT NULL UNIQUE,
    requested_at_ms INTEGER NOT NULL,
    email_sent_at_ms INTEGER,
    decided_at_ms INTEGER,
    decided_by_email TEXT,
    decision_note TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS site_access_requests_status_requested_idx
    ON site_access_requests (status, requested_at_ms)`,
  `CREATE TABLE IF NOT EXISTS issuer_profiles (
    issuer_id TEXT PRIMARY KEY NOT NULL,
    canonical_name TEXT NOT NULL,
    tickers_json TEXT NOT NULL,
    cik TEXT,
    valuation_family TEXT NOT NULL,
    business_model TEXT NOT NULL,
    segment_structure_json TEXT NOT NULL,
    driver_schema_json TEXT NOT NULL,
    preferred_models_json TEXT NOT NULL,
    rejected_models_json TEXT NOT NULL,
    peer_group_json TEXT NOT NULL,
    profile_source TEXT NOT NULL,
    profile_version TEXT NOT NULL,
    classification_confidence REAL NOT NULL,
    last_ai_reviewed_at_ms INTEGER,
    material_change_hash TEXT NOT NULL,
    investment_question TEXT NOT NULL,
    thesis_summary TEXT NOT NULL,
    risk_summary TEXT NOT NULL,
    business_model_summary TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS issuer_profiles_cik_unique
    ON issuer_profiles (cik)`,
  `CREATE TABLE IF NOT EXISTS issuer_profile_securities (
    ticker TEXT PRIMARY KEY NOT NULL,
    issuer_id TEXT NOT NULL REFERENCES issuer_profiles(issuer_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS issuer_profile_securities_issuer_idx
    ON issuer_profile_securities (issuer_id)`,
  `CREATE TABLE IF NOT EXISTS issuer_ai_usage (
    issuer_id TEXT NOT NULL,
    usage_date TEXT NOT NULL,
    role TEXT NOT NULL,
    call_count INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (issuer_id, usage_date, role)
  )`,
  // Forward-validation store for published valuations.
  `CREATE TABLE IF NOT EXISTS valuation_backtests (
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
  )`,
  `CREATE INDEX IF NOT EXISTS valuation_backtests_ticker_date_idx
    ON valuation_backtests (ticker, valuation_date)`,
] as const;
