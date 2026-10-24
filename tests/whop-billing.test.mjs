import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { dataUrl, loadModule } from "./helpers/transpile.mjs";
import { applyMigration, createD1 } from "./helpers/sqlite-d1.mjs";

const billingUrl = await loadModule("whop-billing.ts");
const billing = await import(billingUrl);
const { whopConfig, createWhopCheckout, verifyWhopSignature, assertPlan, WHOP_VERSION, WHOP_API } = billing;
const webhookSource = (await readFile(new URL("../monitor-worker/src/whop-webhook.ts", import.meta.url), "utf8")).replace('"../../lib/whop-billing"', JSON.stringify(billingUrl));
const { handleWhopWebhook } = await import(dataUrl(ts.transpileModule(webhookSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText));
const { resolveEntitlement } = await import(await loadModule("entitlement.ts"));
const env = { WHOP_API_KEY: "sandbox-secret-never-print", WHOP_ENVIRONMENT: "sandbox", WHOP_CHECKOUT_ENABLED: "true", WHOP_ACCOUNT_ID: "biz_test", WHOP_PRODUCT_ID: "prod_test", WHOP_PLAN_MONTHLY_ID: "plan_monthly", WHOP_PLAN_ANNUAL_ID: "plan_annual", WHOP_WEBHOOK_SECRET: "ws_test_secret", SITE_ORIGIN: "https://whop-sandbox.example.com" };
const config = whopConfig(env);
const plan = (kind = "monthly") => ({ id: config.plans[kind], account: { id: config.account }, product: { id: config.product }, plan_type: "renewal", billing_period: kind === "monthly" ? 30 : 365, currency: "usd", initial_price: 0, initial_price_due: { amount: kind === "monthly" ? "19.99" : "179.00", currency: "usd" }, renewal_price: kind === "monthly" ? 19.99 : 179, trial_period_days: null, split_pay_required_payments: null, release_method: "buy_now", visibility: "hidden" });
const start = new Date().toISOString();
const days = (n) => new Date(Date.parse(start) + n * 86400000).toISOString();
const membership = (extra = {}) => ({ id: "mem_test", account: { id: "biz_test" }, product_id: "prod_test", plan_id: "plan_monthly", current_period_end: days(30), status: "active", cancel_at_period_end: false, metadata: { user_id: "user_a", order_id: "order_test" }, ...extra });
const payment = (extra = {}) => ({ id: "pay_test", account_id: "biz_test", product_id: "prod_test", plan_id: "plan_monthly", membership_id: "mem_test", status: "paid", substatus: "succeeded", paid_at: start, updated_at: start, subtotal: { amount: "19.99", currency: "usd" }, total: { amount: "19.99", currency: "usd" }, metadata: { user_id: "user_a", order_id: "order_test" }, checkout_configuration_id: "ch_test", ...extra });

async function database() {
  const db = createD1();
  for (const migration of ["0015_membership", "0016_billing_schema_fixes", "0017_stripe_status", "0018_cancel_at", "0021_whop_billing"]) await applyMigration(db, `../../monitor-worker/migrations/${migration}.sql`);
  db.raw.prepare("INSERT INTO users(id,email,email_verified,created_at,updated_at) VALUES (?,?,1,?,?)").run("user_a", "a@example.com", start, start);
  const original = db.prepare.bind(db), queries = new WeakMap();
  db.prepare = (sql) => ({ bind(...args) { const statement = original(sql).bind(...args); queries.set(statement, [sql, args]); return statement; } });
  db.batch = async statements => {
    db.raw.exec("BEGIN");
    try {
      const result = statements.map(statement => { const [sql, args] = queries.get(statement); return db.raw.prepare(sql).run(...args); });
      db.raw.exec("COMMIT"); return result;
    } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
  };
  return db;
}
function seedOrder(db, overrides = {}) {
  const o = { id: "order_test", user: "user_a", plan: "monthly", planId: "plan_monthly", ...overrides };
  db.raw.prepare("INSERT INTO whop_orders(id,user_id,plan_id,plan,checkout_id,status,created_at) VALUES (?,?,?,?,?,'pending',?)").run(o.id, o.user, o.planId, o.plan, "ch_test", start);
}
function signed(type = "payment.succeeded", id = "msg_test", data = { id: "pay_test" }, extra = {}) {
  const raw = JSON.stringify({ id, type, account_id: "biz_test", api_version: "v1", api_version_date: WHOP_VERSION, timestamp: start, data, ...extra });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", env.WHOP_WEBHOOK_SECRET).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return new Request("https://worker.example.com/webhooks/whop", { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${sig}` }, body: raw });
}
function api(resources) {
  return async (url, options) => {
    assert.ok(url.startsWith(WHOP_API + "/"));
    assert.equal(options.headers["Api-Version-Date"], WHOP_VERSION);
    assert.equal(options.redirect, "error");
    const path = url.slice(WHOP_API.length);
    const value = resources[path];
    if (!value) return new Response("provider secret error", { status: 500 });
    return Response.json(typeof value === "function" ? value(options) : value);
  };
}
const resources = (p = payment(), m = membership()) => ({ [`/payments/${p.id}`]: p, [`/memberships/${m.id}`]: m });
const sub = db => db.raw.prepare("SELECT * FROM subscriptions WHERE provider='whop'").get();
const tier = (db, now = Date.now()) => {
  const s = sub(db);
  return resolveEntitlement({ user: { id: "user_a", emailVerified: true }, subscriptions: s ? [{ id: s.id, userId: s.user_id, plan: s.plan, status: s.status, accessUntil: s.access_until, cancelAtPeriodEnd: Boolean(s.cancel_at_period_end) }] : [], now }).tier;
};

test("sandbox config fails closed for missing values, live environments and production origins", () => {
  assert.equal(config.checkoutEnabled, true);
  for (const change of [{ WHOP_ENVIRONMENT: "live" }, { WHOP_ENVIRONMENT: undefined }, { WHOP_API_KEY: "" }, { WHOP_ACCOUNT_ID: "" }, { WHOP_PLAN_ANNUAL_ID: "plan_monthly" }, { SITE_ORIGIN: "https://signalledgerlab.com" }, { SITE_ORIGIN: "https://your-project.pages.dev" }]) assert.equal(whopConfig({ ...env, ...change }).valid, false);
  assert.equal(whopConfig({ ...env, WHOP_CHECKOUT_ENABLED: undefined }).checkoutEnabled, false);
});
test("exact price/interval/product/account checks reject mismatches and trials", () => {
  assertPlan(plan(), config, "monthly"); assertPlan(plan("annual"), config, "annual");
  for (const patch of [{ initial_price: 19.99 }, { renewal_price: 19.9901 }, { currency: "eur" }, { billing_period: 31 }, { trial_period_days: 7 }, { plan_type: "one_time" }, { product: { id: "prod_other" } }, { account: { id: "biz_other" } }, { adaptive_pricing_enabled: true }, { visibility: "archived" }]) assert.throws(() => assertPlan({ ...plan(), ...patch }, config, "monthly"));
  assert.equal(billing.cents("19.99"), 1999); assert.equal(billing.cents("19.999"), null);
});
test("signature validates raw bytes, timestamp window, rotating signatures and tampering", async () => {
  const req = signed(), raw = await req.text();
  assert.equal(await verifyWhopSignature(raw, req.headers, env.WHOP_WEBHOOK_SECRET), true);
  assert.equal(await verifyWhopSignature(raw + " ", req.headers, env.WHOP_WEBHOOK_SECRET), false);
  assert.equal(await verifyWhopSignature(raw, req.headers, "ws_wrong"), false);
  assert.equal(await verifyWhopSignature(raw, req.headers, env.WHOP_WEBHOOK_SECRET, Date.now() + 301000), false);
  assert.equal(await verifyWhopSignature(raw, req.headers, env.WHOP_WEBHOOK_SECRET, Date.now() - 301000), false);
  req.headers.set("webhook-signature", `v1,garbage ${req.headers.get("webhook-signature")}`);
  assert.equal(await verifyWhopSignature(raw, req.headers, env.WHOP_WEBHOOK_SECRET), true);
});
for (const kind of ["monthly", "annual"]) test(`${kind} checkout persists server identity and shares order/idempotency across retries`, async () => {
  const db = await database(); let calls = 0;
  const fetchImpl = api({ [`/plans/${config.plans[kind]}`]: plan(kind), "/checkout_configurations": options => {
    calls++; const body = JSON.parse(options.body);
    assert.equal(body.plan_id, config.plans[kind]); assert.equal(body.metadata.user_id, "user_a");
    assert.equal(body.metadata.order_id, options.headers["Idempotency-Key"]);
    assert.equal(db.raw.prepare("SELECT user_id FROM whop_orders WHERE id=?").get(body.metadata.order_id).user_id, "user_a");
    return { id: "ch_test", purchase_url: "https://sandbox.whop.com/checkout/test" };
  } });
  const user = { id: "user_a", emailVerified: true };
  const first = await createWhopCheckout(db, config, user, kind, fetchImpl);
  const again = await createWhopCheckout(db, config, user, kind, fetchImpl);
  assert.deepEqual(first, again); assert.equal(calls, 1); assert.equal(tier(db), "FREE");
});
test("checkout refuses disabled gate, unverified users and production redirects", async () => {
  const db = await database(); const user = { id: "user_a", emailVerified: true };
  await assert.rejects(createWhopCheckout(db, { ...config, checkoutEnabled: false }, user, "monthly"));
  await assert.rejects(createWhopCheckout(db, config, { ...user, emailVerified: false }, "monthly"));
  await assert.rejects(createWhopCheckout(db, config, user, "monthly", api({ "/plans/plan_monthly": plan(), "/checkout_configurations": { id: "ch_live", purchase_url: "https://whop.com/checkout/live" } })));
  for (const url of ["https://sandbox.whop.com.evil.com/x", "http://sandbox.whop.com/x", "https://a@ sandbox.whop.com/x"]) assert.throws(() => billing.sandboxCheckoutUrl(url));
});
test("payment grants exactly the paid period; replay and concurrent duplicate are idempotent", async () => {
  const db = await database(); seedOrder(db);
  const fetchImpl = api(resources());
  const responses = await Promise.all([handleWhopWebhook(signed(), { ...env, DB: db }, fetchImpl), handleWhopWebhook(signed(), { ...env, DB: db }, fetchImpl)]);
  assert.ok(responses.every(r => r.status === 200));
  assert.equal(tier(db), "PRO"); assert.equal(sub(db).access_until, days(30));
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM whop_payments").get().n, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM billing_events").get().n, 1);
  assert.equal((await handleWhopWebhook(signed(), { ...env, DB: db }, () => { throw Error("must not call"); })).status, 200);
});
test("membership activation alone and checkout return do not grant PRO", async () => {
  const db = await database(); seedOrder(db);
  assert.equal((await handleWhopWebhook(signed("membership.activated", "msg_activation", { id: "mem_test" }), { ...env, DB: db }, api(resources()))).status, 200);
  assert.equal(tier(db), "FREE"); assert.equal(sub(db).access_until, null);
});
test("renewal extends once, cancellation preserves paid time, expiry resolves FREE", async () => {
  const db = await database(); seedOrder(db);
  await handleWhopWebhook(signed(), { ...env, DB: db }, api(resources()));
  const renewal = payment({ id: "pay_renewal", paid_at: days(30), updated_at: days(30), metadata: null });
  assert.equal((await handleWhopWebhook(signed("payment.succeeded", "msg_renewal", { id: "pay_renewal" }, { timestamp: days(30) }), { ...env, DB: db }, api(resources(renewal, membership({ current_period_end: days(60) }))))).status, 200);
  assert.equal(sub(db).access_until, days(60));
  await handleWhopWebhook(signed("membership.cancel_at_period_end_changed", "msg_cancel", { id: "mem_test" }, { timestamp: days(31) }), { ...env, DB: db }, api(resources(renewal, membership({ current_period_end: days(60), cancel_at_period_end: true }))));
  assert.equal(sub(db).cancel_at_period_end, 1); assert.equal(tier(db, Date.parse(days(40))), "PRO");
  assert.equal(tier(db, Date.parse(days(60))), "FREE");
  await handleWhopWebhook(signed("membership.activated", "msg_old", { id: "mem_test" }), { ...env, DB: db }, api(resources()));
  assert.equal(sub(db).cancel_at_period_end, 1); assert.equal(sub(db).access_until, days(60));
});
test("failed renewal neither extends nor truncates paid access", async () => {
  const db = await database(); seedOrder(db);
  await handleWhopWebhook(signed(), { ...env, DB: db }, api(resources()));
  const failed = payment({ id: "pay_failed", status: "open", paid_at: null });
  await handleWhopWebhook(signed("payment.failed", "msg_failed", { id: "pay_failed" }), { ...env, DB: db }, api(resources(failed, membership({ status: "past_due", current_period_end: days(60) }))));
  assert.equal(sub(db).access_until, days(30)); assert.equal(tier(db), "PRO");
});
test("full refund revokes its payment and late success cannot restore it", async () => {
  const db = await database(); seedOrder(db);
  await handleWhopWebhook(signed(), { ...env, DB: db }, api(resources()));
  const refunded = payment({ substatus: "refunded" });
  const fetchImpl = api({ ...resources(refunded), "/refunds/rf_test": { id: "rf_test", payment_id: "pay_test", account_id: "biz_test", status: "succeeded" } });
  assert.equal((await handleWhopWebhook(signed("refund.updated", "msg_refund", { id: "rf_test" }), { ...env, DB: db }, fetchImpl)).status, 200);
  assert.equal(tier(db), "FREE");
  await handleWhopWebhook(signed("payment.succeeded", "msg_late"), { ...env, DB: db }, api(resources()));
  assert.equal(tier(db), "FREE");
});
test("refund arriving before success cannot create transient access", async () => {
  const db = await database(); seedOrder(db);
  const fetchImpl = api({ ...resources(payment({ substatus: "refunded" })), "/refunds/rf_test": { payment_id: "pay_test", account_id: "biz_test", status: "succeeded" } });
  await handleWhopWebhook(signed("refund.created", "msg_refund", { id: "rf_test" }), { ...env, DB: db }, fetchImpl);
  assert.equal(tier(db), "FREE");
});
test("partial and pending refunds retain access", async () => {
  for (const status of ["pending", "succeeded"]) {
    const db = await database(); seedOrder(db);
    await handleWhopWebhook(signed(), { ...env, DB: db }, api(resources()));
    const fetchImpl = api({ ...resources(payment({ substatus: "partially_refunded" })), "/refunds/rf_test": { payment_id: "pay_test", account_id: "biz_test", status } });
    await handleWhopWebhook(signed("refund.updated", `msg_${status}`, { id: "rf_test" }), { ...env, DB: db }, fetchImpl);
    assert.equal(tier(db), "PRO");
  }
});
test("refund of old period does not revoke a later paid renewal", async () => {
  const db = await database(); seedOrder(db);
  await handleWhopWebhook(signed(), { ...env, DB: db }, api(resources()));
  const renewal = payment({ id: "pay_renewal", paid_at: days(30), updated_at: days(30) });
  await handleWhopWebhook(signed("payment.succeeded", "msg_renewal", { id: "pay_renewal" }), { ...env, DB: db }, api(resources(renewal, membership({ current_period_end: days(60) }))));
  const fetchImpl = api({ ...resources(payment({ substatus: "refunded" }), membership({ current_period_end: days(60) })), "/refunds/rf_test": { payment_id: "pay_test", account_id: "biz_test", status: "succeeded" } });
  await handleWhopWebhook(signed("refund.updated", "msg_refund", { id: "rf_test" }), { ...env, DB: db }, fetchImpl);
  assert.equal(sub(db).access_until, days(60));
});
test("annual payment grants a bounded year", async () => {
  const db = await database(); seedOrder(db, { plan: "annual", planId: "plan_annual" });
  const annual = payment({ plan_id: "plan_annual", subtotal: { amount: "179.00", currency: "usd" }, total: { amount: "179.00", currency: "usd" } });
  await handleWhopWebhook(signed(), { ...env, DB: db }, api(resources(annual, membership({ plan_id: "plan_annual", current_period_end: days(365) }))));
  assert.equal(sub(db).access_until, days(365)); assert.equal(sub(db).billing_interval, "year");
});
test("identity, product, account, checkout and version mismatches never grant", async () => {
  for (const patch of [{ metadata: { user_id: "user_b", order_id: "order_test" } }, { product_id: "prod_other" }, { account_id: "biz_other" }, { checkout_configuration_id: "ch_other" }, { plan_id: "plan_other" }, { subtotal: { currency: "usd", amount: "1.00" } }]) {
    const db = await database(); seedOrder(db);
    await handleWhopWebhook(signed(), { ...env, DB: db }, api(resources(payment(patch))));
    assert.equal(tier(db), "FREE");
  }
  const db = await database(); seedOrder(db);
  for (const extra of [{ account_id: "biz_other" }, { api_version_date: "2020-01-01" }]) assert.equal((await handleWhopWebhook(signed("payment.succeeded", "msg_invalid", { id: "pay_test" }, extra), { ...env, DB: db }, api(resources()))).status, 400);
});
test("atomic rollback leaves events retryable and preserves existing providers", async () => {
  const db = await database(); seedOrder(db); const batch = db.batch;
  db.raw.exec("CREATE TRIGGER fail_whop BEFORE INSERT ON whop_payments BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal((await handleWhopWebhook(signed(), { ...env, DB: db }, api(resources()))).status, 503);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM billing_events").get().n, 0);
  assert.equal(db.raw.prepare("SELECT membership_id FROM whop_orders").get().membership_id, null);
  db.raw.exec("DROP TRIGGER fail_whop"); db.batch = batch;
  assert.equal((await handleWhopWebhook(signed(), { ...env, DB: db }, api(resources()))).status, 200);
  assert.equal(tier(db), "PRO");
});
test("bad signature and upstream failure never acknowledge fulfillment", async () => {
  const db = await database(); seedOrder(db);
  const req = signed(); req.headers.set("webhook-signature", "v1,bad");
  assert.equal((await handleWhopWebhook(req, { ...env, DB: db }, api(resources()))).status, 401);
  const result = await handleWhopWebhook(signed(), { ...env, DB: db }, api({}));
  assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), /secret|provider/);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM billing_events").get().n, 0);
});

