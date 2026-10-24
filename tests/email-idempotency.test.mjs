import assert from "node:assert/strict";
import test from "node:test";

import { applyMigration, createD1 } from "./helpers/sqlite-d1.mjs";
import { loadModule } from "./helpers/transpile.mjs";

/**
 * Provider-side email idempotency.
 *
 * Two idempotency questions have to stay separate.
 *
 * The business one — "has this logical job already been handled?" — is keyed on
 * sessionDate + recipient and is deliberately untouched here: a retry must
 * still be incapable of double-sending.
 *
 * The provider one — "is this the same HTTP request I already accepted?" — is
 * keyed on the job id *plus* a fingerprint of the exact payload. Resend
 * compares the body of a reused key against the original and answers a
 * mismatch with 409 invalid_idempotent_request, so the bare, deliberately
 * stable job id cannot be the provider key: the moment the job is legitimately
 * regenerated with new content, the second send is refused. These tests pin
 * both halves: same job + same bytes dedupes, same job + new bytes goes out.
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
const idempotencyUrl = await loadModule("email-idempotency.ts", { "./crypto": cryptoUrl });
const idem = await import(idempotencyUrl);

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

/* ------------------------------------------------------------------- helpers */

const NOW_ISO = "2026-09-20T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const FUTURE = "2027-09-20T00:00:00.000Z";

/** A queued Daily Brief job, as the flush hands it to the sender. */
function briefJob(overrides = {}) {
  return {
    id: "a".repeat(64),
    recipient: "pro@example.com",
    subject: "【Signal Ledger 收盘简报】2026-09-18",
    textBody: "TEXT v1",
    htmlBody: "<p>HTML v1</p>",
    fromAddress: "Signal Ledger <brief@signalledgerlab.com>",
    bodyMode: "stored",
    ...overrides,
  };
}

const key = (job) => idem.emailJobIdempotencyKey(job);

/* ------------------------------------------------------- provider key: retries */

test("1. the same job retried with the same payload yields the SAME provider key", async () => {
  const job = briefJob();
  assert.equal(await key(job), await key({ ...job }));
  // Not merely equal by luck of a fresh computation in one process: the value
  // is a pure function of the inputs, so it is stable across a restart too.
  assert.equal(await key(job), await idem.emailJobIdempotencyKey(briefJob()));
});

test("2. a changed subject yields a DIFFERENT provider key", async () => {
  const before = await key(briefJob());
  const after = await key(briefJob({ subject: "【Signal Ledger 收盘简报】2026-09-18 | v2" }));
  assert.notEqual(before, after);
});

test("3. changed text or html yields a DIFFERENT provider key", async () => {
  const base = await key(briefJob());
  assert.notEqual(base, await key(briefJob({ textBody: "TEXT v2" })), "text changed");
  assert.notEqual(base, await key(briefJob({ htmlBody: "<p>HTML v2</p>" })), "html changed");
});

test("4. changed recipient or sender yields a DIFFERENT provider key", async () => {
  const base = await key(briefJob());
  assert.notEqual(base, await key(briefJob({ recipient: "other@example.com" })));
  assert.notEqual(base, await key(briefJob({ fromAddress: "Signal Ledger <other@signalledgerlab.com>" })));
});

test("5. the reported regression: same outbox id, regenerated content, new key", async () => {
  // The exact sandbox shape — one deterministic job id, a deleted and
  // recreated job, a new canonical artifact behind it.
  const jobId = await fanout.dailyBriefOutboxId("2026-09-18", "pro@example.com");
  const first = await key(briefJob({ id: jobId, subject: "S1", textBody: "OLD", htmlBody: "<p>OLD</p>" }));
  const second = await key(briefJob({ id: jobId, subject: "S2", textBody: "NEW", htmlBody: "<p>NEW</p>" }));
  assert.notEqual(first, second, "the regenerated payload gets its own provider key");
  // ...while a retry of either one still collapses onto itself.
  assert.equal(second, await key(briefJob({ id: jobId, subject: "S2", textBody: "NEW", htmlBody: "<p>NEW</p>" })));
});

/* -------------------------------------------------------- provider key: shape */

test("6. the provider key is deterministic, bounded, and carries no randomness", async () => {
  const job = briefJob();
  const a = await key(job);
  const b = await key(job);

  assert.equal(a, b, "no clock and no randomness");
  assert.ok(a.length <= 256, "Resend rejects an Idempotency-Key longer than 256 characters");
  assert.match(a, /^[0-9a-f]{64}\.[0-9a-f]{64}$/, "job id plus a sha256 payload fingerprint");
  // Two independent runs of a longer-than-limit job id must not collide by
  // truncation.
  const long = await key(briefJob({ id: "x".repeat(400) }));
  assert.ok(long.length <= 256, "an over-long job id is hashed, not truncated");
  assert.notEqual(long, await key(briefJob({ id: "y".repeat(400) })));
});

