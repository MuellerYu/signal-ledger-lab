-- Stripe statuses on top of 0016_billing_schema_fixes.sql.
--
-- Stripe subscription statuses are a superset of what 0016 allows. Three of
-- them — incomplete, incomplete_expired, unpaid — describe a subscription that
-- has NOT earned access, and the local CHECK must be able to represent them
-- without silently mapping them to 'active' (which would mint PRO). The
-- entitlement resolver does not consult status directly: it grants PRO only for
-- a future `access_until`, and the Stripe sync sets `access_until` to NULL for
-- these three, so storing them is safe and still never grants.
--
-- This needs a table rebuild because SQLite cannot widen an inline CHECK
-- constraint in place. The rebuild copies every column and re-creates the two
-- provider-unique indexes and the user index exactly as 0016 left them.
--
-- Local/test only. Not applied to remote D1.

CREATE TABLE subscriptions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,
  plan TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','trialing','past_due','canceled','expired','paused','incomplete','incomplete_expired','unpaid')),
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
