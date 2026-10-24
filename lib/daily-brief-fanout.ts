/**
 * PRO Daily Brief subscriber fan-out.
 *
 * After a canonical post-close brief is complete, this copies that ONE brief to
 * every eligible PRO subscriber. It never generates content: the caller hands in
 * a single rendered brief and this module fans it out verbatim, so a subscriber
 * receives exactly the same canonical artifact as the owner — never a separate
 * AI rendering.
 *
 * The fan-out drains through the general `email_outbox` (the table the worker's
 * service-email flush already sends), not the market `briefing_outbox`, because
 * the sandbox has only the membership schema. Deterministic deduplication is the
 * primary key itself: each recipient's job id is
 * `sha256("daily-brief|<sessionDate>|<recipient>")`, inserted with
 * INSERT OR IGNORE, so retrying the same session is a no-op and can never
 * double-send a subscriber.
 *
 * This module is pure: it reads entitlement, writes the queue, and builds HTML,
 * and takes no runtime dependency on the worker or the Pages app.
 */

import { resolveEntitlement } from "./entitlement";
import { readUserSubscriptions } from "./subscriptions";
import { enqueueStoredEmail } from "./email-jobs";
import { sha256Hex } from "./crypto";
import type { MinimalD1Database } from "./d1";

export type DailyBriefRecipient = {
  userId: string;
  email: string;
};

const esc = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Candidates: a verified account with the Daily Brief switched ON. The two
 * flags live on different tables (verification on `users`, the preference on
 * `email_preferences`), so eligibility is a join, not a single column.
 */
export async function selectDailyBriefRecipients(d1: MinimalD1Database): Promise<DailyBriefRecipient[]> {
  const rows = await d1
    .prepare(
      `SELECT u.id AS user_id, u.email
         FROM users u
         JOIN email_preferences p ON p.user_id = u.id
        WHERE u.email_verified = 1
          AND p.daily_brief_enabled = 1
        ORDER BY u.email`,
    )
    .bind()
    .all<{ user_id: string; email: string }>();
  return (rows.results ?? []).map((row) => ({
    userId: row.user_id,
    email: row.email,
  }));
}

/**
 * The full eligibility predicate, in one place: verified + opt-in (above) AND
 * PRO entitlement with a future `access_until`.
 *
 * Entitlement is decided by `resolveEntitlement`, never re-derived here, so the
 * fan-out cannot drift from what the account page reports. A subscription
 * scheduled to cancel but still inside `access_until` remains eligible, because
 * `cancel_at` is informational; an expired one is not, because `access_until`
 * has passed.
 */
export async function resolveDailyBriefRecipients(
  d1: MinimalD1Database,
  now: number,
): Promise<DailyBriefRecipient[]> {
  const candidates = await selectDailyBriefRecipients(d1);
  const eligible: DailyBriefRecipient[] = [];
  for (const candidate of candidates) {
    const subscriptions = await readUserSubscriptions(d1, candidate.userId);
    // The candidate query already requires email_verified = 1, so this is not
    // a re-check — it just satisfies the resolver's own contract.
    const entitlement = resolveEntitlement({
      user: { id: candidate.userId, emailVerified: true },
      subscriptions,
      now,
    });
    if (
      entitlement.tier === "PRO" &&
      entitlement.accessUntil &&
      Date.parse(entitlement.accessUntil) > now
    ) {
      eligible.push(candidate);
    }
  }
  return eligible;
}

/**
 * The deterministic job id. Retries of the same session produce the same id, so
 * INSERT OR IGNORE makes a duplicate delivery structurally impossible.
 */
export async function dailyBriefOutboxId(sessionDate: string, recipient: string): Promise<string> {
  return sha256Hex(`daily-brief|${sessionDate}|${recipient.trim().toLowerCase()}`);
}

/**
 * Queues the canonical brief once per recipient, and reports which were new and
 * which were already present (a retry). `inserted === false` is the dedup hit.
 *
 * Each recipient is enqueued in isolation: a failure for one subscriber (a bad
 * row, a transient write) is recorded and does not abort the loop, so a single
 * subscriber can never stop delivery to the rest.
 */
export async function enqueueDailyBriefFanout(
  d1: MinimalD1Database,
  input: {
    sessionDate: string;
    subject: string;
    text: string;
    html: string;
    recipients: DailyBriefRecipient[];
    nowIso: string;
    fromAddress?: string | null;
  },
): Promise<{ queued: string[]; skipped: string[]; failed: string[] }> {
  const queued: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const recipient of input.recipients) {
    try {
      const jobId = await dailyBriefOutboxId(input.sessionDate, recipient.email);
      const { inserted } = await enqueueStoredEmail(d1, {
        jobId,
        kind: "daily_brief",
        recipient: recipient.email,
        subject: input.subject,
        text: input.text,
        html: input.html,
        fromAddress: input.fromAddress ?? null,
        nowIso: input.nowIso,
      });
      (inserted ? queued : skipped).push(recipient.email);
    } catch (error) {
      // Do not let one subscriber's enqueue failure break the fan-out. The
      // address is recorded (never the error body, which could carry a secret)
      // so the run ledger can show who is outstanding and a later tick retries.
      failed.push(recipient.email);
    }
  }
  return { queued, skipped, failed };
}

/**
 * Wraps the canonical brief in the Signal Ledger envelope: branding, the
 * briefing date, and a link back to /daily-brief. The ten-section content is
 * inserted verbatim — this adds the shell around the reused artifact, it does
 * not re-render it, and the shell is identical for every subscriber.
 */
export function renderDailyBriefFanout(
  canonical: { sessionDate: string; subject: string; text: string; html: string },
  viewUrl: string,
): { subject: string; text: string; html: string } {
  const text = [
    "Signal Ledger — Daily Brief",
    `Session ${canonical.sessionDate}`,
    "",
    canonical.text,
    "",
    `Read it in the research desk: ${viewUrl}`,
  ].join("\n");

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#14243a;max-width:720px">
<div style="padding:14px 0 12px;border-bottom:2px solid #0f5c4a;margin-bottom:8px">
  <div style="font-weight:700;font-size:18px;color:#0f5c4a">Signal Ledger</div>
  <div style="color:#516074;font-size:13px">Daily Brief · ${esc(canonical.sessionDate)}</div>
</div>
${canonical.html}
<div style="margin-top:24px;border-top:1px solid #e3e9ef;padding-top:16px">
  <a href="${esc(viewUrl)}" style="background:#0f5c4a;color:#fff;text-decoration:none;border-radius:8px;padding:12px 22px;font-weight:600;display:inline-block">Open in the research desk</a>
  <p style="color:#516074;font-size:13px;margin:12px 0 0">You receive the full brief because your PRO membership and Daily Brief preference are both active.</p>
</div>
</div>`;

  return { subject: canonical.subject, text, html };
}
