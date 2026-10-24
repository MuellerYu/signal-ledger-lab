import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyMigration, createD1, MIGRATION_PATH } from "./helpers/sqlite-d1.mjs";
import { loadModule } from "./helpers/transpile.mjs";

const entitlementUrl = await loadModule("entitlement.ts");
const tokensUrl = await loadModule("auth-tokens.ts");
const preferencesUrl = await loadModule("email-preferences.ts", { "./entitlement": entitlementUrl, "./auth-tokens": tokensUrl });

const { resolveEntitlement } = await import(entitlementUrl);
const { preferenceLink, signPreference, verifyPreference } = await import(tokensUrl);
const preferences = await import(preferencesUrl);

const NOW = Date.UTC(2026, 8, 21, 21, 15);
const future = (days) => new Date(NOW + days * 24 * 60 * 60 * 1_000).toISOString();
const past = (days) => new Date(NOW - days * 24 * 60 * 60 * 1_000).toISOString();

const verified = { id: "user_1", emailVerified: true };
const unverified = { id: "user_2", emailVerified: false };

const sub = (overrides = {}) => ({
  id: "sub_1",
  userId: "user_1",
  plan: "PRO",
  status: "active",
  accessUntil: future(10),
  cancelAtPeriodEnd: false,
  cancelAt: null,
  ...overrides,
});

const resolve = (user, subscriptions) => resolveEntitlement({ user, subscriptions, now: NOW });

/* ==================================================== entitlement */

test("14. a legacy-imported user is unverified and resolves FREE", async () => {
  const d1 = createD1();
  await applyMigration(d1, MIGRATION_PATH);

  // Run the real importer over a fixture, so this covers the import behaviour
  // and not just the resolver.
  const fixture = join(tmpdir(), `legacy-access-${process.pid}.json`);
  await writeFile(
    fixture,
    JSON.stringify([
      {
        results: [
          { email: "Legacy@Example.com ", user_id: "oai-1", full_name: "Legacy User", status: "approved" },
          { email: "pending@example.com", user_id: "oai-2", full_name: null, status: "approved" },
        ],
      },
    ]),
  );
  const sql = execFileSync(process.execPath, ["scripts/import-legacy-site-access.mjs", fixture], { encoding: "utf8" });
  for (const statement of sql.split(";\n").map((s) => s.trim()).filter(Boolean)) d1.exec(statement);

  const row = d1.raw.prepare("SELECT email, email_verified, legacy_site_access_status FROM users WHERE email = 'legacy@example.com'").get();
  assert.ok(row, "the approved legacy address was imported");
  assert.equal(row.email_verified, 0, "owner approval is not user verification");
  assert.equal(row.legacy_site_access_status, "approved", "provenance is preserved");

  const entitlement = resolve({ id: "legacy", emailVerified: row.email_verified === 1 }, [sub({ userId: "legacy" })]);
  assert.equal(entitlement.tier, "FREE", "even with a subscription, an unverified account is FREE");
  assert.equal(entitlement.reason, "email_unverified");
});

test("15. a verified user with no subscription resolves FREE", () => {
  const entitlement = resolve(verified, []);
  assert.equal(entitlement.tier, "FREE");
  assert.equal(entitlement.reason, "no_active_subscription");
});

test("an anonymous visitor resolves FREE", () => {
  assert.equal(resolve(null, [sub()]).reason, "anonymous");
});

test("16. an active PRO subscription resolves PRO", () => {
  const entitlement = resolve(verified, [sub()]);
  assert.equal(entitlement.tier, "PRO");
  assert.equal(entitlement.reason, "active");
  assert.equal(entitlement.accessUntil, future(10));
});

test("17. past_due with a future access_until stays PRO", () => {
  const entitlement = resolve(verified, [sub({ status: "past_due" })]);
  assert.equal(entitlement.tier, "PRO", "a failed payment must not shorten a paid period");
});

test("18. canceled with a future access_until stays PRO, and cancel_at_period_end decides nothing", () => {
  const canceling = resolve(verified, [sub({ status: "canceled", cancelAtPeriodEnd: true })]);
  assert.equal(canceling.tier, "PRO", "canceled-but-paid-through keeps access");
  assert.equal(canceling.cancelAtPeriodEnd, true, "reported for the account page");

  const stopped = resolve(verified, [sub({ status: "canceled", cancelAtPeriodEnd: false })]);
  assert.equal(stopped.tier, "PRO", "the flag does not decide present access either way");
});

test("18b. cancel_at is reported for the account page and never decides access", () => {
  const scheduled = resolve(verified, [sub({ status: "active", cancelAt: future(20) })]);
  assert.equal(scheduled.tier, "PRO", "cancel_at does not revoke access");
  assert.equal(scheduled.cancelAt, future(20), "the scheduled date is reported");
  assert.equal(scheduled.cancelAtPeriodEnd, false);
});

test("a trialing subscription resolves PRO", () => {
  assert.equal(resolve(verified, [sub({ status: "trialing" })]).tier, "PRO");
});

