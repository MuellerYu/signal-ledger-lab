/**
 * Stripe billing — pure mapping and verification, no I/O.
 *
 * The webhook handler (monitor-worker/src/stripe-webhook.ts) owns the request
 * plumbing and the D1 writes; this module owns the two pieces that must stay
 * testable without a Worker and without a live Stripe account:
 *
 *   1. Signature verification. Stripe signs `"{timestamp}.{rawBody}"` with the
 *      webhook endpoint secret (`whsec_...`, HMAC-SHA256) and puts the digest in
 *      a `Stripe-Signature: t=...;v1=...` header (older `v1` values may appear
 *      during secret rotation). The raw body must be compared byte-for-byte —
 *      never re-serialized — or the signature will not match.
 *
 *   2. The subscription → local-state mapping. One canonical function
 *      (`syncSubscriptionFromStripe`) turns any Stripe subscription object into
 *      the local `subscriptions` row state, so no two event handlers invent
 *      competing entitlement logic.
 *
 * `crypto.subtle` is used directly (available in Workers and in Node ≥ 22, where
 * the test suite runs), so this module bundles into the worker and into tests.
 */

/* ------------------------------------------------------------------ types */

/** The local subscription statuses, mirroring the D1 CHECK constraint. */
export type StripeSubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "paused"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid";

/** The subscription row state a Stripe subscription object produces. */
export type StripeSubscriptionState = {
  providerSubscriptionId: string;
  providerCustomerId: string | null;
  status: StripeSubscriptionStatus;
  billingInterval: "month" | "year" | null;
  currency: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  accessUntil: string | null;
  /** Scheduled-cancellation timestamp (`cancel_at`), or null. Informational only. */
  cancelAt: string | null;
  cancelAtPeriodEnd: boolean;
};

/* ------------------------------------------------------------------ signature */

export type StripeSignatureParts = { ts: string; v1: string[] };

/** Parses `t=...;v1=...;v1=...` (rotation can emit more than one `v1`). */
export function parseStripeSignature(header: string | null): StripeSignatureParts | null {
  if (!header) return null;
  let ts: string | null = null;
  const signatures: string[] = [];
  for (const segment of header.split(",")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (key === "t" && value) ts = value;
    else if (key === "v1" && value) signatures.push(value);
  }
  if (!ts || signatures.length === 0) return null;
  return { ts, v1: signatures };
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Length-safe string comparison, so a digest mismatch leaks no timing signal. */
export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Verifies a Stripe-Signature header against the raw request body.
 *
 * Accepts any `v1` value (secret rotation), rejects stale timestamps before the
 * caller touches the database, and compares digests in constant time.
 */
export async function verifyStripeSignature(input: {
  secret: string;
  rawBody: string;
  signatureHeader: string | null;
  nowMs?: number;
  toleranceMs?: number;
}): Promise<boolean> {
  const parts = parseStripeSignature(input.signatureHeader);
  if (!parts || !input.secret) return false;

  const nowMs = input.nowMs ?? Date.now();
  const toleranceMs = input.toleranceMs ?? 5 * 60 * 1_000;

  const timestampSec = Number(parts.ts);
  if (!Number.isFinite(timestampSec)) return false;
  if (Math.abs(nowMs - timestampSec * 1_000) > toleranceMs) return false;

  const expected = await hmacSha256Hex(input.secret, `${parts.ts}.${input.rawBody}`);
  return parts.v1.some((signature) => constantTimeEqual(expected, signature));
}

/* ------------------------------------------------------------------ helpers */

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length ? value : null;

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** A Stripe unix timestamp (seconds) as an ISO string, or null. */
function unixToIso(seconds: unknown): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1_000).toISOString();
}

/** The later of two ISO timestamps. Never shortens. */
function laterIso(a: string | null, b: string | null): string | null {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta >= tb ? (a as string) : (b as string);
  if (Number.isFinite(ta)) return a;
  if (Number.isFinite(tb)) return b;
  return null;
}

/** Maps a Stripe subscription status to a local status, or null when unknown. */
export function mapStripeStatus(raw: unknown): StripeSubscriptionStatus | null {
  switch (asString(raw)) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "paused":
      return "paused";
    case "incomplete":
      return "incomplete";
    case "incomplete_expired":
      return "incomplete_expired";
    case "unpaid":
      return "unpaid";
    default:
      return null;
  }
}

/** The recurring interval from the first line item's price, when it is month/year. */
function billingIntervalFromStripe(subscription: Record<string, unknown>): "month" | "year" | null {
  const items = asObject(subscription.items);
  const data = Array.isArray(items.data) ? (items.data as Array<Record<string, unknown>>) : [];
  const price = asObject(asObject(data[0]).price);
  const interval = asString(asObject(price.recurring).interval);
  if (interval === "month") return "month";
  if (interval === "year") return "year";
  return null;
}

/**
 * The subscription's billing period. Since API version `2025-03-31.basil`, the
 * `current_period_start` / `current_period_end` fields were REMOVED from the
 * Subscription object and moved onto each subscription item (`items.data[]`).
 * This reads the earliest start and latest end across items, then falls back to
 * the legacy top-level fields so events from an older API version still map.
 */
