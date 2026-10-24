-- Additive only. Apply to the isolated sandbox membership DB first.
CREATE TABLE whop_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('monthly','annual')),
  membership_id TEXT UNIQUE,
  checkout_id TEXT UNIQUE,
  checkout_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','paid')),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX whop_pending_order ON whop_orders(user_id, plan_id) WHERE status = 'pending';
CREATE INDEX whop_orders_user ON whop_orders(user_id);
-- Paid periods, keyed by payment: retries cannot add another month/year.
CREATE TABLE whop_payments (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES whop_orders(id),
  paid_at TEXT NOT NULL,
  access_until TEXT NOT NULL,
  refunded INTEGER NOT NULL DEFAULT 0 CHECK (refunded IN (0,1)),
  updated_at TEXT NOT NULL
);
CREATE INDEX whop_payments_membership ON whop_payments(membership_id, refunded, access_until);
-- Orders and payments establish identity; membership events only alter state.
ALTER TABLE subscriptions ADD COLUMN whop_state_at TEXT;