test("7. a secret-derived body never enters the key, and still does not change it", async () => {
  // The auth-link flush rebuilds the body from the derivation secret, so the
  // two attempts below carry *different* bearer tokens for the same job.
  const attemptOne = {
    id: "mlinkjob1",
    recipient: "user@example.com",
    subject: "登录 Signal Ledger",
    textBody: "https://preview.example/auth/verify?token=TOKEN-AAAA",
    htmlBody: '<a href="https://preview.example/auth/verify?token=TOKEN-AAAA">登录</a>',
    fromAddress: null,
    bodyMode: "derived_auth_link",
  };
  const attemptTwo = {
    ...attemptOne,
    textBody: "https://preview.example/auth/verify?token=TOKEN-BBBB",
    htmlBody: '<a href="https://preview.example/auth/verify?token=TOKEN-BBBB">登录</a>',
  };

  const first = await key(attemptOne);
  assert.equal(first, await key(attemptTwo), "a derived body is represented by its mode, not its bytes");
  assert.ok(!first.includes("TOKEN"), "no token material leaks into the provider key");

  // The fingerprint itself must be free of the secret too, since it is derived
  // from a credential and travels to the provider as a header.
  const fingerprint = idem.emailJobFingerprint(attemptOne);
  assert.equal(fingerprint.text, "");
  assert.equal(fingerprint.html, "");
  assert.equal(fingerprint.bodyMode, "derived_auth_link");
});

test("8. a switch between stored and derived bodies is a different payload", async () => {
  const stored = await key(briefJob({ id: "job1" }));
  const derived = await key(briefJob({ id: "job1", bodyMode: "derived_auth_link" }));
  assert.notEqual(stored, derived);
});

/* ------------------------------------------------- business dedup is unchanged */

test("9. business dedup stays keyed on sessionDate + recipient", async () => {
  const a = await fanout.dailyBriefOutboxId("2026-09-18", "pro@example.com");
  const b = await fanout.dailyBriefOutboxId("2026-09-18", "pro@example.com");
  const otherDay = await fanout.dailyBriefOutboxId("2026-09-19", "pro@example.com");
  const otherPerson = await fanout.dailyBriefOutboxId("2026-09-18", "other@example.com");

  assert.equal(a, b);
  assert.notEqual(a, otherDay);
  assert.notEqual(a, otherPerson);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("10. re-queuing the same session with regenerated content still cannot double-send", async () => {
  const d1 = await freshDb();
  d1.raw
    .prepare(`INSERT INTO users (id, email, email_verified, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run("u1", "pro@example.com", NOW_ISO, NOW_ISO);
  d1.raw
    .prepare(`INSERT INTO email_preferences (user_id, daily_brief_enabled, marketing_enabled, token_version, updated_at) VALUES (?, 1, 0, 1, ?)`)
    .run("u1", NOW_ISO);
  d1.raw
    .prepare(`INSERT INTO subscriptions (id, user_id, email, plan, status, provider, currency, access_until, created_at, updated_at) VALUES ('s1', 'u1', 'pro@example.com', 'PRO', 'active', 'stripe', 'usd', ?, ?, ?)`)
    .run(FUTURE, NOW_ISO, NOW_ISO);

  const recipients = await fanout.resolveDailyBriefRecipients(d1, NOW_MS);
  const send = (subject, text, html) =>
    fanout.enqueueDailyBriefFanout(d1, { sessionDate: "2026-09-18", subject, text, html, recipients, nowIso: NOW_ISO });

  const first = await send("S1", "OLD", "<p>OLD</p>");
  // The regeneration: same logical job, new canonical artifact behind it.
  const second = await send("S2", "NEW", "<p>NEW</p>");

  assert.deepEqual(first.queued, ["pro@example.com"]);
  assert.deepEqual(second.queued, [], "the deterministic job id still absorbs the retry");
  assert.deepEqual(second.skipped, ["pro@example.com"]);

  const rows = d1.raw.prepare(`SELECT id, subject FROM email_outbox WHERE kind = 'daily_brief'`).all();
  assert.equal(rows.length, 1, "exactly one queued send for the session — dedup is untouched");

  // The two sends above are the same provider-distinguishable case: one job id,
  // two payloads. The provider key separates them even though the queue did
  // not, which is what lets a deliberately regenerated job be delivered.
  const jobId = rows[0].id;
  assert.notEqual(
    await key(briefJob({ id: jobId, subject: "S1", textBody: "OLD", htmlBody: "<p>OLD</p>" })),
    await key(briefJob({ id: jobId, subject: "S2", textBody: "NEW", htmlBody: "<p>NEW</p>" })),
  );
});
