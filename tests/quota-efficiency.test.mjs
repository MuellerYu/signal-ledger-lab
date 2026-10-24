import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

// Load the actual TypeScript code, not a duplicate implementation.
const modules = new Map();
async function moduleUrl(url) {
  const key = url.href;
  if (modules.has(key)) return modules.get(key);
  let source = await readFile(url, "utf8");
  // The worker now reaches lib/alpaca-bars, which reaches lib/runtime and its
  // Cloudflare binding import. Stand it in, as the other worker tests do.
  source = source.replace('import { env } from "cloudflare:workers";', "const env = {};");
  for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
    const path = match[1].endsWith(".ts") ? match[1] : `${match[1]}.ts`;
    source = source.replace(match[0], `from "${await moduleUrl(new URL(path, url))}"`);
  }
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const data = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  modules.set(key, data);
  return data;
}
const { createSnapshotCache, snapshotPayload } = await import(await moduleUrl(new URL("../lib/snapshot-cache.ts", import.meta.url)));

function memoryEdge() {
  const values = new Map();
  return { async match(key) { return values.get(key)?.clone(); },
    async put(key, response) { values.set(key, response.clone()); } };
}

test("100 simultaneous viewers share one source read; next minute refreshes once", async () => {
  let now = 100_000, reads = 0;
  const get = createSnapshotCache({ now: () => now });
  const edge = memoryEdge();
  const load = async () => { reads++; return { snapshotAt: "original", price: 10 }; };
  const snapshots = await Promise.all(Array.from({ length: 100 }, () => get("https://test/snapshot", load, edge)));
  assert.equal(reads, 1);
  assert.equal(snapshots[99].value.price, 10);
  now += 59_999;
  await get("https://test/snapshot", load, edge);
  assert.equal(reads, 1);
  now++;
  await get("https://test/snapshot", load, edge);
  assert.equal(reads, 2);
  // A fresh isolate uses the existing edge copy without another D1 read.
  await createSnapshotCache({ now: () => now })("https://test/snapshot", load, edge);
  assert.equal(reads, 2);
});

test("quota failure retains the old timestamp, marks stale, and suppresses repeated retries", async () => {
  let now = 100_000, reads = 0;
  const edge = memoryEdge();
  const get = createSnapshotCache({ now: () => now });
  const original = { snapshotAt: "2026-09-04T14:00:00Z", system: {}, price: 10 };
  await get("https://test/stale", async () => original, edge);
  now += 60_000;
  const fail = async () => { reads++; throw new Error("D1 quota exhausted"); };
  const stale = await get("https://test/stale", fail, edge);
  const rendered = snapshotPayload(stale);
  assert.equal(rendered.snapshotAt, original.snapshotAt);
  assert.equal(rendered.system.snapshotCache.status, "stale");
  assert.equal(rendered.status, "partial");
  await get("https://test/stale", fail, edge);
  await createSnapshotCache({ now: () => now })("https://test/stale", fail, edge);
  assert.equal(reads, 1);
  now += 24 * 60 * 60_000;
  await assert.rejects(get("https://test/stale", fail, edge));
});

test("empty-cache failure is not replaced by demo data and is retried after cooldown", async () => {
  let now = 100_000, reads = 0;
  const get = createSnapshotCache({ now: () => now });
  const edge = memoryEdge();
  const fail = async () => { reads++; throw new Error("offline"); };
  await assert.rejects(get("https://test/empty", fail, edge));
  await assert.rejects(get("https://test/empty", fail, edge));
  assert.equal(reads, 1);
  now += 60_000;
  assert.equal((await get("https://test/empty", async () => ({ price: 20 }), edge)).value.price, 20);
});

test("proxy caches preserve upstream age and do not extend an expired snapshot", async () => {
  const now = 2 * 24 * 60 * 60_000;
  const get = createSnapshotCache({ now: () => now });
  const upstream = { system: { snapshotCache: { status: "stale", storedAt: new Date(now - 120_000).toISOString() } } };
  const result = await get("https://test/proxy", async () => upstream, memoryEdge());
  assert.equal(result.storedAt, now - 120_000);
  assert.equal(snapshotPayload(result).system.snapshotCache.status, "stale");
  const expired = { system: { snapshotCache: { storedAt: new Date(0).toISOString() } } };
  await assert.rejects(get("https://test/expired", async () => expired, memoryEdge()));
});

test("cache storage errors do not break a successful source response", async () => {
  const broken = { async match() { throw new Error("cache down"); }, async put() { throw new Error("cache down"); } };
  const result = await createSnapshotCache()("https://test/broken", async () => ({ price: 30 }), broken);
  assert.equal(result.value.price, 30);
});

