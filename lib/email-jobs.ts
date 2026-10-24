/**
 * The service email queue.
 *
 * The Daily Brief keeps its own `briefing_outbox`; this is the general queue for
 * auth links, receipts and account notices. Both drain through the same sender
 * in the worker, so there is still exactly one Resend integration.
 *
 * The important property: an auth-link job is enqueued with `body_mode =
 * derived_auth_link` and **no body and no payload**, because a rendered body
 * would contain the bearer token. The worker rebuilds the link at send time.
 * The database CHECK constraint refuses any other shape.
 */

import { AUTH_LINK_KIND } from "./auth-tokens";
import type { MinimalD1Database } from "./d1";

export type EmailJobKind =
  | typeof AUTH_LINK_KIND
  | "billing_receipt"
  | "account_notice"
  | "daily_brief";

/** Queues a magic-link email without ever writing the link itself. */
export async function enqueueAuthLinkEmail(
  d1: MinimalD1Database,
  input: {
    jobId: string;
    recipient: string;
    subject: string;
    nowIso: string;
    expiresAtIso: string;
    fromAddress: string | null;
  },
): Promise<void> {
  await d1
    .prepare(
      `INSERT OR IGNORE INTO email_outbox
         (id, kind, recipient, from_address, subject, body_mode, text_body, html_body,
          payload_json, scheduled_for, expires_at, status, attempts, next_attempt_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'derived_auth_link', NULL, NULL, NULL, ?, ?, 'queued', 0, ?, ?, ?)`,
    )
    .bind(
      input.jobId,
      AUTH_LINK_KIND,
      input.recipient.trim().toLowerCase(),
      input.fromAddress,
      input.subject,
      input.nowIso,
      input.expiresAtIso,
      input.nowIso,
      input.nowIso,
      input.nowIso,
    )
    .run();
}

/** Queues a normal service email whose body is safe to store. */
export async function enqueueStoredEmail(
  d1: MinimalD1Database,
  input: {
    jobId: string;
    kind: Exclude<EmailJobKind, typeof AUTH_LINK_KIND>;
    recipient: string;
    subject: string;
    text: string;
    html: string;
    fromAddress: string | null;
    nowIso: string;
    expiresAtIso?: string | null;
    payloadJson?: string | null;
  },
): Promise<{ inserted: boolean }> {
  const result = await d1
    .prepare(
      `INSERT OR IGNORE INTO email_outbox
         (id, kind, recipient, from_address, subject, body_mode, text_body, html_body,
          payload_json, scheduled_for, expires_at, status, attempts, next_attempt_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'stored', ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
    )
    .bind(
      input.jobId,
      input.kind,
      input.recipient.trim().toLowerCase(),
      input.fromAddress,
      input.subject,
      input.text,
      input.html,
      input.payloadJson ?? null,
      input.nowIso,
      input.expiresAtIso ?? null,
      input.nowIso,
      input.nowIso,
      input.nowIso,
    )
    .run();
  // INSERT OR IGNORE makes the caller's idempotency the whole story: a retry
  // with the same jobId changes nothing, and `inserted` says which happened.
  return { inserted: result.meta?.changes != null && Number(result.meta.changes) > 0 };
}
