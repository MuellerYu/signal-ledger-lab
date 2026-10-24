import { getMembershipD1 } from "@/lib/membership-db";
import { authSecrets } from "@/lib/auth-config";
import { issuePendingAuth, validateMagicLink } from "@/lib/auth-flow";
import { PENDING_AUTH_TTL_MS } from "@/lib/auth-tokens";
import { AUTH_NO_STORE_HEADERS, PENDING_AUTH_COOKIE, serializeCookie } from "@/lib/session-cookie";

export const dynamic = "force-dynamic";

/**
 * The interstitial between the email and the sign-in.
 *
 * This is a GET, and GET must never authenticate anyone: mail scanners and link
 * previewers follow links in email, so consuming here would burn the link
 * before the human ever clicked it. All this does is validate the token, hand
 * back a short-lived signed cookie that identifies the link, and redirect to a
 * clean URL with no token in it.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";

  const to = (path: string, cookie?: string) => {
    const headers = new Headers(AUTH_NO_STORE_HEADERS);
    headers.set("Location", new URL(path, url.origin).toString());
    if (cookie) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 303, headers });
  };

  const d1 = getMembershipD1();
  const secrets = authSecrets();
  if (!d1 || !secrets.sessionSigning) return to("/auth/continue?status=unavailable");

  const pending = await validateMagicLink(d1, token, Date.now());
  if (!pending) return to("/auth/continue?status=invalid");

  const pendingCookie = await issuePendingAuth(secrets, pending.linkId, Date.now());
  return to(
    "/auth/continue",
    serializeCookie(PENDING_AUTH_COOKIE, pendingCookie, { maxAgeSeconds: Math.floor(PENDING_AUTH_TTL_MS / 1_000) }),
  );
}
