import assert from "node:assert/strict";
import test from "node:test";

import { applyMigration, createD1 } from "./helpers/sqlite-d1.mjs";
import { dataUrl, loadModule } from "./helpers/transpile.mjs";

/**
 * Stripe customer-creation race safety in `ensureStripeCustomer`.
 *
 * Two concurrent first-time checkout requests used to be able to create two
 * Stripe customers (the local `billing_customers` lookup missing for both, and
 * `POST /v1/customers` happening before any uniqueness guard), leaving one of
 * them orphaned. These tests pin the fixed contract:
 *   - a deterministic Idempotency-Key (`signal-ledger-customer:<userId>`) makes
 *     Stripe return the SAME customer id to both concurrent requests;
 *   - `UNIQUE(user_id, provider)` still caps the mapping at one row; and
 *   - the loser of the DB insert re-reads the canonical mapping instead of
 *     trusting the customer id it just created, so the portal always resolves
 *     the customer that owns the subscription.
 */

const SANDBOX_DIR = "../../monitor-worker/migrations-sandbox";
const MEMBERSHIP_MIGRATIONS = ["0015_membership.sql"];

const NOW_ISO = "2026-09-20T00:00:00.000Z";

const config = {
  configured: true,
  mode: "test",
  apiBaseUrl: "https://api.stripe.com/v1",
  secretKey: "sk_test_fake",
  live: false,
  valid: true,
  reason: null,
  priceIds: { monthly: "price_m", annual: "price_a" },
};

async function freshDb() {
  const d1 = createD1();
  for (const file of MEMBERSHIP_MIGRATIONS) {
    await applyMigration(d1, `${SANDBOX_DIR}/${file}`);
  }
  return d1;
}

/* ------------------------------------------------------------ module loading */

const cryptoUrl = await loadModule("crypto.ts");

// `getMembershipD1()` reads runtime bindings; in tests it is routed through a
// mutable global so each test can point it at its own D1 (or wrapper).
const membershipDbMock = dataUrl(
  `export function getMembershipD1() { return globalThis.__slMembershipD1 ?? null; }
export const MEMBERSHIP_DB_BINDING = "MEMBERSHIP_DB";`,
);
const runtimeMock = dataUrl(`export function getBindings() { return {}; }`);

const stripeServerUrl = await loadModule("stripe-server.ts", {
  "./crypto": cryptoUrl,
  "./membership-db": membershipDbMock,
  "./runtime": runtimeMock,
});
const stripeServer = await import(stripeServerUrl);

/* ------------------------------------------------------------- seeding data */

function seedUser(d1, id, email) {
  d1.raw
    .prepare(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(id, email, NOW_ISO, NOW_ISO);
}

function insertMapping(d1, userId, customerId) {
  d1.raw
    .prepare(
      `INSERT INTO billing_customers (id, user_id, provider, provider_customer_id, created_at, updated_at)
       VALUES (?, ?, 'stripe', ?, ?, ?)`,
    )
    .run(`billing_${userId}_${customerId}`, userId, customerId, NOW_ISO, NOW_ISO);
}

const mappingCount = (d1, userId) =>
  d1.raw
    .prepare(`SELECT COUNT(*) AS n FROM billing_customers WHERE user_id = ?`)
    .get(userId).n;

const totalMappingCount = (d1) =>
  d1.raw.prepare(`SELECT COUNT(*) AS n FROM billing_customers`).get().n;

/**
 * A fake Stripe API that records every call and returns a customer id derived
 * from the request's metadata user id — the same value Stripe would return to
 * two requests that share an Idempotency-Key.
 */
function fakeStripe() {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      const body = new URLSearchParams(init.body);
      const userId = body.get("metadata[signal_ledger_user_id]");
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: `cus_${userId}`, url: "https://portal.example" }),
        text: async () => "",
      };
    },
  };
}

/**
 * A D1 wrapper that simulates the losing side of a concurrent insert: when the
 * INSERT OR IGNORE runs, another request has already stored the canonical
 * customer (a different id), and this request's insert changes zero rows.
 */
function lostRaceD1(d1, winnerCustomerId, userId) {
  return {
    prepare(sql) {
      const stmt = d1.prepare(sql);
      return {
        bind(...values) {
          const bound = stmt.bind(...values);
          return {
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO billing_customers")) {
                d1.raw
                  .prepare(
                    `INSERT INTO billing_customers (id, user_id, provider, provider_customer_id, created_at, updated_at)
                     VALUES (?, ?, 'stripe', ?, ?, ?)`,
                  )
                  .run("billing_winner", userId, winnerCustomerId, NOW_ISO, NOW_ISO);
                return { success: true, meta: { changes: 0 } };
              }
              return bound.run();
            },
            async first(...args) {
              return bound.first(...args);
            },
            async all(...args) {
              return bound.all(...args);
            },
          };
        },
      };
    },
  };
}

/* ------------------------------------------------------------------- tests */

