/**
 * First-party sign-in: request a link, validate it, consume it, hold a session.
 *
 * Two properties are load-bearing and easy to lose in a refactor:
 *
 *   1. The raw magic-link token is produced and consumed inside this module. It
 *      is derived from the job id and hashed before storage, so it exists only
 *      in memory here and in the email the worker sends.
 *   2. `GET` never authenticates. It validates and hands back a short-lived
 *      signed cookie; only an explicit `POST` claims the link. Mail scanners
 *      and link previewers follow GETs, and must not be able to log anyone in.
 */

import { newId } from "./crypto";
import {
  AUTH_LINK_PURPOSE,
  MAGIC_LINK_TTL_MS,
  PENDING_AUTH_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  createPendingAuth,
  deriveMagicToken,
  hashMagicToken,
  hmacSha256Hex,
  looksLikeEmail,
  nextSessionExpiry,
  normalizeEmail,
  randomToken,
  readPendingAuth,
} from "./auth-tokens";
import {
  attachMagicLinkToUser,
  claimMagicLink,
  countRecentLinksForEmail,
  countRecentLinksForIp,
  createSession,
  ensureVerifiedUser,
  findMagicLinkById,
  findMagicLinkByTokenHash,
  findSessionByTokenHash,
  findUserByEmail,
  findUserById,
  hashSessionToken,
  insertMagicLink,
  isMagicLinkUsable,
  revokeAllSessions,
  revokeSession,
  touchSession,
  type SessionRow,
  type UserRow,
} from "./auth-store";
import { enqueueAuthLinkEmail } from "./email-jobs";
import { getOrCreateEmailPreferences } from "./email-preferences";

export type AuthSecrets = {
  /** Derives magic-link tokens. Server-only; never sent to a browser. */
  linkDerivation: string;
  /** Signs the pending-auth cookie. Server-only. */
  sessionSigning: string;
  /** Keys the IP rate-limit digest. Server-only. */
  rateLimit: string;
};

export const RATE_LIMITS = Object.freeze({
  perEmail: 3,
  emailWindowMs: 15 * 60 * 1_000,
  perIp: 10,
  ipWindowMs: 60 * 60 * 1_000,
});

/**
 * A keyed digest of the client address. Deliberately not a plain hash: without
 * the server-side secret the stored value cannot be turned back into an IP, so
 * the auth table is not an IP log.
 */
export async function hashIp(secret: string, ip: string | null | undefined): Promise<string | null> {
  const normalized = String(ip ?? "").trim().toLowerCase();
  if (!normalized || !secret) return null;
  return hmacSha256Hex(secret, `ip|${normalized}`);
}

/* ------------------------------------------------------------------ request */

export type RequestLinkOutcome = { ok: true; suppressed: boolean };

/**
 * Queues a sign-in link.
 *
 * Every path returns the same shape — an unusable address, a rate-limited one
 * and a deliverable one are indistinguishable to the caller, so this endpoint
 * cannot be used to discover which addresses have accounts.
 */
export async function requestMagicLink(
  d1: D1Database,
  secrets: AuthSecrets,
  input: {
    email: string;
    ipHmac: string | null;
    userAgent: string | null;
    nowIso: string;
    nowMs: number;
    fromAddress: string | null;
  },
): Promise<RequestLinkOutcome> {
  const email = normalizeEmail(input.email);
  if (!looksLikeEmail(email)) return { ok: true, suppressed: true };

  const sinceEmail = new Date(input.nowMs - RATE_LIMITS.emailWindowMs).toISOString();
  if ((await countRecentLinksForEmail(d1, email, sinceEmail)) >= RATE_LIMITS.perEmail) {
    return { ok: true, suppressed: true };
  }
  if (input.ipHmac) {
    const sinceIp = new Date(input.nowMs - RATE_LIMITS.ipWindowMs).toISOString();
    if ((await countRecentLinksForIp(d1, input.ipHmac, sinceIp)) >= RATE_LIMITS.perIp) {
      return { ok: true, suppressed: true };
    }
  }

  const user = await findUserByEmail(d1, email);
  // The job id is the only thing the worker needs to rebuild the token, so it
  // is what the queue stores — never the token.
  const jobId = randomToken(32);
  const linkId = newId("mlink");
  const expiresAtIso = new Date(input.nowMs + MAGIC_LINK_TTL_MS).toISOString();

  const token = await deriveMagicToken(secrets.linkDerivation, jobId, email, AUTH_LINK_PURPOSE);
  await insertMagicLink(d1, {
    id: linkId,
    userId: user?.id ?? null,
    email,
    tokenHash: await hashMagicToken(token),
    purpose: AUTH_LINK_PURPOSE,
    createdAtIso: input.nowIso,
    expiresAtIso,
    ipHmac: input.ipHmac,
    userAgent: input.userAgent,
  });

  await enqueueAuthLinkEmail(d1, {
    jobId,
    recipient: email,
    subject: "登录 Signal Ledger",
    nowIso: input.nowIso,
    expiresAtIso,
    fromAddress: input.fromAddress,
  });

  return { ok: true, suppressed: false };
}

/* ------------------------------------------------------------------ validate (GET) */

export type PendingAuth = { linkId: string; email: string };

/**
 * Checks a presented token and nothing more. It does not consume, does not
 * create a user and does not start a session — so a mail scanner that follows
 * the link gets an interstitial and leaves the link intact for the human.
 */
