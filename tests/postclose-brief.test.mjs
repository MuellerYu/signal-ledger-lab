import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The post-close email is one canonical pipeline. These assertions hold the
 * worker to that: the retired generator must not be reachable for after-close
 * mail, the window must be 17:15 ET, and the send id must be per-session.
 */

const root = new URL("../", import.meta.url);
const worker = await readFile(new URL("monitor-worker/src/index.ts", root), "utf8");
const config = await readFile(new URL("monitor-worker/wrangler.jsonc", root), "utf8");

test("the post-close generator is retired and replaced", () => {
  assert.match(worker, /async function buildPostCloseBrief\(/);
  // The old renderer survives only for the pre-market brief.
  const calls = [...worker.matchAll(/buildBriefingContent\(/g)];
  assert.equal(calls.length, 2, "one definition plus the morning call site");
  assert.match(worker, /if \(briefingType === "after_close"\) \{[\s\S]{0,400}buildPostCloseBrief\(env, sessionDate\)/);
  assert.match(worker, /\} else \{\s*content = buildBriefingContent\(/, "the old renderer is the else branch only");
});

test("the banned filler copy is gone", async () => {
  for (const phrase of ["财报将检验当前盈利预期和估值", "关键事件与财报观察"]) {
    assert.ok(!worker.includes(phrase), `retired copy still present: ${phrase}`);
  }
});

test("the post-close window is 17:15 ET and skips non-trading days", () => {
  assert.match(worker, /hour === 17 && minute >= 15/);
  assert.ok(!/hour === 16 && minute >= 20/.test(worker), "the old 16:20 window is gone");
  assert.match(worker, /isTradingDay\(newYorkDate\(at\)\)/, "the shared holiday rule gates the send");
});

test("the send id is the canonical per-session id", () => {
  assert.match(worker, /briefingType === "after_close"\s*\?\s*briefSendId\(sessionDate\)/);
  assert.match(worker, /send_id = \?/);
});

test("the worker refuses to send when a dependency is missing", () => {
  // No Alpaca credentials means no brief, and nothing is queued.
  assert.match(worker, /market-data credentials are unavailable, so no session brief was generated/);
  // The briefings ledger is append-only, so a failed run must return before it
  // writes anything rather than inserting and then deleting.
  assert.doesNotMatch(worker, /DELETE FROM briefings/, "the ledger forbids deletes");
  assert.match(worker, /build the brief first and return without writing/);
  assert.match(worker, /Quality gate rejected the brief/);
});

test("the brief persists what it concluded, not just the text", async () => {
  for (const column of ["regime", "dominant_theme", "body_hash", "engine_version", "send_id"]) {
    assert.ok(worker.includes(`${column} = ?`), `the brief must persist ${column}`);
  }
  const migration = await readFile(new URL("monitor-worker/migrations/0013_postclose_intelligence.sql", root), "utf8");
  for (const column of ["regime", "dominant_theme", "body_hash", "engine_version", "send_id"]) {
    assert.match(migration, new RegExp(`ADD COLUMN ${column}`));
  }
});

test("the worker reads valuations from the canonical endpoint instead of recomputing", () => {
  assert.match(worker, /SIGNAL_LEDGER_ORIGIN/);
  assert.match(worker, /\/api\/valuation\/snapshot\?tickers=/);
  assert.match(config, /"SIGNAL_LEDGER_ORIGIN"/);
  // No valuation engine may be imported into the worker.
  assert.doesNotMatch(worker, /from "\.\.\/\.\.\/lib\/universal-valuation"/);
  assert.doesNotMatch(worker, /from "\.\.\/\.\.\/lib\/investment-snapshot"/);
});

test("no secret value is committed", () => {
  assert.doesNotMatch(config, /ALPACA_API_KEY_ID"\s*:/, "credentials belong in the secret store, not vars");
  assert.doesNotMatch(config, /ALPACA_API_SECRET_KEY"\s*:/);
});
