import { cookies } from "next/headers";

import { authSecrets } from "./auth-config";
import { resolveSession } from "./auth-flow";
import { resolveEntitlement, type Entitlement } from "./entitlement";
import { getMembershipD1 } from "./membership-db";
import { SESSION_COOKIE } from "./session-cookie";
import { readUserSubscriptions } from "./subscriptions";

/**
 * The server-side access layer behind the paywall.
 *
 * These are the only helpers that decide "what can this request see". They read
 * the same session cookie, session store and subscription rows as the account
 * pages, and they never read a header, a query string or anything the browser
 * controls — so a forged client cannot upgrade itself. They deliberately contain
 * no billing-provider logic: a future Paddle layer grants a subscription row,
 * and `resolveEntitlement` already turns that row into PRO here.
 */

export type AccessUser = {
  id: string;
  email: string;
  emailVerified: boolean;
};

const ANONYMOUS: Entitlement = {
  tier: "FREE",
  reason: "anonymous",
  accessUntil: null,
  subscriptionId: null,
  cancelAtPeriodEnd: false,
  cancelAt: null,
};

/**
 * Resolve the signed-in user from the session cookie, or null when anonymous,
 * unauthenticated, or when the membership database is not bound.
 */
export async function getCurrentUser(): Promise<AccessUser | null> {
  const d1 = getMembershipD1();
  const secrets = authSecrets();
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;

  if (!d1 || !secrets.sessionSigning || !token) return null;

  const now = new Date();
  const resolved = await resolveSession(d1, {
    sessionToken: token,
    nowIso: now.toISOString(),
    nowMs: now.getTime(),
  });
  if (!resolved) return null;

  return {
    id: resolved.user.id,
    email: resolved.user.email,
    emailVerified: resolved.user.email_verified === 1,
  };
}

/**
 * The resolved FREE/PRO entitlement for the current request. Anonymous and
 * unauthenticated visitors resolve to a FREE "anonymous" entitlement — never
 * null — so callers can branch on `tier` without null checks.
 */
export async function getCurrentEntitlement(): Promise<Entitlement> {
  const d1 = getMembershipD1();
  const secrets = authSecrets();
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;

  if (!d1 || !secrets.sessionSigning || !token) return ANONYMOUS;

  const now = new Date();
  const resolved = await resolveSession(d1, {
    sessionToken: token,
    nowIso: now.toISOString(),
    nowMs: now.getTime(),
  });
  if (!resolved) return ANONYMOUS;

  const subscriptions = await readUserSubscriptions(d1, resolved.user.id);
  return resolveEntitlement({
    user: { id: resolved.user.id, emailVerified: resolved.user.email_verified === 1 },
    subscriptions,
    now: now.getTime(),
  });
}

/** The authenticated user, or null. Named for parity with `requirePro`. */
export async function requireAuthenticatedUser(): Promise<AccessUser | null> {
  return getCurrentUser();
}

/** True only for a verified PRO subscription still inside its access window. */
export async function requirePro(): Promise<boolean> {
  const entitlement = await getCurrentEntitlement();
  return entitlement.tier === "PRO";
}

/**
 * Pick the response shape for the current entitlement. Both arguments are
 * already computed, so this never re-derives anything and never branches on
 * provider state. Pass a teaser and the full value; FREE gets the teaser.
 */
export function teaserOrPro<T>(entitlement: Entitlement, teaser: T, full: T): T {
  return entitlement.tier === "PRO" ? full : teaser;
}

/** The canonical "this needs PRO" response shared by every gated endpoint. */
export function upgradeRequired(pricingPath = "/pricing") {
  return Response.json(
    {
      schema: "signal-ledger.access.v1",
      error: "upgrade_required",
      message: "This content is part of Signal Ledger PRO.",
      pricing: pricingPath,
    },
    { status: 402, headers: { "Cache-Control": "no-store" } },
  );
}
