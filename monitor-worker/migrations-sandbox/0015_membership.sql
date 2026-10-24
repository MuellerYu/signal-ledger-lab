-- Phase 2 membership: first-party identity, entitlement, and service email.
--
-- Design notes that the DDL below enforces rather than merely documents:
--
--   * Identity is first-party. `users` is keyed by our own id and a normalized
--     email; nothing here derives from the platform's oai-authenticated-*
--     headers, and `site_access_requests` is not consulted for entitlement.
--
--   * A raw magic-link token is never stored. `auth_magic_links` holds only
--     sha256(token); the token is re-derived by the worker at send time from
--     the email job id. `email_outbox` therefore has two body modes, and the
--     CHECK constraint makes it impossible to store a rendered body for an
--     auth-link job — the class of bug this schema exists to prevent.
--
--   * Entitlement is provider-neutral. Paddle is never named in `users`; the
--     provider mapping lives in `billing_customers`, so a second provider can
--     be added without touching identity or entitlement.
--
-- Not applied to remote D1 in Phase 2. Local only.

-- ------------------------------------------------------------------ identity

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,                    -- normalized: trim + lowercase, nothing else
  email_verified INTEGER NOT NULL DEFAULT 0,
  email_verified_at TEXT,
  display_name TEXT,
  -- Provenance only. An owner approval in the legacy table is NOT a user
  -- verification, so the importer records it here and never sets email_verified.
  legacy_site_access_status TEXT,
  legacy_imported_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);
--> statement-breakpoint

-- ------------------------------------------------------------------ magic links

CREATE TABLE IF NOT EXISTS auth_magic_links (
  id TEXT PRIMARY KEY,
  -- NULL while the address has no users row yet: the row is created at
  -- consumption, so an unverified request never becomes a permanent account.
  user_id TEXT REFERENCES users(id),
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,               -- sha256 only; the token itself is never stored
  purpose TEXT NOT NULL CHECK (purpose IN ('signin', 'verify_email')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,               -- created_at + 15 minutes
  consumed_at TEXT,                       -- set exactly once, by a conditional UPDATE
  attempt_count INTEGER NOT NULL DEFAULT 0,
  -- HMAC(rate_limit_secret, normalized_ip): not reversible to an IP without the
  -- server-side secret, so this table is not an IP log.
  requested_ip_hmac TEXT,
  requested_user_agent TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS auth_magic_links_token_hash_unique ON auth_magic_links (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_magic_links_email_idx ON auth_magic_links (email, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_magic_links_ip_idx ON auth_magic_links (requested_ip_hmac, created_at DESC);
--> statement-breakpoint

-- ------------------------------------------------------------------ sessions

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_token_hash TEXT NOT NULL,       -- sha256 of the cookie value, never the value
  authenticated_at TEXT NOT NULL,         -- reserved for future recent-auth checks
  created_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,      -- created_at + 90 days; never extended
  expires_at TEXT NOT NULL,               -- rolling: min(now + 30d, absolute_expires_at)
  last_seen_at TEXT,
  revoked_at TEXT,
  user_agent TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS auth_sessions_token_hash_unique ON auth_sessions (session_token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, expires_at DESC);
--> statement-breakpoint

-- ------------------------------------------------------------------ billing (provider-neutral)

CREATE TABLE IF NOT EXISTS billing_customers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,                 -- 'paddle'; users is never coupled to a provider
  provider_customer_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS billing_customers_provider_customer_unique
  ON billing_customers (provider, provider_customer_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS billing_customers_user_provider_unique
  ON billing_customers (user_id, provider);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,
  plan TEXT NOT NULL,                     -- 'PRO'. FREE is the absence of a row.
  status TEXT NOT NULL CHECK (status IN ('active','trialing','past_due','canceled','expired')),
  provider TEXT NOT NULL,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  provider_transaction_id TEXT,
  -- 'one_time_365d' is the WeChat annual grant: a fixed 365 days, never recurring.
  billing_interval TEXT CHECK (billing_interval IN ('month','year','one_time_365d')),
  currency TEXT NOT NULL,                 -- display/record only; never gates entitlement
  current_period_start TEXT,
  current_period_end TEXT,
  access_until TEXT,                      -- the access arbiter for every status
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  founding_member INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_sub_unique
  ON subscriptions (provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id, access_until DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,                    -- provider event id: the idempotency key
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  provider_transaction_id TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('processed','ignored','error')),
  note TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS billing_events_subscription_idx ON billing_events (provider_subscription_id, received_at DESC);
--> statement-breakpoint

-- ------------------------------------------------------------------ email preferences

CREATE TABLE IF NOT EXISTS email_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  -- Opt-in. Creating an account subscribes nobody to the Daily Brief.
  daily_brief_enabled INTEGER NOT NULL DEFAULT 0,
  marketing_enabled INTEGER NOT NULL DEFAULT 0,
  -- Preference links are signed, not bearer tokens: the signature covers
  -- user_id + token_version, so bumping the version invalidates every old link.
  token_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint

-- ------------------------------------------------------------------ service email

-- The general service queue. The Daily Brief keeps its own briefing_outbox and
-- is untouched; both drain through the same sender in the worker.
--
-- body_mode exists because an auth email must not carry a rendered body: the
-- link contains a bearer token, and a stored body would put that token in D1.
-- For 'derived_auth_link' the worker re-derives the token from the job id at
-- send time, which is also what makes a retry safe.
CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('auth_magic_link','billing_receipt','account_notice')),
  recipient TEXT NOT NULL,
  from_address TEXT,                      -- resolved per kind; nullable until configured
  subject TEXT NOT NULL,
  body_mode TEXT NOT NULL CHECK (body_mode IN ('stored','derived_auth_link')),
  text_body TEXT,
  html_body TEXT,
  payload_json TEXT,
  scheduled_for TEXT NOT NULL,
  expires_at TEXT,                        -- a stale magic link must never be sent late
  status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','expired','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  -- The invariant, enforced by the database: a derived auth-link job has no
  -- stored body and no payload, so a raw token cannot reach a row.
  CHECK (
    (body_mode = 'stored' AND text_body IS NOT NULL AND html_body IS NOT NULL)
    OR
    (body_mode = 'derived_auth_link' AND text_body IS NULL AND html_body IS NULL AND payload_json IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_outbox_delivery_idx
  ON email_outbox (status, next_attempt_at, scheduled_for);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_outbox_recipient_idx
  ON email_outbox (recipient, created_at DESC);
