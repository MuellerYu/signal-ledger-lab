import assert from "node:assert/strict";
import test from "node:test";

import { applyMigration, allTextInDatabase, createD1, MIGRATION_PATH } from "./helpers/sqlite-d1.mjs";
import { loadModule } from "./helpers/transpile.mjs";

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

const tokens = await import(tokensUrl);
const store = await import(storeUrl);
const flow = await import(flowUrl);

const SECRETS = {
  linkDerivation: "test-link-derivation-secret",
  sessionSigning: "test-session-signing-secret",
  rateLimit: "test-rate-limit-secret",
};

const EMAIL = "user@example.com";

async function freshDb() {
  const d1 = createD1();
  await applyMigration(d1, MIGRATION_PATH);
  return d1;
}

const at = (offsetMs = 0) => new Date(Date.UTC(2026, 8, 21, 21, 15) + offsetMs);
const iso = (offsetMs = 0) => at(offsetMs).toISOString();

/** Requests a link and returns the derived token, which the app never stores. */
async function requestAndDerive(d1, email = EMAIL, nowMs = at().getTime()) {
  await flow.requestMagicLink(d1, SECRETS, {
    email,
    ipHmac: "ip-hmac",
    userAgent: "test-agent",
    nowIso: new Date(nowMs).toISOString(),
    nowMs,
    fromAddress: null,
  });
  const job = d1.raw.prepare("SELECT id, body_mode, text_body, html_body, payload_json FROM email_outbox ORDER BY created_at DESC LIMIT 1").get();
  const token = await tokens.deriveMagicToken(SECRETS.linkDerivation, job.id, email, tokens.AUTH_LINK_PURPOSE);
  return { job, token };
}

/* ==================================================== token is never stored */

test("1. the raw magic token appears in no D1 row", async () => {
  const d1 = await freshDb();
  const { token } = await requestAndDerive(d1);

  for (const value of allTextInDatabase(d1)) {
    assert.ok(!value.includes(token), `token leaked into: ${value.slice(0, 80)}`);
  }
  const link = d1.raw.prepare("SELECT token_hash FROM auth_magic_links LIMIT 1").get();
  assert.equal(link.token_hash, await tokens.hashMagicToken(token), "only the hash is stored");
  assert.notEqual(link.token_hash, token);
});

test("2. an auth-link job stores no body and no payload", async () => {
  const d1 = await freshDb();
  const { job } = await requestAndDerive(d1);
  assert.equal(job.body_mode, "derived_auth_link");
  assert.equal(job.text_body, null);
  assert.equal(job.html_body, null);
  assert.equal(job.payload_json, null);
});

test("2b. the schema itself refuses a stored body on a derived auth-link job", async () => {
  const d1 = await freshDb();
  assert.throws(
    () =>
      d1.raw
        .prepare(
          `INSERT INTO email_outbox (id, kind, recipient, subject, body_mode, text_body, html_body,
             scheduled_for, status, attempts, created_at, updated_at)
           VALUES ('x', 'auth_magic_link', 'a@b.co', 's', 'derived_auth_link', 'token here', '<p>x</p>',
             '2026-09-21T00:00:00Z', 'queued', 0, '2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z')`,
        )
        .run(),
    /CHECK/i,
    "the CHECK constraint is what makes the leak impossible, not just convention",
  );
});

/* ==================================================== GET never authenticates */

test("3. a GET-style validation does not consume the link", async () => {
  const d1 = await freshDb();
  const { token, job } = await requestAndDerive(d1);

  const pending = await flow.validateMagicLink(d1, token, at().getTime());
  assert.ok(pending, "the link validates");
  const link = d1.raw.prepare("SELECT consumed_at FROM auth_magic_links WHERE id = ?").get(pending.linkId);
  assert.equal(link.consumed_at, null, "validating must not spend the link");
  assert.ok(job.id, "job exists");
});

test("5. a scanner following the link cannot authenticate", async () => {
  const d1 = await freshDb();
  const { token } = await requestAndDerive(d1);

  // What a link previewer does: follow the URL.
  await flow.validateMagicLink(d1, token, at().getTime());
  await flow.validateMagicLink(d1, token, at().getTime());

  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get().n, 0, "no session was created");
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0, "no account was created");
  const link = d1.raw.prepare("SELECT consumed_at FROM auth_magic_links LIMIT 1").get();
  assert.equal(link.consumed_at, null, "the link survives the scanner, for the human");
});

/* ==================================================== consume exactly once */

test("4. a POST consume spends the link exactly once", async () => {
  const d1 = await freshDb();
  const { token } = await requestAndDerive(d1);
  const pending = await flow.validateMagicLink(d1, token, at().getTime());
  const cookie = await flow.issuePendingAuth(SECRETS, pending.linkId, at().getTime());

  const first = await flow.consumeMagicLink(d1, SECRETS, {
    pendingCookie: cookie, nowIso: iso(), nowMs: at().getTime(), userAgent: "test",
  });
  assert.equal(first.ok, true, "the first consume succeeds");
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get().n, 1);
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
});