function periodFromStripe(subscription: Record<string, unknown>): {
  start: string | null;
  end: string | null;
} {
  const items = asObject(subscription.items);
  const data = Array.isArray(items.data) ? (items.data as Array<Record<string, unknown>>) : [];

  let start: string | null = null;
  let end: string | null = null;
  for (const item of data) {
    const itemStart = unixToIso(item.current_period_start);
    const itemEnd = unixToIso(item.current_period_end);
    if (itemStart && (start === null || itemStart < start)) start = itemStart;
    if (itemEnd && (end === null || itemEnd > end)) end = itemEnd;
  }

  // Legacy API versions (< 2025-03-31.basil) keep the period at the top level.
  if (start === null) start = unixToIso(subscription.current_period_start);
  if (end === null) end = unixToIso(subscription.current_period_end);

  return { start, end };
}

/* ------------------------------------------------------------------ mapping */

/**
 * The single canonical subscription sync. Turns a Stripe subscription object
 * (from `customer.subscription.created` / `.updated` / `.deleted`) into the
 * local row state. There is no other mapping path, so events cannot compete.
 *
 * Access follows the existing `access_until`-is-the-arbiter rule:
 *
 *   - `active` / `trialing`        → extend to the later of the period end and
 *                                    the existing window.
 *   - `past_due`                   → preserve the existing window only; never
 *                                    invent new paid time.
 *   - `paused`                     → preserve the already-paid period; never extend.
 *   - `canceled`                   → preserve the already-paid period end
 *                                    (`cancel_at_period_end` never revokes early).
 *   - `incomplete` / `incomplete_expired` / `unpaid`
 *                                  → no access. These must never grant PRO.
 */
export function syncSubscriptionFromStripe(
  subscription: Record<string, unknown>,
  existingAccessUntil: string | null,
): StripeSubscriptionState | null {
  const subscriptionId = asString(subscription.id);
  const status = mapStripeStatus(subscription.status);
  if (!subscriptionId || !status) return null;

  const { start: periodStart, end: periodEnd } = periodFromStripe(subscription);
  const trialEnd = unixToIso(subscription.trial_end);
  const paidThrough = periodEnd ?? trialEnd;

  let accessUntil: string | null;
  switch (status) {
    case "active":
    case "trialing":
      accessUntil = laterIso(paidThrough, existingAccessUntil);
      break;
    case "past_due":
      accessUntil = existingAccessUntil; // never invent new paid time
      break;
    case "paused":
      accessUntil = existingAccessUntil ?? paidThrough; // keep the paid period, no extension
      break;
    case "canceled":
      accessUntil = laterIso(paidThrough, existingAccessUntil); // paid-through preserved
      break;
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
      accessUntil = null; // unearned access must not be granted
      break;
    default:
      accessUntil = existingAccessUntil;
  }

  return {
    providerSubscriptionId: subscriptionId,
    providerCustomerId: asString(subscription.customer),
    status,
    billingInterval: billingIntervalFromStripe(subscription),
    currency: asString(subscription.currency)?.toUpperCase() ?? null,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    accessUntil,
    // `cancel_at` (a future unix timestamp) is the scheduled-cancellation form
    // that coexists with `cancel_at_period_end: false`. It is purely
    // informational: access is still decided by `access_until`.
    cancelAt: unixToIso(subscription.cancel_at),
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
  };
}

/* ------------------------------------------------------------------ events */

export type StripeEvent = {
  id: string;
  type: string;
  data?: { object?: Record<string, unknown> };
};

/** The `data.object` of an event, when there is one. */
export function eventObject(event: StripeEvent): Record<string, unknown> {
  return asObject(asObject(event.data).object);
}

/** The Stripe customer id an event's object carries, when present. */
export function customerIdFromObject(object: Record<string, unknown>): string | null {
  return asString(object.customer);
}

/** The subscription id an event's object carries, when present. */
export function subscriptionIdFromObject(object: Record<string, unknown>): string | null {
  return asString(object.subscription) ?? asString(object.id);
}

/** The later paid-through timestamp across an invoice's lines, as ISO. */
export function paidThroughFromInvoice(invoice: Record<string, unknown>): string | null {
  const lines = asObject(invoice.lines);
  const data = Array.isArray(lines.data) ? (lines.data as Array<Record<string, unknown>>) : [];
  let latest: string | null = null;
  for (const line of data) {
    const period = asObject(line.period);
    const end = unixToIso(period.end);
    latest = laterIso(latest, end);
  }
  return latest;
}

/** The caller-supplied user id in an object's metadata, if any. */
export function userIdFromMetadata(object: Record<string, unknown>): string | null {
  const metadata = asObject(object.metadata);
  return asString(metadata.signal_ledger_user_id) ?? asString(object.client_reference_id);
}

/** The access window an `invoice.paid` produces: never shorter than the current one. */
export function extendAccessFromInvoice(
  existingAccessUntil: string | null,
  invoice: Record<string, unknown>,
): string | null {
  return laterIso(existingAccessUntil, paidThroughFromInvoice(invoice));
}
