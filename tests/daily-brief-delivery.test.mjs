import assert from "node:assert/strict";
import test from "node:test";

import { applyMigration, createD1 } from "./helpers/sqlite-d1.mjs";
import { loadModule } from "./helpers/transpile.mjs";

/**
 * Canonical post-close Daily Brief finalization and automatic PRO fan-out.
 *
 * The scheduled pipeline is two decoupled halves: finalize (validate + persist
 * the ONE canonical artifact) and deliver (copy that artifact to every eligible
 * PRO subscriber, never regenerating). These tests pin the contract:
 *   - a good brief is persisted once and fanned out verbatim to eligible members;
 *   - a failed or invalid generation fans out nothing;
 *   - eligibility is the single predicate (verified + opt-in + PRO + future
 *     access_until, with scheduled-cancel-but-still-valid included);
 *   - dedup is per (sessionDate, recipient), so a retry enqueues nothing twice;
 *   - one subscriber's failure never blocks the rest; and
 *   - a retry reconstructs from the persisted artifact, not from re-run research.
 */

const SANDBOX_DIR = "../../monitor-worker/migrations-sandbox";
const SANDBOX_MIGRATIONS = [
  "0015_membership.sql",
  "0016_billing_schema_fixes.sql",
  "0017_stripe_status.sql",
  "0018_cancel_at.sql",
  "0019_daily_brief_fanout.sql",
  "0020_daily_brief_artifact.sql",
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
const artifactUrl = await loadModule("daily-brief-artifact.ts", { "./crypto": cryptoUrl });
const deliveryUrl = await loadModule("daily-brief-delivery.ts", {
  "./daily-brief-fanout": fanoutUrl,
  "./daily-brief-artifact": artifactUrl,
});
const delivery = await import(deliveryUrl);
const artifact = await import(artifactUrl);

/* ------------------------------------------------------------- seeding data */

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

/** A canonical brief body long enough to clear the 200-char gate, with no markers. */
const longText = () =>
  "收盘后简报正文：市场数据、新闻归因与估值快照完整呈现，供 PRO 订阅者查阅当日研究结论。".repeat(10);

function validBrief(sessionDate = "2026-09-20") {
  return {
    sessionDate,
    subject: `【Signal Ledger 收盘简报】${sessionDate}`,
    text: longText(),
    html: `<p>${longText()}</p>`,
  };
}

const outboxCount = (d1) => d1.raw.prepare(`SELECT COUNT(*) AS n FROM email_outbox WHERE kind = 'daily_brief'`).get().n;
const artifactCount = (d1) => d1.raw.prepare(`SELECT COUNT(*) AS n FROM daily_brief_artifacts`).get().n;

/** A D1 that throws when the failing recipient's enqueue is attempted. */
function failingForRecipient(d1, failEmail) {
  return {
    prepare(sql) {
      const stmt = d1.prepare(sql);
      return {
        bind(...values) {
          const bound = stmt.bind(...values);
          return {
            async run() {
              if (values.includes(failEmail)) throw new Error("injected enqueue failure");
              return bound.run();
            },
            async first(...args) { return bound.first(...args); },
            async all(...args) { return bound.all(...args); },
          };
        },
      };
    },
  };
}

/* ------------------------------------------------------------------- tests */

test("1. a finalized canonical brief is fanned out to an opted-in PRO subscriber", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "pro@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "pro@example.com", status: "active", accessUntil: FUTURE });

  const canonical = validBrief();
  const finalized = await delivery.finalizeCanonicalDailyBrief(d1, { ...canonical, nowIso: NOW_ISO });
  assert.equal(finalized.ok, true);
  assert.equal(finalized.canonicalBriefReady, true);

  const outcome = await delivery.deliverCanonicalDailyBrief(d1, {
    canonical, nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: "https://preview.example/daily-brief",
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.eligibleRecipients, 1);
  assert.deepEqual(outcome.queued, ["pro@example.com"]);
  assert.equal(outboxCount(d1), 1);
});

test("2. a failed generation leaves no artifact, so the fan-out has nothing to send", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "pro@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "pro@example.com", status: "active", accessUntil: FUTURE });

  // A brief that never got past generation (empty subject, short body) is refused
  // and — crucially — not persisted, so the delivery source reads nothing.
  const finalized = await delivery.finalizeCanonicalDailyBrief(d1, {
    sessionDate: "2026-09-20", subject: "", text: "x", html: "<p>x</p>", nowIso: NOW_ISO,
  });
  assert.equal(finalized.ok, false);
  assert.equal(await artifact.readDailyBriefArtifact(d1, "2026-09-20"), null);
  assert.equal(artifactCount(d1), 0);
});

test("3. a brief carrying a placeholder marker is rejected and not fanned out", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "pro@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "pro@example.com", status: "active", accessUntil: FUTURE });

  const placeholder = {
    sessionDate: "2026-09-20",
    subject: "收盘简报",
    text: ("收盘后简报正文。Pick-NY vs SPY — 这是一条低数据占位符。").padEnd(300, "。"),
    html: "<p>x</p>",
  };
  const outcome = await delivery.deliverCanonicalDailyBrief(d1, {
    canonical: placeholder, nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.problems.some((p) => p.includes("placeholder")));
  assert.equal(outboxCount(d1), 0);
});

test("4. a PRO subscriber who opted out is excluded", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "pro@example.com", true);
  seedPref(d1, "u1", false);
  seedSub(d1, { id: "s1", userId: "u1", email: "pro@example.com", status: "active", accessUntil: FUTURE });

  const outcome = await delivery.deliverCanonicalDailyBrief(d1, {
    canonical: validBrief(), nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null,
  });
  assert.deepEqual(outcome.queued, []);
  assert.equal(outcome.eligibleRecipients, 0);
  assert.equal(outboxCount(d1), 0);
});

