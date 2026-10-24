/**
 * Paddle billing — pure mapping and verification, no I/O.
 *
 * The webhook handler (monitor-worker/src/paddle-webhook.ts) owns the D1 writes
 * and the request plumbing; this module owns the two pieces that must stay
 * testable without a Worker and without a live Paddle account:
 *
 *   1. Signature verification. Paddle signs `"{ts}:{rawBody}"` with the
 *      notification-destination secret (HMAC-SHA256) and puts the digest in a
 *      `Paddle-Signature: ts=...;h1=...` header. The raw body must be compared
 *      byte-for-byte — never re-serialized — or the signature will not match.
 *      During secret rotation Paddle sends multiple `h1` values, so any match
 *      succeeds.
 *
 *   2. The event → subscription-state mapping. There are exactly two billing
 *      shapes, and therefore exactly two mutation paths:
 *        - recurring — driven only by the subscription entity itself
 *          (`subscription.created` / `subscription.updated` and the optional
 *          lifecycle events all funnel through `syncSubscriptionFromEntity`),
 *        - one-time — driven only by a `transaction.completed` whose items are
 *          non-recurring (`oneTimeAccessFromTransaction`).
 *
 *      Nothing here writes; the worker applies the result.
 *
 * `crypto.subtle` is used directly (available in Workers and in Node ≥ 22, where
 * the test suite runs), so this module bundles into the worker and into tests.
 */

/* ------------------------------------------------------------------ types */

/** The top-level shape of a Paddle notification. */
export type PaddleNotification = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  notification_id?: string;
  data: Record<string, unknown>;
};

/** The billing intervals this system understands. */
export type PaddleBillingInterval = "month" | "year" | "one_time_365d";

/** Local subscription statuses, mirroring the D1 CHECK constraint (incl. paused). */
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "expired" | "paused";

/** The subscription row state an event produces, ready to upsert. */
export type SubscriptionState = {
  providerSubscriptionId: string | null;
  providerTransactionId: string | null;
  providerCustomerId: string | null;
  status: SubscriptionStatus;
  billingInterval: PaddleBillingInterval;
  currency: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  accessUntil: string | null;
  cancelAtPeriodEnd: boolean;
};

export const ONE_TIME_365D_MS = 365 * 24 * 60 * 60 * 1_000;

/* ------------------------------------------------------------------ signature */

export type PaddleSignatureParts = { ts: string; h1: string[] };

/** Parses `ts=...;h1=...;h1=...` (rotation emits more than one `h1`). */
export function parsePaddleSignature(header: string | null): PaddleSignatureParts | null {
  if (!header) return null;
  let ts: string | null = null;
  const signatures: string[] = [];
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (key === "ts" && value) ts = value;
    else if (key === "h1" && value) signatures.push(value);
  }
  if (!ts || signatures.length === 0) return null;
  return { ts, h1: signatures };
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
 * Verifies a Paddle-Signature header against the raw request body.
 *
 * Accepts any `h1` value (secret rotation), rejects stale timestamps before the
 * caller touches the database, and compares digests in constant time.
 */
export async function verifyPaddleSignature(input: {
  secret: string;
  rawBody: string;
  signatureHeader: string | null;
  nowMs?: number;
  toleranceMs?: number;
}): Promise<boolean> {
  const parts = parsePaddleSignature(input.signatureHeader);
  if (!parts || !input.secret) return false;

  const nowMs = input.nowMs ?? Date.now();
  const toleranceMs = input.toleranceMs ?? 5 * 60 * 1_000;

  const timestampSec = Number(parts.ts);
  if (!Number.isFinite(timestampSec)) return false;
  if (Math.abs(nowMs - timestampSec * 1_000) > toleranceMs) return false;

  const expected = await hmacSha256Hex(input.secret, `${parts.ts}:${input.rawBody}`);
  return parts.h1.some((signature) => constantTimeEqual(expected, signature));
}

/* ------------------------------------------------------------------ helpers */

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length ? value : null;

