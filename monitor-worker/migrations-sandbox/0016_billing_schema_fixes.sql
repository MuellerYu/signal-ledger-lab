-- Billing schema fixes on top of 0015_membership.sql.
--
-- Three additive changes, each needing a table rebuild because SQLite cannot
-- modify an inline CHECK constraint:
--
--   1. `subscriptions.status` gains 'paused'. Paddle's `paused` is NOT a
--      cancellation: the subscription can resume, and paid access must be kept
--      until `access_until`. Entitlement behaviour lives in the resolver
--      (unchanged): any status except 'expired' grants PRO while `access_until`
--      is still in the future — so a paused subscription keeps PRO for its
--      already-paid window and loses it when the window elapses. No extension
--      happens while paused.
--
--   2. A partial unique index on (provider, provider_transaction_id) backs the
--      webhook's one-time dedup: a single non-recurring payment can never
--      produce two rows, so it can never grant 365 days twice.
--
--   3. `billing_events.status` gains 'received'. The webhook claims an event
--      with `INSERT OR IGNORE … status 'received'` before applying it, so a
--      duplicate delivery of a processed event is a no-op and an event that
--      crashed mid-apply is reprocessed. That claim status must be a valid
--      value or the idempotency write silently inserts nothing.

-- ------------------------------------------------------------------ subscriptions

CREATE TABLE subscriptions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','trialing','past_due','canceled','expired','paused')),
  provider TEXT NOT NULL,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  provider_transaction_id TEXT,
  billing_interval TEXT CHECK (billing_interval IN ('month','year','one_time_365d')),
  currency TEXT NOT NULL,
  current_period_start TEXT,
  current_period_end TEXT,
  access_until TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  founding_member INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO subscriptions_new
  SELECT id, user_id, email, plan, status, provider, provider_customer_id,
         provider_subscription_id, provider_transaction_id, billing_interval,
         currency, current_period_start, current_period_end, access_until,
         cancel_at_period_end, founding_member, created_at, updated_at
  FROM subscriptions;
--> statement-breakpoint
DROP TABLE subscriptions;
--> statement-breakpoint
ALTER TABLE subscriptions_new RENAME TO subscriptions;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_sub_unique
  ON subscriptions (provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_transaction_unique
  ON subscriptions (provider, provider_transaction_id) WHERE provider_transaction_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id, access_until DESC);
--> statement-breakpoint

-- ------------------------------------------------------------------ billing_events

CREATE TABLE billing_events_new (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  provider_transaction_id TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('received','processed','ignored','error')),
  note TEXT
);
--> statement-breakpoint
INSERT INTO billing_events_new
  SELECT id, provider, event_type, provider_customer_id, provider_subscription_id,
         provider_transaction_id, received_at, processed_at, status, note
  FROM billing_events;
--> statement-breakpoint
DROP TABLE billing_events;
--> statement-breakpoint
ALTER TABLE billing_events_new RENAME TO billing_events;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS billing_events_subscription_idx ON billing_events (provider_subscription_id, received_at DESC);
