/**
 * Paddle webhook handler for the monitor Worker.
 *
 * Owns the request plumbing and the D1 writes; the pure mapping and signature
 * verification live in lib/paddle-billing so they stay testable without a
 * Worker. The route is `POST /webhooks/paddle`.
 *
 * The three properties that matter here:
 *
 *   1. The body is verified raw — `request.text()` is passed straight to the
 *      verifier, never JSON-parsed first — because the signature covers the
 *      exact bytes Paddle sent. Stale signatures are rejected before any DB
 *      mutation.
 *
 *   2. Delivery is idempotent via the `billing_events` table keyed on Paddle's
 *      `event_id`. The first write claims the event; a duplicate delivery of an
 *      already-processed event is a 200 no-op, and an event that crashed
 *      mid-apply is reprocessed rather than silently dropped.
 *
 *   3. There are exactly two entitlement paths, matching Paddle's two billing
 *      shapes:
 *        - recurring  — every `subscription.*` event funnels through
 *          `syncSubscriptionFromEntity` (the authoritative state sync), and
 *        - one-time   — a non-recurring `transaction.completed` funnels through
 *          `oneTimeAccessFromTransaction`, guarded by `provider_transaction_id`
 *          uniqueness so one payment can never grant twice.
 *
 *      `transaction.completed` for a recurring charge is intentionally ignored:
 *      the subscription entity, not the transaction, drives recurring state.
 */

import { newId } from "../../lib/crypto";
import {
  customerIdFromEvent,
  customUserIdFromEvent,
  decideOneTimeGrant,
  oneTimeAccessFromTransaction,
  syncSubscriptionFromEntity,
  transactionIdFromData,
  verifyPaddleSignature,
  type PaddleNotification,
  type SubscriptionState,
} from "../../lib/paddle-billing";

/* Minimal structural D1 shape, kept local so this module has no dependency on
 * the worker's own interface declarations. Structurally compatible with both
 * the worker's `D1Database` and the ambient `D1Database`. */
interface WebhookD1Prepared {
  bind(...values: unknown[]): WebhookD1Prepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
interface WebhookD1 {
  prepare(query: string): WebhookD1Prepared;
}

export type PaddleWebhookEnv = {
  DB: WebhookD1;
  PADDLE_WEBHOOK_SECRET?: string;
  /** "sandbox" or "production". Asserted so a live key can't run a sandbox hook. */
  PADDLE_ENVIRONMENT?: string;
  /** The designated one-time annual price id; the only price that grants 365d. */
  PADDLE_PRICE_PRO_ONETIME_CNY?: string;
};

type EventRow = { status: string };

const noStore = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...noStore } });
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length ? value : null;

/** The user owning a Paddle customer, from the provider mapping or custom_data. */
async function resolveUserId(db: WebhookD1, event: PaddleNotification): Promise<string | null> {
  const customerId = customerIdFromEvent(event);
  if (customerId) {
    const mapped = await db
      .prepare(`SELECT user_id FROM billing_customers WHERE provider = 'paddle' AND provider_customer_id = ? LIMIT 1`)
      .bind(customerId)
      .first<{ user_id: string }>();
    if (mapped?.user_id) return mapped.user_id;
  }
  const custom = customUserIdFromEvent(event);
  if (custom) {
    const user = await db.prepare(`SELECT id FROM users WHERE id = ? LIMIT 1`).bind(custom).first<{ id: string }>();
    if (user?.id) return user.id;
  }
  return null;
}

/** Creates the provider mapping when a customer event can be matched by email. */
async function ensureCustomerMapping(db: WebhookD1, event: PaddleNotification, nowIso: string): Promise<boolean> {
  const customerId = customerIdFromEvent(event);
  const email = asString(event.data.email)?.trim().toLowerCase() ?? "";
  if (!customerId || !email) return false;

  const user = await db.prepare(`SELECT id FROM users WHERE email = ? LIMIT 1`).bind(email).first<{ id: string }>();
  if (!user?.id) return false;

  await db
    .prepare(
      `INSERT OR IGNORE INTO billing_customers
         (id, user_id, provider, provider_customer_id, created_at, updated_at)
       VALUES (?, ?, 'paddle', ?, ?, ?)`,
    )
    .bind(newId("billing"), user.id, customerId, nowIso, nowIso)
    .run();
  return true;
}

/** A recurring subscription row, found by its Paddle subscription id. */
async function findRecurring(db: WebhookD1, providerSubscriptionId: string) {
  return db
    .prepare(`SELECT id, access_until FROM subscriptions WHERE provider = 'paddle' AND provider_subscription_id = ? LIMIT 1`)
    .bind(providerSubscriptionId)
    .first<{ id: string; access_until: string | null }>();
}

/** The single one-time-annual row a user owns, if any. */
async function findOneTime(db: WebhookD1, userId: string) {
  return db
    .prepare(
      `SELECT id, access_until FROM subscriptions
        WHERE user_id = ? AND provider = 'paddle' AND billing_interval = 'one_time_365d' LIMIT 1`,
    )
    .bind(userId)
    .first<{ id: string; access_until: string | null }>();
}

