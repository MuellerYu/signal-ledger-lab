-- Canonical post-close Daily Brief artifact storage, on top of
-- 0019_daily_brief_fanout.sql.
--
-- The billing sandbox has no market schema (no `briefings`, no `briefing_outbox`,
-- no `events`, no valuation tables) and no Alpaca credentials, so the real
-- price-first pipeline cannot run here. The fan-out must therefore reuse the
-- canonical brief the real pipeline already produced, not rebuild a low-data one.
--
-- This table is the read-only store for that artifact. One row per session,
-- keyed by session_date, upserted by the gated import route. It is never written
-- by the fan-out itself: the fan-out only reads from here, so it cannot invent
-- research content.
--
-- Sandbox only. Not applied to production D1.

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
