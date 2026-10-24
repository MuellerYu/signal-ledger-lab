/**
 * Stripe webhook handler for the monitor Worker.
 *
 * Owns the request plumbing and the D1 writes; the pure mapping and signature
 * verification live in lib/stripe-billing so they stay testable without a
 * Worker. The route is `POST /webhooks/stripe`.
 *
 * The three properties that matter here:
 *
 *   1. The body is verified raw — `request.text()` is passed straight to the
 *      verifier, never JSON-parsed first — because the signature covers the
 *      exact bytes Stripe sent. Stale or mismatched signatures are rejected
 *      before any database mutation.
 *
 *   2. Delivery is idempotent via the `billing_events` table keyed on Stripe's
 *      event id (`evt_...`). The first write claims the event; a duplicate
 *      delivery of an already-processed event is a 200 no-op, and an event that
 *      crashed mid-apply is reprocessed rather than silently dropped.
 *
 *   3. There is exactly ONE entitlement path for subscriptions:
 *      `syncSubscriptionFromStripe` in lib/stripe-billing. Every
 *      `customer.subscription.*` event funnels through it, so no two events can
 *      compete over entitlement. `checkout.session.completed` establishes the
 *      customer mapping but NEVER grants PRO — the browser's success redirect
 *      grants nothing, and only webhook-confirmed server state is authoritative.
 */

import { newId } from "../../lib/crypto";
import {
  customerIdFromObject,
  eventObject,
  extendAccessFromInvoice,
  subscriptionIdFromObject,
  syncSubscriptionFromStripe,
  userIdFromMetadata,
  verifyStripeSignature,
  type StripeEvent,
  type StripeSubscriptionState,
} from "../../lib/stripe-billing";

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

export type StripeWebhookEnv = {
  DB: WebhookD1;
  STRIPE_WEBHOOK_SECRET?: string;
};

type EventRow = { status: string };

const noStore = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...noStore } });
}

/** Resolves the user an event object belongs to: the provider mapping first, then metadata. */
async function resolveUserId(db: WebhookD1, object: Record<string, unknown>): Promise<string | null> {
  const customerId = customerIdFromObject(object);
  if (customerId) {
    const mapped = await db
      .prepare(`SELECT user_id FROM billing_customers WHERE provider = 'stripe' AND provider_customer_id = ? LIMIT 1`)
      .bind(customerId)
      .first<{ user_id: string }>();
    if (mapped?.user_id) return mapped.user_id;
  }
  const metadataUserId = userIdFromMetadata(object);
  if (metadataUserId) {
    const user = await db.prepare(`SELECT id FROM users WHERE id = ? LIMIT 1`).bind(metadataUserId).first<{ id: string }>();
    if (user?.id) return user.id;
  }
  return null;
}