test("19. an expired subscription loses PRO", () => {
  const entitlement = resolve(verified, [sub({ status: "expired", accessUntil: future(30) })]);
  assert.equal(entitlement.tier, "FREE", "expired wins even if access_until looks generous");
});

test("20. a past access_until loses PRO", () => {
  const entitlement = resolve(verified, [sub({ accessUntil: past(1) })]);
  assert.equal(entitlement.tier, "FREE");
});

test("a subscription with no access_until grants nothing", () => {
  assert.equal(resolve(verified, [sub({ accessUntil: null })]).tier, "FREE");
});

test("21. the latest qualifying access_until wins", () => {
  const entitlement = resolve(verified, [
    sub({ id: "sub_short", status: "active", accessUntil: future(3) }),
    sub({ id: "sub_long", status: "canceled", cancelAtPeriodEnd: true, accessUntil: future(40) }),
    sub({ id: "sub_expired", status: "expired", accessUntil: future(400) }),
  ]);
  assert.equal(entitlement.tier, "PRO");
  assert.equal(entitlement.subscriptionId, "sub_long");
  assert.equal(entitlement.accessUntil, future(40));
});

test("a FREE plan row does not grant PRO", () => {
  assert.equal(resolve(verified, [sub({ plan: "FREE" })]).tier, "FREE");
});

test("a one-time 365-day grant is ordinary access, with no recurring branch", () => {
  const entitlement = resolve(verified, [sub({ status: "active", billingInterval: "one_time_365d", accessUntil: future(365) })]);
  assert.equal(entitlement.tier, "PRO");
  assert.equal(entitlement.accessUntil, future(365));
});

/* ==================================================== scanner safety */

const PREFERENCE_SECRET = "test-preference-secret";

async function userWithPreferences({ enabled }) {
  const d1 = createD1();
  await applyMigration(d1, MIGRATION_PATH);
  d1.exec(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ('user_1','a@b.co',1,'${future(0)}','${future(0)}')`);
  await preferences.getOrCreateEmailPreferences(d1, "user_1", future(0));
  await preferences.setDailyBriefEnabled(d1, "user_1", enabled, future(0));
  return d1;
}

const preferenceSnapshot = (d1) => d1.raw.prepare("SELECT * FROM email_preferences ORDER BY user_id").all();

test("a scanner-style GET does not unsubscribe", async () => {
  const d1 = await userWithPreferences({ enabled: true });
  const signature = await signPreference(PREFERENCE_SECRET, "user_1", 1);
  const before = preferenceSnapshot(d1);

  // Exactly what the GET route does, twice — as a link previewer would.
  const first = await preferences.verifyPreferenceRequest(d1, PREFERENCE_SECRET, "user_1", signature);
  await preferences.verifyPreferenceRequest(d1, PREFERENCE_SECRET, "user_1", signature);

  assert.equal(first.ok, true, "the link is valid");
  assert.equal(first.preferences.dailyBriefEnabled, true, "and still reports the current state");
  assert.deepEqual(preferenceSnapshot(d1), before, "a GET changed nothing at all");
});

test("a GET does not even create a preferences row", async () => {
  const d1 = createD1();
  await applyMigration(d1, MIGRATION_PATH);
  d1.exec(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ('user_1','a@b.co',1,'${future(0)}','${future(0)}')`);

  const before = d1.raw.prepare("SELECT COUNT(*) AS n FROM email_preferences").get().n;
  const authorized = await preferences.verifyPreferenceRequest(d1, PREFERENCE_SECRET, "user_1", await signPreference(PREFERENCE_SECRET, "user_1", 1));

  assert.equal(authorized.ok, true);
  assert.equal(authorized.preferences.dailyBriefEnabled, false, "an absent row reads as the defaults");
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM email_preferences").get().n, before, "the read path is side-effect free");
});

test("a valid POST unsubscribes", async () => {
  const d1 = await userWithPreferences({ enabled: true });
  const signature = await signPreference(PREFERENCE_SECRET, "user_1", 1);
  assert.equal((await preferences.verifyPreferenceRequest(d1, PREFERENCE_SECRET, "user_1", signature)).ok, true);

  const updated = await preferences.applyPreferenceChange(d1, "user_1", { dailyBriefEnabled: false, marketingEnabled: false }, future(0));
  assert.equal(updated.dailyBriefEnabled, false, "the POST is what changes it");
  assert.equal(d1.raw.prepare("SELECT daily_brief_enabled FROM email_preferences WHERE user_id='user_1'").get().daily_brief_enabled, 0);
});

test("a tampered signature cannot change anything", async () => {
  const d1 = await userWithPreferences({ enabled: true });
  const before = preferenceSnapshot(d1);

  const forged = await signPreference("a-different-secret", "user_1", 1);
  const attempted = await preferences.verifyPreferenceRequest(d1, PREFERENCE_SECRET, "user_1", forged);
  assert.equal(attempted.ok, false, "the POST route refuses before it writes");
  assert.deepEqual(preferenceSnapshot(d1), before, "nothing changed");

  const wrongUser = await preferences.verifyPreferenceRequest(d1, PREFERENCE_SECRET, "user_2", await signPreference(PREFERENCE_SECRET, "user_1", 1));
  assert.equal(wrongUser.ok, false, "a signature does not transfer to another user");
  assert.deepEqual(preferenceSnapshot(d1), before);
});

