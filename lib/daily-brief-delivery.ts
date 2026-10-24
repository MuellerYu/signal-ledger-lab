/**
 * Canonical Daily Brief finalization and subscriber delivery.
 *
 * The scheduled post-close pipeline has two halves that must never be coupled:
 *
 *   1. Finalize — validate the ONE rendered brief and persist it as the durable
 *      canonical artifact for the session. This is the recovery source: once it
 *      is written, a fan-out that fails partway can be reconstructed without
 *      re-running research.
 *
 *   2. Deliver — read that canonical artifact and copy it to every eligible PRO
 *      subscriber, verbatim, never regenerating content per subscriber.
 *
 * Splitting them means research is done exactly once and the fan-out is a pure
 * read-and-copy step, so eligibility (verified + opt-in + PRO + future
 * access_until) and dedup (sessionDate + recipient) stay the only moving parts
 * of delivery. Both functions are pure over `MinimalD1Database`: they read
 * entitlement, write the queue, and take no runtime dependency on the worker.
 */

import {
  enqueueDailyBriefFanout,
  renderDailyBriefFanout,
  resolveDailyBriefRecipients,
} from "./daily-brief-fanout";
import { upsertDailyBriefArtifact, validateCanonicalArtifact } from "./daily-brief-artifact";
import type { MinimalD1Database } from "./d1";

export type CanonicalDailyBrief = {
  sessionDate: string;
  subject: string;
  text: string;
  html: string;
};

/** The outcome of validating and persisting a freshly generated brief. */
export type FinalizeDailyBriefOutcome =
  | { ok: true; canonicalBriefReady: true; artifactWritten: boolean; sessionDate: string }
  | { ok: false; canonicalBriefReady: false; status: "rejected"; sessionDate: string; problems: string[] };

/**
 * Validates a freshly generated brief and, when it clears the placeholder gate,
 * persists it as the session's canonical artifact. Returns without writing when
 * validation fails, so a low-data brief can never be stored or fanned out.
 */
export async function finalizeCanonicalDailyBrief(
  d1: MinimalD1Database,
  input: {
    sessionDate: string;
    subject: string;
    text: string;
    html: string;
    nowIso: string;
  },
): Promise<FinalizeDailyBriefOutcome> {
  const problems = validateCanonicalArtifact({
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
  if (problems.length) {
    return {
      ok: false,
      canonicalBriefReady: false,
      status: "rejected",
      sessionDate: input.sessionDate,
      problems,
    };
  }
  const { written } = await upsertDailyBriefArtifact(d1, {
    sessionDate: input.sessionDate,
    subject: input.subject,
    text: input.text,
    html: input.html,
    nowIso: input.nowIso,
  });
  return {
    ok: true,
    canonicalBriefReady: true,
    artifactWritten: written,
    sessionDate: input.sessionDate,
  };
}

/** The outcome of one delivery pass over the eligible subscriber set. */
export type DeliverDailyBriefOutcome =
  | {
      ok: true;
      canonicalBriefReady: true;
      eligibleRecipients: number;
      queued: string[];
      alreadyQueued: string[];
      failed: string[];
    }
  | {
      ok: false;
      canonicalBriefReady: false;
      status: "rejected";
      problems: string[];
    };

/**
 * Copies the canonical brief to every eligible PRO subscriber, verbatim. It
 * validates the brief defensively, resolves eligibility once, wraps it in the
 * Signal Ledger envelope when a view URL is supplied, and enqueues each
 * recipient under a deterministic (sessionDate, recipient) job id so a retry is
 * a no-op. It never regenerates content.
 */
export async function deliverCanonicalDailyBrief(
  d1: MinimalD1Database,
  input: {
    canonical: CanonicalDailyBrief;
    nowIso: string;
    nowMs: number;
    viewUrl: string | null;
    fromAddress?: string | null;
  },
): Promise<DeliverDailyBriefOutcome> {
  const problems = validateCanonicalArtifact(input.canonical);
  if (problems.length) {
    return { ok: false, canonicalBriefReady: false, status: "rejected", problems };
  }

  const recipients = await resolveDailyBriefRecipients(d1, input.nowMs);
  if (recipients.length === 0) {
    return {
      ok: true,
      canonicalBriefReady: true,
      eligibleRecipients: 0,
      queued: [],
      alreadyQueued: [],
      failed: [],
    };
  }

  const wrapped = input.viewUrl
    ? renderDailyBriefFanout(input.canonical, input.viewUrl)
    : input.canonical;

  const { queued, skipped, failed } = await enqueueDailyBriefFanout(d1, {
    sessionDate: input.canonical.sessionDate,
    subject: wrapped.subject,
    text: wrapped.text,
    html: wrapped.html,
    recipients,
    nowIso: input.nowIso,
    fromAddress: input.fromAddress ?? null,
  });

  return {
    ok: true,
    canonicalBriefReady: true,
    eligibleRecipients: recipients.length,
    queued,
    alreadyQueued: skipped,
    failed,
  };
}
