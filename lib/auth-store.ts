/**
 * Persistence for first-party auth.
 *
 * Storage holds hashes only: `auth_magic_links.token_hash` is sha256 of a token
 * that is never written, and `auth_sessions.session_token_hash` is sha256 of a
 * cookie value that only the browser has. Nothing in this file accepts or
 * returns a raw credential.
 *
 * Every function takes the D1 binding as an argument so the behaviour can be
 * exercised without a browser or a Worker.
 */

import { newId, sha256Hex } from "./crypto";
import { normalizeEmail } from "./auth-tokens";

export type UserRow = {
  id: string;
  email: string;
  email_verified: number;
  email_verified_at: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
};

export type MagicLinkRow = {
  id: string;
  user_id: string | null;
  email: string;
  token_hash: string;
  purpose: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  attempt_count: number;
};

export type SessionRow = {
  id: string;
  user_id: string;
  session_token_hash: string;
  authenticated_at: string;
  created_at: string;
  absolute_expires_at: string;
  expires_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

const changes = (result: { meta?: { changes?: number } }) => result.meta?.changes ?? 0;

const USER_COLUMNS = "id, email, email_verified, email_verified_at, display_name, created_at, updated_at";
const LINK_COLUMNS =
  "id, user_id, email, token_hash, purpose, created_at, expires_at, consumed_at, attempt_count";
const SESSION_COLUMNS =
  "id, user_id, session_token_hash, authenticated_at, created_at, absolute_expires_at, expires_at, last_seen_at, revoked_at";

/* ------------------------------------------------------------------ users */

/**
 * Creates the account at verification time, never at request time.
 *
 * An address that only ever requests a link leaves no permanent row, so the
 * users table means "verified accounts" and cannot be inflated by anyone who
 * types an address. Concurrency is absorbed by the unique index on email.
 */
export async function ensureVerifiedUser(
  d1: D1Database,
  rawEmail: string,
  nowIso: string,
): Promise<{ user: UserRow; created: boolean }> {
  const email = normalizeEmail(rawEmail);
  const existing = await findUserByEmail(d1, email);
  if (existing) {
    if (existing.email_verified !== 1) {
      await markEmailVerified(d1, existing.id, nowIso);
      const verified = await findUserById(d1, existing.id);
      return { user: verified ?? existing, created: false };
    }
    return { user: existing, created: false };
  }

  await d1
    .prepare(
      `INSERT OR IGNORE INTO users (id, email, email_verified, email_verified_at, display_name, created_at, updated_at)
       VALUES (?, ?, 1, ?, NULL, ?, ?)`,
    )
    .bind(newId("user"), email, nowIso, nowIso, nowIso)
    .run();

  const created = await findUserByEmail(d1, email);
  if (!created) throw new Error("The account could not be created.");
  return { user: created, created: true };
}

export async function findUserByEmail(d1: D1Database, rawEmail: string): Promise<UserRow | null> {
  return d1
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ? LIMIT 1`)
    .bind(normalizeEmail(rawEmail))
    .first<UserRow>();
}

export async function findUserById(d1: D1Database, userId: string): Promise<UserRow | null> {
  return d1.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`).bind(userId).first<UserRow>();
}

export async function markEmailVerified(d1: D1Database, userId: string, nowIso: string): Promise<void> {
  await d1
    .prepare(`UPDATE users SET email_verified = 1, email_verified_at = ?, updated_at = ? WHERE id = ? AND email_verified = 0`)
    .bind(nowIso, nowIso, userId)
    .run();
}

/* ------------------------------------------------------------------ magic links */

/**
 * Records a link by hash only.
 *
 * `user_id` is null when the address has no account yet; the row is attached at
 * consumption. Any outstanding link for the same address is retired first, so
 * only the newest link is ever live.
 */