test("unsubscribing does not remove PRO", async () => {
  const d1 = await userWithPreferences({ enabled: true });
  const user = { id: "user_1", emailVerified: true };
  const rows = [sub({ userId: "user_1" })];
  assert.equal(resolve(user, rows).tier, "PRO", "PRO before unsubscribing");

  await preferences.applyPreferenceChange(d1, "user_1", { dailyBriefEnabled: false, marketingEnabled: false }, future(0));

  assert.equal(resolve(user, rows).tier, "PRO", "still PRO after unsubscribing");
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1, "the account still exists");
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM subscriptions").get().n, 0, "no subscription was touched");
});



test("22. Daily Brief defaults to OFF", async () => {
  const d1 = createD1();
  await applyMigration(d1, MIGRATION_PATH);
  d1.exec(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ('user_1','a@b.co',1,'${future(0)}','${future(0)}')`);

  const created = await preferences.getOrCreateEmailPreferences(d1, "user_1", future(0));
  assert.equal(created.dailyBriefEnabled, false, "creating an account subscribes nobody");
  assert.equal(created.marketingEnabled, false);
  assert.equal(created.tokenVersion, 1);

  const delivery = preferences.dailyBriefDelivery(created, resolve(verified, [sub()]));
  assert.equal(delivery.deliver, false, "a PRO member with the flag off gets no brief email");
});

test("23. disabling the Daily Brief does not remove PRO", async () => {
  const d1 = createD1();
  await applyMigration(d1, MIGRATION_PATH);
  d1.exec(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ('user_1','a@b.co',1,'${future(0)}','${future(0)}')`);

  await preferences.getOrCreateEmailPreferences(d1, "user_1", future(0));
  await preferences.setDailyBriefEnabled(d1, "user_1", true, future(0));
  const on = await preferences.getOrCreateEmailPreferences(d1, "user_1", future(0));
  assert.deepEqual(preferences.dailyBriefDelivery(on, resolve(verified, [sub()])), { deliver: true, edition: "full" });

  await preferences.setDailyBriefEnabled(d1, "user_1", false, future(0));
  const off = await preferences.getOrCreateEmailPreferences(d1, "user_1", future(0));
  assert.equal(preferences.dailyBriefDelivery(off, resolve(verified, [sub()])).deliver, false);
  assert.equal(resolve(verified, [sub()]).tier, "PRO", "entitlement is untouched by the email preference");
});

test("a FREE member who opts in gets the teaser, not the full brief", () => {
  const optedIn = { dailyBriefEnabled: true };
  assert.deepEqual(preferences.dailyBriefDelivery(optedIn, resolve(verified, [])), { deliver: true, edition: "teaser" });
});

test("24. a signed preference link validates, and a tampered one does not", async () => {
  const secret = "test-preference-secret";
  const signature = await signPreference(secret, "user_1", 1);
  assert.equal(await verifyPreference(secret, "user_1", 1, signature), true);
  assert.equal(await verifyPreference(secret, "user_1", 1, "0".repeat(32)), false, "a forged signature is rejected");
  assert.equal(await verifyPreference(secret, "user_2", 1, signature), false, "a signature does not transfer between users");
  assert.equal(await verifyPreference("other-secret", "user_1", 1, signature), false);
});

test("25. bumping token_version invalidates every previously issued link", async () => {
  const d1 = createD1();
  await applyMigration(d1, MIGRATION_PATH);
  d1.exec(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES ('user_1','a@b.co',1,'${future(0)}','${future(0)}')`);

  const secret = "test-preference-secret";
  await preferences.getOrCreateEmailPreferences(d1, "user_1", future(0));
  const oldSignature = await signPreference(secret, "user_1", 1);

  await preferences.bumpPreferenceTokenVersion(d1, "user_1", future(0));
  const after = await preferences.getOrCreateEmailPreferences(d1, "user_1", future(0));
  assert.equal(after.tokenVersion, 2);
  assert.equal(await verifyPreference(secret, "user_1", after.tokenVersion, oldSignature), false, "the old link is dead");

  const fresh = await signPreference(secret, "user_1", after.tokenVersion);
  assert.equal(await verifyPreference(secret, "user_1", after.tokenVersion, fresh), true);
  assert.match(await preferenceLink("https://signalledgerlab.com", secret, "user_1", 2), /uid=user_1&sig=/);
});

test("the preference URL carries no secret material", async () => {
  const secret = "test-preference-secret";
  const link = await preferenceLink("https://signalledgerlab.com/", secret, "user_1", 3);
  assert.ok(!link.includes(secret), "the signing key is never in the URL");
  assert.ok(link.startsWith("https://signalledgerlab.com/email/preferences?"), "no double slash from the origin");
});