/** Persists the customer mapping when a user id and Stripe customer id are both known. */
async function establishMapping(
  db: WebhookD1,
  customerId: string | null,
  userId: string | null,
  nowIso: string,
): Promise<void> {
  if (!customerId || !userId) return;
  const user = await db.prepare(`SELECT id FROM users WHERE id = ? LIMIT 1`).bind(userId).first<{ id: string }>();
  if (!user?.id) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO billing_customers
         (id, user_id, provider, provider_customer_id, created_at, updated_at)
       VALUES (?, ?, 'stripe', ?, ?, ?)`,
    )
    .bind(newId("billing"), user.id, customerId, nowIso, nowIso)
    .run();
}

/** A recurring subscription row, found by its Stripe subscription id. */
async function findRecurring(db: WebhookD1, providerSubscriptionId: string) {
  return db
    .prepare(
      `SELECT id, access_until, current_period_end
         FROM subscriptions WHERE provider = 'stripe' AND provider_subscription_id = ? LIMIT 1`,
    )
    .bind(providerSubscriptionId)
    .first<{ id: string; access_until: string | null; current_period_end: string | null }>();
}

async function upsertRecurring(
  db: WebhookD1,
  userId: string,
  email: string,
  state: StripeSubscriptionState,
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
           current_period_end = ?, access_until = ?, cancel_at = ?, cancel_at_period_end = ?, updated_at = ?
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
        state.cancelAt,
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
          cancel_at, cancel_at_period_end, founding_member, created_at, updated_at)
       VALUES (?, ?, ?, 'PRO', ?, 'stripe', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
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
      state.cancelAt,
      cancel,
      nowIso,
      nowIso,
    )
    .run();
}

export async function handleStripeWebhook(request: Request, env: StripeWebhookEnv): Promise<Response> {
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  const rawBody = await request.text();

  const valid = await verifyStripeSignature({
    secret,
    rawBody,
    signatureHeader: request.headers.get("Stripe-Signature"),
  });
  if (!valid) return json({ received: false, error: "invalid_signature" }, 401);

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return json({ received: false, error: "invalid_json" }, 400);
  }
  if (!event?.id || !event?.type) {
    return json({ received: false, error: "missing_fields" }, 400);
  }

  const nowIso = new Date().toISOString();
  const db = env.DB;
  const object = eventObject(event);

  /* --- claim the event (idempotency) ------------------------------- */
  const claimed = await db
    .prepare(
      `INSERT OR IGNORE INTO billing_events
         (id, provider, event_type, provider_customer_id, provider_subscription_id, provider_transaction_id, received_at, status)
       VALUES (?, 'stripe', ?, ?, ?, NULL, ?, 'received')`,
    )
    .bind(
      event.id,
      event.type,
      customerIdFromObject(object),
      subscriptionIdFromObject(object),
      nowIso,
    )
    .run();

  if ((claimed.meta?.changes ?? 0) === 0) {
    const prior = await db.prepare(`SELECT status FROM billing_events WHERE id = ? LIMIT 1`).bind(event.id).first<EventRow>();
    if (prior?.status === "processed") return json({ received: true, duplicate: true });
    // status 'received' or 'error': a prior attempt crashed before applying, so
    // fall through and reprocess. The upserts below converge, so this is safe.
  }

  const markProcessed = () =>
    db.prepare(`UPDATE billing_events SET status = 'processed', processed_at = ? WHERE id = ?`).bind(nowIso, event.id).run();
  const markIgnored = (note?: string) =>
    db
      .prepare(`UPDATE billing_events SET status = 'ignored', note = ?, processed_at = ? WHERE id = ?`)
      .bind(note ?? null, nowIso, event.id)
      .run();
  const markError = (message: string) =>
    db
      .prepare(`UPDATE billing_events SET status = 'error', note = ? WHERE id = ?`)
      .bind(message.slice(0, 500), event.id)
      .run();

  const eventType = event.type;

  try {
    /* --- checkout.session.completed: mapping only, NEVER grants PRO --- */
    if (eventType === "checkout.session.completed") {
      await establishMapping(db, customerIdFromObject(object), userIdFromMetadata(object), nowIso);
      await markProcessed();
      return json({ received: true });
    }

    /* --- customer mapping (optional; created server-side anyway) ------ */
    if (eventType === "customer.created" || eventType === "customer.updated") {
      await establishMapping(db, customerIdFromObject(object), userIdFromMetadata(object), nowIso);
      await markProcessed();
      return json({ received: true });
    }

    /* --- subscription.* is the single authoritative entitlement path --- */
    if (eventType.startsWith("customer.subscription.")) {
      const subscriptionId = subscriptionIdFromObject(object);
      if (!subscriptionId) {
        await markIgnored("subscription event without a subscription id");
        return json({ received: true, ignored: true });
      }
      const existing = await findRecurring(db, subscriptionId);
      const state = syncSubscriptionFromStripe(object, existing?.access_until ?? null);
      if (!state) {
        await markIgnored("unrecognized subscription status");
        return json({ received: true, ignored: true });
      }
      // Out-of-order guard: never let a delayed, stale event move the period
      // (and therefore status) backward. access_until is separately protected
      // by the pure sync's "later()" logic.
      if (existing?.current_period_end && state.currentPeriodEnd) {
        if (Date.parse(state.currentPeriodEnd) < Date.parse(existing.current_period_end)) {
          await markIgnored("stale subscription state (earlier period)");
          return json({ received: true, ignored: true });
        }
      }
      const userId = await resolveUserId(db, object);
      if (!userId) {
        await markIgnored("no billing_customers mapping and no metadata user");
        return json({ received: true, ignored: true, reason: "unmapped" });
      }
      const email = (await db.prepare(`SELECT email FROM users WHERE id = ? LIMIT 1`).bind(userId).first<{ email: string }>())?.email ?? "";
      await upsertRecurring(db, userId, email, state, existing, nowIso);
      await markProcessed();
      return json({ received: true });
    }

    /* --- invoice.paid: extend paid-through, never grant on its own ----- */
    if (eventType === "invoice.paid") {
      const subscriptionId = subscriptionIdFromObject(object);
      if (!subscriptionId) {
        await markIgnored("invoice without a subscription id");
        return json({ received: true, ignored: true });
      }
      const existing = await findRecurring(db, subscriptionId);
      if (!existing) {
        await markIgnored("no local subscription for the paid invoice");
        return json({ received: true, ignored: true });
      }
      const accessUntil = extendAccessFromInvoice(existing.access_until, object);
      if (accessUntil === existing.access_until) {
        await markIgnored("invoice.paid added no paid time");
        return json({ received: true, ignored: true });
      }
      await db
        .prepare(`UPDATE subscriptions SET access_until = ?, updated_at = ? WHERE id = ?`)
        .bind(accessUntil, nowIso, existing.id)
        .run();
      await markProcessed();
      return json({ received: true });
    }

    /* --- invoice.payment_failed: recorded, no entitlement mutation ----- */
    if (eventType === "invoice.payment_failed") {
      await markIgnored("payment_failed recorded; no entitlement mutation");
      return json({ received: true, ignored: true });
    }

    /* --- everything else ---------------------------------------------- */
    await markIgnored("not an entitlement-mutating event");
    return json({ received: true, ignored: true });
  } catch (caught) {
    await markError(caught instanceof Error ? caught.message : "Unknown failure");
    return json({ received: false, error: "apply_failed" }, 500);
  }
}