export async function insertMagicLink(
  d1: D1Database,
  input: { id: string; userId: string | null; email: string; tokenHash: string; purpose: string; createdAtIso: string; expiresAtIso: string; ipHmac: string | null; userAgent: string | null },
): Promise<void> {
  await supersedeOutstandingLinks(d1, input.email, input.createdAtIso);
  await d1
    .prepare(
      `INSERT INTO auth_magic_links
         (id, user_id, email, token_hash, purpose, created_at, expires_at, consumed_at, attempt_count, requested_ip_hmac, requested_user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
    )
    .bind(
      input.id,
      input.userId,
      normalizeEmail(input.email),
      input.tokenHash,
      input.purpose,
      input.createdAtIso,
      input.expiresAtIso,
      input.ipHmac,
      input.userAgent,
    )
    .run();
}

export async function supersedeOutstandingLinks(d1: D1Database, rawEmail: string, nowIso: string): Promise<void> {
  await d1
    .prepare(`UPDATE auth_magic_links SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL`)
    .bind(nowIso, normalizeEmail(rawEmail))
    .run();
}

export async function findMagicLinkByTokenHash(d1: D1Database, tokenHash: string): Promise<MagicLinkRow | null> {
  return d1
    .prepare(`SELECT ${LINK_COLUMNS} FROM auth_magic_links WHERE token_hash = ? LIMIT 1`)
    .bind(tokenHash)
    .first<MagicLinkRow>();
}

export async function findMagicLinkById(d1: D1Database, linkId: string): Promise<MagicLinkRow | null> {
  return d1.prepare(`SELECT ${LINK_COLUMNS} FROM auth_magic_links WHERE id = ? LIMIT 1`).bind(linkId).first<MagicLinkRow>();
}

/** Whether a link may still be used, ignoring who is asking. */
export function isMagicLinkUsable(link: MagicLinkRow, nowMs: number): boolean {
  if (link.consumed_at !== null) return false;
  const expires = Date.parse(link.expires_at);
  if (!Number.isFinite(expires) || expires <= nowMs) return false;
  return link.attempt_count < 5;
}

/**
 * Claims a link exactly once.
 *
 * The conditional UPDATE is the whole guarantee: two simultaneous consumers
 * both run it, and SQLite reports `changes === 1` for exactly one of them. The
 * loser must be treated as a failure, never as a second success.
 */
export async function claimMagicLink(d1: D1Database, linkId: string, nowIso: string): Promise<boolean> {
  const result = await d1
    .prepare(`UPDATE auth_magic_links SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
    .bind(nowIso, linkId)
    .run();
  return changes(result) === 1;
}

export async function attachMagicLinkToUser(d1: D1Database, linkId: string, userId: string): Promise<void> {
  await d1.prepare(`UPDATE auth_magic_links SET user_id = ? WHERE id = ?`).bind(userId, linkId).run();
}

export async function countRecentLinksForEmail(d1: D1Database, rawEmail: string, sinceIso: string): Promise<number> {
  const row = await d1
    .prepare(`SELECT COUNT(*) AS count FROM auth_magic_links WHERE email = ? AND created_at >= ?`)
    .bind(normalizeEmail(rawEmail), sinceIso)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function countRecentLinksForIp(d1: D1Database, ipHmac: string, sinceIso: string): Promise<number> {
  const row = await d1
    .prepare(`SELECT COUNT(*) AS count FROM auth_magic_links WHERE requested_ip_hmac = ? AND created_at >= ?`)
    .bind(ipHmac, sinceIso)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/* ------------------------------------------------------------------ sessions */

/** Stores only the hash of the cookie value. */
export async function createSession(
  d1: D1Database,
  input: { userId: string; sessionTokenHash: string; nowIso: string; expiresAtIso: string; absoluteExpiresAtIso: string; userAgent: string | null },
): Promise<string> {
  const id = newId("sess");
  await d1
    .prepare(
      `INSERT INTO auth_sessions
         (id, user_id, session_token_hash, authenticated_at, created_at, absolute_expires_at, expires_at, last_seen_at, revoked_at, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      id,
      input.userId,
      input.sessionTokenHash,
      input.nowIso,
      input.nowIso,
      input.absoluteExpiresAtIso,
      input.expiresAtIso,
      input.nowIso,
      input.userAgent,
    )
    .run();
  return id;
}

export async function findSessionByTokenHash(d1: D1Database, tokenHash: string): Promise<SessionRow | null> {
  return d1
    .prepare(`SELECT ${SESSION_COLUMNS} FROM auth_sessions WHERE session_token_hash = ? LIMIT 1`)
    .bind(tokenHash)
    .first<SessionRow>();
}

/**
 * Rolling refresh, clamped by the absolute ceiling: activity can extend a
 * session by 30 days at a time but can never push it past 90 days from the
 * moment it was created.
 */
export async function touchSession(d1: D1Database, sessionId: string, expiresAtIso: string, nowIso: string): Promise<void> {
  await d1
    .prepare(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`)
    .bind(nowIso, expiresAtIso, sessionId)
    .run();
}

export async function revokeSession(d1: D1Database, sessionId: string, nowIso: string): Promise<void> {
  await d1.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(nowIso, sessionId).run();
}

export async function revokeAllSessions(d1: D1Database, userId: string, nowIso: string): Promise<number> {
  const result = await d1
    .prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
    .bind(nowIso, userId)
    .run();
  return changes(result);
}

/** The token the browser holds; stored only as a hash. */
export async function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(`session|${token}`);
}
