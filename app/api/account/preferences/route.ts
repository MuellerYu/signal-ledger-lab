import { getCurrentUser } from "@/lib/access";
import { applyPreferenceChange, readEmailPreferences } from "@/lib/email-preferences";
import { getMembershipD1 } from "@/lib/membership-db";
import { AUTH_NO_STORE_HEADERS } from "@/lib/session-cookie";

export const dynamic = "force-dynamic";

/**
 * The account page's Daily Brief toggle.
 *
 * Authentication is the **session cookie** — the same credential
 * /api/billing/portal and every other account-scoped endpoint uses — because
 * this route is only ever called from /account, which already requires a
 * signed-in member.
 *
 * It deliberately does not require an `EMAIL_PREFERENCE_SECRET` signature. That
 * signature exists for the *unauthenticated* preference links we email out; on
 * /account the session is already the stronger credential, and requiring the
 * signature meant the toggle silently rendered disabled — and would have 403'd
 * even if it fired — on any deployment whose environment lacked that secret.
 * A missing secret must never turn a signed-in member's switch into dead UI.
 *
 * It writes only the preference columns: it never touches entitlement, billing,
 * or the account.
 */
export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as {
    daily_brief?: string;
  } | null;

  const user = await getCurrentUser();
  const d1 = getMembershipD1();

  if (!user || !d1) {
    return Response.json(
      { error: "sign_in_required" },
      { status: 401, headers: AUTH_NO_STORE_HEADERS },
    );
  }

  // An explicit "on"/"off" only. Anything else — a truncated body, a proxy
  // rewriting the request — is rejected rather than coerced, so a malformed
  // call can never be read as an unsubscribe.
  const requested = payload?.daily_brief;
  if (requested !== "on" && requested !== "off") {
    return Response.json(
      { error: "invalid_request" },
      { status: 400, headers: AUTH_NO_STORE_HEADERS },
    );
  }

  const current = await readEmailPreferences(d1, user.id);
  const updated = await applyPreferenceChange(
    d1,
    user.id,
    { dailyBriefEnabled: requested === "on", marketingEnabled: current.marketingEnabled },
    new Date().toISOString(),
  );

  return Response.json(
    {
      dailyBriefEnabled: updated.dailyBriefEnabled,
      marketingEnabled: updated.marketingEnabled,
    },
    { status: 200, headers: AUTH_NO_STORE_HEADERS },
  );
}
