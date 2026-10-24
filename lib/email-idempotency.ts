/**
 * Provider-side idempotency keys for outbound email.
 *
 * There are two different questions here and they must not be conflated.
 *
 * Local (business) dedup answers "has this logical job already been handled?".
 * It stays exactly as it is — the Daily Brief keys a job on sessionDate +
 * recipient, and INSERT OR IGNORE makes a second send structurally impossible.
 * Nothing in this file changes that.
 *
 * Provider dedup answers a narrower question: "is this the same HTTP request
 * I already accepted?". Resend answers it by comparing the request body against
 * the one it stored under the Idempotency-Key, and rejects a mismatch with 409
 * invalid_idempotent_request rather than sending. So a job id that is stable by
 * design — and the brief's is deliberately stable — cannot be used bare as the
 * provider key: the moment the job is legitimately recreated with new content,
 * the provider refuses it.
 *
 * The key is therefore the job id plus a fingerprint of the exact payload that
 * will be transmitted:
 *
 *   same job + same bytes      -> same key      (a retry dedupes, as before)
 *   same job + different bytes -> different key (the new content goes out)
 *
 * It is deterministic — no clock, no randomness — so the first property holds
 * across process restarts, machines and retry attempts alike.
 *
 * Two kinds of value never enter the fingerprint. Secrets, because the key
 * travels to the provider as a header: a body the sender derives at send time
 * from a credential (the auth-link magic token) is represented by its body mode
 * instead, so no token-derived value ever leaves the worker. And volatile
 * fields, because a value that differs between two attempts on the same job
 * would silently defeat provider dedup.
 */

import { canonicalJson, sha256Hex } from "./crypto";

/** Exactly the fields that make up one outbound email. */
export interface EmailPayloadFingerprint {
  /** Envelope sender as transmitted. */
  from: string;
  /** Recipient list as stored on the job, before splitting. */
  recipient: string;
  subject: string;
  /**
   * How the body is produced: the stored body, or a marker such as
   * "derived_auth_link" for a body rebuilt from a secret at send time.
   */
  bodyMode: string;
  /** Body as transmitted; empty when the body is derived at send time. */
  text: string;
  html: string;
}

/** Resend rejects an Idempotency-Key longer than 256 characters. */
const MAX_KEY_LENGTH = 256;
/** 256 minus the "." separator and the 64-character hex fingerprint. */
const MAX_JOB_ID_LENGTH = MAX_KEY_LENGTH - 1 - 64;

export const DERIVED_AUTH_LINK_BODY_MODE = "derived_auth_link";

/**
 * The value to send as the provider's Idempotency-Key for one outbound email.
 *
 * `jobId` is the caller's own stable identity for the job; `payload` must
 * describe the bytes about to be transmitted, with any secret-derived body
 * replaced by its body mode.
 */
export async function providerIdempotencyKey(
  jobId: string,
  payload: EmailPayloadFingerprint,
): Promise<string> {
  // canonicalJson sorts keys, so the fingerprint survives a reordering of the
  // fields above and stays stable for a payload that has not actually changed.
  const fingerprint = await sha256Hex(canonicalJson(payload));
  const job = jobId.trim();
  // Job ids are short in practice. Hashing an over-long one keeps the key inside
  // the provider's limit, where a raw concatenation would be truncated into
  // colliding keys and quietly stop deduplicating.
  const idPart = job.length <= MAX_JOB_ID_LENGTH ? job : await sha256Hex(job);
  return `${idPart}.${fingerprint}`;
}

/** The shape of a queued email job, as the sender sees it. */
export interface EmailJobForFingerprint {
  /** The job's own stable id — the business dedup key. */
  id: string;
  recipient: string;
  subject: string;
  textBody?: string | null;
  htmlBody?: string | null;
  fromAddress?: string | null;
  /** "stored" when the body travels with the job; the local body mode otherwise. */
  bodyMode?: string | null;
}

/**
 * Maps a queued job onto the fingerprint of what will actually be transmitted.
 *
 * A body the sender rebuilds from a secret at send time is represented by its
 * body mode, never by its bytes: the magic link is deterministic per job, so
 * the mode is just as stable a fingerprint, and the token stays in the worker.
 */
export function emailJobFingerprint(job: EmailJobForFingerprint): EmailPayloadFingerprint {
  const bodyMode = job.bodyMode?.trim() || "stored";
  const derived = bodyMode === DERIVED_AUTH_LINK_BODY_MODE;
  return {
    from: job.fromAddress?.trim() ?? "",
    recipient: job.recipient,
    subject: job.subject,
    bodyMode,
    text: derived ? "" : job.textBody ?? "",
    html: derived ? "" : job.htmlBody ?? "",
  };
}

/** The provider Idempotency-Key for one queued job. */
export async function emailJobIdempotencyKey(job: EmailJobForFingerprint): Promise<string> {
  return providerIdempotencyKey(job.id, emailJobFingerprint(job));
}