test("5. a FREE user receives no full brief", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "free@example.com", true);
  seedPref(d1, "u1", true); // opted in, but no PRO subscription

  const outcome = await delivery.deliverCanonicalDailyBrief(d1, {
    canonical: validBrief(), nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null,
  });
  assert.deepEqual(outcome.queued, []);
  assert.equal(outboxCount(d1), 0);
});

test("6. an expired PRO subscription is excluded", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "expired@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "expired@example.com", status: "expired", accessUntil: FUTURE });

  const outcome = await delivery.deliverCanonicalDailyBrief(d1, {
    canonical: validBrief(), nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null,
  });
  assert.deepEqual(outcome.queued, []);
  assert.equal(outboxCount(d1), 0);
});

test("7. a scheduled cancellation still inside access_until is included", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "canceling@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "canceling@example.com", status: "canceled", accessUntil: FUTURE, cancelAt: FUTURE, cancelAtPeriodEnd: 0 });

  const outcome = await delivery.deliverCanonicalDailyBrief(d1, {
    canonical: validBrief(), nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null,
  });
  assert.deepEqual(outcome.queued, ["canceling@example.com"]);
  assert.equal(outboxCount(d1), 1);
});

test("8. a duplicate post-close retry enqueues nothing twice", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "pro@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "pro@example.com", status: "active", accessUntil: FUTURE });

  const canonical = validBrief();
  const first = await delivery.deliverCanonicalDailyBrief(d1, {
    canonical, nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null,
  });
  const second = await delivery.deliverCanonicalDailyBrief(d1, {
    canonical, nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null,
  });
  assert.deepEqual(first.queued, ["pro@example.com"]);
  assert.deepEqual(second.queued, []);
  assert.deepEqual(second.alreadyQueued, ["pro@example.com"]);
  assert.equal(outboxCount(d1), 1);
});

test("9. one subscriber's enqueue failure does not block the others", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "good@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "good@example.com", status: "active", accessUntil: FUTURE });
  seedUser(d1, "u2", "fail@example.com", true);
  seedPref(d1, "u2", true);
  seedSub(d1, { id: "s2", userId: "u2", email: "fail@example.com", status: "active", accessUntil: FUTURE });

  const outcome = await delivery.deliverCanonicalDailyBrief(failingForRecipient(d1, "fail@example.com"), {
    canonical: validBrief(), nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null,
  });
  assert.deepEqual(outcome.queued, ["good@example.com"], "the healthy subscriber is still queued");
  assert.deepEqual(outcome.failed, ["fail@example.com"], "the failing subscriber is isolated");
  assert.equal(outboxCount(d1), 1);
});

test("10. the canonical content is copied verbatim, never re-rendered per subscriber", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "pro@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "pro@example.com", status: "active", accessUntil: FUTURE });

  const canonical = validBrief();
  await delivery.finalizeCanonicalDailyBrief(d1, { ...canonical, nowIso: NOW_ISO });
  await delivery.deliverCanonicalDailyBrief(d1, {
    canonical, nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null,
  });

  const row = d1.raw.prepare(`SELECT subject, text_body, html_body FROM email_outbox WHERE kind = 'daily_brief'`).get();
  assert.equal(row.subject, canonical.subject);
  assert.equal(row.text_body, canonical.text);
  assert.equal(row.html_body, canonical.html);
});

test("11. research is authored exactly once, however many times the fan-out runs", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "pro@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "pro@example.com", status: "active", accessUntil: FUTURE });

  const canonical = validBrief();
  await delivery.finalizeCanonicalDailyBrief(d1, { ...canonical, nowIso: NOW_ISO });

  // The fan-out runs several times; it copies, it never authors.
  await delivery.deliverCanonicalDailyBrief(d1, { canonical, nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null });
  await delivery.deliverCanonicalDailyBrief(d1, { canonical, nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null });
  await delivery.deliverCanonicalDailyBrief(d1, { canonical, nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null });

  assert.equal(artifactCount(d1), 1, "one canonical artifact, not one per fan-out");
  assert.equal(outboxCount(d1), 1, "dedup holds across every fan-out");
});

test("12. a retry reconstructs delivery from the persisted artifact, not from re-run research", async () => {
  const d1 = await freshDb();
  seedUser(d1, "u1", "pro@example.com", true);
  seedPref(d1, "u1", true);
  seedSub(d1, { id: "s1", userId: "u1", email: "pro@example.com", status: "active", accessUntil: FUTURE });

  // First the brief is generated and persisted, as generateScheduledBriefing does.
  const canonical = validBrief("2026-09-20");
  await delivery.finalizeCanonicalDailyBrief(d1, { ...canonical, nowIso: NOW_ISO });

  // A later tick's delivery source reads the artifact back (the recovery source)
  // and fans it out — it never re-invokes research.
  const stored = await artifact.readDailyBriefArtifact(d1, "2026-09-20");
  assert.ok(stored, "the artifact persisted by finalize is the recovery source");
  const outcome = await delivery.deliverCanonicalDailyBrief(d1, {
    canonical: { sessionDate: "2026-09-20", subject: stored.subject, text: stored.text, html: stored.html },
    nowIso: NOW_ISO, nowMs: NOW_MS, viewUrl: null,
  });
  assert.deepEqual(outcome.queued, ["pro@example.com"]);

  const row = d1.raw.prepare(`SELECT text_body FROM email_outbox WHERE kind = 'daily_brief'`).get();
  assert.equal(row.text_body, stored.text, "the enqueued content is the stored artifact, byte for byte");
});
