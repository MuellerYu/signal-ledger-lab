-- Canonical post-close Daily Brief artifact storage, on top of
-- 0019_daily_brief_fanout.sql.
--
-- The canonical post-close brief is authored once by the price-first research
-- pipeline (market data + news + valuation), rendered once, and then fanned out
-- to the owner and every eligible PRO subscriber without regeneration. This
-- table is the durable store for that ONE rendered artifact per session, so a
-- fan-out that fails partway can be reconstructed from the authoritative render
-- instead of re-running research (which would have no deterministic market data
-- after the window and could produce a different brief).
--
-- One row per session, keyed by session_date, upserted (never appended) by the
-- scheduled briefing source once generation succeeds. The fan-out only reads
-- from here; it never writes, so it cannot invent research content.

CREATE TABLE IF NOT EXISTS daily_brief_artifacts (
  session_date TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS daily_brief_artifacts_imported_idx
  ON daily_brief_artifacts (imported_at);