test("6. a replayed POST is refused", async () => {
  const d1 = await freshDb();
  const { token } = await requestAndDerive(d1);
  const pending = await flow.validateMagicLink(d1, token, at().getTime());
  const cookie = await flow.issuePendingAuth(SECRETS, pending.linkId, at().getTime());

  const first = await flow.consumeMagicLink(d1, SECRETS, { pendingCookie: cookie, nowIso: iso(), nowMs: at().getTime(), userAgent: null });
  const replay = await flow.consumeMagicLink(d1, SECRETS, { pendingCookie: cookie, nowIso: iso(1_000), nowMs: at(1_000).getTime(), userAgent: null });

  assert.equal(first.ok, true);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "already_consumed");
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get().n, 1, "no second session");
});

test("9. two simultaneous consumes produce exactly one winner", async () => {
  const d1 = await freshDb();
  const { token } = await requestAndDerive(d1);
  const pending = await flow.validateMagicLink(d1, token, at().getTime());
  const cookie = await flow.issuePendingAuth(SECRETS, pending.linkId, at().getTime());

  const [a, b] = await Promise.all([
    flow.consumeMagicLink(d1, SECRETS, { pendingCookie: cookie, nowIso: iso(), nowMs: at().getTime(), userAgent: null }),
    flow.consumeMagicLink(d1, SECRETS, { pendingCookie: cookie, nowIso: iso(), nowMs: at().getTime(), userAgent: null }),
  ]);

  assert.equal([a, b].filter((outcome) => outcome.ok).length, 1, "exactly one wins");
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get().n, 1);
});

test("7. a superseded link fails", async () => {
  const d1 = await freshDb();
  const first = await requestAndDerive(d1);
  const second = await requestAndDerive(d1, EMAIL, at(60_000).getTime());

  assert.equal(await flow.validateMagicLink(d1, first.token, at(60_000).getTime()), null, "the older link is dead");
  assert.ok(await flow.validateMagicLink(d1, second.token, at(60_000).getTime()), "only the newest link is live");
});

test("8. an expired link fails", async () => {
  const d1 = await freshDb();
  const { token } = await requestAndDerive(d1);
  const afterTtl = at(tokens.MAGIC_LINK_TTL_MS + 1_000).getTime();
  assert.equal(await flow.validateMagicLink(d1, token, afterTtl), null);
});

test("a pending-auth cookie cannot be forged", async () => {
  const d1 = await freshDb();
  const { token } = await requestAndDerive(d1);
  const pending = await flow.validateMagicLink(d1, token, at().getTime());
  const cookie = await flow.issuePendingAuth(SECRETS, pending.linkId, at().getTime());

  const tampered = `${cookie.split(".")[0]}.${cookie.split(".")[1]}.${"0".repeat(32)}`;
  assert.equal(await flow.readPendingAuthCookie(SECRETS, tampered, at().getTime()), null);

  const expired = at(tokens.PENDING_AUTH_TTL_MS + 1_000).getTime();
  assert.equal(await flow.readPendingAuthCookie(SECRETS, cookie, expired), null, "the 5-minute window is enforced");
});

/* ==================================================== enumeration */

test("10. known and unknown addresses get an identical outcome", async () => {
  const d1 = await freshDb();
  // One account exists; one does not. (A second request would supersede the
  // first link, so the account is established in a single clean pass.)
  const { token } = await requestAndDerive(d1, "known@example.com");
  const pending = await flow.validateMagicLink(d1, token, at().getTime());
  await flow.consumeMagicLink(d1, SECRETS, {
    pendingCookie: await flow.issuePendingAuth(SECRETS, pending.linkId, at().getTime()),
    nowIso: iso(), nowMs: at().getTime(), userAgent: null,
  });
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE email_verified = 1").get().n, 1, "the account exists and is verified");

  const forKnown = await flow.requestMagicLink(d1, SECRETS, { email: "known@example.com", ipHmac: null, userAgent: null, nowIso: iso(10_000), nowMs: at(10_000).getTime(), fromAddress: null });
  const forUnknown = await flow.requestMagicLink(d1, SECRETS, { email: "stranger@example.com", ipHmac: null, userAgent: null, nowIso: iso(10_000), nowMs: at(10_000).getTime(), fromAddress: null });
  const forGarbage = await flow.requestMagicLink(d1, SECRETS, { email: "not-an-email", ipHmac: null, userAgent: null, nowIso: iso(10_000), nowMs: at(10_000).getTime(), fromAddress: null });

  assert.deepEqual(forKnown, forUnknown, "the same shape for a known and an unknown address");
  assert.deepEqual(forGarbage, { ok: true, suppressed: true });
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1, "requesting did not create a second account");
});