const root = new URL("../", import.meta.url);
const workerText = await readFile(new URL("monitor-worker/src/index.ts", root), "utf8");
const newsText = await readFile(new URL("monitor-worker/src/btc-news.ts", root), "utf8");

test("warm monitor cache still rejects unauthorized requests without any database reads", async () => {
  const { default: worker } = await import(await moduleUrl(new URL("monitor-worker/src/index.ts", root)));
  let reads = 0;
  const env = { DASHBOARD_READ_KEY: "test-only-key", DB: { prepare() {
    reads++;
    return { bind() { return this; }, async all() { return { success: true, results: [] }; }, async first() { return null; } };
  } } };
  const request = (token) => new Request("https://test/api/dashboard", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await worker.fetch(request("test-only-key"), env)).status, 200);
  const firstReads = reads;
  assert.ok(firstReads > 0);
  assert.equal((await worker.fetch(request("wrong"), env)).status, 401);
  assert.equal((await worker.fetch(request("test-only-key"), env)).status, 200);
  assert.equal(reads, firstReads);
});

test("news queries use existing region/date indexes; no schema migration required", async () => {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("monitor-worker/migrations/", root);
  for (const file of (await readdir(dir)).filter(f => f.endsWith(".sql")).sort()) {
    db.exec(await readFile(new URL(file, dir), "utf8"));
  }
  try {
    const sourceDefinition = workerText.slice(workerText.indexOf("async function ensureSource"));
    const upsert = sourceDefinition.match(/`(INSERT INTO sources[\s\S]*?)`/)[1];
    const definition = ["test-feed", "Test feed", "news", 1, 1, 1, "starting", "2026-09-04", "2026-09-04"];
    assert.equal(db.prepare(upsert).run(...definition).changes, 1);
    assert.equal(db.prepare(upsert).run(...definition.slice(0, 8), "2026-09-05").changes, 0);
    const changed = [...definition];
    changed[1] = "Renamed feed";
    assert.equal(db.prepare(upsert).run(...changed).changes, 1);
    for (const source of [workerText, newsText]) {
      const sql = [...source.matchAll(/`(SELECT[\s\S]*?)`/g)]
        .map(match => match[1]).find(sql => sql.includes("INDEXED BY world_news_region_published_idx"));
      assert.ok(sql);
      const params = Array.from({length: (sql.match(/\?/g) ?? []).length}, () => "test-version");
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail).join("\n");
      assert.match(plan, /SEARCH world_news USING INDEX world_news_region_published_idx \(region=\? AND published_at>\?\)/);
      assert.doesNotMatch(plan, /SCAN world_news/);
    }
    for (const name of ["suppressQueuedRoutineSecAlerts", "suppressQueuedStaleImmediateAlerts"]) {
      const section = workerText.slice(workerText.indexOf(`async function ${name}`));
      const sql = section.match(/`(UPDATE[\s\S]*?)`/)[1];
      const params = Array.from({length: (sql.match(/\?/g) ?? []).length}, () => "2026-09-04T00:00:00Z");
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail).join("\n");
      assert.match(plan, /SEARCH alert_outbox USING INDEX alert_outbox_delivery_idx/);
      assert.match(plan, /SEARCH events USING INDEX sqlite_autoindex_events_1 \(id=\?\)/);
      assert.doesNotMatch(plan, /SCAN events/);
    }
  } finally { db.close(); }
});

test("public reads no longer scan historical run logs and frontend pauses hidden polling", async () => {
  const dashboard = workerText.slice(workerText.indexOf("async function dashboardResponse"), workerText.indexOf("async function healthResponse"));
  assert.doesNotMatch(dashboard, /FROM run_sources/);
  assert.match(dashboard, /sources\.map\(\(row\) => Number\(row\.last_latency_ms\)/);
  const page = await readFile(new URL("app/dashboard-client.tsx", root), "utf8");
  assert.match(page, /document\.visibilityState === "visible"/);
  assert.match(page, /dashboardRequest\.current \|\| Date\.now\(\) < nextDashboardRead\.current/);
  assert.match(page, /Math\.min\(300_000, 60_000 \* 2 \*\*/);
  const route = await readFile(new URL("app/api/dashboard/route.ts", root), "utf8");
  assert.ok(route.indexOf("fetchMonitorDashboard()") < route.indexOf("getD1()"));
  assert.match(route, /if \(monitor\.configured\) throw/);
});
