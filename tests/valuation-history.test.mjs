import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Valuation history: the projection behind model_input_hash, and the prior vs
 * current comparison that replaced comparing a snapshot against itself.
 *
 * The regression the user asked for is at the bottom: a synthetic day-1 row
 * proves a real day-2 session can report FAIR VALUE CHANGED and
 * VALUATION INPUT CHANGED.
 */

const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const transpile = async (path, replacements = []) => {
  let code = await readFile(new URL(path, import.meta.url), "utf8");
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  return dataUrl(ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
};

const pickNyUrl = await transpile("../lib/pick-ny.ts");
const formatUrl = await transpile("../lib/format.ts");
const briefUrl = await transpile("../lib/daily-brief.ts", [
  ['from "./pick-ny"', `from "${pickNyUrl}"`],
  ['from "./format"', `from "${formatUrl}"`],
]);

const {
  compareValuationSnapshots,
  describeValuationInputChanges,
  valuationInputProjection,
  valuationThesisProjection,
} = await import(briefUrl);

/** The same digest the worker takes of the projection. */
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** A canonical snapshot shaped like `/api/valuation/snapshot` returns. */
function snapshot(overrides = {}) {
  return {
    ticker: "AMD",
    engineVersion: "signal-ledger.investment-snapshot.v2",
    issuerProfileVersion: "issuer-profile.v3",
    valuationFamily: "SEMICONDUCTOR_CYCLICAL",
    valuationStatus: "released",
    modelsIncluded: 3,
    modelsRouted: 4,
    modelWeights: { DCF: 0.5, EPS_MULTIPLE: 0.3, PEER_MULTIPLE: 0.2 },
    keyAssumptions: ["HBM pricing holds", "Data-centre capex grows 20%"],
    selectedModels: [
      { model: "DCF", label: "Discounted cash flow", value: 470, effectiveWeight: 0.5, applicability: 1, confidence: 0.7, priorReliability: 0.6, status: "used", reason: "cash generative" },
    ],
    rejectedModels: [{ model: "SPAC", label: "SPAC", value: null, reason: "not applicable" }],
    modelsUsed: [{ model: "DCF", label: "Discounted cash flow", role: "primary", value: 470, effectiveWeight: 0.5, priorReliability: 0.6 }],
    keyDrivers: [{ driver: "Data-centre GPU demand", assumption: "20% growth", source: "10-Q" }],
    evidence: [
      { metric: "revenue", value: 100, unit: "USDm", asOfDate: "2026-06-30", retrievedAt: "2026-09-18T20:00:00Z", sourceType: "sec", sourceId: "0001", confidence: 0.9 },
    ],
    // Outputs and bookkeeping: none of these may reach the hash.
    fairValue: 451.4,
    marketPrice: 557.32,
    marketPriceTimestamp: "2026-09-18T20:00:00Z",
    valuationUpdatedAt: "2026-09-18T12:00:00Z",
    snapshotId: "snap-1",
    upsidePct: 12.4,
    p10: 380,
    p90: 520,
    modelRange: { bear: 380, base: 451.4, bull: 520 },
    cache: { hit: false, ageMs: 12, financialsCached: true, engineVersion: "v2" },
    ...overrides,
  };
}

const hashOf = (value) => digest(valuationInputProjection(value));

/* ------------------------------------------------------------ projection */

test("the input hash ignores price, timestamps, ids and derived outputs", () => {
  const base = snapshot();
  const revalued = snapshot({
    fairValue: 999.99,
    marketPrice: 1.01,
    marketPriceTimestamp: "2026-09-19T09:00:00Z",
    valuationUpdatedAt: "2026-09-19T12:00:00Z",
    snapshotId: "snap-2",
    upsidePct: 88,
    p10: 1, p90: 999,
    modelRange: { bear: 1, base: 999, bull: 1000 },
    cache: { hit: true, ageMs: 999, financialsCached: false, engineVersion: "v9" },
  });
  assert.equal(hashOf(base), hashOf(revalued), "a stock moving is not a valuation input changing");

  // A re-read that only refreshes retrieval times is the same valuation.
  const reread = snapshot({
    evidence: [{ metric: "revenue", value: 100, unit: "USDm", asOfDate: "2026-06-30", retrievedAt: "2026-09-18T23:59:00Z", sourceType: "sec", sourceId: "0001", confidence: 0.9 }],
  });
  assert.equal(hashOf(base), hashOf(reread), "retrievedAt is a timestamp and never reaches the hash");
});

test("the input hash moves when a real valuation input moves", () => {
  const base = snapshot();
  assert.notEqual(hashOf(base), hashOf(snapshot({ modelWeights: { DCF: 0.6, EPS_MULTIPLE: 0.2, PEER_MULTIPLE: 0.2 } })));
  assert.notEqual(hashOf(base), hashOf(snapshot({ evidence: [{ metric: "revenue", value: 130, unit: "USDm", asOfDate: "2026-06-30", retrievedAt: "2026-09-18T20:00:00Z", sourceType: "sec", sourceId: "0001", confidence: 0.9 }] })));
  assert.notEqual(hashOf(base), hashOf(snapshot({ keyAssumptions: ["HBM pricing holds", "Data-centre capex grows 30%"] })));
  assert.notEqual(hashOf(base), hashOf(snapshot({ issuerProfileVersion: "issuer-profile.v4" })));
  assert.notEqual(hashOf(base), hashOf(snapshot({ selectedModels: [{ model: "DCF", label: "Discounted cash flow", value: 500, effectiveWeight: 0.5, applicability: 1, confidence: 0.7, priorReliability: 0.6, status: "used", reason: "cash generative" }] })));
});

test("the projection is stable under key reordering", () => {
  const base = snapshot();
  const reordered = snapshot({ modelWeights: { PEER_MULTIPLE: 0.2, DCF: 0.5, EPS_MULTIPLE: 0.3 } });
  assert.equal(valuationInputProjection(base), valuationInputProjection(reordered), "equal inputs must print equal");
});

test("thesis hash is nullable because the canonical payload carries no thesis document", () => {
  assert.equal(valuationThesisProjection(snapshot()), null);
});

/* ------------------------------------------------------------ comparison */

const row = (ticker, sessionDate, fairValue, modelInputHash, snapshotValue = null, thesisHash = null) => ({
  ticker, sessionDate, fairValue, modelInputHash, thesisHash, snapshot: snapshotValue,
});

test("no prior session reports NO COMPARABLE PRIOR SNAPSHOT, never a flat +0.00%", () => {
  const [move] = compareValuationSnapshots([{
    ticker: "AMD",
    priceChangePct: 5.8,
    prior: null,
    current: row("AMD", "2026-09-18", 451.4, "hash-a"),
  }]);
  assert.equal(move.classification, "NO COMPARABLE PRIOR SNAPSHOT");
  assert.equal(move.fairValueChangePct, null, "no delta is invented");
  assert.equal(move.fairValuePrior, null);
});

test("an unchanged valuation is PRICE MOVED ONLY however far the price ran", () => {
  const [move] = compareValuationSnapshots([{
    ticker: "MSTR",
    priceChangePct: 16.37,
    prior: row("MSTR", "2026-09-17", 165.558, "hash-a"),
    current: row("MSTR", "2026-09-18", 165.558, "hash-a"),
  }]);
  assert.equal(move.classification, "PRICE MOVED ONLY");
  assert.equal(move.fairValueChangePct, 0);
  assert.equal(move.modelInputChanged, false);
});

test("a changed model input is VALUATION INPUT CHANGED and names what moved", () => {
  const priorSnapshot = snapshot({ modelWeights: { DCF: 0.5, EPS_MULTIPLE: 0.3, PEER_MULTIPLE: 0.2 }, fairValue: 451.4 });
  const currentSnapshot = snapshot({ modelWeights: { DCF: 0.6, EPS_MULTIPLE: 0.2, PEER_MULTIPLE: 0.2 }, fairValue: 470 });
  const [move] = compareValuationSnapshots([{
    ticker: "AMD",
    priceChangePct: 2.72,
    prior: row("AMD", "2026-09-17", 451.4, hashOf(priorSnapshot), priorSnapshot),
    current: row("AMD", "2026-09-18", 470, hashOf(currentSnapshot), currentSnapshot),
  }]);
  assert.equal(move.classification, "VALUATION INPUT CHANGED");
  assert.equal(move.modelInputChanged, true);
  assert.ok(move.inputChanges.length > 0, "the driver of the change is named");
  assert.ok(move.inputChanges.some((change) => change.includes("modelWeights.DCF")), move.inputChanges.join(" | "));
});

test("a changed fair value on unchanged inputs is FAIR VALUE CHANGED with prior, current and delta", () => {
  const priorSnapshot = snapshot();
  const currentSnapshot = snapshot();
  const [move] = compareValuationSnapshots([{
    ticker: "AMD",
    priceChangePct: 2.72,
    prior: row("AMD", "2026-09-17", 400, hashOf(priorSnapshot), priorSnapshot),
    current: row("AMD", "2026-09-18", 451.4, hashOf(currentSnapshot), currentSnapshot),
  }]);
  assert.equal(move.classification, "FAIR VALUE CHANGED");
  assert.equal(move.fairValuePrior, 400);
  assert.equal(move.fairValueCurrent, 451.4);
  assert.ok(Math.abs(move.fairValueChangePct - 12.85) < 0.01, `delta was ${move.fairValueChangePct}`);
  assert.equal(move.modelInputChanged, false);
});

test("a changed thesis outranks an input change", () => {
  const [move] = compareValuationSnapshots([{
    ticker: "AMD",
    priceChangePct: 1,
    prior: row("AMD", "2026-09-17", 400, "hash-a", null, "thesis-a"),
    current: row("AMD", "2026-09-18", 451.4, "hash-b", null, "thesis-b"),
  }]);
  assert.equal(move.classification, "THESIS CHANGED");
  assert.equal(move.thesisChanged, true);
});

test("an input diff reports nothing when the inputs are identical", () => {
  const value = snapshot();
  assert.deepEqual(describeValuationInputChanges(value, snapshot()), []);
});

/* ------------------------------------------------- synthetic prior regression */

test("a synthetic prior session proves day two can detect both change kinds", () => {
  // Day 1: what the worker would have appended after the 2026-09-17 close.
  const dayOne = snapshot({
    fairValue: 400,
    marketPrice: 500,
    modelWeights: { DCF: 0.5, EPS_MULTIPLE: 0.3, PEER_MULTIPLE: 0.2 },
  });
  const dayOneRow = row("AMD", "2026-09-17", 400, hashOf(dayOne), dayOne);

  // Day 2a: the inputs moved, so the fair value moved with them.
  const dayTwoInputsMoved = snapshot({
    fairValue: 470,
    marketPrice: 557.32,
    modelWeights: { DCF: 0.6, EPS_MULTIPLE: 0.2, PEER_MULTIPLE: 0.2 },
  });
  const inputMoved = compareValuationSnapshots([{
    ticker: "AMD",
    priceChangePct: 2.72,
    prior: dayOneRow,
    current: row("AMD", "2026-09-18", 470, hashOf(dayTwoInputsMoved), dayTwoInputsMoved),
  }])[0];
  assert.equal(inputMoved.classification, "VALUATION INPUT CHANGED");
  assert.equal(inputMoved.fairValuePrior, 400);
  assert.equal(inputMoved.fairValueCurrent, 470);
  assert.ok(Math.abs(inputMoved.fairValueChangePct - 17.5) < 0.01);
  assert.ok(inputMoved.inputChanges.some((change) => change.includes("modelWeights.DCF")));

  // Day 2b: nothing but the price moved.
  const dayTwoPriceOnly = snapshot({
    fairValue: 400,
    marketPrice: 520,
    modelWeights: { DCF: 0.5, EPS_MULTIPLE: 0.3, PEER_MULTIPLE: 0.2 },
  });
  const priceOnly = compareValuationSnapshots([{
    ticker: "AMD",
    priceChangePct: 4,
    prior: dayOneRow,
    current: row("AMD", "2026-09-18", 400, hashOf(dayTwoPriceOnly), dayTwoPriceOnly),
  }])[0];
  assert.equal(priceOnly.classification, "PRICE MOVED ONLY", "the price more than doubling is not a valuation change");
  assert.equal(priceOnly.inputChanges.length, 0);

  // Day 2c: the inputs held but the engine republished a different fair value.
  const dayTwoFairValueOnly = snapshot({
    fairValue: 430,
    marketPrice: 557.32,
    modelWeights: { DCF: 0.5, EPS_MULTIPLE: 0.3, PEER_MULTIPLE: 0.2 },
  });
  const fairMoved = compareValuationSnapshots([{
    ticker: "AMD",
    priceChangePct: 2.72,
    prior: dayOneRow,
    current: row("AMD", "2026-09-18", 430, hashOf(dayTwoFairValueOnly), dayTwoFairValueOnly),
  }])[0];
  assert.equal(fairMoved.classification, "FAIR VALUE CHANGED");
  assert.equal(fairMoved.fairValuePrior, 400);
  assert.equal(fairMoved.fairValueCurrent, 430);
  assert.equal(fairMoved.modelInputChanged, false);
});

/* ------------------------------------------------------ storage guarantees */

test("the history table is append-only, per-session unique and idempotent", async () => {
  const migration = await readFile(new URL("../monitor-worker/migrations/0014_valuation_snapshot_history.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS valuation_snapshot_history/);
  assert.match(migration, /UNIQUE \(ticker, session_date\)/, "one snapshot per instrument per session");
  assert.match(migration, /snapshot_json TEXT NOT NULL/, "the canonical result is stored verbatim");
  assert.match(migration, /BEFORE UPDATE ON valuation_snapshot_history[\s\S]*RAISE\(ABORT/);
  assert.match(migration, /BEFORE DELETE ON valuation_snapshot_history[\s\S]*RAISE\(ABORT/);
});

test("the worker appends with INSERT OR IGNORE and never updates the history", async () => {
  const worker = await readFile(new URL("../monitor-worker/src/index.ts", import.meta.url), "utf8");
  assert.match(worker, /INSERT OR IGNORE INTO valuation_snapshot_history/);
  assert.doesNotMatch(worker, /UPDATE valuation_snapshot_history/);
  assert.doesNotMatch(worker, /DELETE FROM valuation_snapshot_history/);
  // The append happens after the brief is built and gated, not inside the builder.
  const builderReturn = worker.indexOf("valuationCaptures,");
  const append = worker.indexOf("persistValuationCaptures(env, brief.valuationCaptures)");
  assert.ok(builderReturn > 0 && append > builderReturn, "the write sits with the caller, after the gate");
});
