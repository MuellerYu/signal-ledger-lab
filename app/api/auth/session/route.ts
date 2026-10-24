import { authSecrets } from "@/lib/auth-config";
import { resolveSession } from "@/lib/auth-flow";
import { resolveEntitlement } from "@/lib/entitlement";
import { getMembershipD1 } from "@/lib/membership-db";
import { AUTH_NO_STORE_HEADERS, SESSION_COOKIE, readCookie } from "@/lib/session-cookie";
import { readUserSubscriptions } from "@/lib/subscriptions";

export const dynamic = "force-dynamic";

/**
 * Who the caller is, and what they may access.
 *
 * This is the server-side seam the paywall will use: the answer comes from the
 * session record and the subscription rows, never from the browser.
 */
export async function GET(request: Request) {
  const d1 = getMembershipD1();
  const secrets = authSecrets();
  if (!d1 || !secrets.sessionSigning) {
    return Response.json({ authenticated: false, tier: "FREE", reason: "unavailable" }, { status: 503, headers: AUTH_NO_STORE_HEADERS });
  }

  const now = new Date();
  const resolved = await resolveSession(d1, {
    sessionToken: readCookie(request, SESSION_COOKIE),
    nowIso: now.toISOString(),
    nowMs: now.getTime(),
  });

  if (!resolved) {
    return Response.json({ authenticated: false, tier: "FREE", reason: "anonymous" }, { status: 200, headers: AUTH_NO_STORE_HEADERS });
  }

  const subscriptions = await readUserSubscriptions(d1, resolved.user.id);
  const entitlement = resolveEntitlement({
    user: { id: resolved.user.id, emailVerified: resolved.user.email_verified === 1 },
    subscriptions,
    now: now.getTime(),
  });

  return Response.json(
    {
      authenticated: true,
      email: resolved.user.email,
      emailVerified: resolved.user.email_verified === 1,
      tier: entitlement.tier,
      reason: entitlement.reason,
      accessUntil: entitlement.accessUntil,
      cancelAtPeriodEnd: entitlement.cancelAtPeriodEnd,
      cancelAt: entitlement.cancelAt,
      session: { expiresAt: resolved.session.expires_at, absoluteExpiresAt: resolved.session.absolute_expires_at },
    },
    { status: 200, headers: AUTH_NO_STORE_HEADERS },
  );
}
