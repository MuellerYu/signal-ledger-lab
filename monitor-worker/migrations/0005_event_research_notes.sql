PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS event_research_notes (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  research_key TEXT NOT NULL UNIQUE,
  ticker TEXT NOT NULL,
  document_type TEXT NOT NULL,
  document_url TEXT NOT NULL,
  source_url TEXT NOT NULL,
  information_cutoff_at TEXT NOT NULL,
  headline TEXT NOT NULL,
  key_metrics_json TEXT NOT NULL,
  key_points_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'limited', 'failed')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS event_research_notes_event_idx
  ON event_research_notes (event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS event_research_notes_ticker_idx
  ON event_research_notes (ticker, created_at DESC);

CREATE TRIGGER IF NOT EXISTS event_research_notes_prevent_delete
BEFORE DELETE ON event_research_notes
BEGIN
  SELECT RAISE(ABORT, 'event research note is append-only');
END;

CREATE TRIGGER IF NOT EXISTS event_research_notes_prevent_update
BEFORE UPDATE ON event_research_notes
BEGIN
  SELECT RAISE(ABORT, 'event research note is immutable');
END;
