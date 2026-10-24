import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Source-loading helper: transpile the module and import it from a data URL.
// public-samples.ts and valuation-teaser.ts carry no runtime imports (only
// `import type`), so no specifier rewriting is needed.
async function load(path) {
  const code = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
}

const samples = await load("../lib/public-samples.ts");
const teaser = await load("../lib/valuation-teaser.ts");

// --- 1 & 2 & 3: allowlist behaviour drives AMD/SPCX full-sample vs MSFT teaser ---

test("public sample allowlist contains exactly AMD and SPCX", () => {
  assert.equal(samples.PUBLIC_SAMPLE_TICKERS.size, 2);
  assert.deepEqual([...samples.PUBLIC_SAMPLE_TICKERS].sort(), ["AMD", "SPCX"]);
});

test("isPublicSampleTicker returns true for AMD and SPCX, normalizing case/whitespace", () => {
  for (const ticker of ["AMD", "SPCX", "amd", "spcx", "  amd ", "SPCX  "]) {
    assert.equal(samples.isPublicSampleTicker(ticker), true, `expected ${JSON.stringify(ticker)} to be a public sample`);
  }
});

test("isPublicSampleTicker has no wildcard, prefix or fallback behaviour", () => {
  // Non-sample majors stay teaser; near-matches and blanks are never treated as samples.
  for (const ticker of ["MSFT", "NVDA", "ORCL", "TSLA", "AMDX", "", null, undefined, " SPC", "SPC"]) {
    assert.equal(samples.isPublicSampleTicker(ticker), false, `expected ${JSON.stringify(ticker)} to be rejected`);
  }
});

// --- teaser projection: FREE never receives premium valuation fields ---

const fullSnapshot = {
  ticker: "MSFT",
  company: "Microsoft",
  sector: "Technology",
  marketPrice: 450,
  marketPriceTimestamp: "2026-09-19T20:00:00Z",
  quote: { price: 450, asOf: "2026-09-19T20:00:00Z", source: "test" },
  fairValue: 500,
  rating: "WATCH",
  ratingLabel: "Watch",
  upsidePct: 11.1,
  confidence: 0.7,
  confidenceLabel: "Medium",
  valuationFamilyLabel: "Digital platform",
  valuationStatus: "published",
  valuationUpdatedAt: "2026-09-19T20:00:00Z",
  snapshotId: "msft",
  releaseGate: "pass",
  releaseGateDetail: "test",
  // Premium fields a full snapshot would carry — must be stripped for FREE.
  modelRange: { bear: 380, base: 500, bull: 640 },
  bearValue: 380,
  baseValue: 500,
  bullValue: 640,
  buyZone: 420,
  strongBuyZone: 400,
  p10: 390,
  p50: 500,
  p90: 620,
};

const fullOutput = {
  ticker: "NVDA",
  currentPrice: { value: 900, asOf: "2026-09-19T20:00:00Z", source: "test" },
  ensemble: { fairValue: 1000, probabilityDistribution: { p10: 800, p50: 1000, p90: 1200 }, confidence: 0.8 },
  rating: { value: "BUY" },
  classification: { companyName: "NVIDIA", sector: "Semiconductors", modelFamily: "ai_compute_platform" },
  models: [{ model: "dcf", value: 1000, effectiveWeight: 0.5 }],
  assumptions: { growth: 0.1 },
  investorRead: { evidenceMissing: [] },
};

test("teaserSnapshot nulls every premium valuation field for FREE", () => {
  const result = teaser.teaserSnapshot(fullSnapshot);
  assert.equal(result.access, "FREE");
  assert.equal(result.schema, "signal-ledger.valuation-teaser.v1");
  // Non-premium summary fields survive.
  assert.equal(result.ticker, "MSFT");
  assert.equal(result.fairValue, 500);
  assert.equal(result.rating, "WATCH");
  // Premium fields are deliberately nulled, never leaked.
  for (const key of ["modelRange", "bearValue", "baseValue", "bullValue", "buyZone", "strongBuyZone", "p10", "p50", "p90"]) {
    if (key === "modelRange") {
      assert.deepEqual(result.modelRange, { bear: null, base: null, bull: null });
    } else {
      assert.equal(result[key], null, `expected ${key} to be null for FREE`);
    }
  }
});

test("valuationOutputTeaser exposes only the FREE projection keys", () => {
  const result = teaser.valuationOutputTeaser(fullOutput);
  assert.equal(result.access, "FREE");
  assert.equal(result.schema, "signal-ledger.valuation-teaser.v1");
  const keys = Object.keys(result).sort();
  assert.deepEqual(
    keys,
    ["access", "company", "currentPrice", "fairValue", "lockedSections", "rating", "schema", "sector", "ticker", "upsidePct"].sort(),
  );
  assert.equal(result.fairValue, 1000);
  assert.equal(result.rating, "BUY");
  // No premium engine fields may leak through the projection.
  for (const key of ["models", "assumptions", "investorRead", "ensemble", "distribution", "evidence", "pipeline", "classification"]) {
    assert.equal(key in result, false, `expected ${key} to be absent from FREE projection`);
  }
});

// --- 4: /api/valuation/run is PRO-only for EVERY ticker, including AMD/SPCX ---

test("/api/valuation/run gates with requirePro() before any compute and makes no sample exception", async () => {
  const runRoute = await readFile(new URL("../app/api/valuation/run/route.ts", import.meta.url), "utf8");
  // Gate is the first thing POST does, ahead of any model/valuation compute.
  assert.match(runRoute, /if \(!\(await requirePro\(\)\)\) return upgradeRequired\(\);/);
  const gateIndex = runRoute.indexOf("requirePro()");
  assert.ok(gateIndex < runRoute.indexOf("buildAutomatedValuationPack("), "requirePro gate must precede pack build");
  assert.ok(gateIndex < runRoute.indexOf("runAiOrchestratedValuation("), "requirePro gate must precede AI orchestration");
  // No public-sample branch exists here — AMD/SPCX cannot bypass the PRO gate.
  assert.doesNotMatch(runRoute, /isPublicSampleTicker|PUBLIC_SAMPLE_TICKERS/);
});

// --- structural verification of the GET surfaces ---

test("single-ticker valuation GET serves the teaser for non-samples and the full output only for PRO/samples", async () => {
  const route = await readFile(new URL("../app/api/valuation/[ticker]/route.ts", import.meta.url), "utf8");
  assert.match(route, /entitlement\.tier !== "PRO" && !isPublicSampleTicker\(ticker\)/);
  assert.match(route, /valuationOutputTeaser\(output\)/);
  assert.match(route, /isPublicSampleTicker\(ticker\)/);
});

test("snapshot GET projects a teaser for FREE lists and full snapshot only for PRO/single sample", async () => {
  const route = await readFile(new URL("../app/api/valuation/snapshot/route.ts", import.meta.url), "utf8");
  // Single-ticker path: full snapshot only for PRO or a public sample.
  assert.match(route, /entitlement\.tier === "PRO" \|\| isPublicSampleTicker\(single\)/);
  // List path: FREE clients get a teaser for every snapshot.
  assert.match(route, /entitlement\.tier === "PRO" \? snapshots : snapshots\.map\(\(snapshot\) => teaserSnapshot\(snapshot\)\)/);
});
