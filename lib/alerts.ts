import { canonicalJson, newId, sha256Hex } from "./crypto";
import { providerIdempotencyKey } from "./email-idempotency";
import {
  DEFAULT_ALERT_RECIPIENT,
  getBindings,
} from "./runtime";

type AlertInput = {
  eventId?: string | null;
  recipient?: string;
  priority: "P0" | "P1" | "TEST";
  dedupeKey: string;
  subject: string;
  bodyText: string;
  materialRevision?: number;
  sourcePublishedAtMs?: number | null;
  firstSeenAtMs?: number | null;
};

export function getEmailSetup() {
  const bindings = getBindings();
  const missing = [
    !bindings.RESEND_API_KEY ? "RESEND_API_KEY" : null,
    !bindings.ALERT_FROM ? "ALERT_FROM" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    configured: missing.length === 0,
    missing,
    recipient:
      bindings.ALERT_RECIPIENT?.trim() || DEFAULT_ALERT_RECIPIENT,
  };
}

export async function queueAlert(d1: D1Database, input: AlertInput) {
  const setup = getEmailSetup();
  const now = Date.now();
  const recipient = input.recipient?.trim() || setup.recipient;
  const payloadHash = await sha256Hex(
    canonicalJson({
      recipient,
      subject: input.subject,
      bodyText: input.bodyText,
    }),
  );
  const status = setup.configured ? "queued" : "needs_setup";
  const result = await d1
    .prepare(
      `INSERT INTO alerts (
        id, event_id, recipient, channel, priority, policy_version,
        material_revision, dedupe_key, subject, body_text, payload_hash,
        status, attempt_count, source_to_seen_ms, created_at_ms
      ) VALUES (?, ?, ?, 'email', ?, 'alert-v1', ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(dedupe_key) DO NOTHING`,
    )
    .bind(
      newId("alert"),
      input.eventId ?? null,
      recipient,
      input.priority,
      input.materialRevision ?? 1,
      input.dedupeKey,
      input.subject,
      input.bodyText,
      payloadHash,
      status,
      input.sourcePublishedAtMs && input.firstSeenAtMs
        ? Math.max(0, input.firstSeenAtMs - input.sourcePublishedAtMs)
        : null,
      now,
    )
    .run();

  return {
    inserted: Number(result.meta.changes ?? 0) > 0,
    status,
    recipient,
    missing: setup.missing,
  };
}

function htmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function deliverAlertByDedupeKey(
  d1: D1Database,
  dedupeKey: string,
) {
  const setup = getEmailSetup();
  if (!setup.configured) {
    return {
      ok: false,
      status: "needs_setup" as const,
      missing: setup.missing,
    };
  }

  const row = await d1
    .prepare(
      `SELECT id, recipient, subject, body_text, status, created_at_ms
       FROM alerts WHERE dedupe_key = ? LIMIT 1`,
    )
    .bind(dedupeKey)
    .first<{
      id: string;
      recipient: string;
      subject: string;
      body_text: string;
      status: string;
      created_at_ms: number;
    }>();
  if (!row) {
    return { ok: false, status: "not_found" as const, missing: [] };
  }
  if (row.status === "sent") {
    return { ok: true, status: "sent" as const, missing: [] };
  }

  const bindings = getBindings();
  const startedAt = Date.now();
  // getEmailSetup() above already refused the send when ALERT_FROM is missing,
  // so this is non-empty here; read it once so the fingerprinted payload is
  // byte-for-byte the payload that goes out.
  const alertFrom = bindings.ALERT_FROM ?? "";
  // The dedupe key stays the business identity of the alert — it is what the
  // `alerts` row and its UNIQUE constraint are keyed on. The provider key is
  // that identity plus the exact payload, so a row that is deleted and queued
  // again with different content sends on its own key instead of being refused
  // by Resend as a reused key whose body moved.
  const alertHtml = `<div style="font-family:Inter,Arial,sans-serif;white-space:pre-wrap;line-height:1.55">${htmlEscape(row.body_text)}</div>`;
  const idempotencyKey = await providerIdempotencyKey(dedupeKey, {
    from: alertFrom,
    recipient: row.recipient,
    subject: row.subject,
    bodyMode: "stored",
    text: row.body_text,
    html: alertHtml,
  });
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bindings.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: alertFrom,
        to: [row.recipient],
        subject: row.subject,
        text: row.body_text,
        html: alertHtml,
      }),
    });
    const result = (await response.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
    };
    if (!response.ok || !result.id) {
      const error = result.message || `Resend returned ${response.status}.`;
      await d1
        .prepare(
          `UPDATE alerts
           SET status = 'retry', attempt_count = attempt_count + 1,
               next_attempt_at_ms = ?, last_error = ?
           WHERE id = ?`,
        )
        .bind(Date.now() + 60_000, error, row.id)
        .run();
      return { ok: false, status: "retry" as const, error, missing: [] };
    }

    await d1
      .prepare(
        `UPDATE alerts
         SET status = 'sent', attempt_count = attempt_count + 1,
             provider_id = ?, sent_at_ms = ?, seen_to_send_ms = ?,
             next_attempt_at_ms = NULL, last_error = NULL
         WHERE id = ?`,
      )
      .bind(
        result.id,
        Date.now(),
        Math.max(0, startedAt - row.created_at_ms),
        row.id,
      )
      .run();
    return {
      ok: true,
      status: "sent" as const,
      providerId: result.id,
      missing: [],
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Email delivery failed.";
    await d1
      .prepare(
        `UPDATE alerts
         SET status = 'retry', attempt_count = attempt_count + 1,
             next_attempt_at_ms = ?, last_error = ?
         WHERE id = ?`,
      )
      .bind(Date.now() + 60_000, message, row.id)
      .run();
    return {
      ok: false,
      status: "retry" as const,
      error: message,
      missing: [],
    };
  }
}

export async function queueAndSendTestAlert(
  d1: D1Database,
  recipient?: string,
) {
  const nowIso = new Date().toISOString();
  const dedupeKey = `test/${crypto.randomUUID()}`;
  const queued = await queueAlert(d1, {
    recipient,
    priority: "TEST",
    dedupeKey,
    subject: "[TEST] Signal Ledger 突发预警链路",
    bodyText: [
      "Signal Ledger 邮件链路测试",
      "",
      `生成时间：${nowIso}`,
      "状态：这是一封测试邮件，不是投资新闻或交易建议。",
      "",
      "如果你收到这封邮件，说明 Sites → 监控服务 → Gmail 链路可用。",
    ].join("\n"),
  });

  if (queued.status === "needs_setup") {
    return {
      ok: false,
      queued: true,
      status: "needs_setup" as const,
      recipient: queued.recipient,
      missing: queued.missing,
      dedupeKey,
    };
  }

  const delivered = await deliverAlertByDedupeKey(d1, dedupeKey);
  return {
    ...delivered,
    queued: queued.inserted,
    recipient: queued.recipient,
    dedupeKey,
  };
}
