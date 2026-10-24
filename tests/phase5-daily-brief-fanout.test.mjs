import assert from "node:assert/strict";
import test from "node:test";

import { applyMigration, createD1 } from "./helpers/sqlite-d1.mjs";
import { loadModule } from "./helpers/transpile.mjs";

/**
 * PRO Daily Brief subscriber fan-out.
 *
 * After a canonical post-close brief is complete, every eligible PRO subscriber
 * gets the SAME full brief — never a per-subscriber rendering. Eligibility is:
 * verified user + Daily Brief ON + PRO entitlement + access_until in the future.
 * A subscription scheduled to cancel but still inside access_until stays
 * eligible; an expired one does not; a FREE user gets nothing from the fan-out.
 * Retries dedupe on sha256("daily-brief|<date>|<recipient>"), so a subscriber is
 * never emailed twice for one session.
 */

const SANDBOX_DIR = "../../monitor-worker/migrations-sandbox";
const SANDBOX_MIGRATIONS = [
  "0015_membership.sql",
  "0016_billing_schema_fixes.sql",
  "0017_stripe_status.sql",
  "0018_cancel_at.sql",
  "0019_daily_brief_fanout.sql",
];

async function freshDb() {
  const d1 = createD1();
  for (const file of SANDBOX_MIGRATIONS) {
    await applyMigration(d1, `${SANDBOX_DIR}/${file}`);
  }
  return d1;
}

/* ------------------------------------------------------------ module loading */

const cryptoUrl = await loadModule("crypto.ts");
const entitlementUrl = await loadModule("entitlement.ts");
const tokensUrl = await loadModule("auth-tokens.ts");
const subscriptionsUrl = await loadModule("subscriptions.ts", { "./entitlement": entitlementUrl });
const jobsUrl = await loadModule("email-jobs.ts", { "./auth-tokens": tokensUrl });
const fanoutUrl = await loadModule("daily-brief-fanout.ts", {
  "./entitlement": entitlementUrl,
  "./subscriptions": subscriptionsUrl,
  "./email-jobs": jobsUrl,
  "./crypto": cryptoUrl,
});
const fanout = await import(fanoutUrl);

/* ------------------------------------------------------------- seeding data */

// Fixed instants so eligibility is deterministic and the future/past cases map
// to the real sandbox test user (access_until 2027-09-20).
const NOW_ISO = "2026-09-20T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const FUTURE = "2027-09-20T00:00:00.000Z";
const PAST = "2026-08-20T00:00:00.000Z";

function seedUser(d1, id, email, verified) {
  d1.raw
    .prepare(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, email, verified ? 1 : 0, NOW_ISO, NOW_ISO);
}

function seedPref(d1, userId, enabled) {
  d1.raw
    .prepare(`INSERT INTO email_preferences (user_id, daily_brief_enabled, marketing_enabled, token_version, updated_at) VALUES (?, ?, 0, 1, ?)`)
    .run(userId, enabled ? 1 : 0, NOW_ISO);
}

function seedSub(d1, { id, userId, email, plan = "PRO", status = "active", accessUntil = null, cancelAt = null, cancelAtPeriodEnd = 0 }) {
  d1.raw
    .prepare(`INSERT INTO subscriptions (id, user_id, email, plan, status, provider, currency, access_until, cancel_at, cancel_at_period_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'stripe', 'usd', ?, ?, ?, ?, ?)`)
    .run(id, userId, email, plan, status, accessUntil, cancelAt, cancelAtPeriodEnd, NOW_ISO, NOW_ISO);
}

const emails = (recipients) => recipients.map((r) => r.email);
const queuedCount = (d1) => d1.raw.prepare(`SELECT COUNT(*) AS n FROM email_outbox WHERE kind = 'daily_brief'`).get().n;

async function fanoutOnce(d1, sessionDate = "2026-09-20") {
  const recipients = await fanout.resolveDailyBriefRecipients(d1, NOW_MS);
  return fanout.enqueueDailyBriefFanout(d1, {
    sessionDate,
    subject: "SUBJ",
    text: "TEXT-BODY",
    html: "<p>HTML-BODY</p>",
    recipients,
    nowIso: NOW_ISO,
  });
}

/* ------------------------------------------------------------------- tests */

test("1. PRO + opt-in is queued, as a stored full brief", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "pro@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "pro@example.com", status: "active", accessUntil: FUTURE });

  assert.deepEqual(emails(await fanout.resolveDailyBriefRecipients(d1, NOW_MS)), ["pro@example.com"]);

  const { queued, skipped } = await fanoutOnce(d1);
  assert.deepEqual(queued, ["pro@example.com"]);
  assert.deepEqual(skipped, []);
  assert.equal(queuedCount(d1), 1);

  const row = d1.raw.prepare(`SELECT kind, recipient, body_mode, subject, text_body, html_body FROM email_outbox WHERE kind = 'daily_brief'`).get();
  assert.equal(row.kind, "daily_brief");
  assert.equal(row.recipient, "pro@example.com");
  assert.equal(row.body_mode, "stored");
  assert.equal(row.subject, "SUBJ");
  assert.equal(row.text_body, "TEXT-BODY");
  assert.equal(row.html_body, "<p>HTML-BODY</p>");
});

