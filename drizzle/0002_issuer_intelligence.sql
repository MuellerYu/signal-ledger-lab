CREATE TABLE IF NOT EXISTS issuer_profiles (
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS issuer_profiles_cik_unique ON issuer_profiles(cik);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS issuer_profile_securities (
  ticker TEXT PRIMARY KEY NOT NULL,
  issuer_id TEXT NOT NULL REFERENCES issuer_profiles(issuer_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS issuer_profile_securities_issuer_idx ON issuer_profile_securities(issuer_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS issuer_ai_usage (
  issuer_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  role TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (issuer_id, usage_date, role)
);
