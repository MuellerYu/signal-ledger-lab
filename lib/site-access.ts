import type { ChatGPTUser } from "@/app/chatgpt-auth";
import { newId, sha256Hex } from "./crypto";
import { DEFAULT_ALERT_RECIPIENT, getBindings } from "./runtime";

export type SiteAccessStatus =
  | "not_requested"
  | "pending"
  | "approved"
  | "denied"
  | "revoked";

export type SiteAccessRequestRow = {
  id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  status: Exclude<SiteAccessStatus, "not_requested">;
  approval_token_hash: string;
  requested_at_ms: number;
  email_sent_at_ms: number | null;
  decided_at_ms: number | null;
  decided_by_email: string | null;
  decision_note: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

const REQUEST_EMAIL_COOLDOWN_MS = 10 * 60 * 1000;

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function siteOwnerEmail() {
  const bindings = getBindings();
  return normalizeEmail(
    bindings.ALLOWED_EMAIL ??
      bindings.ALERT_RECIPIENT ??
      DEFAULT_ALERT_RECIPIENT,
  );
}

export function isSiteOwnerEmail(email: string) {
  return normalizeEmail(email) === siteOwnerEmail();
}

export function requestUserFromHeaders(headers: Headers): ChatGPTUser | null {
  const email = headers.get("oai-authenticated-user-email");
  if (!email) return null;
  const encodedName = headers.get("oai-authenticated-user-full-name");
  const encoding = headers.get("oai-authenticated-user-full-name-encoding");
  let fullName: string | null = null;
  if (encodedName && encoding === "percent-encoded-utf-8") {
    try {
      fullName = decodeURIComponent(encodedName);
    } catch {
      fullName = null;
    }
  }
  return {
    id:
      headers.get("oai-authenticated-user-id") ??
      normalizeEmail(email),
    email: normalizeEmail(email),
    fullName,
    displayName: fullName ?? email,
  };
}

export async function getSiteAccessRequestByEmail(
  d1: D1Database,
  email: string,
) {
  return d1
    .prepare(
      `SELECT id, user_id, email, full_name, status, approval_token_hash,
              requested_at_ms, email_sent_at_ms, decided_at_ms,
              decided_by_email, decision_note, created_at_ms, updated_at_ms
       FROM site_access_requests
       WHERE email = ?
       LIMIT 1`,
    )
    .bind(normalizeEmail(email))
    .first<SiteAccessRequestRow>();
}

export async function getSiteAccessStatus(
  d1: D1Database,
  email: string,
): Promise<SiteAccessStatus> {
  if (isSiteOwnerEmail(email)) return "approved";
  const row = await getSiteAccessRequestByEmail(d1, email);
  return row?.status ?? "not_requested";
}

export async function isApprovedSiteViewer(
  request: Request,
  d1: D1Database | null,
) {
  const user = requestUserFromHeaders(request.headers);
  if (!user) return false;
  if (isSiteOwnerEmail(user.email)) return true;
  if (!d1) return false;
  return (await getSiteAccessStatus(d1, user.email)) === "approved";
}

function generateAccessToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function createOrRefreshAccessRequest(
  d1: D1Database,
  user: ChatGPTUser,
) {
  const email = normalizeEmail(user.email);
  const existing = await getSiteAccessRequestByEmail(d1, email);
  if (existing?.status === "approved") {
    return {
      row: existing,
      status: "approved" as const,
      approvalToken: null,
      shouldSendEmail: false,
    };
  }

  const now = Date.now();
  if (
    existing?.status === "pending" &&
    existing.email_sent_at_ms &&
    now - existing.email_sent_at_ms < REQUEST_EMAIL_COOLDOWN_MS
  ) {
    return {
      row: existing,
      status: "pending" as const,
      approvalToken: null,
      shouldSendEmail: false,
    };
  }

  const approvalToken = generateAccessToken();
  const approvalTokenHash = await sha256Hex(approvalToken);
  const id = existing?.id ?? newId("access");
  await d1
    .prepare(
      `INSERT INTO site_access_requests (
        id, user_id, email, full_name, status, approval_token_hash,
        requested_at_ms, email_sent_at_ms, decided_at_ms, decided_by_email,
        decision_note, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        user_id = excluded.user_id,
        full_name = excluded.full_name,
        status = 'pending',
        approval_token_hash = excluded.approval_token_hash,
        requested_at_ms = excluded.requested_at_ms,
        email_sent_at_ms = NULL,
        decided_at_ms = NULL,
        decided_by_email = NULL,
        decision_note = NULL,
        updated_at_ms = excluded.updated_at_ms`,
    )
    .bind(
      id,
      user.id,
      email,
      user.fullName,
      approvalTokenHash,
      now,
      existing?.created_at_ms ?? now,
      now,
    )
    .run();

  const row = await getSiteAccessRequestByEmail(d1, email);
  if (!row) throw new Error("Access request could not be stored.");
  return {
    row,
    status: "pending" as const,
    approvalToken,
    shouldSendEmail: true,
  };
}

export async function markAccessRequestEmailSent(
  d1: D1Database,
  requestId: string,
) {
  await d1
    .prepare(
      `UPDATE site_access_requests
       SET email_sent_at_ms = ?, updated_at_ms = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(Date.now(), Date.now(), requestId)
    .run();
}

export async function getSiteAccessRequestByToken(
  d1: D1Database,
  token: string,
) {
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  return d1
    .prepare(
      `SELECT id, user_id, email, full_name, status, approval_token_hash,
              requested_at_ms, email_sent_at_ms, decided_at_ms,
              decided_by_email, decision_note, created_at_ms, updated_at_ms
       FROM site_access_requests
       WHERE approval_token_hash = ?
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<SiteAccessRequestRow>();
}

export async function decideSiteAccessRequest(
  d1: D1Database,
  token: string,
  decision: "approved" | "denied",
  ownerEmail: string,
) {
  const row = await getSiteAccessRequestByToken(d1, token);
  if (!row) return { ok: false as const, status: "not_found" as const };
  if (row.status !== "pending") {
    return {
      ok: true as const,
      status: row.status,
      row,
      changed: false,
    };
  }
  const now = Date.now();
  await d1
    .prepare(
      `UPDATE site_access_requests
       SET status = ?, decided_at_ms = ?, decided_by_email = ?,
           updated_at_ms = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(decision, now, normalizeEmail(ownerEmail), now, row.id)
    .run();
  const updated = await getSiteAccessRequestByEmail(d1, row.email);
  return {
    ok: true as const,
    status: decision,
    row: updated ?? row,
    changed: true,
  };
}

export function siteViewerUnauthorizedResponse() {
  return Response.json(
    {
      error: "请先登录并获得站点所有者批准。",
      status: "access_required",
    },
    {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
