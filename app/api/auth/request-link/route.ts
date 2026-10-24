import { getMembershipD1 } from "@/lib/membership-db";
import { authSecrets, clientIpHmac, userAgent, authFromAddress } from "@/lib/auth-config";
import { requestMagicLink } from "@/lib/auth-flow";
import { nudgeServiceEmailFlush } from "@/lib/service-email";
import { AUTH_NO_STORE_HEADERS } from "@/lib/session-cookie";

export const dynamic = "force-dynamic";

/**
 * Requests a sign-in link.
 *
 * The response is identical whether the address is deliverable, already has an
 * account, is unusable, or is rate-limited — so this endpoint cannot be used to
 * discover who is registered. The timing is not claimed to be byte-identical;
 * the status and body are.
 */
export async function POST(request: Request) {
  const respond = () =>
    Response.json({ status: "check_your_email" }, { status: 200, headers: AUTH_NO_STORE_HEADERS });

  const payload = (await request.json().catch(() => null)) as { email?: string } | null;
  const email = String(payload?.email ?? "");

  const d1 = getMembershipD1();
  const secrets = authSecrets();
  if (!d1 || !secrets.linkDerivation || !secrets.sessionSigning || !secrets.rateLimit) {
    // Misconfiguration must not look like a delivered email, but it also must
    // not leak which addresses exist.
    return Response.json({ error: "auth is not configured" }, { status: 503, headers: AUTH_NO_STORE_HEADERS });
  }

  const now = new Date();
  const outcome = await requestMagicLink(d1, secrets, {
    email,
    ipHmac: await clientIpHmac(request, secrets),
    userAgent: userAgent(request),
    nowIso: now.toISOString(),
    nowMs: now.getTime(),
    fromAddress: authFromAddress(),
  });

  // A suppressed request (unusable or rate-limited address) enqueued nothing,
  // so there is no job to flush. Otherwise, nudge the Worker so the waiting
  // user does not sit out a cron interval. The nudge is awaited with a short
  // timeout and swallows its own failure: delivery is best-effort, the outbox
  // row stays queued for retry, and the response below is identical either way.
  if (!outcome.suppressed) {
    await nudgeServiceEmailFlush();
  }

  return respond();
}
