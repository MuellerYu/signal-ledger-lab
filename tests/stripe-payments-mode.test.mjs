import assert from "node:assert/strict";
import test from "node:test";

import { dataUrl, loadModule } from "./helpers/transpile.mjs";

/**
 * Task H — the explicit production live-payments gate.
 *
 * Before this change, the live-key refusal was a hard stop on the key prefix
 * (`sk_live_`) alone: safe, but it made a real production launch impossible and
 * let the code infer "live" from a string. The gate makes the declared mode
 * (`STRIPE_PAYMENTS_MODE`) authoritative and never infers live from the key:
 *
 *   - missing / unrecognized mode → "test" (safe) — Preview/Sandbox can never
 *     drift into live mode just because a live key was dropped in;
 *   - mode=live + sk_test  → invalid (fail closed);
 *   - mode=test + sk_live  → invalid (fail closed);
 *   - mode=live + sk_live + both live price ids → the ONLY valid live path.
 *
 * Checkout and portal share the single `validateStripePayments` rule via
 * `stripeApi`, and neither returns the secret key to the client.
 */

const SK_TEST = "sk_test_FAKE_FIXTURE_NOT_A_KEY";
const SK_LIVE = "sk_live_FAKE_FIXTURE_NOT_A_KEY";
const PRICE_MONTHLY = "price_monthly_live";
const PRICE_ANNUAL = "price_annual_live";

/* ------------------------------------------------------------ module loading */

const cryptoUrl = await loadModule("crypto.ts");

const membershipDbMock = dataUrl(
  `export function getMembershipD1() { return null; }
export const MEMBERSHIP_DB_BINDING = "MEMBERSHIP_DB";`,
);

const runtimeMock = dataUrl(
  `let bindings = {};
export function setBindings(b) { bindings = b ?? {}; }
export function getBindings() { return bindings; }`,
);

const stripeServerUrl = await loadModule("stripe-server.ts", {
  "./crypto": cryptoUrl,
  "./membership-db": membershipDbMock,
  "./runtime": runtimeMock,
});
const stripeServer = await import(stripeServerUrl);
const runtime = await import(runtimeMock);

const { stripePaymentsMode, validateStripePayments, stripeServerConfig } = stripeServer;

/** A fake Stripe API that returns a hosted URL and records the Authorization header. */
function fakeStripe(urlValue = "https://hosted.example/session") {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ url: urlValue }),
        text: async () => "",
      };
    },
  };
}

const bindingsWith = (overrides) =>
  runtime.setBindings({
    STRIPE_SECRET_KEY: SK_TEST,
    STRIPE_PRICE_PRO_MONTHLY_USD: PRICE_MONTHLY,
    STRIPE_PRICE_PRO_ANNUAL_USD: PRICE_ANNUAL,
    ...overrides,
  });

/* ------------------------------------------------------------------- tests */

test("stripePaymentsMode: live is enabled only by an explicit 'live' value", () => {
  assert.equal(stripePaymentsMode(undefined), "test");
  assert.equal(stripePaymentsMode(null), "test");
  assert.equal(stripePaymentsMode(""), "test");
  assert.equal(stripePaymentsMode("   "), "test");
  assert.equal(stripePaymentsMode("test"), "test");
  assert.equal(stripePaymentsMode("live"), "live");
  assert.equal(stripePaymentsMode("LIVE"), "live");
  assert.equal(stripePaymentsMode(" Live "), "live");
  assert.equal(stripePaymentsMode("production"), "test", "unknown values fall back to safe test mode");
  assert.equal(stripePaymentsMode("bogus"), "test");
});

test("validateStripePayments: full truth table for mode × key × prices", () => {
  const v = (mode, key, monthly, annual) => validateStripePayments(mode, key, monthly, annual);

  // Test mode (default): the safe path.
  assert.deepEqual(v("test", SK_TEST, PRICE_MONTHLY, PRICE_ANNUAL), { valid: true, reason: null });
  // Live key in test mode is refused.
  const testWithLive = v("test", SK_LIVE, PRICE_MONTHLY, PRICE_ANNUAL);
  assert.equal(testWithLive.valid, false);
  assert.match(testWithLive.reason, /live key/i);

  // Missing key always fails closed, whatever the mode.
  assert.equal(v("test", "", PRICE_MONTHLY, PRICE_ANNUAL).valid, false);
  assert.equal(v("live", "", PRICE_MONTHLY, PRICE_ANNUAL).valid, false);

  // Test mode needs a test key and both price ids.
  assert.equal(v("test", SK_TEST, "", PRICE_ANNUAL).valid, false);
  assert.equal(v("test", SK_TEST, PRICE_MONTHLY, "").valid, false);

  // Live mode: the ONLY valid live path.
  assert.deepEqual(v("live", SK_LIVE, PRICE_MONTHLY, PRICE_ANNUAL), { valid: true, reason: null });
  // A test key in live mode is refused.
  const liveWithTest = v("live", SK_TEST, PRICE_MONTHLY, PRICE_ANNUAL);
  assert.equal(liveWithTest.valid, false);
  assert.match(liveWithTest.reason, /not a live key/i);
  // Live mode requires live price ids too.
  assert.equal(v("live", SK_LIVE, "", PRICE_ANNUAL).valid, false);
  assert.equal(v("live", SK_LIVE, PRICE_MONTHLY, "").valid, false);
});

test("stripeServerConfig: missing mode cannot enable live, even with a live key", () => {
  // The exact Preview/Sandbox hazard: a live key present, but no STRIPE_PAYMENTS_MODE.
  bindingsWith({ STRIPE_SECRET_KEY: SK_LIVE, STRIPE_PAYMENTS_MODE: undefined });
  const config = stripeServerConfig();

  assert.equal(config.mode, "test", "missing mode resolves to test");
  assert.equal(config.live, true, "the key is still detected as live (informational)");
  assert.equal(config.valid, false, "but a live key in test mode fails closed");
  assert.ok(config.reason);
});

