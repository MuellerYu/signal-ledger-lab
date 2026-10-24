-- Current calendar facts are separate from immutable prediction snapshots.
CREATE TABLE IF NOT EXISTS earnings_calendar (
  ticker TEXT NOT NULL,
  fiscal_period TEXT NOT NULL,
  announcement_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ticker, fiscal_period)
);
