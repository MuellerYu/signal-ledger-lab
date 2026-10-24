import { getMembershipD1 } from "@/lib/membership-db";
import { signOutSession } from "@/lib/auth-flow";
import { AUTH_NO_STORE_HEADERS, SESSION_COOKIE, clearCookie, readCookie } from "@/lib/session-cookie";

export const dynamic = "force-dynamic";

/** Revokes the session server-side and clears the cookie. */
export async function POST(request: Request) {
  const d1 = getMembershipD1();
  const token = readCookie(request, SESSION_COOKIE);
  if (d1 && token) await signOutSession(d1, token, new Date().toISOString());

  const headers = new Headers(AUTH_NO_STORE_HEADERS);
  headers.append("Set-Cookie", clearCookie(SESSION_COOKIE));
  headers.set("Location", new URL("/", new URL(request.url).origin).toString());
  return new Response(null, { status: 303, headers });
}