test("stripeServerConfig: test mode refuses a live key; live mode refuses a test key", () => {
  bindingsWith({ STRIPE_SECRET_KEY: SK_LIVE, STRIPE_PAYMENTS_MODE: "test" });
  const testMode = stripeServerConfig();
  assert.equal(testMode.mode, "test");
  assert.equal(testMode.valid, false);
  assert.match(testMode.reason, /live key/i);

  bindingsWith({ STRIPE_SECRET_KEY: SK_TEST, STRIPE_PAYMENTS_MODE: "live" });
  const liveMode = stripeServerConfig();
  assert.equal(liveMode.mode, "live");
  assert.equal(liveMode.valid, false);
  assert.match(liveMode.reason, /not a live key/i);
});

test("stripeServerConfig: live mode + live key + both price ids is the valid live path", () => {
  bindingsWith({ STRIPE_SECRET_KEY: SK_LIVE, STRIPE_PAYMENTS_MODE: "live" });
  const config = stripeServerConfig();

  assert.equal(config.mode, "live");
  assert.equal(config.valid, true);
  assert.equal(config.reason, null);
});

test("stripeServerConfig: live mode with a live key but a missing price id fails closed", () => {
  bindingsWith({
    STRIPE_SECRET_KEY: SK_LIVE,
    STRIPE_PAYMENTS_MODE: "live",
    STRIPE_PRICE_PRO_MONTHLY_USD: "",
  });
  const config = stripeServerConfig();
  assert.equal(config.valid, false);
  assert.match(config.reason, /price/i);
});

test("stripeServerConfig: sandbox defaults are unchanged (test key, no mode) and remain valid", () => {
  bindingsWith({ STRIPE_PAYMENTS_MODE: undefined });
  const config = stripeServerConfig();
  assert.equal(config.mode, "test");
  assert.equal(config.valid, true);
  assert.equal(config.live, false);
});

test("checkout and portal share the same rule: an invalid config is refused by both", async () => {
  bindingsWith({ STRIPE_SECRET_KEY: SK_LIVE, STRIPE_PAYMENTS_MODE: "test" });
  const config = stripeServerConfig();
  assert.equal(config.valid, false);

  await assert.rejects(
    stripeServer.createCheckoutSession({
      customerId: "cus_x",
      priceId: config.priceIds.monthly,
      userId: "user_x",
      successUrl: "https://site.example/success",
      cancelUrl: "https://site.example/cancel",
      config,
      fetchImpl: fakeStripe().fetch,
    }),
    /live key/i,
    "checkout refuses an invalid config",
  );

  await assert.rejects(
    stripeServer.createPortalSessionUrl("cus_x", {
      config,
      fetchImpl: fakeStripe().fetch,
      returnUrl: "https://site.example/account",
    }),
    /live key/i,
    "portal refuses the same invalid config",
  );
});

test("checkout and portal share the same rule: a valid config is accepted by both", async () => {
  bindingsWith({ STRIPE_SECRET_KEY: SK_TEST, STRIPE_PAYMENTS_MODE: "test" });
  const config = stripeServerConfig();
  assert.equal(config.valid, true);

  const checkoutFetch = fakeStripe("https://hosted.example/checkout");
  const checkout = await stripeServer.createCheckoutSession({
    customerId: "cus_x",
    priceId: config.priceIds.monthly,
    userId: "user_x",
    successUrl: "https://site.example/success",
    cancelUrl: "https://site.example/cancel",
    config,
    fetchImpl: checkoutFetch.fetch,
  });
  assert.deepEqual(checkout, { url: "https://hosted.example/checkout" });

  const portalFetch = fakeStripe("https://hosted.example/portal");
  const portalUrl = await stripeServer.createPortalSessionUrl("cus_x", {
    config,
    fetchImpl: portalFetch.fetch,
    returnUrl: "https://site.example/account",
  });
  assert.equal(portalUrl, "https://hosted.example/portal");
});

test("no secret reaches the client: the returned values carry no key material", async () => {
  bindingsWith({ STRIPE_SECRET_KEY: SK_TEST, STRIPE_PAYMENTS_MODE: "test" });
  const config = stripeServerConfig();

  const checkoutFetch = fakeStripe("https://hosted.example/checkout");
  const checkout = await stripeServer.createCheckoutSession({
    customerId: "cus_x",
    priceId: config.priceIds.monthly,
    userId: "user_x",
    successUrl: "https://site.example/success",
    cancelUrl: "https://site.example/cancel",
    config,
    fetchImpl: checkoutFetch.fetch,
  });

  // The secret is sent to Stripe on the wire (server-side)…
  assert.equal(checkoutFetch.calls[0].init.headers.Authorization, `Bearer ${SK_TEST}`);
  // …but the value handed back to the browser is exactly { url }, nothing else.
  assert.deepEqual(Object.keys(checkout).sort(), ["url"]);
  assert.ok(!JSON.stringify(checkout).includes(SK_TEST), "checkout result must not contain the secret");

  const portalFetch = fakeStripe("https://hosted.example/portal");
  const portalUrl = await stripeServer.createPortalSessionUrl("cus_x", {
    config,
    fetchImpl: portalFetch.fetch,
    returnUrl: "https://site.example/account",
  });
  assert.equal(portalFetch.calls[0].init.headers.Authorization, `Bearer ${SK_TEST}`);
  assert.ok(!portalUrl.includes(SK_TEST), "portal result must not contain the secret");
});
