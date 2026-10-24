import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { applyMigration, createD1, MIGRATION_PATH } from "./helpers/sqlite-d1.mjs";
import { dataUrl, loadModule } from "./helpers/transpile.mjs";

/* ==================================================== load modules */

const billingUrl = await loadModule("paddle-billing.ts");
const cryptoUrl = await loadModule("crypto.ts");

const {
  parsePaddleSignature,
  verifyPaddleSignature,
  syncSubscriptionFromEntity,
  oneTimeAccessFromTransaction,
  isOneTimeTransaction,
  decideOneTimeGrant,
  oneTimeItems,
  ONE_TIME_365D_MS,
} = await import(billingUrl);

// The server-side price mapping lives in lib/paddle-server.ts, which imports the
// runtime bindings and the membership D1. Load it with those two swapped for
// stubs so the pure `priceKeyFor` / `paddleServerConfig` mapping is testable
// without a Worker. `./crypto` is already transpiled above.
const paddleServerUrl = await loadModule("paddle-server.ts", {
  "./crypto": cryptoUrl,
  "./membership-db": dataUrl('export function getMembershipD1() { return null; } export const MEMBERSHIP_DB_BINDING = "MEMBERSHIP_DB";'),
  "./runtime": dataUrl(
    `export function getBindings() {
       return {
         PADDLE_ENVIRONMENT: "sandbox",
         PADDLE_API_KEY: "pdl_test_key",
         PADDLE_CLIENT_SIDE_TOKEN: "pdl_test_client",
         PADDLE_PRICE_PRO_MONTHLY_USD: "pri_monthly_usd",
         PADDLE_PRICE_PRO_MONTHLY_CNY: "pri_monthly_cny",
         PADDLE_PRICE_PRO_ANNUAL_USD: "pri_annual_usd",
         PADDLE_PRICE_PRO_ANNUAL_CNY: "pri_annual_cny",
         PADDLE_PRICE_PRO_ONETIME_CNY: "pri_onetime_cny",
       };
     }
     export function cleanBaseUrl(v) { return v || null; }
     export const DEFAULT_ALERT_RECIPIENT = "x";`,
  ),
});
const { priceKeyFor, paddleServerConfig } = await import(paddleServerUrl);

