-- PRO Daily Brief subscriber fan-out on top of 0018_cancel_at.sql.
--
-- The full post-close brief must reach every eligible PRO subscriber, not just
-- the owner. The owner copy drains through the market `briefing_outbox`; the
-- subscriber fan-out drains through the general service `email_outbox` (the
-- table the service-email flush already sends), because that queue is the one
-- keyed on the membership schema and carries a per-recipient dedup identity.
--
-- `email_outbox.kind` is a CHECK-restricted column, and `daily_brief` is a new
-- kind. SQLite cannot widen an inline CHECK in place, so the table is rebuilt
-- with `daily_brief` added to the allowed set, copying every column and the two
-- delivery/recipient indexes exactly as 0015 left them. Existing rows (pending
-- auth links, receipts, notices) are preserved verbatim; the kind set only
-- widens, so no existing row can violate the new CHECK.
--
-- Deterministic deduplication is the primary key itself: the fan-out writes
-- each recipient's job with id = sha256("daily-brief|<sessionDate>|<recipient>")
-- and INSERT OR IGNORE, so a retry of the same session can never enqueue the
-- same subscriber twice.

CREATE TABLE email_outbox_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('auth_magic_link','billing_receipt','account_notice','daily_brief')),
  recipient TEXT NOT NULL,
  from_address TEXT,
  subject TEXT NOT NULL,
  body_mode TEXT NOT NULL CHECK (body_mode IN ('stored','derived_auth_link')),
  text_body TEXT,
  html_body TEXT,
  payload_json TEXT,
  scheduled_for TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','expired','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  CHECK (
    (body_mode = 'stored' AND text_body IS NOT NULL AND html_body IS NOT NULL)
    OR
    (body_mode = 'derived_auth_link' AND text_body IS NULL AND html_body IS NULL AND payload_json IS NULL)
  )
);
--> statement-breakpoint
INSERT INTO email_outbox_new
  SELECT id, kind, recipient, from_address, subject, body_mode, text_body, html_body,
         payload_json, scheduled_for, expires_at, status, attempts, next_attempt_at,
         provider_message_id, last_error, created_at, updated_at, sent_at
  FROM email_outbox;
--> statement-breakpoint
DROP TABLE email_outbox;
--> statement-breakpoint
ALTER TABLE email_outbox_new RENAME TO email_outbox;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_outbox_delivery_idx
  ON email_outbox (status, next_attempt_at, scheduled_for);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_outbox_recipient_idx
  ON email_outbox (recipient, created_at DESC);