test("2. PRO + opt-out is not queued", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "pro@example.com", true);
  seedPref(d1, "u1", false);
  seedSub(d1, { id: "s1", userId: "u1", email: "pro@example.com", status: "active", accessUntil: FUTURE });

  assert.deepEqual(await fanout.resolveDailyBriefRecipients(d1, NOW_MS), []);
  await fanoutOnce(d1);
  assert.equal(queuedCount(d1), 0);
});

test("3. a FREE user receives no full brief from the fan-out", async () => {
  const d1 = await freshDb();
  // Verified and opted in, but no PRO subscription at all.
  seedUser(d1, "u1", "free@example.com", true);
  seedPref(d1, "u1", true);

  assert.deepEqual(await fanout.resolveDailyBriefRecipients(d1, NOW_MS), []);
  await fanoutOnce(d1);
  assert.equal(queuedCount(d1), 0);
});

test("4. an expired PRO subscription is not queued", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "expired@example.com", true);
  seedPref(d1, "u1", true);
  // Expired wins over a (bogus) future access_until: status is decisive.
  seedSub(d1, { id: "s1", userId: "u1", email: "expired@example.com", status: "expired", accessUntil: FUTURE });

  assert.deepEqual(await fanout.resolveDailyBriefRecipients(d1, NOW_MS), []);
  await fanoutOnce(d1);
  assert.equal(queuedCount(d1), 0);
});

test("5. a scheduled cancellation still inside access_until is queued", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "canceling@example.com", true);
  seedPref(d1, "u1", true);
  // Stripe representation 2: canceled with a future cancel_at, but access_until
  // is still future — the member has already paid for this period.
  seedSub(d1, { id: "s1", userId: "u1", email: "canceling@example.com", status: "canceled", accessUntil: FUTURE, cancelAt: FUTURE, cancelAtPeriodEnd: 0 });

  assert.deepEqual(emails(await fanout.resolveDailyBriefRecipients(d1, NOW_MS)), ["canceling@example.com"]);
  await fanoutOnce(d1);
  assert.equal(queuedCount(d1), 1);
});

test("6. an active subscription whose access_until has passed is not queued", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "lapsed@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "lapsed@example.com", status: "active", accessUntil: PAST });

  assert.deepEqual(await fanout.resolveDailyBriefRecipients(d1, NOW_MS), []);
  await fanoutOnce(d1);
  assert.equal(queuedCount(d1), 0);
});

test("7. a retry of the same session enqueues nothing twice", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "pro@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "pro@example.com", status: "active", accessUntil: FUTURE });

  const first = await fanoutOnce(d1, "2026-09-20");
  const second = await fanoutOnce(d1, "2026-09-20");

  assert.deepEqual(first.queued, ["pro@example.com"]);
  assert.deepEqual(second.queued, []);
  assert.deepEqual(second.skipped, ["pro@example.com"]);
  assert.equal(queuedCount(d1), 1, "the second pass inserted nothing");
});

test("8. the outbox id is deterministic and scoped to date + recipient", async () => {
  const a = await fanout.dailyBriefOutboxId("2026-09-20", "pro@example.com");
  const b = await fanout.dailyBriefOutboxId("2026-09-20", "pro@example.com");
  const c = await fanout.dailyBriefOutboxId("2026-09-20", "PRO@example.com"); // same after normalization
  const d = await fanout.dailyBriefOutboxId("2026-09-21", "pro@example.com");
  const e = await fanout.dailyBriefOutboxId("2026-09-20", "other@example.com");

  assert.equal(a, b, "same date + recipient yields the same id");
  assert.equal(a, c, "recipient normalization is part of the id");
  assert.notEqual(a, d, "a different session date is a different send");
  assert.notEqual(a, e, "a different recipient is a different send");
  assert.match(a, /^[0-9a-f]{64}$/, "the id is a sha256 hex digest");
});

test("9. the envelope adds branding, date and /daily-brief while carrying the brief verbatim", () => {
  const wrapped = fanout.renderDailyBriefFanout(
    { sessionDate: "2026-09-20", subject: "SUBJ", text: "TEXT-MARKER", html: "<p>HTML-MARKER</p>" },
    "https://preview.example/daily-brief",
  );

  assert.equal(wrapped.subject, "SUBJ", "the canonical subject is unchanged");
  assert.ok(wrapped.text.includes("Signal Ledger"), "text carries the brand");
  assert.ok(wrapped.text.includes("2026-09-20"), "text carries the briefing date");
  assert.ok(wrapped.text.includes("TEXT-MARKER"), "text carries the full brief verbatim");
  assert.ok(wrapped.text.includes("https://preview.example/daily-brief"), "text links back to /daily-brief");

  assert.ok(wrapped.html.includes("Signal Ledger"), "html carries the brand");
  assert.ok(wrapped.html.includes("2026-09-20"), "html carries the briefing date");
  assert.ok(wrapped.html.includes("HTML-MARKER"), "html carries the full brief verbatim");
  assert.ok(wrapped.html.includes('href="https://preview.example/daily-brief"'), "html links back to /daily-brief");
});
