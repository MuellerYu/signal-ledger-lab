/**
 * Credential derivation and signing for first-party auth.
 *
 * The central rule: a raw magic-link token is never stored. It is derived as
 * HMAC(secret, outboxId | email | purpose), so the worker can reconstruct the
 * exact same token at delivery time — including on a retry — while D1 only ever
 * holds sha256(token). Nothing below writes to storage; this module is pure.
 */

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1_000;
export const PENDING_AUTH_TTL_MS = 5 * 60 * 1_000;
export const SESSION_ROLLING_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

/**
 * The job kind and token purpose for a sign-in link. Pages mints the job, the
 * worker derives the token, and both must agree — so the pairing lives here
 * rather than being spelled out at each site.
 */
export const AUTH_LINK_KIND = "auth_magic_link" as const;
export const AUTH_LINK_PURPOSE = "signin" as const;

/** The rolling window can never push a session past this. */
export function nextSessionExpiry(nowMs: number, absoluteExpiresAtMs: number): number {
  return Math.min(nowMs + SESSION_ROLLING_TTL_MS, absoluteExpiresAtMs);
}

/**
 * Identity normalization: trim and lowercase, and nothing else.
 *
 * Deliberately no provider-specific rewriting — Gmail dots and `+tags` are part
 * of the mailbox the user gave us and are treated as the identity. Rewriting
 * them would silently merge distinct addresses.
 */
export function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** A basic structural check. Not a deliverability guarantee. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value) && value.length <= 254;
}

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64UrlEncode(buffer);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** Length-safe comparison, so a mismatch does not leak position by timing. */
export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

/** A keyed digest as lowercase hex, for signatures compared as strings. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const bytes = await hmacSha256(secret, message);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The magic-link token, reconstructed rather than remembered.
 *
 * Deterministic in (outboxId, email, purpose) and keyed by a server-only
 * secret, so the value is unpredictable without the secret and identical on
 * every retry — which is what lets the job row stay free of it.
 */
export async function deriveMagicToken(secret: string, outboxId: string, email: string, purpose: string): Promise<string> {
  if (!secret) throw new Error("AUTH_LINK_DERIVATION_SECRET is not configured.");
  return base64UrlEncode(await hmacSha256(secret, `${outboxId}|${normalizeEmail(email)}|${purpose}`));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What actually goes in the database. */
export async function hashMagicToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/* ------------------------------------------------------------------ pending auth */

/**
 * The short-lived, integrity-protected cookie set by the GET interstitial.
 *
 * It identifies the validated magic-link record and nothing else — no token, no
 * email — so a scanner that follows the link cannot turn the cookie into a
 * session even if it were stolen.
 */
export async function createPendingAuth(secret: string, linkId: string, expiresAtMs: number): Promise<string> {
  const payload = `${linkId}.${Math.floor(expiresAtMs / 1_000)}`;
  const signature = await hmacSha256Hex(secret, `magic-pending|${payload}`);
  return `${payload}.${signature}`;
}

export async function readPendingAuth(secret: string, cookieValue: string | null | undefined, nowMs: number): Promise<{ linkId: string } | null> {
  if (!secret || !cookieValue) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;
  const [linkId, expiry, signature] = parts;
  if (!linkId || !/^\d+$/.test(expiry)) return null;
  const expected = await hmacSha256Hex(secret, `magic-pending|${linkId}.${expiry}`);
  if (!constantTimeEqual(signature, expected)) return null;
  if (Number(expiry) * 1_000 <= nowMs) return null;
  return { linkId };
}

/* ------------------------------------------------------------------ preferences */

/**
 * Preference links are signed, not bearer tokens: the signature covers the
 * user id and the token version, so bumping the version invalidates every link
 * ever issued without storing anything.
 */
export async function signPreference(secret: string, userId: string, tokenVersion: number): Promise<string> {
  if (!secret) throw new Error("EMAIL_PREFERENCE_SECRET is not configured.");
  return (await hmacSha256Hex(secret, `${userId}|${tokenVersion}`)).slice(0, 32);
}

export async function verifyPreference(
  secret: string,
  userId: string,
  tokenVersion: number,
  signature: string,
): Promise<boolean> {
  if (!secret || !userId || !signature) return false;
  return constantTimeEqual(signature, await signPreference(secret, userId, tokenVersion));
}

/** The public preference URL for one user. Contains no secret material. */
export async function preferenceLink(origin: string, secret: string, userId: string, tokenVersion: number): Promise<string> {
  const base = origin.replace(/\/+$/, "");
  const signature = await signPreference(secret, userId, tokenVersion);
  return `${base}/email/preferences?uid=${encodeURIComponent(userId)}&sig=${signature}`;
}

/**
 * The origin used to assemble a magic-link URL.
 *
 * It must come from explicit configuration — `SITE_ORIGIN` first, then the
 * deployment's valuation origin — and is **never** defaulted to a hardcoded
 * production URL. That is deliberate: a misconfigured sandbox fails closed
 * (returns null, so the worker refuses to build a link) rather than emailing a
 * user a sign-in link that points at production. A configured trailing slash
 * is tolerated and stripped.
 */
export function authLinkOrigin(
  siteOrigin: string | null | undefined,
  valuationOrigin: string | null | undefined,
): string | null {
  const origin = (siteOrigin ?? valuationOrigin ?? "").trim().replace(/\/+$/, "");
  return origin || null;
}