test("a requesting address does not become a user until it verifies", async () => {
  const d1 = await freshDb();
  await requestAndDerive(d1, "never-verifies@example.com");
  assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0, "no row is created at request time");
});

/* ==================================================== sessions */

test("11. the session table stores only a hash", async () => {
  const d1 = await freshDb();
  const { token } = await requestAndDerive(d1);
  const pending = await flow.validateMagicLink(d1, token, at().getTime());
  const cookie = await flow.issuePendingAuth(SECRETS, pending.linkId, at().getTime());
  const consumed = await flow.consumeMagicLink(d1, SECRETS, { pendingCookie: cookie, nowIso: iso(), nowMs: at().getTime(), userAgent: "ua" });

  const row = d1.raw.prepare("SELECT session_token_hash FROM auth_sessions LIMIT 1").get();
  assert.notEqual(row.session_token_hash, consumed.sessionToken);
  assert.equal(row.session_token_hash, await store.hashSessionToken(consumed.sessionToken));
  for (const value of allTextInDatabase(d1)) {
    assert.ok(!value.includes(consumed.sessionToken), "the cookie value is nowhere in the database");
  }
});

test("12. a rolling refresh cannot pass the 90-day absolute ceiling", async () => {
  const d1 = await freshDb();
  const { token } = await requestAndDerive(d1);
  const pending = await flow.validateMagicLink(d1, token, at().getTime());
  const cookie = await flow.issuePendingAuth(SECRETS, pending.linkId, at().getTime());
  const consumed = await flow.consumeMagicLink(d1, SECRETS, { pendingCookie: cookie, nowIso: iso(), nowMs: at().getTime(), userAgent: null });

  const DAY = 24 * 60 * 60 * 1_000;
  const resolveAt = async (offsetMs) =>
    flow.resolveSession(d1, { sessionToken: consumed.sessionToken, nowIso: iso(offsetMs), nowMs: at(offsetMs).getTime() });

  // Each use must happen inside the current rolling window, extending it by 30
  // days but never past the ceiling.
  assert.ok(await resolveAt(25 * DAY), "active at day 25");
  assert.ok(await resolveAt(50 * DAY), "active at day 50");
  assert.ok(await resolveAt(75 * DAY), "active at day 75, where the clamp starts to bite");
  const nearCeiling = await resolveAt(85 * DAY);
  assert.ok(nearCeiling, "active at day 85");
  assert.equal(
    nearCeiling.session.expires_at,
    nearCeiling.session.absolute_expires_at,
    "the rolling window is clamped by the absolute ceiling, not extended past it",
  );

  const past = await resolveAt(tokens.SESSION_ABSOLUTE_TTL_MS + DAY);
  assert.equal(past, null, "past the absolute ceiling the session is dead and a new link is required");
});

test("13. a revoked session fails", async () => {
  const d1 = await freshDb();
  const { token } = await requestAndDerive(d1);
  const pending = await flow.validateMagicLink(d1, token, at().getTime());
  const cookie = await flow.issuePendingAuth(SECRETS, pending.linkId, at().getTime());
  const consumed = await flow.consumeMagicLink(d1, SECRETS, { pendingCookie: cookie, nowIso: iso(), nowMs: at().getTime(), userAgent: null });

  assert.ok(await flow.resolveSession(d1, { sessionToken: consumed.sessionToken, nowIso: iso(), nowMs: at().getTime() }));
  await flow.signOutSession(d1, consumed.sessionToken, iso());
  assert.equal(await flow.resolveSession(d1, { sessionToken: consumed.sessionToken, nowIso: iso(), nowMs: at().getTime() }), null);
});

test("sign-out-everywhere revokes every live session for the user", async () => {
  const d1 = await freshDb();
  const tokensIssued = [];
  for (let index = 0; index < 2; index += 1) {
    const { token } = await requestAndDerive(d1, EMAIL, at(index * 60_000).getTime());
    const pending = await flow.validateMagicLink(d1, token, at(index * 60_000).getTime());
    const cookie = await flow.issuePendingAuth(SECRETS, pending.linkId, at(index * 60_000).getTime());
    const consumed = await flow.consumeMagicLink(d1, SECRETS, { pendingCookie: cookie, nowIso: iso(index * 60_000), nowMs: at(index * 60_000).getTime(), userAgent: null });
    tokensIssued.push(consumed.sessionToken);
  }
  const userId = d1.raw.prepare("SELECT id FROM users LIMIT 1").get().id;
  assert.equal(await flow.signOutEverywhere(d1, userId, iso(120_000)), 2);
  for (const sessionToken of tokensIssued) {
    assert.equal(await flow.resolveSession(d1, { sessionToken, nowIso: iso(120_000), nowMs: at(120_000).getTime() }), null);
  }
});
