import { cookies } from "next/headers";

import { authSecrets } from "./auth-config";
import { resolveSession } from "./auth-flow";
import { isPro, resolveEntitlement } from "./entitlement";
import { getMembershipD1 } from "./membership-db";
import { SESSION_COOKIE } from "./session-cookie";
import { readUserSubscriptions } from "./subscriptions";

/**
 * The account state a page renders its header and account surfaces from.
 *
 * Resolved server-side from the session cookie — never from the browser — so a
 * cached or client-tampered value cannot grant anything. This is the exact same
 * path /api/auth/session uses, kept here so server components can read the same
 * answer without round-tripping to their own route.
 */
export type MemberState = {
  authenticated: boolean;
  userId: string | null;
  email: string | null;
  tier: "FREE" | "PRO";
};

const ANONYMOUS: MemberState = {
  authenticated: false,
  userId: null,
  email: null,
  tier: "FREE",
};

export async function resolveMember(): Promise<MemberState> {
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
  const entitlement = resolveEntitlement({
    user: { id: resolved.user.id, emailVerified: resolved.user.email_verified === 1 },
    subscriptions,
    now: now.getTime(),
  });

  return {
    authenticated: true,
    userId: resolved.user.id,
    email: resolved.user.email,
    tier: isPro(entitlement) ? "PRO" : "FREE",
  };
}