async function routeHarness(name) {
  const state = dataUrl(`let user = null, db = null, bindings = {}; export const getCurrentUser = async () => user; export const getMembershipD1 = () => db; export const getBindings = () => bindings; export function set(u,d,b) { user=u;db=d;bindings=b; }`);
  let source = await readFile(new URL(`../app/api/billing/whop/${name}/route.ts`, import.meta.url), "utf8");
  for (const specifier of ["@/lib/access", "@/lib/membership-db", "@/lib/runtime"]) source = source.replace(JSON.stringify(specifier), JSON.stringify(state));
  source = source.replace('"@/lib/whop-billing"', JSON.stringify(billingUrl));
  const route = await import(dataUrl(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText));
  return { ...route, state: await import(state) };
}
const request = (body, origin = config.origin) => new Request(`${config.origin}/api/billing/whop/checkout`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
test("checkout route requires a verified same-origin session; injected identities and prices are ignored", async () => {
  const route = await routeHarness("checkout"), db = await database();
  route.state.set(null, db, env); assert.equal((await route.POST(request({ plan: "monthly" }))).status, 401);
  route.state.set({ id: "user_a", emailVerified: false }, db, env); assert.equal((await route.POST(request({ plan: "monthly" }))).status, 403);
  route.state.set({ id: "user_a", emailVerified: true }, db, env);
  assert.equal((await route.POST(request({ plan: "monthly" }, "https://evil.example"))).status, 403);
  assert.equal((await route.POST(request({ plan: "free" }))).status, 400);
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = api({ "/plans/plan_monthly": plan(), "/checkout_configurations": options => {
      const sent = JSON.parse(options.body); assert.equal(sent.metadata.user_id, "user_a"); assert.notEqual(sent.metadata.order_id, "order_attacker"); assert.equal(sent.plan_id, "plan_monthly");
      return { id: "ch_test", purchase_url: "https://sandbox.whop.com/checkout/test" };
    } });
    const response = await route.POST(request({ plan: "monthly", user_id: "user_b", order_id: "order_attacker", plan_id: "plan_free", price: 0 }));
    assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store"); assert.doesNotMatch(await response.text(), /sandbox-secret|ws_test/);
  } finally { globalThis.fetch = previous; }
});
test("cancellation endpoint selects only the session user's subscriptions and always cancels at period end", async () => {
  const route = await routeHarness("cancel"), db = await database(); seedOrder(db);
  await handleWhopWebhook(signed(), { ...env, DB: db }, api(resources()));
  route.state.set({ id: "user_a", emailVerified: true }, db, env);
  const previous = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = api({ "/memberships/mem_test/cancel": options => { calls++; assert.deepEqual(JSON.parse(options.body), { cancel_at_period_end: true }); return membership({ cancel_at_period_end: true }); } });
    assert.equal((await route.POST(request({ membership_id: "mem_someone_else" }))).status, 200); assert.equal(calls, 1); assert.equal(tier(db), "PRO");
    assert.equal((await route.POST(request({}, "https://evil.example"))).status, 403);
    route.state.set({ id: "user_b", emailVerified: true }, db, env); assert.equal((await route.POST(request({}))).status, 409);
  } finally { globalThis.fetch = previous; }
});