export async function validateMagicLink(
  d1: D1Database,
  rawToken: string,
  nowMs: number,
): Promise<PendingAuth | null> {
  if (!rawToken) return null;
  const link = await findMagicLinkByTokenHash(d1, await hashMagicToken(rawToken));
  if (!link || !isMagicLinkUsable(link, nowMs)) return null;
  return { linkId: link.id, email: link.email };
}

/** The short-lived signed cookie that carries a validated link to the POST. */
export async function issuePendingAuth(secrets: AuthSecrets, linkId: string, nowMs: number): Promise<string> {
  return createPendingAuth(secrets.sessionSigning, linkId, nowMs + PENDING_AUTH_TTL_MS);
}

export async function readPendingAuthCookie(
  secrets: AuthSecrets,
  cookieValue: string | null,
  nowMs: number,
): Promise<{ linkId: string } | null> {
  return readPendingAuth(secrets.sessionSigning, cookieValue, nowMs);
}

/* ------------------------------------------------------------------ consume (POST) */

export type ConsumeOutcome =
  | { ok: true; userId: string; email: string; sessionToken: string; expiresAt: string }
  | { ok: false; reason: "pending_cookie_invalid" | "link_invalid" | "already_consumed" };

/**
 * Claims a link exactly once and starts a session.
 *
 * The claim is a single conditional UPDATE; when it reports zero changes the
 * link was already used, and that is a failure rather than a second sign-in.
 * That is what makes a replayed POST harmless.
 */
export async function consumeMagicLink(
  d1: D1Database,
  secrets: AuthSecrets,
  input: { pendingCookie: string | null; nowIso: string; nowMs: number; userAgent: string | null },
): Promise<ConsumeOutcome> {
  const pending = await readPendingAuth(secrets.sessionSigning, input.pendingCookie, input.nowMs);
  if (!pending) return { ok: false, reason: "pending_cookie_invalid" };

  const link = await findMagicLinkById(d1, pending.linkId);
  if (!link) return { ok: false, reason: "link_invalid" };
  // Distinguishable from an invalid link only for a caller that already held a
  // valid token, so this leaks nothing: it just makes a replay legible.
  if (link.consumed_at !== null) return { ok: false, reason: "already_consumed" };
  if (!isMagicLinkUsable(link, input.nowMs)) return { ok: false, reason: "link_invalid" };

  if (!(await claimMagicLink(d1, link.id, input.nowIso))) {
    return { ok: false, reason: "already_consumed" };
  }

  // Created here rather than at request time, so an unverified address never
  // becomes a permanent account.
  const { user } = await ensureVerifiedUser(d1, link.email, input.nowIso);
  await attachMagicLinkToUser(d1, link.id, user.id);
  await getOrCreateEmailPreferences(d1, user.id, input.nowIso);

  const sessionToken = randomToken(32);
  const absoluteMs = input.nowMs + SESSION_ABSOLUTE_TTL_MS;
  await createSession(d1, {
    userId: user.id,
    sessionTokenHash: await hashSessionToken(sessionToken),
    nowIso: input.nowIso,
    expiresAtIso: new Date(nextSessionExpiry(input.nowMs, absoluteMs)).toISOString(),
    absoluteExpiresAtIso: new Date(absoluteMs).toISOString(),
    userAgent: input.userAgent,
  });

  return {
    ok: true,
    userId: user.id,
    email: user.email,
    sessionToken,
    expiresAt: new Date(nextSessionExpiry(input.nowMs, absoluteMs)).toISOString(),
  };
}

/* ------------------------------------------------------------------ session */

export type ResolvedSession = { session: SessionRow; user: UserRow };

/**
 * Resolves a session cookie.
 *
 * Both clocks are checked: the rolling expiry and the absolute ceiling. The
 * rolling window is extended on use, but never past the ceiling — so an active
 * session still dies at 90 days and needs a fresh magic link.
 */
export async function resolveSession(
  d1: D1Database,
  input: { sessionToken: string | null; nowIso: string; nowMs: number },
): Promise<ResolvedSession | null> {
  if (!input.sessionToken) return null;
  const session = await findSessionByTokenHash(d1, await hashSessionToken(input.sessionToken));
  if (!session || session.revoked_at !== null) return null;

  const expires = Date.parse(session.expires_at);
  const absolute = Date.parse(session.absolute_expires_at);
  if (!Number.isFinite(expires) || expires <= input.nowMs) return null;
  if (!Number.isFinite(absolute) || absolute <= input.nowMs) return null;

  const user = await findUserById(d1, session.user_id);
  if (!user || user.email_verified !== 1) return null;

  const refreshed = nextSessionExpiry(input.nowMs, absolute);
  if (refreshed > expires) {
    await touchSession(d1, session.id, new Date(refreshed).toISOString(), input.nowIso);
  }
  return { session, user };
}

export async function signOutSession(d1: D1Database, sessionToken: string | null, nowIso: string): Promise<void> {
  if (!sessionToken) return;
  const session = await findSessionByTokenHash(d1, await hashSessionToken(sessionToken));
  if (session) await revokeSession(d1, session.id, nowIso);
}

export async function signOutEverywhere(d1: D1Database, userId: string, nowIso: string): Promise<number> {
  return revokeAllSessions(d1, userId, nowIso);
}
