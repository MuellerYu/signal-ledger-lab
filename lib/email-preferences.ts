/**
 * Email preferences, kept deliberately separate from billing.
 *
 * Billing answers "is this user PRO". Preferences answer "does this user want
 * the Daily Brief email". A PRO member can switch the email off and keep every
 * bit of website access: nothing here consults entitlement, and entitlement
 * never consults this.
 *
 * Defaults are OFF. Creating an account subscribes nobody to anything.
 */

import { isPro, type Entitlement } from "./entitlement";
import { verifyPreference } from "./auth-tokens";

export type EmailPreferences = {
  userId: string;
  dailyBriefEnabled: boolean;
  marketingEnabled: boolean;
  tokenVersion: number;
  updatedAt: string;
};

export const EMAIL_PREFERENCES_DEFAULTS = Object.freeze({
  dailyBriefEnabled: false,
  marketingEnabled: false,
  tokenVersion: 1,
});

type PreferenceRow = {
  user_id: string;
  daily_brief_enabled: number;
  marketing_enabled: number;
  token_version: number;
  updated_at: string;
};

const toPreferences = (row: PreferenceRow): EmailPreferences => ({
  userId: row.user_id,
  dailyBriefEnabled: row.daily_brief_enabled === 1,
  marketingEnabled: row.marketing_enabled === 1,
  tokenVersion: row.token_version,
  updatedAt: row.updated_at,
});

/**
 * Reads preferences without ever writing.
 *
 * This is what a GET may call. Email security scanners follow links
 * automatically, so the read path must be side-effect free: an absent row is
 * reported as the defaults rather than created. Any mutation goes through
 * getOrCreateEmailPreferences or applyPreferenceChange, which only a POST
 * reaches.
 */
export async function readEmailPreferences(d1: D1Database, userId: string): Promise<EmailPreferences> {
  const row = await d1
    .prepare(
      `SELECT user_id, daily_brief_enabled, marketing_enabled, token_version, updated_at
         FROM email_preferences WHERE user_id = ? LIMIT 1`,
    )
    .bind(userId)
    .first<PreferenceRow>();
  if (row) return toPreferences(row);
  return {
    userId,
    dailyBriefEnabled: EMAIL_PREFERENCES_DEFAULTS.dailyBriefEnabled,
    marketingEnabled: EMAIL_PREFERENCES_DEFAULTS.marketingEnabled,
    tokenVersion: EMAIL_PREFERENCES_DEFAULTS.tokenVersion,
    updatedAt: "",
  };
}

/**
 * The only way an email preference changes.
 *
 * It touches exactly two columns and nothing else: unsubscribing must never
 * cancel a subscription, alter billing, or close an account.
 */
export async function applyPreferenceChange(
  d1: D1Database,
  userId: string,
  change: { dailyBriefEnabled: boolean; marketingEnabled: boolean },
  nowIso: string,
): Promise<EmailPreferences> {
  await getOrCreateEmailPreferences(d1, userId, nowIso);
  await setDailyBriefEnabled(d1, userId, change.dailyBriefEnabled, nowIso);
  await setMarketingEnabled(d1, userId, change.marketingEnabled, nowIso);
  return readEmailPreferences(d1, userId);
}

/**
 * Creates the row on first use with both flags off, so an account created by
 * authentication is never implicitly subscribed to marketing or the brief.
 */
export async function getOrCreateEmailPreferences(d1: D1Database, userId: string, nowIso: string): Promise<EmailPreferences> {
  const existing = await d1
    .prepare(
      `SELECT user_id, daily_brief_enabled, marketing_enabled, token_version, updated_at
         FROM email_preferences WHERE user_id = ? LIMIT 1`,
    )
    .bind(userId)
    .first<PreferenceRow>();
  if (existing) return toPreferences(existing);

  await d1
    .prepare(
      `INSERT OR IGNORE INTO email_preferences
         (user_id, daily_brief_enabled, marketing_enabled, token_version, updated_at)
       VALUES (?, 0, 0, 1, ?)`,
    )
    .bind(userId, nowIso)
    .run();

  const created = await d1
    .prepare(
      `SELECT user_id, daily_brief_enabled, marketing_enabled, token_version, updated_at
         FROM email_preferences WHERE user_id = ? LIMIT 1`,
    )
    .bind(userId)
    .first<PreferenceRow>();
  if (!created) throw new Error("Email preferences could not be stored.");
  return toPreferences(created);
}

export async function setDailyBriefEnabled(d1: D1Database, userId: string, enabled: boolean, nowIso: string): Promise<void> {
  await d1
    .prepare(`UPDATE email_preferences SET daily_brief_enabled = ?, updated_at = ? WHERE user_id = ?`)
    .bind(enabled ? 1 : 0, nowIso, userId)
    .run();
}

export async function setMarketingEnabled(d1: D1Database, userId: string, enabled: boolean, nowIso: string): Promise<void> {
  await d1
    .prepare(`UPDATE email_preferences SET marketing_enabled = ?, updated_at = ? WHERE user_id = ?`)
    .bind(enabled ? 1 : 0, nowIso, userId)
    .run();
}

/** Invalidating every previously issued preference link. */
export async function bumpPreferenceTokenVersion(d1: D1Database, userId: string, nowIso: string): Promise<void> {
  await d1
    .prepare(`UPDATE email_preferences SET token_version = token_version + 1, updated_at = ? WHERE user_id = ?`)
    .bind(nowIso, userId)
    .run();
}

/**
 * Validates a signed preference request.
 *
 * Read-only, so both the GET that displays state and the POST that changes it
 * can share it. The signature covers user_id and the current token_version,
 * which is what retires every previously issued link when the version is bumped.
 */
export async function verifyPreferenceRequest(
  d1: D1Database,
  secret: string,
  userId: string,
  signature: string,
): Promise<{ ok: true; preferences: EmailPreferences } | { ok: false }> {
  if (!secret || !userId || !signature) return { ok: false };
  const preferences = await readEmailPreferences(d1, userId);
  if (!(await verifyPreference(secret, userId, preferences.tokenVersion, signature))) return { ok: false };
  return { ok: true, preferences };
}

/**
 * Whether the Daily Brief email should go out, and which edition.
 *
 * Turning this off must never affect PRO access — it only stops delivery.
 */
export function dailyBriefDelivery(
  preferences: Pick<EmailPreferences, "dailyBriefEnabled">,
  entitlement: Entitlement,
): { deliver: boolean; edition: "full" | "teaser" | null } {
  if (!preferences.dailyBriefEnabled) return { deliver: false, edition: null };
  return { deliver: true, edition: isPro(entitlement) ? "full" : "teaser" };
}
