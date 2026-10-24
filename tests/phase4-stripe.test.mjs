import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { applyMigration, createD1, MIGRATION_PATH } from "./helpers/sqlite-d1.mjs";
import { dataUrl, loadModule } from "./helpers/transpile.mjs";

/* ==================================================== load modules */

const billingUrl = await loadModule("stripe-billing.ts");
const cryptoUrl = await loadModule("crypto.ts");
const entitlementUrl = await loadModule("entitlement.ts");

// The server-side helpers import the runtime bindings and the membership D1.
// Load them with those swapped for stubs so the pure plan/price/authorize
// mapping and the checkout/portal REST calls are testable without a Worker or
// a live Stripe account. The membership stub exposes a settable D1 so the
// customer-mapping write path can run against the sqlite adapter.
const membershipStub = dataUrl(`
  let current = null;
  export function setMembershipD1(d1) { current = d1; }
  export function getMembershipD1() { return current; }
  export const MEMBERSHIP_DB_BINDING = "MEMBERSHIP_DB";
`);

const runtimeStub = dataUrl(`
  export function getBindings() {
    return {
      STRIPE_SECRET_KEY: "sk_test_secret",
      STRIPE_PRICE_PRO_MONTHLY_USD: "price_monthly",
      STRIPE_PRICE_PRO_ANNUAL_USD: "price_annual",
      SITE_ORIGIN: "https://preview.example.com",
    };
  }
  export function cleanBaseUrl(v) { return v || null; }
  export const DEFAULT_ALERT_RECIPIENT = "x";
`);

const stripeServerUrl = await loadModule("stripe-server.ts", {
  "./crypto": cryptoUrl,
  "./membership-db": membershipStub,
  "./runtime": runtimeStub,
});

const {
  parseCheckoutPlan,
  authorizeCheckout,
  stripePriceForPlan,
  stripeServerConfig,
  ensureStripeCustomer,
  createCheckoutSession,
} = await import(stripeServerUrl);

const membership = await import(membershipStub);

const {
  parseStripeSignature,
  verifyStripeSignature,
  syncSubscriptionFromStripe,
  mapStripeStatus,
} = await import(billingUrl);

const { resolveEntitlement } = await import(entitlementUrl);

// The webhook handler lives in monitor-worker/src and imports lib/ by relative
// path; transpile it with those imports swapped for the data URLs above.
const webhookSource = await readFile(new URL("../monitor-worker/src/stripe-webhook.ts", import.meta.url), "utf8");
const webhookUrl = dataUrl(
  ts.transpileModule(
    webhookSource
      .replaceAll('"../../lib/stripe-billing"', `"${billingUrl}"`)
      .replaceAll('"../../lib/crypto"', `"${cryptoUrl}"`),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText,
);
const { handleStripeWebhook } = await import(webhookUrl);

/* ==================================================== fixtures */

const WH_SECRET = "whsec_test_webhook_secret";
const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
const T0 = "2026-09-18T00:00:00.000Z";
const T1 = "2026-10-18T00:00:00.000Z"; // one month paid through
const T2 = "2026-11-18T00:00:00.000Z"; // one further period

const signBody = (secret, ts, body) => createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

function stripeRequest(bodyObject, { ts = Math.floor(Date.now() / 1000), secret = WH_SECRET } = {}) {
  const body = JSON.stringify(bodyObject);
  const v1 = signBody(secret, ts, body);
  return new Request("https://worker.test/webhooks/stripe", {
    method: "POST",
    headers: { "Stripe-Signature": `t=${ts},v1=${v1}` },
    body,
  });
}

/** A Stripe subscription object (unix timestamps, as Stripe sends them). */
function subObject(overrides = {}) {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    currency: "usd",
    current_period_start: unix(T0),
    current_period_end: unix(T1),
    cancel_at_period_end: false,
    items: { data: [{ price: { recurring: { interval: "month" } } }] },
    ...overrides,
  };
}

/**
 * The Stripe "Basil" (API 2025-03-31.basil) subscription shape: the billing
 * period moved OFF the subscription onto the subscription item. The top-level
 * `current_period_start` / `current_period_end` are absent.
 */
