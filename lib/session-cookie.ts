/**
 * Cookie plumbing for first-party auth.
 *
 * Sessions and the pending-auth handoff are both HttpOnly, Secure, SameSite=Lax
 * and never readable from JavaScript — `localStorage` is not used for auth
 * anywhere in this codebase.
 *
 * Lax rather than Strict is deliberate: arriving from an email client is a
 * cross-site navigation, and Strict would drop the cookie on exactly the
 * request that needs it.
 */

export const SESSION_COOKIE = "sl_session";
export const PENDING_AUTH_COOKIE = "sl_magic_pending";

type CookieOptions = {
  maxAgeSeconds: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
};

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    `SameSite=${options.sameSite ?? "Lax"}`,
  ];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure !== false) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, path = "/"): string {
  return `${name}=; Path=${path}; Max-Age=0; SameSite=Lax; HttpOnly; Secure`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

/** Headers every response in the auth flow carries. */
export const AUTH_NO_STORE_HEADERS: Record<string, string> = {
  // The verification URL contains a token; keep it out of referrers and caches.
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};