const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** The later of two RFC 3339 timestamps, as an ISO string. Never shortens. */
function later(a: string | null, b: string | null): string | null {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta >= tb ? (a as string) : (b as string);
  if (Number.isFinite(ta)) return a;
  if (Number.isFinite(tb)) return b;
  return null;
}

function billingIntervalFromCycle(cycle: unknown): PaddleBillingInterval | null {
  const interval = asString(asObject(cycle).interval);
  if (interval === "month") return "month";
  if (interval === "year") return "year";
  return null;
}

function mapStatus(raw: unknown): SubscriptionStatus | null {
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
    default:
      return null;
  }
}

/** `current_billing_period.ends_at` — the end of the period Paddle has billed. */
function periodEnd(data: Record<string, unknown>): string | null {
  return asString(asObject(data.current_billing_period).ends_at);
}

function periodStart(data: Record<string, unknown>): string | null {
  return asString(asObject(data.current_billing_period).starts_at);
}

/** `next_billed_at` is the trial/cancel anchor when there is no paid period. */
function nextBilledAt(data: Record<string, unknown>): string | null {
  return asString(data.next_billed_at);
}

/** The Paddle transaction id from an entity snapshot, when it is one. */
export function transactionIdFromData(data: Record<string, unknown>): string | null {
  const id = asString(data.id);
  return id?.startsWith("txn_") ? id : null;
}

/** The price ids in a transaction's line items, in order. */
export function priceIdsFromTransaction(data: Record<string, unknown>): string[] {
  const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
  const ids: string[] = [];
  for (const item of items) {
    const price = asObject(asObject(item).price);
    const id = asString(price.id);
    if (id) ids.push(id);
  }
  return ids;
}

/** A parsed transaction line item, for one-time validation. */
export type OneTimeItem = { priceId: string | null; quantity: number };

/** The transaction line items, parsed into price id + quantity. */
export function oneTimeItems(data: Record<string, unknown>): OneTimeItem[] {
  const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
  const parsed: OneTimeItem[] = [];
  for (const raw of items) {
    const item = asObject(raw);
    const price = asObject(item.price);
    const rawQuantity = item.quantity;
    const quantity = typeof rawQuantity === "number" ? rawQuantity : Number(rawQuantity);
    parsed.push({
      priceId: asString(price.id),
      // Paddle defaults a missing quantity to 1; a non-positive value is not a
      // meaningful "one" purchase, so normalize it to the rejecting sentinel 0.
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    });
  }
  return parsed;
}

/* ------------------------------------------------------------------ mapping */

/**
 * Recurring sync: derives the subscription row state from a subscription
 * entity snapshot, whatever the `subscription.*` event that carried it.
 *
 * `subscription.updated` is the authoritative path; `subscription.created`,
 * `subscription.activated`, `subscription.canceled`, `subscription.past_due`,
 * `subscription.paused`, `subscription.resumed` and `subscription.trialing` all
 * carry the same entity and funnel through here, so there is no competing
 * mutation logic.
 *
 * `existingAccessUntil` is the row's current window. Extending statuses move it
 * forward (never backward); `past_due`, `canceled` and `paused` preserve it.
 */
export function syncSubscriptionFromEntity(
  data: Record<string, unknown>,
  existingAccessUntil: string | null,
): SubscriptionState | null {
  const subscriptionId = asString(data.id);
  const status = mapStatus(data.status);
  const interval = billingIntervalFromCycle(data.billing_cycle);
  if (!subscriptionId || !status || !interval) return null;

  const paidThrough = periodEnd(data) ?? nextBilledAt(data);
  const scheduledAction = asString(asObject(data.scheduled_change).action);
  const extend = status === "active" || status === "trialing";

  return {
    providerSubscriptionId: subscriptionId,
    providerTransactionId: null,
    providerCustomerId: asString(data.customer_id),
    status,
    billingInterval: interval,
    currency: asString(data.currency_code),
    currentPeriodStart: periodStart(data),
    currentPeriodEnd: periodEnd(data),
    accessUntil: extend ? later(paidThrough, existingAccessUntil) : existingAccessUntil ?? paidThrough,
    cancelAtPeriodEnd: status === "canceled" || scheduledAction === "cancel",
  };
}

