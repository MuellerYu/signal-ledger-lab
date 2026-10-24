/**
 * Membership reads.
 *
 * Reads go through the caller-supplied membership D1 (see lib/membership-db),
 * never the generic market database, so this module cannot be pointed at the
 * live market schema by accident.
 */

import type { SubscriptionRecord } from "./entitlement";
import type { MinimalD1Database } from "./d1";

type SubscriptionRow = {
  id: string;
  user_id: string;
  plan: string;
  status: string;
  access_until: string | null;
  cancel_at_period_end: number;
  cancel_at: string | null;
  billing_interval: string | null;
  currency: string | null;
};

const toRecord = (row: SubscriptionRow): SubscriptionRecord => ({
  id: row.id,
  userId: row.user_id,
  plan: row.plan,
  status: row.status,
  accessUntil: row.access_until,
  cancelAtPeriodEnd: row.cancel_at_period_end === 1,
  cancelAt: row.cancel_at,
  billingInterval: row.billing_interval,
  currency: row.currency,
});

/** Every subscription for a user. resolveEntitlement decides what it means. */
export async function readUserSubscriptions(d1: MinimalD1Database, userId: string): Promise<SubscriptionRecord[]> {
  const rows = await d1
    .prepare(
      `SELECT id, user_id, plan, status, access_until, cancel_at_period_end, cancel_at, billing_interval, currency
         FROM subscriptions WHERE user_id = ?`,
    )
    .bind(userId)
    .all<SubscriptionRow>();
  return (rows.results ?? []).map(toRecord);
}