/** Whether a one-time payment (by transaction id) was already applied, anywhere. */
async function transactionAlreadyApplied(db: WebhookD1, transactionId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM subscriptions WHERE provider = 'paddle' AND provider_transaction_id = ? LIMIT 1`)
    .bind(transactionId)
    .first<{ id: string }>();
  return Boolean(row?.id);
}

async function upsertRecurring(
  db: WebhookD1,
  userId: string,
  email: string,
  state: SubscriptionState,
  existing: { id: string } | null,
  nowIso: string,
): Promise<void> {
  const cancel = state.cancelAtPeriodEnd ? 1 : 0;
  if (existing) {
    await db
      .prepare(
        `UPDATE subscriptions SET
           user_id = ?, email = ?, status = ?, provider_customer_id = ?,
           billing_interval = ?, currency = ?, current_period_start = ?,
           current_period_end = ?, access_until = ?, cancel_at_period_end = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        userId,
        email,
        state.status,
        state.providerCustomerId,
        state.billingInterval,
        state.currency,
        state.currentPeriodStart,
        state.currentPeriodEnd,
        state.accessUntil,
        cancel,
        nowIso,
        existing.id,
      )
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO subscriptions
         (id, user_id, email, plan, status, provider, provider_customer_id,
          provider_subscription_id, provider_transaction_id, billing_interval,
          currency, current_period_start, current_period_end, access_until,
          cancel_at_period_end, founding_member, created_at, updated_at)
       VALUES (?, ?, ?, 'PRO', ?, 'paddle', ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      newId("sub"),
      userId,
      email,
      state.status,
      state.providerCustomerId,
      state.providerSubscriptionId,
      state.billingInterval,
      state.currency,
      state.currentPeriodStart,
      state.currentPeriodEnd,
      state.accessUntil,
      cancel,
      nowIso,
      nowIso,
    )
    .run();
}