/** Whether a transaction is a one-time (non-recurring) purchase. */
export function isOneTimeTransaction(data: Record<string, unknown>): boolean {
  if (asString(data.subscription_id)) return false;
  const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
  for (const item of items) {
    const price = asObject(asObject(item).price);
    if (asString(asObject(price.billing_cycle).interval)) return false;
  }
  return true;
}

export type OneTimeGrantDecision = { granted: true } | { granted: false; reason: string };

/**
 * The strict gate for a one-time grant. A `transaction.completed` grants PRO
 * only when it is exactly the designated one-time purchase:
 *
 *   - no `subscription_id` (recurring charges are driven by `subscription.*`),
 *   - a single line item,
 *   - that item's price id equals `designatedPriceId`,
 *   - and its quantity is exactly 1.
 *
 * A basket carrying the designated price alongside any other item — or a
 * quantity other than 1 — is rejected, not granted, so an unexpected basket can
 * never silently mint entitlement.
 */
export function decideOneTimeGrant(
  data: Record<string, unknown>,
  designatedPriceId: string,
): OneTimeGrantDecision {
  if (!designatedPriceId) return { granted: false, reason: "no designated one-time price configured" };
  if (asString(data.subscription_id)) return { granted: false, reason: "transaction carries a subscription_id" };
  if (!isOneTimeTransaction(data)) return { granted: false, reason: "transaction has a recurring line item" };
  const items = oneTimeItems(data);
  if (items.length === 0) return { granted: false, reason: "transaction has no line items" };
  if (items.length !== 1) return { granted: false, reason: "transaction has unexpected extra items" };
  const item = items[0];
  if (item.priceId !== designatedPriceId) return { granted: false, reason: "transaction price is not the designated one-time price" };
  if (item.quantity !== 1) return { granted: false, reason: "transaction quantity is not 1" };
  return { granted: true };
}

/**
 * One-time sync: a non-recurring `transaction.completed` grants exactly 365
 * days measured from `max(existing access, payment time)`.
 *
 *   - first purchase          → paid_at + 365d
 *   - early renewal           → preserves remaining paid time, then + 365d
 *   - expired user            → payment time + 365d
 *
 * "The same payment never extends twice" is NOT enforced here (the formula
 * alone would double-extend a replayed payment); the worker enforces it via
 * `provider_transaction_id` uniqueness before applying.
 */
export function oneTimeAccessFromTransaction(
  event: PaddleNotification,
  existingAccessUntil: string | null,
): SubscriptionState | null {
  const paidAtMs = Date.parse(event.occurred_at);
  const existingMs = existingAccessUntil ? Date.parse(existingAccessUntil) : NaN;
  const baseMs = Math.max(
    Number.isFinite(paidAtMs) ? paidAtMs : 0,
    Number.isFinite(existingMs) ? existingMs : 0,
  );
  if (baseMs <= 0) return null;

  const accessUntil = new Date(baseMs + ONE_TIME_365D_MS).toISOString();
  return {
    providerSubscriptionId: null,
    providerTransactionId: transactionIdFromData(event.data) ?? event.event_id,
    providerCustomerId: asString(event.data.customer_id),
    status: "active",
    billingInterval: "one_time_365d",
    currency: asString(event.data.currency_code),
    currentPeriodStart: event.occurred_at,
    currentPeriodEnd: accessUntil,
    accessUntil,
    cancelAtPeriodEnd: false,
  };
}

/** The customer identity an event carries, if any. */
export function customerIdFromEvent(event: PaddleNotification): string | null {
  return asString(event.data.customer_id);
}

/** A caller-supplied user id in custom_data, for the fallback mapping path. */
export function customUserIdFromEvent(event: PaddleNotification): string | null {
  const customData = asObject(event.data.custom_data);
  return asString(customData.userId) ?? asString(customData.user_id);
}
