-- Stripe scheduled cancellation (cancel_at) on top of 0017_stripe_status.sql.
--
-- Stripe represents a scheduled cancellation two ways:
--   1. cancel_at_period_end = true — cancel at the end of the current period.
--   2. cancel_at = <future unix> — cancel at a specific future date. This
--      arrives alongside cancel_at_period_end = false, so relying on
--      cancel_at_period_end alone hides the scheduled cancellation.
--
-- 0017 already stores cancel_at_period_end; this adds cancel_at so the account
-- page can render "Cancels on <date>" for representation 2. The column is
-- purely informational — entitlement is decided by access_until, never by
-- cancel_at — so a nullable additive column needs no table rebuild.

ALTER TABLE subscriptions ADD COLUMN cancel_at TEXT;
