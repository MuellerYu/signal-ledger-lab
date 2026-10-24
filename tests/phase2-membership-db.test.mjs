import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { dataUrl, loadModule } from "./helpers/transpile.mjs";

/**
 * The membership binding contract.
 *
 * Membership data shares a physical D1 with the market data, so the only thing
 * keeping the Pages app's legacy `ensureDatabase()` away from the live market
 * database is that membership is read through its own binding. These tests fail
 * if that separation is ever quietly removed.
 */

/** Auth/membership surfaces. Each must reach the database one way only. */
const MEMBERSHIP_ROUTES = [
  "app/api/auth/request-link/route.ts",
  "app/api/auth/consume/route.ts",
  "app/api/auth/signout/route.ts",
  "app/api/account/preferences/route.ts",
  "app/auth/verify/route.ts",
  "app/email/preferences/route.ts",
  "app/api/email/preferences/route.ts",
];

/* ------------------------------------------------------- the accessor */

/** The assertions below are about code, so prose in comments must not match. */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the membership accessor reads only MEMBERSHIP_DB", async () => {
  const code = stripComments(await readFile("lib/membership-db.ts", "utf8"));
  assert.match(code, /MEMBERSHIP_DB/, "it reads the dedicated binding");
  assert.doesNotMatch(code, /\bDB\b(?!\s*:)/, "it must not fall back to DB");
  assert.doesNotMatch(code, /PORTFOLIO_DB/, "it must not fall back to PORTFOLIO_DB");
  assert.doesNotMatch(code, /ensureDatabase/, "it must never initialize a schema");
  assert.doesNotMatch(code, /new Map\(|memoryViews|globalThis\./, "it must not carry a fallback store");
  assert.doesNotMatch(code, /CREATE TABLE|INSERT INTO|UPDATE |DELETE FROM/, "it must not create or seed anything");
});

test("the accessor resolves MEMBERSHIP_DB and nothing else", async () => {
  const liveRuntimeUrl = dataUrl(`export const getBindings = () => globalThis.__membershipTestBindings;`);
  const moduleUrl = await loadModule("membership-db.ts", { "./runtime": liveRuntimeUrl });
  const { getMembershipD1 } = await import(moduleUrl);

  globalThis.__membershipTestBindings = {};
  assert.equal(getMembershipD1(), null, "absent binding fails closed");

  // The trap this architecture exists to prevent: a market DB binding must not
  // satisfy a membership lookup.
  globalThis.__membershipTestBindings = { DB: { name: "market-signal-monitor" } };
  assert.equal(getMembershipD1(), null, "a DB binding is never used for membership");

  globalThis.__membershipTestBindings = { PORTFOLIO_DB: { name: "portfolios" } };
  assert.equal(getMembershipD1(), null, "a PORTFOLIO_DB binding is never used for membership");

  const membership = { name: "membership" };
  globalThis.__membershipTestBindings = { DB: { name: "market" }, MEMBERSHIP_DB: membership };
  assert.equal(getMembershipD1(), membership, "the dedicated binding is used");

  delete globalThis.__membershipTestBindings;
});

/* ------------------------------------------------------- the routes */

test("every auth route reaches the database through MEMBERSHIP_DB only", async () => {
  for (const path of MEMBERSHIP_ROUTES) {
    const source = await readFile(path, "utf8");
    assert.match(source, /getMembershipD1/, `${path} must use the membership accessor`);
    assert.doesNotMatch(source, /from "@\/db"/, `${path} must not import the generic db module`);
    assert.doesNotMatch(source, /\bgetD1\s*\(/, `${path} must not call getD1()`);
    assert.doesNotMatch(source, /ensureDatabase/, `${path} must not initialize a schema`);
  }
});

test("membership tables are never referenced from the generic schema path", async () => {
  // The Pages initializer owns the market-facing schema. If a membership table
  // ever appears here, ensureDatabase() would start creating it against the
  // market database.
  const schema = await readFile("lib/db-schema.ts", "utf8");
  for (const table of ["users", "auth_magic_links", "auth_sessions", "subscriptions", "billing_customers", "billing_events", "email_preferences", "email_outbox"]) {
    assert.doesNotMatch(
      schema,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
      `lib/db-schema.ts must not create ${table}`,
    );
  }
});

test("0015 remains the sole owner of the membership schema", async () => {
  const migration = await readFile("monitor-worker/migrations/0015_membership.sql", "utf8");
  for (const table of ["users", "auth_magic_links", "auth_sessions", "billing_customers", "subscriptions", "billing_events", "email_preferences", "email_outbox"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `0015 declares ${table}`);
  }
  // And the market migration is untouched by this work.
  const prior = await readFile("monitor-worker/migrations/0014_valuation_snapshot_history.sql", "utf8");
  assert.match(prior, /valuation_snapshot_history/);
  assert.doesNotMatch(prior, /users|auth_|subscriptions/, "0014 remains purely a valuation-history migration");
});
