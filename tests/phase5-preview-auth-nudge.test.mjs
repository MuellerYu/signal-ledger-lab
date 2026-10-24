import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";

import { applyMigration, createD1 } from "./helpers/sqlite-d1.mjs";
import { dataUrl, loadModule } from "./helpers/transpile.mjs";

/* ==================================================== load modules */

const cryptoUrl = await loadModule("crypto.ts");
const tokensUrl = await loadModule("auth-tokens.ts");
const entitlementUrl = await loadModule("entitlement.ts");
const preferencesUrl = await loadModule("email-preferences.ts", { "./entitlement": entitlementUrl, "./auth-tokens": tokensUrl });
const storeUrl = await loadModule("auth-store.ts", { "./crypto": cryptoUrl, "./auth-tokens": tokensUrl });
const jobsUrl = await loadModule("email-jobs.ts", { "./auth-tokens": tokensUrl });
const flowUrl = await loadModule("auth-flow.ts", {
  "./crypto": cryptoUrl,
  "./auth-tokens": tokensUrl,
  "./auth-store": storeUrl,
  "./email-jobs": jobsUrl,
  "./email-preferences": preferencesUrl,
});

// The nudge reads bindings through lib/runtime (cloudflare:workers in the app),
// so swap in a settable stub to exercise both the config getter and the nudge
// without a Worker or a live network.
const runtimeStub = dataUrl(`
  let current = {};
  export function setBindings(b) { current = b; }
  export function getBindings() { return current; }
  export function cleanBaseUrl(v) { const t = (v ?? "").trim(); return t ? t.replace(/\\/+$/, "") : null; }
  export const DEFAULT_ALERT_RECIPIENT = "x";
`);
const serviceEmailUrl = await loadModule("service-email.ts", { "./runtime": runtimeStub });

const tokens = await import(tokensUrl);
const flow = await import(flowUrl);
const serviceEmail = await import(serviceEmailUrl);
const runtime = await import(runtimeStub);

/* ==================================================== fixtures */

const SECRETS = {
  linkDerivation: "preview-shared-link-derivation-secret",
  sessionSigning: "preview-session-signing-secret",
  rateLimit: "preview-rate-limit-secret",
};
const EMAIL = "owner@example.com";
const WORKER_URL = "https://market-signal-monitor-sandbox.your-account.workers.dev";
const FLUSH_TOKEN = "preview-flush-token";

// The schema the sandbox D1 runs, taken from the sandbox migrations dir (a
// copy of 0015); this is what Preview auth actually executes against.
const SANDBOX_MIGRATION_PATH = "../../monitor-worker/migrations-sandbox/0015_membership.sql";

async function freshDb() {
  const d1 = createD1();
  await applyMigration(d1, SANDBOX_MIGRATION_PATH);
  return d1;
}

/* ==================================================== the nudge */

test("1. the nudge POSTs the flush endpoint with the shared bearer token", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response("{}", { status: 200 });
  };
  await serviceEmail.nudgeServiceEmailFlush({
    config: { workerUrl: WORKER_URL, flushToken: FLUSH_TOKEN },
    fetchImpl,
    timeoutMs: 50,
  });
  assert.equal(captured.url, `${WORKER_URL}/internal/service-email/flush`);
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.authorization, `Bearer ${FLUSH_TOKEN}`);
  assert.ok(captured.init.signal instanceof AbortSignal, "a timeout signal is attached");
});

test("2. a missing flush token sends nothing (no unauthenticated flush)", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  await serviceEmail.nudgeServiceEmailFlush({
    config: { workerUrl: WORKER_URL, flushToken: null },
    fetchImpl,
    timeoutMs: 50,
  });
  assert.equal(called, false, "the nudge must not fire an unauthenticated request");
});

test("3. a missing worker URL sends nothing", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  await serviceEmail.nudgeServiceEmailFlush({
    config: { workerUrl: null, flushToken: FLUSH_TOKEN },
    fetchImpl,
    timeoutMs: 50,
  });
  assert.equal(called, false);
});

test("4. a failing flush is swallowed and returns undefined", async () => {
  const fetchImpl = async () => {
    throw new Error("network down");
  };
  const result = await serviceEmail.nudgeServiceEmailFlush({
    config: { workerUrl: WORKER_URL, flushToken: FLUSH_TOKEN },
    fetchImpl,
    timeoutMs: 50,
  });
  assert.equal(result, undefined, "the nudge never throws into the caller");
});

test("4b. a non-2xx flush response is logged, not silently treated as success", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await serviceEmail.nudgeServiceEmailFlush({
      config: { workerUrl: WORKER_URL, flushToken: FLUSH_TOKEN },
      fetchImpl: async () => new Response("{}", { status: 401 }),
      timeoutMs: 50,
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1, "a non-2xx flush is reported");
  assert.match(errors[0], /401/, "the status code is logged");
  assert.ok(!errors[0].includes(FLUSH_TOKEN), "the bearer token is never logged");
});