function subObjectBasil(overrides = {}) {
  return {
    id: "sub_basil_1",
    status: "active",
    customer: "cus_1",
    currency: "usd",
    cancel_at_period_end: false,
    items: {
      data: [
        {
          price: { recurring: { interval: "month" } },
          current_period_start: unix(T0),
          current_period_end: unix(T1),
        },
      ],
    },
    ...overrides,
  };
}

const stripeEvent = (id, type, object) => ({ id, type, data: { object } });

const applyMembership = async (d1) => {
  await applyMigration(d1, MIGRATION_PATH);
  await applyMigration(d1, "../../monitor-worker/migrations/0016_billing_schema_fixes.sql");
  await applyMigration(d1, "../../monitor-worker/migrations/0017_stripe_status.sql");
  await applyMigration(d1, "../../monitor-worker/migrations/0018_cancel_at.sql");
};

function seedUser(d1, { id = "user_1", email = "a@b.co" } = {}) {
  d1.exec(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ('${id}', '${email}', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
}
function seedStripeCustomer(d1, { userId = "user_1", customerId = "cus_1" } = {}) {
  d1.exec(`INSERT INTO billing_customers (id, user_id, provider, provider_customer_id, created_at, updated_at) VALUES ('billing_1', '${userId}', 'stripe', '${customerId}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
}

async function freshEnv() {
  const d1 = createD1();
  await applyMembership(d1);
  seedUser(d1);
  seedStripeCustomer(d1);
  return { DB: d1, STRIPE_WEBHOOK_SECRET: WH_SECRET };
}

const rowCount = (d1, table) => d1.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const subRows = (d1) => d1.raw.prepare("SELECT * FROM subscriptions ORDER BY created_at").all();
const eventStatus = (d1, id) => d1.raw.prepare("SELECT status FROM billing_events WHERE id = ?").get(id)?.status;

/** Resolves entitlement from the stored subscription rows for a fixed user. */
function entitlementFromRows(d1, nowIso) {
  const rows = d1.raw.prepare("SELECT * FROM subscriptions WHERE user_id = 'user_1'").all();
  const records = rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    plan: row.plan,
    status: row.status,
    accessUntil: row.access_until,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    cancelAt: row.cancel_at,
    billingInterval: row.billing_interval,
    currency: row.currency,
  }));
  return resolveEntitlement({ user: { id: "user_1", emailVerified: true }, subscriptions: records, now: Date.parse(nowIso) });
}

/* ==================================================== checkout gate + price mapping */

test("(1) anonymous user cannot create checkout", () => {
  assert.deepEqual(authorizeCheckout(null), { ok: false, reason: "anonymous" });
});

test("(2) unverified user cannot create checkout", () => {
  assert.deepEqual(authorizeCheckout({ id: "user_1", email: "a@b.co", emailVerified: false }), { ok: false, reason: "email_unverified" });
  assert.deepEqual(authorizeCheckout({ id: "user_1", email: "a@b.co", emailVerified: true }), { ok: true });
});

test("(3) the client cannot inject an arbitrary price id", () => {
  // The parser reads only `plan`; any smuggled price/customer/user field is ignored.
  assert.equal(parseCheckoutPlan({ plan: "monthly", priceId: "price_hacker", customerId: "cus_hacker" }), "monthly");
  assert.equal(parseCheckoutPlan({ plan: "monthly" }), "monthly");
  assert.equal(parseCheckoutPlan({ plan: "annual" }), "annual");
  assert.equal(parseCheckoutPlan({ plan: "bogus" }), null);
  assert.equal(parseCheckoutPlan({ priceId: "price_hacker" }), null);
  assert.equal(parseCheckoutPlan(null), null);
});

test("(4) monthly plan maps to the exact monthly price", () => {
  const config = stripeServerConfig();
  assert.equal(stripePriceForPlan(config, "monthly"), "price_monthly");
});

test("(5) annual plan maps to the exact annual price", () => {
  const config = stripeServerConfig();
  assert.equal(stripePriceForPlan(config, "annual"), "price_annual");
  assert.equal(stripeServerConfig().live, false, "the test key is not a live key");
});

test("createCheckoutSession posts the configured price and server-side identity", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const config = stripeServerConfig();
  const { url } = await createCheckoutSession({
    customerId: "cus_1",
    priceId: config.priceIds.monthly,
    userId: "user_1",
    successUrl: "https://preview.example.com/billing/success",
    cancelUrl: "https://preview.example.com/pricing",
    config,
    fetchImpl,
  });
  assert.equal(url, "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(captured.url, "https://api.stripe.com/v1/checkout/sessions");
  const body = new URLSearchParams(captured.init.body);
  assert.equal(body.get("mode"), "subscription");
  assert.equal(body.get("line_items[0][price]"), "price_monthly");
  assert.equal(body.get("line_items[0][quantity]"), "1");
  assert.equal(body.get("client_reference_id"), "user_1");
  assert.equal(body.get("metadata[signal_ledger_user_id]"), "user_1");
  assert.equal(body.get("success_url"), "https://preview.example.com/billing/success");
});

/* ==================================================== signature */

test("parseStripeSignature reads every v1 during rotation", () => {
  assert.deepEqual(parseStripeSignature("t=1700000000,v1=aaa,v1=bbb"), { ts: "1700000000", v1: ["aaa", "bbb"] });
  assert.equal(parseStripeSignature(null), null);
  assert.equal(parseStripeSignature("v1=only"), null);
});

test("verifyStripeSignature accepts any rotated v1 and rejects stale timestamps", async () => {
  const rawBody = '{"x":1}';
  const ts = Math.floor(Date.now() / 1000);
  const current = signBody(WH_SECRET, ts, rawBody);
  const retired = signBody("the-retired-secret", ts, rawBody);
  assert.equal(await verifyStripeSignature({ secret: WH_SECRET, rawBody, signatureHeader: `t=${ts},v1=${retired},v1=${current}` }), true);
  assert.equal(await verifyStripeSignature({ secret: WH_SECRET, rawBody, signatureHeader: `t=${ts},v1=${signBody("wrong", ts, rawBody)}` }), false);
  assert.equal(await verifyStripeSignature({ secret: WH_SECRET, rawBody, signatureHeader: `t=${ts - 3600},v1=${current}` }), false);
});

test("mapStripeStatus covers all eight Stripe statuses and nothing else", () => {
  assert.equal(mapStripeStatus("active"), "active");
  assert.equal(mapStripeStatus("trialing"), "trialing");
  assert.equal(mapStripeStatus("past_due"), "past_due");
  assert.equal(mapStripeStatus("canceled"), "canceled");
  assert.equal(mapStripeStatus("paused"), "paused");
  assert.equal(mapStripeStatus("incomplete"), "incomplete");
  assert.equal(mapStripeStatus("incomplete_expired"), "incomplete_expired");
  assert.equal(mapStripeStatus("unpaid"), "unpaid");
  assert.equal(mapStripeStatus("bogus"), null);
});

/* ==================================================== webhook integration */

test("(6) the customer mapping created at checkout is reused by subscription events", async () => {
  const d1 = createD1();
  await applyMembership(d1);
  seedUser(d1); // no billing_customers mapping yet

  const session = stripeEvent("evt_session_1", "checkout.session.completed", {
    id: "cs_1",
    customer: "cus_1",
    metadata: { signal_ledger_user_id: "user_1" },
  });
  await handleStripeWebhook(stripeRequest(session), { DB: d1, STRIPE_WEBHOOK_SECRET: WH_SECRET });
  assert.equal(rowCount(d1, "billing_customers"), 1, "checkout completed created the mapping");

  // The subscription event resolves identity through the mapping just created.
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_sub_1", "customer.subscription.created", subObject())), { DB: d1, STRIPE_WEBHOOK_SECRET: WH_SECRET });
  assert.equal(rowCount(d1, "billing_customers"), 1, "the mapping was reused, not duplicated");
  assert.equal(rowCount(d1, "subscriptions"), 1);
  assert.equal(subRows(d1)[0].user_id, "user_1");
});

test("(7) checkout.session.completed alone never grants PRO", async () => {
  const d1 = createD1();
  await applyMembership(d1);
  seedUser(d1);

  const session = stripeEvent("evt_session_2", "checkout.session.completed", {
    id: "cs_2",
    customer: "cus_1",
    metadata: { signal_ledger_user_id: "user_1" },
  });
  const res = await handleStripeWebhook(stripeRequest(session), { DB: d1, STRIPE_WEBHOOK_SECRET: WH_SECRET });
  assert.equal(res.status, 200);
  assert.equal(rowCount(d1, "subscriptions"), 0, "the success redirect / session event must not create entitlement");
});

test("(8) an invalid signature mutates nothing", async () => {
  const env = await freshEnv();
  const res = await handleStripeWebhook(
    new Request("https://worker.test/webhooks/stripe", {
      method: "POST",
      headers: { "Stripe-Signature": "t=0,v1=deadbeef" },
      body: JSON.stringify(stripeEvent("evt_bad", "customer.subscription.created", subObject())),
    }),
    env,
  );
  assert.equal(res.status, 401);
  assert.equal(rowCount(env.DB, "subscriptions"), 0);
  assert.equal(rowCount(env.DB, "billing_events"), 0);
});

test("(9) a missing signature mutates nothing", async () => {
  const env = await freshEnv();
  const res = await handleStripeWebhook(
    new Request("https://worker.test/webhooks/stripe", {
      method: "POST",
      body: JSON.stringify(stripeEvent("evt_nosig", "customer.subscription.created", subObject())),
    }),
    env,
  );
  assert.equal(res.status, 401);
  assert.equal(rowCount(env.DB, "subscriptions"), 0);
  assert.equal(rowCount(env.DB, "billing_events"), 0);
});

test("(10) a duplicate evt_ id is a 200 no-op", async () => {
  const env = await freshEnv();
  const event = stripeEvent("evt_dup", "customer.subscription.created", subObject());
  await handleStripeWebhook(stripeRequest(event), env);
  const res = await handleStripeWebhook(stripeRequest(event), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, true);
  assert.equal(rowCount(env.DB, "subscriptions"), 1);
});

test("(11) an active paid subscription resolves to PRO", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_active", "customer.subscription.created", subObject())), env);
  const rows = subRows(env.DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].access_until, T1);
  assert.equal(entitlementFromRows(env.DB, "2026-09-25T00:00:00.000Z").tier, "PRO");
});

test("(21) Basil item-level periods resolve to PRO (period moved off the subscription)", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_basil", "customer.subscription.created", subObjectBasil())), env);
  const row = subRows(env.DB)[0];
  assert.equal(row.status, "active");
  assert.equal(row.current_period_start, T0, "period start read from items.data[0]");
  assert.equal(row.current_period_end, T1, "period end read from items.data[0]");
  assert.equal(row.access_until, T1, "access_until derives from the item-level period_end");
  assert.equal(entitlementFromRows(env.DB, "2026-09-25T00:00:00.000Z").tier, "PRO");
});

test("(22) Basil item-level periods feed the out-of-order guard", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_basil_0", "customer.subscription.created", subObjectBasil())), env);
  // A Basil-shaped item period one month further out.
  const basilLater = subObjectBasil();
  basilLater.items.data[0].current_period_end = unix(T2);
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_basil_1", "customer.subscription.updated", basilLater)), env);
  assert.equal(subRows(env.DB)[0].access_until, T2, "the later item period extends access");

  const res = await handleStripeWebhook(stripeRequest(stripeEvent("evt_basil_stale", "customer.subscription.updated", subObjectBasil())), env);
  assert.equal((await res.json()).ignored, true, "a stale, earlier item period is ignored");
  assert.equal(subRows(env.DB)[0].access_until, T2, "access_until did not move backward");
});

test("(12) canceled-at-period-end retains access through the paid period", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_cancel_0", "customer.subscription.created", subObject())), env);
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_cancel_1", "customer.subscription.updated", subObject({ cancel_at_period_end: true }))), env);
  const row = subRows(env.DB)[0];
  assert.equal(row.cancel_at_period_end, 1);
  assert.equal(row.access_until, T1, "cancel_at_period_end never revokes the already-paid window");
  assert.equal(entitlementFromRows(env.DB, "2026-09-25T00:00:00.000Z").tier, "PRO");
});

test("(23) a scheduled cancel_at is captured and preserves PRO (cancel_at_period_end=false)", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(
    stripeRequest(stripeEvent("evt_cancelat", "customer.subscription.updated", subObject({ cancel_at: unix(T2), cancel_at_period_end: false }))),
    env,
  );
  const row = subRows(env.DB)[0];
  assert.equal(row.status, "active");
  assert.equal(row.cancel_at, T2, "cancel_at is stored explicitly");
  assert.equal(row.cancel_at_period_end, 0, "the new form does not set the legacy flag");
  assert.equal(row.access_until, T1, "a scheduled cancellation does not shorten paid access");

  const ent = entitlementFromRows(env.DB, "2026-09-25T00:00:00.000Z");
  assert.equal(ent.tier, "PRO");
  assert.equal(ent.cancelAt, T2, "the account page sees the scheduled cancellation date");
  assert.equal(ent.cancelAtPeriodEnd, false);
});

test("(24) the legacy cancel_at_period_end=true form leaves cancel_at null", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(
    stripeRequest(stripeEvent("evt_cancelateop", "customer.subscription.updated", subObject({ cancel_at_period_end: true }))),
    env,
  );
  const row = subRows(env.DB)[0];
  assert.equal(row.cancel_at_period_end, 1);
  assert.equal(row.cancel_at, null, "no cancel_at timestamp in the legacy form");
  assert.equal(row.access_until, T1);

  const ent = entitlementFromRows(env.DB, "2026-09-25T00:00:00.000Z");
  assert.equal(ent.tier, "PRO");
  assert.equal(ent.cancelAtPeriodEnd, true);
  assert.equal(ent.cancelAt, null);
});

test("(13) past_due never extends the paid window", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_pd_0", "customer.subscription.created", subObject())), env);
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_pd_1", "customer.subscription.updated", subObject({ status: "past_due", current_period_end: unix(T2) }))), env);
  const row = subRows(env.DB)[0];
  assert.equal(row.status, "past_due");
  assert.equal(row.access_until, T1, "past_due must not invent new paid time");
});

test("(14) an incomplete subscription does not grant PRO", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_inc", "customer.subscription.created", subObject({ status: "incomplete" }))), env);
  const row = subRows(env.DB)[0];
  assert.equal(row.status, "incomplete");
  assert.equal(row.access_until, null);
  assert.equal(entitlementFromRows(env.DB, "2026-09-25T00:00:00.000Z").tier, "FREE");
});

test("(15) an incomplete_expired subscription does not grant PRO", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_iexp", "customer.subscription.created", subObject({ status: "incomplete_expired" }))), env);
  assert.equal(subRows(env.DB)[0].access_until, null);
  assert.equal(entitlementFromRows(env.DB, "2026-09-25T00:00:00.000Z").tier, "FREE");
});

test("(16) an unpaid subscription does not grant PRO", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_unp", "customer.subscription.created", subObject({ status: "unpaid" }))), env);
  assert.equal(subRows(env.DB)[0].access_until, null);
  assert.equal(entitlementFromRows(env.DB, "2026-09-25T00:00:00.000Z").tier, "FREE");
});

test("(17) invoice.paid extends paid-through correctly", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_inv_0", "customer.subscription.created", subObject())), env);
  assert.equal(subRows(env.DB)[0].access_until, T1);

  await handleStripeWebhook(stripeRequest(stripeEvent("evt_inv_1", "invoice.paid", {
    id: "in_1",
    subscription: "sub_1",
    lines: { data: [{ period: { end: unix(T2) } }] },
  })), env);
  assert.equal(subRows(env.DB)[0].access_until, T2, "invoice.paid extends to the later line period end");
});

test("(18) subscription deletion does not create extra access", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_del_0", "customer.subscription.created", subObject())), env);
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_del_1", "customer.subscription.deleted", subObject({ status: "canceled" }))), env);
  assert.equal(rowCount(env.DB, "subscriptions"), 1, "deletion updates the row, it does not add one");
  assert.equal(subRows(env.DB)[0].access_until, T1, "the already-paid period is preserved, not extended");
});

test("(19) an out-of-order webhook cannot regress newer state", async () => {
  const env = await freshEnv();
  await handleStripeWebhook(stripeRequest(stripeEvent("evt_ooo_0", "customer.subscription.created", subObject({ current_period_end: unix(T2) }))), env);
  assert.equal(subRows(env.DB)[0].access_until, T2);

  const res = await handleStripeWebhook(stripeRequest(stripeEvent("evt_ooo_1", "customer.subscription.updated", subObject({ current_period_end: unix(T1) }))), env);
  assert.equal((await res.json()).ignored, true, "a stale, earlier period is ignored");
  assert.equal(subRows(env.DB)[0].access_until, T2, "access_until did not move backward");
  assert.equal(eventStatus(env.DB, "evt_ooo_1"), "ignored");
});

test("(20) production entitlement data is untouched by Stripe events", async () => {
  const env = await freshEnv();
  seedUser(env.DB, { id: "user_other", email: "other@b.co" });
  // A pre-existing row belonging to another user/provider, as production data would be.
  env.DB.exec(`INSERT INTO subscriptions (id, user_id, email, plan, status, provider, provider_subscription_id, currency, access_until, cancel_at_period_end, founding_member, created_at, updated_at)
     VALUES ('sub_prod', 'user_other', 'other@b.co', 'PRO', 'active', 'paddle', 'sub_prod_1', 'USD', '2027-01-01T00:00:00.000Z', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);

  await handleStripeWebhook(stripeRequest(stripeEvent("evt_prod", "customer.subscription.created", subObject())), env);

  const prod = env.DB.raw.prepare("SELECT * FROM subscriptions WHERE id = 'sub_prod'").get();
  assert.equal(prod.access_until, "2027-01-01T00:00:00.000Z");
  assert.equal(prod.status, "active");
  assert.equal(prod.provider, "paddle");
  assert.equal(rowCount(env.DB, "subscriptions"), 2, "the Stripe event added exactly its own row");
});

/* ==================================================== schema change */

test("migration 0017 widens the status CHECK for the three unearned Stripe states", async () => {
  const d1 = createD1();
  await applyMigration(d1, MIGRATION_PATH);
  await applyMigration(d1, "../../monitor-worker/migrations/0016_billing_schema_fixes.sql");
  d1.exec(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ('u1', 'a@b.co', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);

  const insertSub = (id, status) => d1.exec(
    `INSERT INTO subscriptions (id, user_id, email, plan, status, provider, currency, cancel_at_period_end, founding_member, created_at, updated_at)
     VALUES ('${id}', 'u1', 'a@b.co', 'PRO', '${status}', 'stripe', 'USD', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );

  // Before 0017, 'incomplete' is rejected by the inline CHECK.
  assert.throws(() => insertSub("s_inc", "incomplete"), /CHECK/i);

  await applyMigration(d1, "../../monitor-worker/migrations/0017_stripe_status.sql");

  insertSub("s_inc", "incomplete");
  insertSub("s_iexp", "incomplete_expired");
  insertSub("s_unp", "unpaid");
  assert.equal(d1.raw.prepare("SELECT status FROM subscriptions WHERE id = 's_unp'").get().status, "unpaid");
});

/* ==================================================== server-side customer mapping */

test("ensureStripeCustomer creates the mapping once and reuses it", async () => {
  const d1 = createD1();
  await applyMembership(d1);
  seedUser(d1);
  membership.setMembershipD1(d1);

  let fetchCalls = 0;
  const fetchImpl = async (url, init) => {
    fetchCalls += 1;
    assert.match(url, /\/customers$/);
    return new Response(JSON.stringify({ id: "cus_1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const config = stripeServerConfig();
  const first = await ensureStripeCustomer("user_1", "a@b.co", "2026-09-18T00:00:00.000Z", { config, fetchImpl });
  assert.equal(first.customerId, "cus_1");
  assert.equal(first.created, true);
  assert.equal(fetchCalls, 1);

  const second = await ensureStripeCustomer("user_1", "a@b.co", "2026-09-18T00:00:00.000Z", { config, fetchImpl });
  assert.equal(second.created, false);
  assert.equal(fetchCalls, 1, "the second call hit the cached mapping, not Stripe");
  assert.equal(rowCount(d1, "billing_customers"), 1);
});