/** Applies a one-time state. Returns true when it extended access. */
async function upsertOneTime(
  db: WebhookD1,
  userId: string,
  email: string,
  state: SubscriptionState,
  existing: { id: string } | null,
  nowIso: string,
): Promise<boolean> {
  const cancel = state.cancelAtPeriodEnd ? 1 : 0;
  if (existing) {
    // The provider_transaction_id guard makes the extension idempotent: if this
    // exact payment already set the window, the UPDATE matches nothing.
    const result = await db
      .prepare(
        `UPDATE subscriptions SET
           status = ?, provider_customer_id = ?, provider_transaction_id = ?, currency = ?,
           current_period_start = ?, current_period_end = ?, access_until = ?,
           cancel_at_period_end = ?, updated_at = ?
         WHERE id = ? AND (provider_transaction_id IS NULL OR provider_transaction_id <> ?)`,
      )
      .bind(
        state.status,
        state.providerCustomerId,
        state.providerTransactionId,
        state.currency,
        state.currentPeriodStart,
        state.currentPeriodEnd,
        state.accessUntil,
        cancel,
        nowIso,
        existing.id,
        state.providerTransactionId,
      )
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  await db
    .prepare(
      `INSERT INTO subscriptions
         (id, user_id, email, plan, status, provider, provider_customer_id,
          provider_subscription_id, provider_transaction_id, billing_interval,
          currency, current_period_start, current_period_end, access_until,
          cancel_at_period_end, founding_member, created_at, updated_at)
       VALUES (?, ?, ?, 'PRO', ?, 'paddle', ?, NULL, ?, 'one_time_365d', ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      newId("sub"),
      userId,
      email,
      state.status,
      state.providerCustomerId,
      state.providerTransactionId,
      state.currency,
      state.currentPeriodStart,
      state.currentPeriodEnd,
      state.accessUntil,
      cancel,
      nowIso,
      nowIso,
    )
    .run();
  return true;
}

export async function handlePaddleWebhook(request: Request, env: PaddleWebhookEnv): Promise<Response> {
  const secret = env.PADDLE_WEBHOOK_SECRET?.trim() ?? "";
  const rawBody = await request.text();

  const valid = await verifyPaddleSignature({
    secret,
    rawBody,
    signatureHeader: request.headers.get("Paddle-Signature"),
  });
  if (!valid) return json({ received: false, error: "invalid_signature" }, 401);

  let event: PaddleNotification;
  try {
    event = JSON.parse(rawBody) as PaddleNotification;
  } catch {
    return json({ received: false, error: "invalid_json" }, 400);
  }
  if (!event?.event_id || !event?.event_type || !event?.data) {
    return json({ received: false, error: "missing_fields" }, 400);
  }

  const nowIso = new Date().toISOString();
  const db = env.DB;

  /* --- claim the event (idempotency) ------------------------------- */
  const claimed = await db
    .prepare(
      `INSERT OR IGNORE INTO billing_events
         (id, provider, event_type, provider_customer_id, provider_subscription_id, provider_transaction_id, received_at, status)
       VALUES (?, 'paddle', ?, ?, ?, ?, ?, 'received')`,
    )
    .bind(
      event.event_id,
      event.event_type,
      asString(event.data.customer_id),
      asString(event.data.subscription_id),
      transactionIdFromData(event.data),
      nowIso,
    )
    .run();

  if ((claimed.meta?.changes ?? 0) === 0) {
    const prior = await db.prepare(`SELECT status FROM billing_events WHERE id = ? LIMIT 1`).bind(event.event_id).first<EventRow>();
    if (prior?.status === "processed") return json({ received: true, duplicate: true });
    // status 'received' or 'error': a prior attempt crashed before applying, so
    // fall through and reprocess. The upserts below converge, so this is safe.
  }

  const markProcessed = () =>
    db.prepare(`UPDATE billing_events SET status = 'processed', processed_at = ? WHERE id = ?`).bind(nowIso, event.event_id).run();
  const markIgnored = (note?: string) =>
    db
      .prepare(`UPDATE billing_events SET status = 'ignored', note = ?, processed_at = ? WHERE id = ?`)
      .bind(note ?? null, nowIso, event.event_id)
      .run();
  const markError = (message: string) =>
    db
      .prepare(`UPDATE billing_events SET status = 'error', note = ? WHERE id = ?`)
      .bind(message.slice(0, 500), event.event_id)
      .run();

  const eventType = event.event_type;

  /* --- customer mapping (optional; created server-side anyway) ------ */
  if (eventType === "customer.created" || eventType === "customer.updated") {
    await ensureCustomerMapping(db, event, nowIso);
    await markProcessed();
    return json({ received: true });
  }

  try {
    /* --- recurring: subscription.* is the single authoritative path --- */
    if (eventType.startsWith("subscription.")) {
      const subscriptionId = asString(event.data.id);
      if (!subscriptionId) {
        await markIgnored("subscription event without a subscription id");
        return json({ received: true, ignored: true });
      }
      const existing = await findRecurring(db, subscriptionId);
      const state = syncSubscriptionFromEntity(event.data, existing?.access_until ?? null);
      if (!state) {
        await markIgnored("unrecognized subscription status or billing_cycle");
        return json({ received: true, ignored: true });
      }
      const userId = await resolveUserId(db, event);
      if (!userId) {
        await markIgnored("no billing_customers mapping and no custom_data user");
        return json({ received: true, ignored: true, reason: "unmapped" });
      }
      const email = (await db.prepare(`SELECT email FROM users WHERE id = ? LIMIT 1`).bind(userId).first<{ email: string }>())?.email ?? "";
      await upsertRecurring(db, userId, email, state, existing, nowIso);
      await markProcessed();
      return json({ received: true });
    }

    /* --- one-time: a non-recurring transaction.completed -------------- */
    if (eventType === "transaction.completed") {
      // A one-time grant requires the transaction to be exactly the designated
      // one-time purchase: no subscription id, a single line item at quantity 1,
      // and that item's price id equal to the designated one-time price. A
      // recurring charge, a missing config, an unrelated price, a quantity other
      // than 1, or a basket with unexpected extra items all record safely and
      // grant nothing.
      const designatedPrice = env.PADDLE_PRICE_PRO_ONETIME_CNY?.trim() ?? "";
      const decision = decideOneTimeGrant(event.data, designatedPrice);
      if (!decision.granted) {
        await markIgnored(`transaction.completed: ${decision.reason}`);
        return json({ received: true, ignored: true });
      }

      const transactionId = transactionIdFromData(event.data) ?? event.event_id;
      if (await transactionAlreadyApplied(db, transactionId)) {
        await markProcessed();
        return json({ received: true, duplicate: true });
      }
      const userId = await resolveUserId(db, event);
      if (!userId) {
        await markIgnored("no billing_customers mapping and no custom_data user");
        return json({ received: true, ignored: true, reason: "unmapped" });
      }
      const email = (await db.prepare(`SELECT email FROM users WHERE id = ? LIMIT 1`).bind(userId).first<{ email: string }>())?.email ?? "";
      const existing = await findOneTime(db, userId);
      const state = oneTimeAccessFromTransaction(event, existing?.access_until ?? null);
      if (!state) {
        await markIgnored("unusable transaction timestamps");
        return json({ received: true, ignored: true });
      }
      await upsertOneTime(db, userId, email, state, existing, nowIso);
      await markProcessed();
      return json({ received: true });
    }

    /* --- everything else (recurring transaction.completed, failed, …) --- */
    await markIgnored("not an entitlement-mutating event");
    return json({ received: true, ignored: true });
  } catch (caught) {
    await markError(caught instanceof Error ? caught.message : "Unknown failure");
    return json({ received: false, error: "apply_failed" }, 500);
  }
}