test("4c. a 2xx flush response logs nothing", async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await serviceEmail.nudgeServiceEmailFlush({
      config: { workerUrl: WORKER_URL, flushToken: FLUSH_TOKEN },
      fetchImpl: async () => new Response("{}", { status: 200 }),
      timeoutMs: 50,
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 0, "a successful flush is silent");
});

test("5. config prefers SERVICE_EMAIL_WORKER_URL and falls back to MONITOR_API_URL", () => {
  runtime.setBindings({ SERVICE_EMAIL_WORKER_URL: "https://a.example/", SERVICE_EMAIL_FLUSH_TOKEN: " t1 " });
  assert.deepEqual(serviceEmail.serviceEmailFlushConfig(), { workerUrl: "https://a.example", flushToken: "t1" });

  runtime.setBindings({ MONITOR_API_URL: "https://b.example/", SERVICE_EMAIL_FLUSH_TOKEN: "t2" });
  assert.deepEqual(serviceEmail.serviceEmailFlushConfig(), { workerUrl: "https://b.example", flushToken: "t2" });

  runtime.setBindings({});
  assert.deepEqual(serviceEmail.serviceEmailFlushConfig(), { workerUrl: null, flushToken: null });
});

/* ==================================================== enqueue survives nudge failure */

test("6. the outbox job survives a failed nudge and stays retryable", async () => {
  const d1 = await freshDb();
  await flow.requestMagicLink(d1, SECRETS, {
    email: EMAIL,
    ipHmac: "ip-hmac",
    userAgent: "test-agent",
    nowIso: new Date().toISOString(),
    nowMs: Date.now(),
    fromAddress: null,
  });
  await serviceEmail.nudgeServiceEmailFlush({
    config: { workerUrl: WORKER_URL, flushToken: FLUSH_TOKEN },
    fetchImpl: async () => {
      throw new Error("down");
    },
    timeoutMs: 50,
  });

  const job = d1.raw.prepare("SELECT status, attempts, body_mode FROM email_outbox LIMIT 1").get();
  assert.equal(job.status, "queued", "the row stays queued (not failed) for a later retry");
  assert.equal(job.attempts, 0, "the failed nudge did not burn a delivery attempt");
  assert.equal(job.body_mode, "derived_auth_link");
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM auth_magic_links").get().n, 1, "the link was enqueued");
});

test("7. the request-link response is uniform whether the nudge succeeds or fails", async () => {
  // Mirrors app/api/auth/request-link/route.ts: enqueue, nudge when not
  // suppressed, then always return the same shape.
  const simulate = async (fetchImpl) => {
    const d1 = await freshDb();
    const outcome = await flow.requestMagicLink(d1, SECRETS, {
      email: EMAIL,
      ipHmac: null,
      userAgent: null,
      nowIso: new Date().toISOString(),
      nowMs: Date.now(),
      fromAddress: null,
    });
    if (!outcome.suppressed) {
      await serviceEmail.nudgeServiceEmailFlush({
        config: { workerUrl: WORKER_URL, flushToken: FLUSH_TOKEN },
        fetchImpl,
        timeoutMs: 50,
      });
    }
    return { status: "check_your_email" };
  };

  const delivered = await simulate(async () => new Response("{}", { status: 200 }));
  const down = await simulate(async () => {
    throw new Error("down");
  });
  assert.deepEqual(delivered, down, "success and failure are indistinguishable to the caller");
  assert.deepEqual(delivered, { status: "check_your_email" });
});

/* ==================================================== magic-link origin */

test("8. the magic-link origin comes from SITE_ORIGIN (Preview) and strips a trailing slash", () => {
  assert.equal(
    tokens.authLinkOrigin("https://your-project.pages.dev/", null),
    "https://your-project.pages.dev",
  );
  assert.equal(
    tokens.authLinkOrigin("https://your-project.pages.dev", null),
    "https://your-project.pages.dev",
  );
});

test("9. no configured origin resolves to null, never the production URL", () => {
  assert.equal(tokens.authLinkOrigin(null, null), null);
  assert.equal(tokens.authLinkOrigin("", ""), null);
  assert.notEqual(tokens.authLinkOrigin(null, null), "https://signalledgerlab.com");
});

test("10. the valuation origin is still honored as an explicit config fallback", () => {
  assert.equal(tokens.authLinkOrigin(null, "https://x.example/"), "https://x.example");
});

/* ==================================================== shared derivation secret */