// The webhook handler lives in monitor-worker/src and imports lib/ by relative
// path; transpile it with those imports swapped for the data URLs above.
const webhookSource = await readFile(new URL("../monitor-worker/src/paddle-webhook.ts", import.meta.url), "utf8");
const webhookUrl = dataUrl(
  ts.transpileModule(
    webhookSource
      .replaceAll('"../../lib/paddle-billing"', `"${billingUrl}"`)
      .replaceAll('"../../lib/crypto"', `"${cryptoUrl}"`),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText,
);
const { handlePaddleWebhook } = await import(webhookUrl);

/* ==================================================== fixtures */

const SECRET = "test-webhook-secret";
const ONETIME_PRICE = "pri_onetime_cny";

const signBody = (secret, ts, body) => createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");

function webhookRequest(bodyObject, { ts = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const body = JSON.stringify(bodyObject);
  const h1 = signBody(secret, ts, body);
  return new Request("https://worker.test/webhooks/paddle", {
    method: "POST",
    headers: { "Paddle-Signature": `ts=${ts};h1=${h1}` },
    body,
  });
}

const applyMembership = async (d1) => {
  await applyMigration(d1, MIGRATION_PATH);
  await applyMigration(d1, "../../monitor-worker/migrations/0016_billing_schema_fixes.sql");
};

function seedUser(d1, { id = "user_1", email = "a@b.co" } = {}) {
  d1.exec(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ('${id}', '${email}', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
}
function seedCustomer(d1, { userId = "user_1", customerId = "ctm_1" } = {}) {
  d1.exec(`INSERT INTO billing_customers (id, user_id, provider, provider_customer_id, created_at, updated_at) VALUES ('billing_1', '${userId}', 'paddle', '${customerId}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
}

async function freshEnv() {
  const d1 = createD1();
  await applyMembership(d1);
  seedUser(d1);
  seedCustomer(d1);
  return {
    DB: d1,
    PADDLE_WEBHOOK_SECRET: SECRET,
    PADDLE_ENVIRONMENT: "sandbox",
    PADDLE_PRICE_PRO_ONETIME_CNY: ONETIME_PRICE,
  };
}

const rowCount = (d1, table) => d1.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const subRows = (d1) => d1.raw.prepare("SELECT * FROM subscriptions ORDER BY created_at").all();
const eventStatus = (d1, id) => d1.raw.prepare("SELECT status FROM billing_events WHERE id = ?").get(id)?.status;

const SUB_CREATED = {
  event_id: "evt_sub_created",
  event_type: "subscription.created",
  occurred_at: "2026-09-18T00:00:00.000Z",
  data: {
    id: "sub_1",
    status: "active",
    customer_id: "ctm_1",
    billing_cycle: { interval: "month", frequency: 1 },
    currency_code: "USD",
    current_billing_period: { starts_at: "2026-09-18T00:00:00.000Z", ends_at: "2026-10-18T00:00:00.000Z" },
  },
};

const ONETIME_DATA = {
  id: "txn_1",
  customer_id: "ctm_1",
  currency_code: "USD",
  items: [{ price: { id: ONETIME_PRICE, billing_cycle: null } }],
};

const oneTimeEvent = (overrides = {}) => ({
  event_id: "evt_txn_1",
  event_type: "transaction.completed",
  occurred_at: "2026-09-18T00:00:00.000Z",
  data: ONETIME_DATA,
  ...overrides,
});

/* ==================================================== signature */

test("parsePaddleSignature reads every h1 during rotation", () => {
  assert.deepEqual(parsePaddleSignature("ts=1700000000;h1=aaa;h1=bbb"), { ts: "1700000000", h1: ["aaa", "bbb"] });
  assert.equal(parsePaddleSignature(null), null);
  assert.equal(parsePaddleSignature("h1=only"), null);
});

test("verifyPaddleSignature accepts any rotated h1", async () => {
  const rawBody = '{"x":1}';
  const ts = Math.floor(Date.now() / 1000);
  const current = signBody(SECRET, ts, rawBody);
  const retired = signBody("the-retired-secret", ts, rawBody);
  assert.equal(await verifyPaddleSignature({ secret: SECRET, rawBody, signatureHeader: `ts=${ts};h1=${retired};h1=${current}` }), true);
});

test("verifyPaddleSignature rejects a stale timestamp", async () => {
  const rawBody = '{"x":1}';
  const ts = Math.floor(Date.now() / 1000) - 3600;
  const h1 = signBody(SECRET, ts, rawBody);
  assert.equal(await verifyPaddleSignature({ secret: SECRET, rawBody, signatureHeader: `ts=${ts};h1=${h1}` }), false);
});

/* ==================================================== pure mapping */

test("syncSubscriptionFromEntity extends on active, preserves on paused/canceled", () => {
  const entity = {
    id: "sub_1",
    status: "active",
    customer_id: "ctm_1",
    billing_cycle: { interval: "month", frequency: 1 },
    currency_code: "USD",
    current_billing_period: { starts_at: "2026-10-01T00:00:00.000Z", ends_at: "2026-11-01T00:00:00.000Z" },
  };
  assert.equal(syncSubscriptionFromEntity(entity, null).accessUntil, "2026-11-01T00:00:00.000Z");

  const paused = syncSubscriptionFromEntity({ ...entity, status: "paused" }, "2026-10-15T00:00:00.000Z");
  assert.equal(paused.status, "paused");
  assert.equal(paused.accessUntil, "2026-10-15T00:00:00.000Z", "paused never extends the window");

  const canceled = syncSubscriptionFromEntity({ ...entity, status: "canceled" }, "2026-10-15T00:00:00.000Z");
  assert.equal(canceled.accessUntil, "2026-10-15T00:00:00.000Z", "canceled preserves paid-through access");
  assert.equal(canceled.cancelAtPeriodEnd, true);
});

test("isOneTimeTransaction distinguishes one-time from recurring", () => {
  assert.equal(isOneTimeTransaction({ items: [{ price: { billing_cycle: null } }] }), true);
  assert.equal(isOneTimeTransaction({ subscription_id: "sub_1" }), false);
  assert.equal(isOneTimeTransaction({ items: [{ price: { billing_cycle: { interval: "month", frequency: 1 } } }] }), false);
});

test("oneTimeAccessFromTransaction: first purchase = paid_at + 365d", () => {
  const event = { event_id: "e", event_type: "transaction.completed", occurred_at: "2026-09-18T00:00:00.000Z", data: { id: "txn_1" } };
  const state = oneTimeAccessFromTransaction(event, null);
  assert.equal(Date.parse(state.accessUntil) - Date.parse(event.occurred_at), ONE_TIME_365D_MS);
});

test("oneTimeAccessFromTransaction: early renewal preserves remaining time", () => {
  const event = { event_id: "e", event_type: "transaction.completed", occurred_at: "2026-09-18T00:00:00.000Z", data: { id: "txn_2" } };
  const existing = new Date(Date.parse(event.occurred_at) + 200 * 24 * 60 * 60 * 1_000).toISOString();
  const state = oneTimeAccessFromTransaction(event, existing);
  assert.equal(Date.parse(state.accessUntil) - Date.parse(existing), ONE_TIME_365D_MS, "measured from the existing end, not from now");
});

test("annual USD subscription maps to a year billing_interval", () => {
  const entity = {
    id: "sub_annual_usd",
    status: "active",
    customer_id: "ctm_1",
    billing_cycle: { interval: "year", frequency: 1 },
    currency_code: "USD",
    current_billing_period: { starts_at: "2026-09-18T00:00:00.000Z", ends_at: "2027-09-18T00:00:00.000Z" },
  };
  const state = syncSubscriptionFromEntity(entity, null);
  assert.equal(state.billingInterval, "year");
  assert.equal(state.currency, "USD");
  assert.equal(state.accessUntil, "2027-09-18T00:00:00.000Z");
});

test("annual CNY subscription maps to a year billing_interval in CNY", () => {
  const entity = {
    id: "sub_annual_cny",
    status: "active",
    customer_id: "ctm_1",
    billing_cycle: { interval: "year", frequency: 1 },
    currency_code: "CNY",
    current_billing_period: { starts_at: "2026-09-18T00:00:00.000Z", ends_at: "2027-09-18T00:00:00.000Z" },
  };
  const state = syncSubscriptionFromEntity(entity, null);
  assert.equal(state.billingInterval, "year");
  assert.equal(state.currency, "CNY");
  assert.equal(state.accessUntil, "2027-09-18T00:00:00.000Z");
});

test("decideOneTimeGrant accepts exactly one designated item at quantity 1", () => {
  const data = { items: [{ price: { id: ONETIME_PRICE, billing_cycle: null } }] };
  assert.deepEqual(decideOneTimeGrant(data, ONETIME_PRICE), { granted: true });
});

test("decideOneTimeGrant rejects quantity > 1", () => {
  const data = { items: [{ price: { id: ONETIME_PRICE, billing_cycle: null }, quantity: 2 }] };
  const decision = decideOneTimeGrant(data, ONETIME_PRICE);
  assert.equal(decision.granted, false);
  assert.match(decision.reason, /quantity/);
});

test("decideOneTimeGrant rejects a mixed basket (designated + extra)", () => {
  const data = {
    items: [
      { price: { id: ONETIME_PRICE, billing_cycle: null } },
      { price: { id: "pri_extra", billing_cycle: null } },
    ],
  };
  const decision = decideOneTimeGrant(data, ONETIME_PRICE);
  assert.equal(decision.granted, false);
  assert.match(decision.reason, /extra items/);
});

test("oneTimeItems defaults a missing quantity to 1", () => {
  assert.deepEqual(oneTimeItems({ items: [{ price: { id: "pri_x", billing_cycle: null } }] }), [{ priceId: "pri_x", quantity: 1 }]);
});

test("the five-price catalog maps plan+currency to the right key and id", () => {
  assert.equal(priceKeyFor("monthly", "usd"), "monthly_usd");
  assert.equal(priceKeyFor("monthly", "cny"), "monthly_cny");
  assert.equal(priceKeyFor("annual", "usd"), "annual_usd");
  assert.equal(priceKeyFor("annual", "cny"), "annual_cny");
  assert.equal(priceKeyFor("annual_onetime", "cny"), "onetime_cny");
  assert.equal(priceKeyFor("annual_onetime", "usd"), "onetime_cny", "the one-time plan is CNY-only regardless of currency");

  const config = paddleServerConfig();
  assert.equal(config.environment, "sandbox");
  assert.equal(config.apiBaseUrl, "https://sandbox-api.paddle.com");
  assert.deepEqual(config.priceIds, {
    monthly_usd: "pri_monthly_usd",
    monthly_cny: "pri_monthly_cny",
    annual_usd: "pri_annual_usd",
    annual_cny: "pri_annual_cny",
    onetime_cny: "pri_onetime_cny",
  });
  assert.equal(config.configured, true);
});

/* ==================================================== webhook integration */

test("subscription.created creates a recurring row with paid-through access", async () => {
  const env = await freshEnv();
  const res = await handlePaddleWebhook(webhookRequest(SUB_CREATED), env);
  assert.equal(res.status, 200);

  const rows = subRows(env.DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider_subscription_id, "sub_1");
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].access_until, "2026-10-18T00:00:00.000Z");
  assert.equal(eventStatus(env.DB, "evt_sub_created"), "processed");
});

test("a duplicate delivery is a 200 no-op", async () => {
  const env = await freshEnv();
  await handlePaddleWebhook(webhookRequest(SUB_CREATED), env);
  const res = await handlePaddleWebhook(webhookRequest(SUB_CREATED), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, true);
  assert.equal(rowCount(env.DB, "subscriptions"), 1);
});

test("subscription.updated paused maps to paused and does not extend access", async () => {
  const env = await freshEnv();
  await handlePaddleWebhook(webhookRequest(SUB_CREATED), env);
  await handlePaddleWebhook(webhookRequest({
    event_id: "evt_sub_paused",
    event_type: "subscription.updated",
    occurred_at: "2026-09-20T00:00:00.000Z",
    data: {
      id: "sub_1",
      status: "paused",
      customer_id: "ctm_1",
      billing_cycle: { interval: "month", frequency: 1 },
      currency_code: "USD",
      current_billing_period: { starts_at: "2026-10-18T00:00:00.000Z", ends_at: "2026-11-18T00:00:00.000Z" },
    },
  }), env);

  const rows = subRows(env.DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "paused");
  assert.equal(rows[0].access_until, "2026-10-18T00:00:00.000Z", "paused never extends, even with a newer reported period");
});

test("a designated one-time transaction grants exactly 365 days", async () => {
  const env = await freshEnv();
  await handlePaddleWebhook(webhookRequest(oneTimeEvent()), env);

  const rows = subRows(env.DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].billing_interval, "one_time_365d");
  assert.equal(rows[0].provider_transaction_id, "txn_1");
  assert.equal(rows[0].access_until, new Date(Date.parse("2026-09-18T00:00:00.000Z") + ONE_TIME_365D_MS).toISOString());
});

test("the same one-time payment can never extend twice", async () => {
  const env = await freshEnv();
  await handlePaddleWebhook(webhookRequest(oneTimeEvent()), env);
  const before = subRows(env.DB)[0].access_until;

  const res = await handlePaddleWebhook(webhookRequest(oneTimeEvent({ event_id: "evt_txn_1_dup", occurred_at: "2026-10-01T00:00:00.000Z" })), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, true);
  assert.equal(subRows(env.DB)[0].access_until, before, "a replayed transaction id grants nothing");
});

test("an early renewal preserves remaining paid time, then adds 365 days", async () => {
  const env = await freshEnv();
  await handlePaddleWebhook(webhookRequest(oneTimeEvent()), env);
  const first = subRows(env.DB)[0].access_until;

  await handlePaddleWebhook(webhookRequest(oneTimeEvent({
    event_id: "evt_txn_2",
    occurred_at: "2026-10-18T00:00:00.000Z",
    data: { ...ONETIME_DATA, id: "txn_2" },
  })), env);

  const second = subRows(env.DB)[0].access_until;
  assert.equal(Date.parse(second) - Date.parse(first), ONE_TIME_365D_MS, "extends by 365 days from the existing end");
});

test("an unrelated one-time price grants nothing", async () => {
  const env = await freshEnv();
  const res = await handlePaddleWebhook(webhookRequest({
    event_id: "evt_txn_other",
    event_type: "transaction.completed",
    occurred_at: "2026-09-18T00:00:00.000Z",
    data: { id: "txn_other", customer_id: "ctm_1", currency_code: "USD", items: [{ price: { id: "pri_some_other_one_time", billing_cycle: null } }] },
  }), env);

  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, true);
  assert.equal(rowCount(env.DB, "subscriptions"), 0, "no entitlement row was created");
  assert.equal(eventStatus(env.DB, "evt_txn_other"), "ignored");
});

test("a quantity-2 purchase of the designated price grants nothing", async () => {
  const env = await freshEnv();
  const res = await handlePaddleWebhook(webhookRequest(oneTimeEvent({
    event_id: "evt_txn_qty2",
    data: {
      ...ONETIME_DATA,
      id: "txn_qty2",
      items: [{ price: { id: ONETIME_PRICE, billing_cycle: null }, quantity: 2 }],
    },
  })), env);

  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, true);
  assert.equal(rowCount(env.DB, "subscriptions"), 0, "quantity > 1 must not mint an entitlement row");
  assert.equal(eventStatus(env.DB, "evt_txn_qty2"), "ignored");
});

test("a mixed basket (designated + unexpected item) grants nothing", async () => {
  const env = await freshEnv();
  const res = await handlePaddleWebhook(webhookRequest(oneTimeEvent({
    event_id: "evt_txn_mixed",
    data: {
      ...ONETIME_DATA,
      id: "txn_mixed",
      items: [
        { price: { id: ONETIME_PRICE, billing_cycle: null } },
        { price: { id: "pri_extra", billing_cycle: null } },
      ],
    },
  })), env);

  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, true);
  assert.equal(rowCount(env.DB, "subscriptions"), 0, "an unexpected basket item must block the grant");
  assert.equal(eventStatus(env.DB, "evt_txn_mixed"), "ignored");
});

test("a recurring transaction.completed is ignored (subscription.* drives it)", async () => {
  const env = await freshEnv();
  await handlePaddleWebhook(webhookRequest(SUB_CREATED), env);
  const before = subRows(env.DB)[0].access_until;

  const res = await handlePaddleWebhook(webhookRequest({
    event_id: "evt_txn_recurring",
    event_type: "transaction.completed",
    occurred_at: "2026-10-18T00:00:00.000Z",
    data: {
      id: "txn_r1",
      subscription_id: "sub_1",
      customer_id: "ctm_1",
      currency_code: "USD",
      items: [{ price: { id: "pri_monthly", billing_cycle: { interval: "month", frequency: 1 } } }],
    },
  }), env);

  assert.equal((await res.json()).ignored, true);
  assert.equal(rowCount(env.DB, "subscriptions"), 1);
  assert.equal(subRows(env.DB)[0].access_until, before);
});

test("a stale signature is rejected before any DB write", async () => {
  const env = await freshEnv();
  const stale = Math.floor(Date.now() / 1000) - 10 * 60;
  const res = await handlePaddleWebhook(webhookRequest(SUB_CREATED, { ts: stale }), env);
  assert.equal(res.status, 401);
  assert.equal(rowCount(env.DB, "subscriptions"), 0);
  assert.equal(rowCount(env.DB, "billing_events"), 0);
});

test("a bad signature is rejected", async () => {
  const env = await freshEnv();
  const res = await handlePaddleWebhook(
    new Request("https://worker.test/webhooks/paddle", {
      method: "POST",
      headers: { "Paddle-Signature": "ts=0;h1=deadbeef" },
      body: JSON.stringify(SUB_CREATED),
    }),
    env,
  );
  assert.equal(res.status, 401);
});

/* ==================================================== schema change */

test("migration 0016 widens the status CHECKs and adds the transaction dedup index", async () => {
  const d1 = createD1();
  await applyMigration(d1, MIGRATION_PATH);
  d1.exec(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ('u1', 'a@b.co', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);

  const insertSub = (status, transactionId) => d1.exec(
    `INSERT INTO subscriptions (id, user_id, email, plan, status, provider, provider_transaction_id, currency, cancel_at_period_end, founding_member, created_at, updated_at)
     VALUES ('s1', 'u1', 'a@b.co', 'PRO', '${status}', 'paddle', ${transactionId === null ? "NULL" : `'${transactionId}'`}, 'USD', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );

  // Before 0016, 'paused' is rejected by the inline CHECK.
  assert.throws(() => insertSub("paused", null), /CHECK/i);

  await applyMigration(d1, "../../monitor-worker/migrations/0016_billing_schema_fixes.sql");

  // After 0016, 'paused' is a valid status and the dedup index exists.
  insertSub("paused", "txn_x");
  assert.equal(d1.raw.prepare("SELECT status FROM subscriptions WHERE id = 's1'").get().status, "paused");
  assert.ok(
    d1.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'subscriptions_provider_transaction_unique'").get(),
    "the transaction dedup index exists",
  );
  assert.throws(() => insertSub("active", "txn_x"), "a duplicate provider_transaction_id is rejected at the database layer");

  // The claim status the webhook writes with is now valid too.
  d1.exec(`INSERT INTO billing_events (id, provider, event_type, received_at, status) VALUES ('evt_x', 'paddle', 'subscription.created', '2026-01-01T00:00:00.000Z', 'received')`);
  assert.equal(d1.raw.prepare("SELECT status FROM billing_events WHERE id = 'evt_x'").get().status, "received");
});

test("migration 0016 preserves existing subscriptions and events", async () => {
  const d1 = createD1();
  await applyMigration(d1, MIGRATION_PATH);
  d1.exec(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ('u1', 'a@b.co', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);

  // Rows the pre-0016 schema already accepts, so they exist before the rebuild
  // and must survive the copy into the widened tables.
  d1.exec(`INSERT INTO subscriptions
     (id, user_id, email, plan, status, provider, provider_transaction_id, currency, cancel_at_period_end, founding_member, created_at, updated_at)
     VALUES ('s_existing', 'u1', 'a@b.co', 'PRO', 'active', 'paddle', 'txn_keep', 'USD', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  d1.exec(`INSERT INTO billing_events (id, provider, event_type, received_at, status) VALUES ('evt_keep', 'paddle', 'subscription.created', '2026-01-01T00:00:00.000Z', 'processed')`);

  await applyMigration(d1, "../../monitor-worker/migrations/0016_billing_schema_fixes.sql");

  const sub = d1.raw.prepare("SELECT id, status, provider_transaction_id, access_until FROM subscriptions WHERE id = 's_existing'").get();
  assert.equal(sub.status, "active");
  assert.equal(sub.provider_transaction_id, "txn_keep");

  const evt = d1.raw.prepare("SELECT status FROM billing_events WHERE id = 'evt_keep'").get();
  assert.equal(evt.status, "processed");

  assert.ok(
    d1.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'subscriptions_provider_transaction_unique'").get(),
    "the transaction dedup index exists after the rebuild",
  );
});