test("1. reuse: an existing mapped customer is returned without calling Stripe", async () => {
  const d1 = await freshDb();
  globalThis.__slMembershipD1 = d1;
  seedUser(d1, "u1", "pro@example.com");
  insertMapping(d1, "u1", "cus_existing");

  const stripe = fakeStripe();
  const result = await stripeServer.ensureStripeCustomer("u1", "pro@example.com", NOW_ISO, {
    config,
    fetchImpl: stripe.fetch,
  });

  assert.deepEqual(result, { customerId: "cus_existing", created: false });
  assert.equal(stripe.calls.length, 0, "no Stripe call when a mapping already exists");
});

test("2. first-time: creates a customer with a deterministic idempotency key", async () => {
  const d1 = await freshDb();
  globalThis.__slMembershipD1 = d1;
  seedUser(d1, "u1", "pro@example.com");

  const stripe = fakeStripe();
  const result = await stripeServer.ensureStripeCustomer("u1", "pro@example.com", NOW_ISO, {
    config,
    fetchImpl: stripe.fetch,
  });

  assert.equal(result.customerId, "cus_u1");
  assert.equal(result.created, true);
  assert.equal(stripe.calls.length, 1);
  assert.equal(stripe.calls[0].url, "https://api.stripe.com/v1/customers");
  assert.equal(stripe.calls[0].init.headers["Idempotency-Key"], "signal-ledger-customer:u1");
  assert.equal(mappingCount(d1, "u1"), 1);
});

test("3. concurrent: two simultaneous first-time creates resolve to one customer", async () => {
  const d1 = await freshDb();
  globalThis.__slMembershipD1 = d1;
  seedUser(d1, "u1", "pro@example.com");

  const stripe = fakeStripe();
  const [a, b] = await Promise.all([
    stripeServer.ensureStripeCustomer("u1", "pro@example.com", NOW_ISO, { config, fetchImpl: stripe.fetch }),
    stripeServer.ensureStripeCustomer("u1", "pro@example.com", NOW_ISO, { config, fetchImpl: stripe.fetch }),
  ]);

  assert.equal(a.customerId, "cus_u1");
  assert.equal(b.customerId, "cus_u1");
  assert.equal(stripe.calls.length, 2, "both requests still POST, but share a key");
  assert.ok(
    stripe.calls.every((c) => c.init.headers["Idempotency-Key"] === "signal-ledger-customer:u1"),
    "every request carries the same deterministic idempotency key",
  );
  assert.equal(mappingCount(d1, "u1"), 1, "exactly one mapping row survives");
});

test("4. lost race: re-reads the canonical mapping, not the just-created response", async () => {
  const d1 = await freshDb();
  const wrapper = lostRaceD1(d1, "cus_winner", "u1");
  globalThis.__slMembershipD1 = wrapper;
  seedUser(d1, "u1", "pro@example.com");

  const stripe = fakeStripe();
  const result = await stripeServer.ensureStripeCustomer("u1", "pro@example.com", NOW_ISO, {
    config,
    fetchImpl: stripe.fetch,
  });

  assert.equal(result.customerId, "cus_winner", "the winner's customer id wins, not the just-created one");
  assert.equal(result.created, false);
  assert.equal(mappingCount(d1, "u1"), 1);
});

test("5. dedup: concurrent creates leave exactly one mapping row overall", async () => {
  const d1 = await freshDb();
  globalThis.__slMembershipD1 = d1;
  seedUser(d1, "u1", "pro@example.com");

  const stripe = fakeStripe();
  await Promise.all([
    stripeServer.ensureStripeCustomer("u1", "pro@example.com", NOW_ISO, { config, fetchImpl: stripe.fetch }),
    stripeServer.ensureStripeCustomer("u1", "pro@example.com", NOW_ISO, { config, fetchImpl: stripe.fetch }),
    stripeServer.ensureStripeCustomer("u1", "pro@example.com", NOW_ISO, { config, fetchImpl: stripe.fetch }),
  ]);

  assert.equal(totalMappingCount(d1), 1, "UNIQUE(user_id, provider) holds under concurrency");
});

test("6. portal: resolves the canonical customer after a lost race", async () => {
  const d1 = await freshDb();
  const wrapper = lostRaceD1(d1, "cus_winner", "u1");
  globalThis.__slMembershipD1 = wrapper;
  seedUser(d1, "u1", "pro@example.com");

  const stripe = fakeStripe();
  const ensured = await stripeServer.ensureStripeCustomer("u1", "pro@example.com", NOW_ISO, {
    config,
    fetchImpl: stripe.fetch,
  });
  assert.equal(ensured.customerId, "cus_winner");

  const portalUrl = await stripeServer.createPortalSessionUrl(ensured.customerId, {
    config,
    fetchImpl: stripe.fetch,
    returnUrl: "https://site.example/account",
  });
  assert.equal(portalUrl, "https://portal.example");

  const portalCall = stripe.calls.find((c) => c.url.endsWith("/billing_portal/sessions"));
  assert.ok(portalCall, "portal session was minted");
  const body = new URLSearchParams(portalCall.init.body);
  assert.equal(body.get("customer"), "cus_winner", "portal resolves the canonical customer id");
});
