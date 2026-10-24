/**
 * Server-side configuration for first-party auth.
 *
 * Everything here is read from server bindings only. None of it is ever
 * serialized into a page, a client component, or a `NEXT_PUBLIC_*` variable —
 * a missing secret yields an empty string, and the callers refuse to operate
 * rather than falling back to something guessable.
 */

import type { AuthSecrets } from "./auth-flow";
import { hashIp } from "./auth-flow";
import { getBindings } from "./runtime";

export function authSecrets(): AuthSecrets {
  const bindings = getBindings();
  return {
    linkDerivation: bindings.AUTH_LINK_DERIVATION_SECRET?.trim() ?? "",
    sessionSigning: bindings.AUTH_SESSION_SECRET?.trim() ?? "",
    rateLimit: bindings.AUTH_RATE_LIMIT_SECRET?.trim() ?? "",
  };
}

export function authSecretsConfigured(secrets: AuthSecrets): boolean {
  return Boolean(secrets.linkDerivation && secrets.sessionSigning && secrets.rateLimit);
}

/**
 * The From address for auth mail. Falls back to the current production sender
 * until the Signal Ledger domain is verified in Resend, so configuring the new
 * identity is a config change rather than a code change.
 */
export function authFromAddress(): string | null {
  const bindings = getBindings();
  const configured = bindings.EMAIL_FROM_AUTH?.trim();
  if (configured) return configured;
  return bindings.ALERT_FROM_EMAIL?.trim() || null;
}

/** The public origin, for building links that leave the site. */
export function publicOrigin(request: Request): string {
  const configured = getBindings().SITE_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

/** The client address, from the Cloudflare header. Never stored raw. */
export function clientAddress(request: Request): string | null {
  return request.headers.get("cf-connecting-ip")?.trim() || null;
}

export async function clientIpHmac(request: Request, secrets: AuthSecrets): Promise<string | null> {
  return hashIp(secrets.rateLimit, clientAddress(request));
}

export function userAgent(request: Request): string | null {
  const value = request.headers.get("user-agent")?.trim();
  return value ? value.slice(0, 120) : null;
}
