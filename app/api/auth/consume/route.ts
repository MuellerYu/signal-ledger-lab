import { getMembershipD1 } from "@/lib/membership-db";
import { authSecrets, userAgent } from "@/lib/auth-config";
import { consumeMagicLink, readPendingAuthCookie } from "@/lib/auth-flow";
import { SESSION_ABSOLUTE_TTL_MS } from "@/lib/auth-tokens";
import { AUTH_NO_STORE_HEADERS, PENDING_AUTH_COOKIE, SESSION_COOKIE, clearCookie, readCookie, serializeCookie } from "@/lib/session-cookie";

export const dynamic = "force-dynamic";

/**
 * The one place a magic link is actually spent.
 *
 * A POST because it changes state, and because only a deliberate action should
 * be able to sign someone in — a scanner following the GET interstitial gets a
 * button, not a session. The claim is a single conditional UPDATE, so a replayed
 * POST loses the race and is refused rather than granting a second sign-in.
 */
export async function POST(request: Request) {
  const to = (path: string, cookies: string[]) => {
    const headers = new Headers(AUTH_NO_STORE_HEADERS);
    headers.set("Location", new URL(path, new URL(request.url).origin).toString());
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 303, headers });
  };

  const d1 = getMembershipD1();
  const secrets = authSecrets();
  if (!d1 || !secrets.sessionSigning) {
    return to("/auth/continue?status=unavailable", [clearCookie(PENDING_AUTH_COOKIE)]);
  }

  const now = new Date();
  const outcome = await consumeMagicLink(d1, secrets, {
    pendingCookie: readCookie(request, PENDING_AUTH_COOKIE),
    nowIso: now.toISOString(),
    nowMs: now.getTime(),
    userAgent: userAgent(request),
  });

  if (!outcome.ok) {
    return to(`/auth/continue?status=${outcome.reason}`, [clearCookie(PENDING_AUTH_COOKIE)]);
  }

  return to("/account", [
    serializeCookie(SESSION_COOKIE, outcome.sessionToken, {
      maxAgeSeconds: Math.floor(SESSION_ABSOLUTE_TTL_MS / 1_000),
    }),
    clearCookie(PENDING_AUTH_COOKIE),
  ]);
}

/** Lets the interstitial report whether a validated link is still waiting. */
export async function GET(request: Request) {
  const secrets = authSecrets();
  const pending = await readPendingAuthCookie(secrets, readCookie(request, PENDING_AUTH_COOKIE), Date.now());
  return Response.json({ pending: pending !== null }, { status: 200, headers: AUTH_NO_STORE_HEADERS });
}
