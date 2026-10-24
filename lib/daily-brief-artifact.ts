/**
 * The canonical post-close Daily Brief artifact.
 *
 * The real research pipeline (price-first, market data + news + valuation) is
 * the only thing that may author the brief. The billing sandbox has none of the
 * market tables or Alpaca credentials that pipeline needs, so it must never try
 * to build a brief of its own — doing so produced the "Pick-NY — vs SPY —" and
 * "0 news items" placeholders that shipped to a paying subscriber.
 *
 * This module is the sandbox-safe replacement for that mistake: it stores and
 * reads the ONE canonical rendered brief per session, exactly as the real
 * pipeline produced it, and it refuses any artifact that still carries the
 * placeholder markers of a brief rendered from an empty model. The fan-out reads
 * from here; it never regenerates.
 */

import { sha256Hex } from "./crypto";
import type { MinimalD1Database } from "./d1";

export type DailyBriefArtifact = {
  sessionDate: string;
  subject: string;
  text: string;
  html: string;
  bodyHash: string;
  importedAt: string;
};

/**
 * Markers that only ever appear when `toPostCloseEmailBrief` was handed an
 * empty model. An imported artifact containing any of these is rejected, so a
 * low-data placeholder can never be fanned out as a PRO brief.
 */
export const PLACEHOLDER_MARKERS = [
  "vs SPY —",
  "0 news items were read",
  "No single move met the anomaly thresholds",
  "No session move required a causal explanation",
  "No tracked instrument moved enough to rank",
] as const;

/**
 * Structural + placeholder validation for an imported artifact. Returns the list
 * of problems; an empty list means it is safe to store and fan out.
 */
export function validateCanonicalArtifact(input: {
  subject: string;
  text: string;
  html: string;
}): string[] {
  const problems: string[] = [];
  if (!input.subject.trim()) problems.push("subject is empty");
  if (!input.text.trim()) problems.push("text is empty");
  if (!input.html.trim()) problems.push("html is empty");

  const body = `${input.subject}\n${input.text}`;
  for (const marker of PLACEHOLDER_MARKERS) {
    if (body.includes(marker)) {
      problems.push(`placeholder marker present: "${marker}"`);
      break;
    }
  }

  if (input.text.trim().length < 200) {
    problems.push("text is suspiciously short (fewer than 200 characters)");
  }
  return problems;
}

/** The deterministic identity of an artifact body, for auditability. */
export async function dailyBriefArtifactHash(text: string): Promise<string> {
  return sha256Hex(text);
}

/**
 * Writes the canonical artifact for a session. `session_date` is the natural
 * key: one canonical brief per session, upserted (never appended), so importing
 * a corrected artifact replaces the old one rather than leaving two.
 */
export async function upsertDailyBriefArtifact(
  d1: MinimalD1Database,
  input: {
    sessionDate: string;
    subject: string;
    text: string;
    html: string;
    nowIso: string;
  },
): Promise<{ written: boolean }> {
  const bodyHash = await dailyBriefArtifactHash(input.text);
  const result = await d1
    .prepare(
      `INSERT INTO daily_brief_artifacts
         (session_date, subject, text_body, html_body, body_hash, imported_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_date) DO UPDATE SET
         subject = excluded.subject,
         text_body = excluded.text_body,
         html_body = excluded.html_body,
         body_hash = excluded.body_hash,
         imported_at = excluded.imported_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.sessionDate,
      input.subject,
      input.text,
      input.html,
      bodyHash,
      input.nowIso,
      input.nowIso,
    )
    .run();
  return { written: result.meta?.changes != null && Number(result.meta.changes) > 0 };
}

/** Reads the canonical artifact for a session, or null when none was imported. */
export async function readDailyBriefArtifact(
  d1: MinimalD1Database,
  sessionDate: string,
): Promise<{ subject: string; text: string; html: string; bodyHash: string } | null> {
  const row = await d1
    .prepare(
      `SELECT subject, text_body, html_body, body_hash
         FROM daily_brief_artifacts
        WHERE session_date = ?`,
    )
    .bind(sessionDate)
    .first<{ subject: string; text_body: string; html_body: string; body_hash: string }>();
  if (!row) return null;
  return { subject: row.subject, text: row.text_body, html: row.html_body, bodyHash: row.body_hash };
}