test("11. the shared derivation secret is deterministic and differs across secrets", async () => {
  const a = await tokens.deriveMagicToken(SECRETS.linkDerivation, "job-1", EMAIL, tokens.AUTH_LINK_PURPOSE);
  const b = await tokens.deriveMagicToken(SECRETS.linkDerivation, "job-1", EMAIL, tokens.AUTH_LINK_PURPOSE);
  assert.equal(a, b, "the same (outboxId, email, purpose, secret) yields the same token on Pages and the Worker");
  const other = await tokens.deriveMagicToken("a-different-secret", "job-1", EMAIL, tokens.AUTH_LINK_PURPOSE);
  assert.notEqual(a, other);
});

/* ==================================================== config isolation */

test("12. the sandbox env binds only the sandbox D1 and disables cron; production is untouched", async () => {
  const text = await readFile(new URL("../monitor-worker/wrangler.jsonc", import.meta.url), "utf8");
  const PROD_DB = "00000000-0000-0000-0000-000000000001";
  const SANDBOX_DB = "00000000-0000-0000-0000-000000000002";

  const [beforeEnv, envBlock] = text.split('"env":');

  assert.ok(beforeEnv.includes(PROD_DB), "the production D1 id remains at the top level");
  assert.ok(!beforeEnv.includes(SANDBOX_DB), "the sandbox D1 id does not leak into the top level");
  assert.ok(beforeEnv.includes('"* * * * *"'), "the production cron is unchanged");

  assert.ok(envBlock.includes(SANDBOX_DB), "the sandbox env binds the sandbox D1");
  assert.ok(!envBlock.includes(PROD_DB), "the sandbox env never references the production D1");
  assert.ok(envBlock.includes('"crons": []'), "the sandbox env disables all cron triggers");
  assert.ok(envBlock.includes("market-signal-monitor-sandbox"), "the sandbox worker name is present");
});

test("13. the sandbox migrations dir holds only the staged membership migrations", async () => {
  const files = (await readdir(new URL("../monitor-worker/migrations-sandbox", import.meta.url))).sort();
  assert.deepEqual(files, [
    "0015_membership.sql",
    "0016_billing_schema_fixes.sql",
    "0017_stripe_status.sql",
    "0018_cancel_at.sql",
    "0019_daily_brief_fanout.sql",
    "0020_daily_brief_artifact.sql",
    "0021_whop_billing.sql",
  ]);
});

/* ==================================================== datetime eligibility regression */

// scheduled_for / next_attempt_at are written as ISO8601 (T/Z), but SQLite's
// datetime('now') is space-separated. The eligibility query must normalize both
// sides through datetime(); this pins the exact value from the bug report so the
// string-comparison regression cannot come back.
test("14. an ISO8601 scheduled_for (T/Z) is eligible when datetime('now') is later", async () => {
  const d1 = await freshDb();

  // The pre-fix comparison: '2026-09-19T…' <= '2026-09-19 …' is FALSE, because
  // 'T' (0x54) sorts after ' ' (0x20) — a genuinely-due row is wrongly skipped.
  const raw = d1.raw.prepare(
    "SELECT '2026-09-19T05:03:55.598Z' <= '2026-09-19 05:04:00' AS ready",
  ).get();
  assert.equal(raw.ready, 0, "raw string comparison marks a due row as not-ready (the bug)");

  // Normalizing both sides through datetime() makes the same comparison TRUE.
  const normalized = d1.raw.prepare(
    "SELECT datetime('2026-09-19T05:03:55.598Z') <= datetime('2026-09-19 05:04:00') AS ready",
  ).get();
  assert.equal(normalized.ready, 1, "datetime() normalization marks the same row ready");

  // And the real eligibility query, run against the real schema, must select a
  // row whose scheduled_for is that ISO8601 value while datetime('now') is later.
  // (The WHERE clause below is the one flushServiceEmailOutbox uses.)
  const ts = "2026-09-19T05:03:55.598Z";
  d1.raw.prepare(`
    INSERT INTO email_outbox
      (id, kind, recipient, from_address, subject, body_mode, text_body, html_body,
       payload_json, scheduled_for, expires_at, status, attempts, next_attempt_at,
       created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, 'derived_auth_link', NULL, NULL, NULL, ?, NULL, 'queued', 0, NULL, ?, ?)
  `).run("job-regression", "auth_magic_link", EMAIL, "Sign in", ts, ts, ts);

  const rows = d1.raw.prepare(`
    SELECT id FROM email_outbox
     WHERE status IN ('queued', 'failed') AND attempts < 5
       AND datetime(scheduled_for) <= datetime('now')
       AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
     ORDER BY scheduled_for
     LIMIT ?
  `).all(25);

  assert.equal(rows.length, 1, "the due ISO8601 row is selected");
  assert.equal(rows[0].id, "job-regression");
});
