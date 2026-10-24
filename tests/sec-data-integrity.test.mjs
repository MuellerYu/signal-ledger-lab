// Generic SEC data-integrity regression tests (Task B, data-integrity audit §6).
//
// These test the *fact-selection and normalization* logic of `deriveAssumptions`
// against crafted companyfacts payloads — no ticker-specific expected constants,
// no market price, no network. Each test targets one of the failure modes the
// audit found: stock-split/share normalization, latest-compatible fact selection,
// quarterly-vs-annual period selection, units (millions/billions), duplicate
// split adjustment, and DCF basis (FCFF vs FCFE) consistency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const root = new URL("../lib/", import.meta.url);
const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

async function transpile(path, replacements = []) {
  let code = await readFile(new URL(path, root), "utf8");
  for (const match of [...code.matchAll(/from "(\.\/company-business\/[^"]+)"/g)]) {
    const dependency = match[1];
    code = code.replaceAll(`from "${dependency}"`, `from "${dataUrl(await transpile(`${dependency.slice(2)}.ts`))}"`);
  }
  if (code.includes('from "./research-isolation"')) {
    code = code.replaceAll('from "./research-isolation"', `from "${dataUrl(await transpile("research-isolation.ts"))}"`);
  }
  for (const dependency of ["research-schema", "research-plan", "research-validate"]) {
    if (code.includes(`from "./${dependency}"`)) code = code.replaceAll(`from "./${dependency}"`, `from "${dataUrl(await transpile(`${dependency}.ts`))}"`);
  }
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

let loadedPromise = null;
async function loadValuationData() {
  if (loadedPromise) return loadedPromise;
  loadedPromise = (async () => {
    const runtimeUrl = dataUrl(await transpile("runtime.ts", [['import { env } from "cloudflare:workers";', "const env = {};"]]));
    const snapshotCacheUrl = dataUrl(await transpile("snapshot-cache.ts"));
    const issuerUrl = dataUrl(await transpile("issuer-intelligence.ts", [['from "./runtime"', `from "${runtimeUrl}"`]]));
    const aiExposureUrl = dataUrl(await transpile("ai-exposure.ts"));
    const spcxUrl = dataUrl(await transpile("spcx-valuation.ts"));
    const muUrl = dataUrl(await transpile("mu-valuation.ts"));
    const capitalCostUrl = dataUrl(await transpile("valuation-capital-cost.ts", [
      ['from "./runtime"', `from "${runtimeUrl}"`],
      ['from "./snapshot-cache"', `from "${snapshotCacheUrl}"`],
      ['import { configuredFeed, fetchDailyAdjustedBars } from "./alpaca-bars";', 'const configuredFeed = () => "iex"; const fetchDailyAdjustedBars = async () => new Map();'],
    ]));
    const valuationUrl = dataUrl(await transpile("universal-valuation.ts", [
      ['from "./issuer-intelligence"', `from "${issuerUrl}"`],
      ['from "./mu-valuation"', `from "${muUrl}"`],
      // Expose the basis→rate→bridge pairing for the DCF-consistency test.
      ['function discountStream(', 'export function discountStream('],
      ['function isEquityCashFlowBasis(', 'export function isEquityCashFlowBasis('],
      ['function discountedValue(', 'export function discountedValue('],
    ]));
    const researchHashUrl = dataUrl(await transpile("research-hash.ts"));
    const packUrl = dataUrl(await transpile("valuation-data.ts", [
      ['import { calculateCapitalCost, loadCapitalCostMarketInputs } from "./valuation-capital-cost";', `import { calculateCapitalCost, loadCapitalCostMarketInputs as loadMarketInputs } from "${capitalCostUrl}";
const loadCapitalCostMarketInputs = (ticker) => globalThis.__capitalIntegrationMarket ? Promise.resolve(globalThis.__capitalIntegrationMarket) : loadMarketInputs(ticker);`],
      ['from "./valuation-capital-cost"', `from "${capitalCostUrl}"`],
      ['from "./snapshot-cache"', `from "${snapshotCacheUrl}"`],
      ['from "./universal-valuation"', `from "${valuationUrl}"`],
      ['from "./runtime"', `from "${runtimeUrl}"`],
      ['from "./ai-exposure"', `from "${aiExposureUrl}"`],
      ['from "./spcx-valuation"', `from "${spcxUrl}"`],
      ['from "./mu-valuation"', `from "${muUrl}"`],
      ['from "./issuer-intelligence"', `from "${issuerUrl}"`],
      ['from "./research-hash"', `from "${researchHashUrl}"`],
      // Expose the internal fact-selection helpers for direct unit testing.
      ['function deriveAssumptions(', 'export function deriveAssumptions('],
      ['function latestDurationShares(', 'export function latestDurationShares('],
      ['function latestInstant(', 'export function latestInstant('],
      ['function latestAnnual(', 'export function latestAnnual('],
      ['function annualSeries(', 'export function annualSeries('],
      ['function trailingPoint(', 'export function trailingPoint('],
      ['function numeric(', 'export function numeric('],
      ['function units(', 'export function units('],
    ]));
    const uv = await import(valuationUrl);
    return { m: await import(packUrl), uv };
  })();
  return loadedPromise;
}

const { m, uv } = await loadValuationData();

// ---------------------------------------------------------------------------
// Minimal companyfacts payload builders. All values are raw SEC units (shares
// as counts, USD as raw dollars) — the same shape SEC companyfacts returns.
// ---------------------------------------------------------------------------
const secFacts = (usGaap = {}, dei = {}) => ({ entityName: "Test Issuer", facts: { "us-gaap": usGaap, dei } });

const shares = (facts) => ({ units: { shares: facts } });
const dollars = (facts) => ({ units: { USD: facts } });

// A generic duration (weighted-average) share fact: [start, end, val] with a 10-Q.
const waDiluted = (start, end, val) => ({ start, end, val, form: "10-Q", filed: end });
// A generic instant (outstanding) share fact on the DEI cover page.
const outstanding = (end, val, form = "10-K") => ({ end, val, form, filed: end });

test("share normalization: latest weighted-average DILUTED beats stale cover-page OUTSTANDING (no split re-multiply)", () => {
  // A stale cover-page "outstanding" (basic, point-in-time, pre-split era) and a
  // recent weighted-average diluted (post-split). The denominator must be the
  // recent diluted count, taken verbatim — not multiplied by any split factor.
  const payload = secFacts(
    { WeightedAverageNumberOfDilutedSharesOutstanding: shares([waDiluted("2026-04-27", "2026-07-26", 24_300_000_000)]) },
    { EntityCommonStockSharesOutstanding: shares([outstanding("2020-01-26", 1_200_000_000)]) },
  );
  const derived = m.deriveAssumptions(payload, "ai_compute_platform");
  assert.equal(derived.assumptions.dilutedSharesB, 24.3, "diluted denominator must be 24.3B, not the stale 1.2B outstanding");
  assert.equal(derived.weightedAverageDilutedSharesB, 24.3);
  // No duplicate split adjustment: the raw post-split count is used verbatim.
  assert.notEqual(derived.assumptions.dilutedSharesB, 243, "must not re-apply a 10-for-1 split (no 24.3 -> 243)");
  assert.notEqual(derived.assumptions.dilutedSharesB, 12, "must not conflate the pre-split 1.2B");
});

test("latest compatible fact selection: newer compatible fact wins, stale fact never preferred", () => {
  const payload = secFacts({
    WeightedAverageNumberOfDilutedSharesOutstanding: shares([
      waDiluted("2025-04-27", "2025-07-26", 20_000_000_000),
      waDiluted("2026-04-27", "2026-07-26", 24_300_000_000),
    ]),
  });
  const derived = m.deriveAssumptions(payload, "ai_compute_platform");
  assert.equal(derived.assumptions.dilutedSharesB, 24.3, "latest-end fact must win over the older compatible fact");
  // Direct helper check: `latestDurationShares` sorts by period end, newest first.
  const picked = m.latestDurationShares(payload, ["WeightedAverageNumberOfDilutedSharesOutstanding"]);
  assert.equal(picked.end, "2026-07-26");
});

test("quarterly vs annual period selection: interim (<=200d) is the denominator, annual is not confused for it", () => {
  const payload = secFacts({
    WeightedAverageNumberOfDilutedSharesOutstanding: shares([
      // Annual 10-K: ~364-day fiscal year — the *annual* weighted average.
      { start: "2025-01-27", end: "2026-01-25", val: 24_500_000_000, form: "10-K", filed: "2026-02-25" },
      // Latest quarter 10-Q: ~91 days — the *current* diluted denominator.
      waDiluted("2026-04-27", "2026-07-26", 24_300_000_000),
    ]),
  });
  const duration = m.latestDurationShares(payload, ["WeightedAverageNumberOfDilutedSharesOutstanding"]);
  const annual = m.latestAnnual(payload, ["WeightedAverageNumberOfDilutedSharesOutstanding"], "shares");
  assert.equal(duration.value / 1e9, 24.3, "duration helper must pick the quarterly fact");
  assert.equal(annual.value / 1e9, 24.5, "annual helper must pick the 10-K fact");
  // `deriveAssumptions` prefers the duration (quarterly) denominator over the annual.
  const derived = m.deriveAssumptions(payload, "ai_compute_platform");
  assert.equal(derived.assumptions.dilutedSharesB, 24.3, "quarterly diluted must outrank the annual average");
});

test("units: numeric() strips separators/currency; raw SEC values normalize to billions exactly once", () => {
  assert.equal(m.numeric("1,234,567"), 1234567, "commas stripped");
  assert.equal(m.numeric("$12.5%"), 12.5, "currency and percent stripped");
  assert.equal(m.numeric(24_300_000_000), 24_300_000_000, "numeric input passes through");
  // A share count reported as a string still lands in the right unit, not millions.
  const payload = secFacts({
    WeightedAverageNumberOfDilutedSharesOutstanding: shares([{ start: "2026-04-27", end: "2026-07-26", val: "24,300,000,000", form: "10-Q", filed: "2026-08-26" }]),
  });
  const derived = m.deriveAssumptions(payload, "ai_compute_platform");
  assert.equal(derived.assumptions.dilutedSharesB, 24.3, "raw 24.3e9 must normalize to 24.3B (billion), not 24,300 million");
});

test("capex tag migration: the modern tag's recent facts beat a legacy tag that went stale", () => {
  // A filer that migrated capex from the legacy `...PropertyPlantAndEquipment` tag
  // to the modern `PaymentsToAcquireProductiveAssets` tag (as NVIDIA did after
  // FY2020). The legacy tag still carries a stale annual fact; the modern tag has
  // the current one. The series must be chosen by latest period end.
  const payload = secFacts({
    PaymentsToAcquireProductiveAssets: dollars([
      { start: "2025-01-26", end: "2026-01-25", val: 9_200_000_000, form: "10-K", filed: "2026-02-25" },
      { start: "2026-01-26", end: "2026-07-26", val: 4_434_000_000, form: "10-Q", filed: "2026-08-26" },
    ]),
    PaymentsToAcquirePropertyPlantAndEquipment: dollars([
      { start: "2019-01-28", end: "2020-01-26", val: 1_500_000_000, form: "10-K", filed: "2020-02-21" },
    ]),
  });
  const series = m.annualSeries(payload, ["PaymentsToAcquireProductiveAssets", "PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsForAdditionsToPropertyPlantAndEquipment"]);
  assert.equal(series.at(-1).end, "2026-01-25", "annual capex must come from the modern tag (2026), not the stale legacy tag (2020)");
  assert.equal(series.at(-1).value, 9_200_000_000, "recent capex is the modern ~$9.2B, not the legacy ~$1.5B");
  // End to end: with recent OCF + modern capex (but no EBIT/D&A/tax), the DCF
  // uses the reported CFO-CapEx stream rather than degrading to a policy-margin
  // proxy because "recent capex" was mis-read as absent.
  const full = secFacts({
    Revenues: dollars([
      { start: "2024-01-01", end: "2024-12-31", val: 50_000_000_000, form: "10-K", filed: "2025-02-01" },
      { start: "2025-01-01", end: "2025-12-31", val: 60_000_000_000, form: "10-K", filed: "2026-02-01" },
    ]),
    NetCashProvidedByUsedInOperatingActivities: dollars([
      { start: "2024-01-01", end: "2024-12-31", val: 20_000_000_000, form: "10-K", filed: "2025-02-01" },
      { start: "2025-01-01", end: "2025-12-31", val: 24_000_000_000, form: "10-K", filed: "2026-02-01" },
    ]),
    PaymentsToAcquireProductiveAssets: dollars([
      { start: "2024-01-01", end: "2024-12-31", val: 5_000_000_000, form: "10-K", filed: "2025-02-01" },
      { start: "2025-01-01", end: "2025-12-31", val: 6_000_000_000, form: "10-K", filed: "2026-02-01" },
    ]),
  }, {
    EntityCommonStockSharesOutstanding: shares([outstanding("2026-01-30", 1_000_000_000, "10-K")]),
  });
  const derived = m.deriveAssumptions(full, "ai_compute_platform");
  assert.equal(derived.cashFlowBasis, "cfo_capex_proxy", "recent modern capex must be found (not degrade to derived_proxy)");
});

test("DCF basis consistency: unlevered (FCFF) discounts at WACC + net-cash bridge; levered (CFO-CapEx) discounts at cost of equity with no bridge", () => {
  // Unlevered evidence (EBIT + D&A + tax + capex + three years of NWC) -> fcff_ebit_bridge.
  const yr = (y) => ({ start: `${y}-01-01`, end: `${y}-12-31` });
  const annual = (vals, form = "10-K") => Object.entries(vals).map(([y, v]) => ({ ...yr(Number(y)), val: v, form, filed: `${y}-02-01` }));
  const unlevered = secFacts({
    Revenues: dollars(annual({ 2023: 40_000_000_000, 2024: 50_000_000_000, 2025: 60_000_000_000 })),
    NetCashProvidedByUsedInOperatingActivities: dollars(annual({ 2023: 16_000_000_000, 2024: 20_000_000_000, 2025: 24_000_000_000 })),
    NetIncomeLoss: dollars(annual({ 2023: 9_600_000_000, 2024: 12_000_000_000, 2025: 14_400_000_000 })),
    OperatingIncomeLoss: dollars(annual({ 2023: 12_000_000_000, 2024: 15_000_000_000, 2025: 18_000_000_000 })),
    DepreciationDepletionAndAmortization: dollars(annual({ 2023: 2_000_000_000, 2024: 2_000_000_000, 2025: 2_200_000_000 })),
    IncomeTaxExpenseBenefit: dollars(annual({ 2023: 2_400_000_000, 2024: 3_000_000_000, 2025: 3_600_000_000 })),
    PaymentsToAcquireProductiveAssets: dollars(annual({ 2023: 4_000_000_000, 2024: 5_000_000_000, 2025: 6_000_000_000 })),
    AccountsReceivableNetCurrent: dollars(annual({ 2023: 7_000_000_000, 2024: 8_000_000_000, 2025: 9_000_000_000 }).map((f) => ({ ...f, start: undefined }))),
    InventoryNet: dollars(annual({ 2023: 2_500_000_000, 2024: 3_000_000_000, 2025: 3_500_000_000 }).map((f) => ({ ...f, start: undefined }))),
    AccountsPayableCurrent: dollars(annual({ 2023: 1_500_000_000, 2024: 2_000_000_000, 2025: 2_300_000_000 }).map((f) => ({ ...f, start: undefined }))),
    CashAndCashEquivalentsAtCarryingValue: dollars([{ end: "2025-12-31", val: 40_000_000_000, form: "10-K" }]),
    LongTermDebt: dollars([{ end: "2025-12-31", val: 10_000_000_000, form: "10-K" }]),
    ShortTermBorrowings: dollars([{ end: "2025-12-31", val: 0, form: "10-K" }]),
    StockholdersEquity: dollars([{ end: "2025-12-31", val: 60_000_000_000, form: "10-K" }]),
  }, {
    EntityCommonStockSharesOutstanding: shares([outstanding("2026-01-30", 1_000_000_000, "10-K")]),
  });
  const u = m.deriveAssumptions(unlevered, "ai_compute_platform");
  assert.equal(u.cashFlowBasis, "fcff_ebit_bridge");
  assert.equal(u.assumptions.cashFlowBasis, "fcff_ebit_bridge");
  assert.equal(Number.isFinite(u.assumptions.netCashB), true, "unlevered basis carries a net-cash bridge");

  // Levered evidence (only CFO + capex, no EBIT/D&A/tax) -> cfo_capex_proxy, but
  // WITH a reported cash/debt position so `netCashB` is actually finite — the
  // point is to prove the levered discount path ignores that bridge, not that the
  // bridge happens to be absent from the payload.
  const levered = secFacts({
    Revenues: dollars([
      { start: "2024-01-01", end: "2024-12-31", val: 50_000_000_000, form: "10-K", filed: "2025-02-01" },
      { start: "2025-01-01", end: "2025-12-31", val: 60_000_000_000, form: "10-K", filed: "2026-02-01" },
    ]),
    NetCashProvidedByUsedInOperatingActivities: dollars([
      { start: "2024-01-01", end: "2024-12-31", val: 20_000_000_000, form: "10-K", filed: "2025-02-01" },
      { start: "2025-01-01", end: "2025-12-31", val: 24_000_000_000, form: "10-K", filed: "2026-02-01" },
    ]),
    PaymentsToAcquireProductiveAssets: dollars([
      { start: "2024-01-01", end: "2024-12-31", val: 5_000_000_000, form: "10-K", filed: "2025-02-01" },
      { start: "2025-01-01", end: "2025-12-31", val: 6_000_000_000, form: "10-K", filed: "2026-02-01" },
    ]),
    CashAndCashEquivalentsAtCarryingValue: dollars([{ end: "2025-12-31", val: 30_000_000_000, form: "10-K" }]),
    LongTermDebt: dollars([{ end: "2025-12-31", val: 12_000_000_000, form: "10-K" }]),
    ShortTermBorrowings: dollars([{ end: "2025-12-31", val: 0, form: "10-K" }]),
  }, {
    EntityCommonStockSharesOutstanding: shares([outstanding("2026-01-30", 1_000_000_000, "10-K")]),
  });
  const l = m.deriveAssumptions(levered, "ai_compute_platform");
  assert.equal(l.cashFlowBasis, "cfo_capex_proxy", "levered CFO-CapEx proxy when EBIT/D&A/tax are absent");
  assert.equal(Number.isFinite(l.assumptions.netCashB), true, "the payload DOES report a finite net-cash position");

  // The basis→rate→bridge pairing is the actual consistency invariant: an equity
  // (levered) stream discounts at the cost of equity with the bridge forced to
  // zero, an unlevered stream at WACC with the reported net cash added back.
  assert.equal(uv.isEquityCashFlowBasis("cfo_capex_proxy"), true);
  assert.equal(uv.isEquityCashFlowBasis("fcfe_equity"), true);
  assert.equal(uv.isEquityCashFlowBasis("fcff_ebit_bridge"), false);
  assert.equal(uv.isEquityCashFlowBasis("fcff_before_nwc"), false);

  const unleveredPerShare = uv.discountStream(u.assumptions, u.assumptions.cashFlows);
  const leveredPerShare = uv.discountStream(l.assumptions, l.assumptions.cashFlows);
  assert.equal(Number.isFinite(unleveredPerShare), true, "unlevered DCF must discount at WACC + net cash");
  assert.equal(Number.isFinite(leveredPerShare), true, "levered DCF must discount at cost of equity");

  // Recompute both by hand and require exact equality — proving the bridge is
  // added only on the unlevered path (netCashB) and forced to 0 on the levered path.
  const unleveredExpected = uv.discountedValue(u.assumptions.cashFlows, u.assumptions.wacc, u.assumptions.terminalGrowth, u.assumptions.netCashB, u.assumptions.dilutedSharesB);
  const leveredExpected = uv.discountedValue(l.assumptions.cashFlows, l.assumptions.costOfEquity, l.assumptions.terminalGrowth, 0, l.assumptions.dilutedSharesB);
  const leveredWithBridge = uv.discountedValue(l.assumptions.cashFlows, l.assumptions.costOfEquity, l.assumptions.terminalGrowth, l.assumptions.netCashB, l.assumptions.dilutedSharesB);
  assert.equal(unleveredPerShare, unleveredExpected, "unlevered path = WACC + reported net cash bridge");
  assert.equal(leveredPerShare, leveredExpected, "levered path = cost of equity with a zero bridge");
  assert.notEqual(leveredPerShare, leveredWithBridge, "levered path must NOT add the reported net cash back into equity value");
});
