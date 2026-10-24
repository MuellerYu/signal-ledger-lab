-- The post-close intelligence brief records what it concluded about the
-- session, not just the text it sent. Regime, theme and a body hash are what
-- the next day's five-session context and the duplicate guard read back.
ALTER TABLE briefings ADD COLUMN regime TEXT;
--> statement-breakpoint
ALTER TABLE briefings ADD COLUMN dominant_theme TEXT;
--> statement-breakpoint
ALTER TABLE briefings ADD COLUMN body_hash TEXT;
--> statement-breakpoint
ALTER TABLE briefings ADD COLUMN engine_version TEXT;
--> statement-breakpoint
ALTER TABLE briefings ADD COLUMN send_id TEXT;
