/**
 * The single answer to "what can this user access".
 *
 * Pure and synchronous: it takes a user and that user's subscription rows and
 * returns a verdict. It does not read cookies, headers, redirects, browser
 * state, `site_access_requests`, or any payment provider — which is what makes
 * it testable before a payment provider exists, and impossible to bypass with a
 * forged header.
 *
 * Access is decided by `access_until`, never by `status` alone. That one choice
 * gives canceled-but-paid-through, past-due grace, and the WeChat one-time
 * annual grant the same code path. It is also what keeps Stripe's unpaid /
 * incomplete / incomplete_expired states safe: those are stored with a NULL
 * `access_until`, so they can never satisfy the "future access_until" test and
 * therefore never grant PRO.
 */

export type Plan = "PRO";

export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "expired"
  | "paused"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid";

export type SubscriptionRecord = {
  id: string;
  userId: string;
  plan: string;
  status: SubscriptionStatus | string;
  accessUntil: string | null;
  cancelAtPeriodEnd: boolean;
  /** Scheduled-cancellation timestamp, or null. Informational only. */
  cancelAt: string | null;
  billingInterval?: string | null;
  currency?: string | null;
};

export type EntitlementUser = {
  id: string;
  emailVerified: boolean;
} | null;

export type EntitlementTier = "FREE" | "PRO";

export type EntitlementReason =
  | "anonymous"
  | "email_unverified"
  | "no_active_subscription"
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "expired"
  | "paused"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid";

export type Entitlement = {
  tier: EntitlementTier;
  reason: EntitlementReason;
  /** The end of granted access, when there is any. */
  accessUntil: string | null;
  subscriptionId: string | null;
  /** Reported for the account page. Never used to decide present access. */
  cancelAtPeriodEnd: boolean;
  /** Scheduled-cancellation timestamp (Stripe `cancel_at`), or null. Informational only. */
  cancelAt: string | null;
};

const FREE = (reason: EntitlementReason): Entitlement => ({
  tier: "FREE",
  reason,
  accessUntil: null,
  subscriptionId: null,
  cancelAtPeriodEnd: false,
  cancelAt: null,
});

export function resolveEntitlement(input: {
  user: EntitlementUser;
  subscriptions: readonly SubscriptionRecord[];
  now?: number;
}): Entitlement {
  const now = input.now ?? Date.now();

  // No identity, no entitlement.
  if (!input.user) return FREE("anonymous");

  // PRO requires a verified account. A subscription does not rescue an
  // unverified one — that ordering is deliberate.
  if (!input.user.emailVerified) return FREE("email_unverified");

  const granting = input.subscriptions.filter((subscription) => {
    if (subscription.plan !== "PRO") return false;
    if (subscription.status === "expired") return false;
    if (subscription.accessUntil === null) return false;
    const until = Date.parse(subscription.accessUntil);
    return Number.isFinite(until) && until > now;
  });

  if (granting.length === 0) return FREE("no_active_subscription");

  // Latest access wins. `cancel_at_period_end` is intentionally not consulted:
  // it describes whether the next period will be charged, not whether this one
  // is still paid for.
  const winner = granting.reduce((best, candidate) =>
    Date.parse(candidate.accessUntil as string) > Date.parse(best.accessUntil as string) ? candidate : best,
  );

  return {
    tier: "PRO",
    reason: winner.status as EntitlementReason,
    accessUntil: winner.accessUntil,
    subscriptionId: winner.id,
    cancelAtPeriodEnd: winner.cancelAtPeriodEnd,
    cancelAt: winner.cancelAt,
  };
}

export function isPro(entitlement: Entitlement): boolean {
  return entitlement.tier === "PRO";
}
