import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function load(path) {
  let code = await readFile(new URL(path, import.meta.url), "utf8");
  code = code.replace(
    'import { getVerifiedIssuerProfile, VERIFIED_MAJOR_STOCK_TICKERS } from "./issuer-intelligence";',
    `const VERIFIED_MAJOR_STOCK_TICKERS = ["INTC"];
     const getVerifiedIssuerProfile = (ticker) => ticker === "INTC" ? {
       canonicalName: "Intel", valuationFamily: "cyclical_semiconductor",
       businessModel: "Integrated device manufacturer and foundry turnaround",
       driverSchema: ["product share", "foundry utilization", "normalized margin", "capital expenditure"],
       investmentQuestion: "Can the product franchises fund a viable foundry turnaround?"
     } : null;`,
  );
  const compiled = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(compiled).toString("base64"));
}

const engine = await load("../lib/universal-valuation.ts");

test("registry covers every requested company family and valuation model", () => {
  const families = Object.keys(engine.MODEL_FAMILIES);
  for (const family of ["ai_semiconductor", "cyclical_semiconductor", "memory_cycle_semiconductor", "saas_growth", "cloud_software_hybrid", "bank", "reit", "biotech", "auto_energy_optionality_sotp", "integrated_space_connectivity_ai_platform", "bitcoin_treasury", "advanced_nuclear_project_npv", "oil_gas", "insurance", "utility", "airline", "telecom"]) assert.ok(families.includes(family), `missing ${family}`);
  const models = Object.keys(engine.VALUATION_MODELS);
  for (const model of ["dcf", "normalized_dcf", "forward_pe", "ev_ebitda", "ev_fcf", "ev_sales", "sotp", "residual_income", "p_tbv", "nav", "affo", "rnpv", "project_npv", "bitcoin_nav", "commodity_scenario", "reverse_dcf"]) assert.ok(models.includes(model), `missing ${model}`);
});

test("classifier routes different economics to different model families", () => {
  assert.equal(engine.classifyCompany("AMD").modelFamily, "ai_semiconductor");
  assert.equal(engine.classifyCompany("NVDA").modelFamily, "ai_compute_platform");
  assert.equal(engine.classifyCompany("AAPL").modelFamily, "consumer_tech_platform");
  assert.equal(engine.classifyCompany("GOOG").modelFamily, "digital_platform");
  assert.equal(engine.classifyCompany("GOOG").companyName, engine.classifyCompany("GOOGL").companyName);
  assert.equal(engine.classifyCompany("CRCL").modelFamily, "stablecoin_network");
  assert.equal(engine.classifyCompany("ORCL").modelFamily, "cloud_software_hybrid");
  assert.equal(engine.classifyCompany("JPM").modelFamily, "bank");
  assert.equal(engine.classifyCompany("PLD").modelFamily, "reit");
  assert.equal(engine.classifyCompany("PLTR").modelFamily, "saas_growth");
  assert.equal(engine.classifyCompany("REGN").modelFamily, "biotech");
  assert.equal(engine.classifyCompany("TSLA").modelFamily, "auto_energy_optionality_sotp");
  assert.equal(engine.classifyCompany("MSTR").modelFamily, "bitcoin_treasury");
  assert.equal(engine.classifyCompany("OKLO").modelFamily, "advanced_nuclear_project_npv");
  assert.equal(engine.classifyCompany("MU").modelFamily, "memory_cycle_semiconductor");
  assert.equal(engine.classifyCompany("INTC").modelFamily, "cyclical_semiconductor");
  assert.equal(engine.classifyCompany("SPCX").modelFamily, "integrated_space_connectivity_ai_platform");
  assert.equal(engine.classifyCompany("CROX", { companyName: "Crocs", sector: "Consumer Discretionary" }).modelFamily, "consumer_discretionary");
});

test("dedicated model implementations calculate from their own required inputs", () => {
  const assumptions = {
    cashFlowBasis: "analyst_fcff",
    cashFlows: [1, 1.2, 1.4, 1.6],
    normalizedCashFlows: [0.8, 1.1, 1.4, 1.8],
    netCashB: 2,
    dilutedSharesB: 1,
    wacc: 0.1,
    terminalGrowth: 0.03,
    forwardEps: 3,
    forwardPe: 15,
    normalizedEbitdaB: 3,
    evEbitdaMultiple: 10,
    forwardFcfB: 2,
    evFcfMultiple: 10,
    forwardRevenueB: 5,
    evSalesMultiple: 4,
    fcfMargin: 0.25,
    sotpSegments: [{ name: "Core", metric: "revenue", metricValueB: 5, multiple: 4 }],
    bookValuePerShare: 20,
    tangibleBookValuePerShare: 18,
    returnOnEquity: 0.16,
    costOfEquity: 0.1,
    residualGrowth: 0.03,
    priceToTangibleBook: 2,
    navB: 40,
    affoPerShare: 4,
    priceToAffo: 18,
    rnpvAssets: [{ name: "Asset A", unadjustedNpvB: 30, probability: 0.5 }],
    projectNpvAssets: [{ name: "Project A", npvB: 20, probability: 0.5 }],
    bitcoinHoldings: 100_000,
    bitcoinPriceUsd: 90_000,
    commodityScenarios: { bearEquityValueB: 12, baseEquityValueB: 20, bullEquityValueB: 32, bearProbability: 0.25, bullProbability: 0.25 },
    otherAssetValueB: 5,
  };
  for (const [id, implementation] of Object.entries(engine.VALUATION_MODELS)) {
    const result = implementation.run(assumptions, 30);
    if (id === "reverse_dcf") {
      assert.equal(result.missingInputs.length, 0);
    } else {
      assert.ok(result.value > 0, `${id} should calculate a positive value`);
    }
  }
});

test("Signal Ledger thesis modifies fundamentals rather than setting fair value", () => {
  const baseline = { cashFlows: [10, 12, 14], fcfMargin: 0.25, forwardEps: 5, forwardPe: 20 };
  const adjusted = engine.applyThesisAdjustments(baseline, { growthDelta: 0.05, marginDelta: 0.02, multipleDelta: -0.1, note: "test" });
  assert.ok(adjusted.cashFlows[2] > baseline.cashFlows[2]);
  assert.ok(adjusted.forwardEps > baseline.forwardEps);
  assert.equal(adjusted.forwardPe, 18);
  assert.equal("fairValue" in adjusted, false);
});

test("ensemble weights, probability distribution and rating are independently reproducible", () => {
  const first = engine.runUniversalValuation("AMD", { currentPrice: 400, simulationCount: 5000 });
  const second = engine.runUniversalValuation("AMD", { currentPrice: 400, simulationCount: 5000 });
  const valuationModels = first.models.filter((item) => item.role === "valuation" && item.value !== null);
  assert.ok(Math.abs(valuationModels.reduce((sum, item) => sum + item.effectiveWeight, 0) - 1) < 1e-12);
  assert.deepEqual(first.ensemble.probabilityDistribution, second.ensemble.probabilityDistribution);
  const range = first.ensemble.probabilityDistribution;
  assert.ok(range.p10 < range.p25 && range.p25 < range.p50 && range.p50 < range.p75 && range.p75 < range.p90);
  assert.ok(["STRONG BUY", "BUY", "WATCH", "REDUCE", "SELL"].includes(first.rating.value));
});

test("input simulation re-runs formulas and collapses to the hand-calculated result at zero uncertainty", () => {
  const a = { cashFlows: [10, 12], wacc: 0.1, terminalGrowth: 0.02, netCashB: 8, dilutedSharesB: 2, cashFlowBasis: "analyst_fcff" };
  const expected = (10 / 1.1 + 12 / 1.1 ** 2 + (12 * 1.02 / 0.08) / 1.1 ** 2 + 8) / 2;
  // The cached output is deliberately wrong: a sampler of model outputs fails.
  const models = [{ model: "dcf", role: "valuation", effectiveWeight: 1, value: 999_999 }];
  const result = engine.simulateValuationDistribution("HAND", a, models, 0, 100);
  for (const value of Object.values(result.percentiles)) assert.ok(Math.abs(value - expected) < 1e-10);
  assert.equal(result.audit.validDraws, 100);
  assert.equal(result.audit.rejectedDraws, 0);
});

test("sampler changes economic inputs without mutating facts, claims or imported present values", () => {
  const a = {
    cashFlows: [-2, 10], forwardRevenueB: 100, forwardEps: 2, forwardPe: 20,
    netCashB: -5, dilutedSharesB: 2, cashFlowBasis: "analyst_fcff",
    sotpSegments: [
      { name: "Sales", metric: "revenue", metricValueB: 10, multiple: 3, method: "revenue_multiple" },
      { name: "DCF", metric: "present value", metricValueB: 50, multiple: 1, method: "dcf" },
      { name: "Claim", metric: "equity claim", metricValueB: -5, multiple: 1, method: "equity_claim" },
      { name: "Option", metric: "unadjusted option value", metricValueB: 20, multiple: 1, probability: 0.5 },
    ],
  };
  const original = structuredClone(a);
  const sampled = engine.sampleValuationAssumptions(a, { growth: 1, conversion: 1, rate: 0, multiple: 1, probability: 1, assetPrice: 0 }, 0.2);
  assert.ok(Math.abs(sampled.forwardRevenueB - 100 * Math.exp(0.04)) < 1e-10);
  assert.ok(Math.abs(sampled.forwardEps - 2.2 * Math.exp(0.04)) < 1e-10);
  assert.ok(sampled.cashFlows[0] > a.cashFlows[0], "better conversion reduces an early loss");
  assert.equal(sampled.netCashB, -5);
  assert.equal(sampled.dilutedSharesB, 2);
  assert.deepEqual(sampled.sotpSegments[1], a.sotpSegments[1]);
  assert.deepEqual(sampled.sotpSegments[2], a.sotpSegments[2]);
  assert.equal(sampled.sotpSegments[3].metricValueB, 20);
  assert.ok(sampled.sotpSegments[3].probability > 0.5 && sampled.sotpSegments[3].probability < 1);
  assert.deepEqual(a, original);
});

test("a fixed capital bridge shifts every simulated percentile exactly once; equity streams ignore it", () => {
  const a = { cashFlows: [10, 12], wacc: 0.1, costOfEquity: 0.12, terminalGrowth: 0.02, netCashB: 8, dilutedSharesB: 2, cashFlowBasis: "analyst_fcff" };
  const models = [{ model: "dcf", role: "valuation", effectiveWeight: 1 }];
  const run = (inputs) => engine.simulateValuationDistribution("BRIDGE", inputs, models, 0.2, 1000).percentiles;
  const first = run(a);
  const shifted = run({ ...a, netCashB: 15 });
  for (const key of Object.keys(first)) assert.ok(Math.abs(shifted[key] - first[key] - 3.5) < 1e-10);
  const equity = { ...a, cashFlowBasis: "cfo_capex_proxy" };
  assert.deepEqual(run(equity), run({ ...equity, netCashB: -500, wacc: 0.2 }));
  assert.notDeepEqual(first, run(equity));
  assert.deepEqual(first, run(a), "same inputs and seed are reproducible");
});

test("failed draws are counted without dropping a model or discarding insolvency outcomes", () => {
  const models = [{ model: "ev_sales", role: "valuation", effectiveWeight: 1 }];
  const a = { forwardRevenueB: 10, evSalesMultiple: 2, dilutedSharesB: 1, netCashB: -100 };
  const insolvent = engine.simulateValuationDistribution("LOSS", a, models, 0, 100);
  assert.deepEqual(insolvent.percentiles, { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 });
  assert.equal(insolvent.audit.zeroEquityDraws, 100);
  assert.equal(insolvent.audit.rejectedDraws, 0);
  const broken = engine.simulateValuationDistribution("MISSING", { forwardEps: 2, forwardPe: 10 }, [
    { model: "forward_pe", role: "valuation", effectiveWeight: 0.5 },
    { model: "dcf", role: "valuation", effectiveWeight: 0.5 },
  ], 0.2, 100);
  assert.equal(broken.audit.rejectedDraws, 100);
  assert.equal(broken.audit.status, "insufficient_valid_draws");
  assert.ok(Object.values(broken.percentiles).every((value) => value === null));
});

test("segment-governed valuation simulates the published SOTP rather than an unrelated ensemble", () => {
  const result = engine.runUniversalValuation("TSLA", { currentPrice: 300, simulationCount: 1000 });
  assert.equal(result.engine.publishedBasis, "reconciled_segment_sotp");
  const expected = engine.simulateValuationDistribution(
    result.classification.companyName, result.signalLedgerThesis.adjustedAssumptions,
    result.models.filter((model) => model.model === "sotp"),
    result.engine.family.uncertainty, 1000, "reconciled_segment_sotp",
  );
  assert.deepEqual(result.ensemble.probabilityDistribution, expected.percentiles);
  assert.equal(result.engine.simulation.reference, "reconciled_segment_sotp");
});

test("asset-only valuations do not invent randomness without underlying asset inputs", () => {
  const result = engine.simulateValuationDistribution("NAV", { navPerShare: 25 }, [{ model: "nav", role: "valuation", effectiveWeight: 1 }], 0.4, 100);
  assert.deepEqual(result.percentiles, { p10: 25, p25: 25, p50: 25, p75: 25, p90: 25 });
  assert.deepEqual(result.audit.sampledInputs, []);
  assert.ok(result.audit.limitations.some((note) => /underlying asset\/cycle drivers/.test(note)));
});

test("adaptive router returns a transparent company-specific screening value", () => {
  const result = engine.runUniversalValuation("TSLA", { currentPrice: 300 });
  assert.notEqual(result.status, "unavailable");
  assert.ok(result.ensemble.fairValue > 0);
  assert.ok(result.models.some((item) => item.model === "sotp" && item.value > 0));
  assert.equal(result.rating.value, "WATCH");
  assert.ok(result.investorRead.evidenceMissing.length >= 1);
});

test("anchor-led ensemble excludes a non-comparable model instead of withholding every result", () => {
  const result = engine.runValuationProfile({
    classification: engine.classifyCompany("CRCL"),
    baseline: {
      netCashB: 1,
      dilutedSharesB: 0.25,
      wacc: 0.12,
      terminalGrowth: 0.025,
      forwardEps: 0.5,
      forwardPe: 15,
      forwardRevenueB: 3,
      evSalesMultiple: 20,
      sotpSegments: [{ name: "Reserve economics", metric: "net contribution", metricValueB: 1.2, multiple: 18 }],
    },
    thesis: { growthDelta: 0, marginDelta: 0, multipleDelta: 0, note: "test" },
    modelConfidence: { sotp: 0.7, forward_pe: 0.5, ev_sales: 0.5 },
    sourcePosture: "reported_internal_forecast",
    evidenceMissing: ["forward rate curve"],
    variantPath: "test",
    downsideMechanism: "test",
    evidenceGate: "test",
  }, { currentPrice: 90 });
  assert.notEqual(result.dataQuality.valuationRelease, "withheld");
  assert.ok(result.ensemble.fairValue > 0);
  assert.equal(result.engine.modelsCalculated, 3);
  assert.ok(result.engine.modelsIncluded < result.engine.modelsCalculated);
});

test("a missing preferred anchor degrades confidence instead of erasing every usable model", () => {
  const circle = engine.runValuationProfile({
    classification: engine.classifyCompany("CRCL"),
    baseline: { normalizedCashFlows: [1, 1.1, 1.2], netCashB: 1, dilutedSharesB: 0.25, wacc: 0.12, terminalGrowth: 0.025, forwardEps: 1, forwardPe: 18, forwardRevenueB: 3, evSalesMultiple: 4 },
    thesis: { growthDelta: 0, marginDelta: 0, multipleDelta: 0, note: "test" },
    modelConfidence: { forward_pe: 0.6, ev_sales: 0.55 },
    sourcePosture: "reported_internal_forecast",
    evidenceMissing: ["reserve-economics SOTP"],
    variantPath: "test",
    downsideMechanism: "test",
    evidenceGate: "test",
  }, { currentPrice: 100 });
  assert.notEqual(circle.dataQuality.valuationRelease, "withheld");
  assert.ok(circle.ensemble.fairValue > 0);
  assert.equal(circle.status, "high-uncertainty");
  assert.equal(circle.rating.value, "WATCH");
});

test("valuation API and page expose the universal engine contract", async () => {
  const [route, runRoute, healthRoute, page] = await Promise.all([
    readFile(new URL("../app/api/valuation/[ticker]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/valuation/run/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ai/health/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/fair-value/workstation.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /signal-ledger\.valuation\.v3/);
  assert.match(runRoute, /export async function POST/);
  assert.match(runRoute, /buildAutomatedValuationPack/);
  assert.match(runRoute, /runAiOrchestratedValuation/);
  assert.match(runRoute, /selectedModels/);
  assert.match(runRoute, /dataFreshness/);
  assert.match(healthRoute, /probeAiHealth/);
  assert.match(page, /What is the market already pricing in\?/);
  assert.match(page, /Calculating…/);
  assert.match(page, /AI baseline/);
  assert.match(page, /Signal Ledger view/);
  assert.match(page, /STRONG BUY/);
  assert.match(page, /AI model plan/);
  assert.match(page, /Valuation methods and weights/);
  assert.match(page, /Largest sensitivities/);
  assert.match(page, /Evidence freshness/);
  assert.match(page, /confidenceLabel/);
  assert.match(page, /Scenario range/);
  assert.equal(engine.runUniversalValuation("TSLA", { currentPrice: 300 }).confidenceLabel.length > 0, true);
  assert.match(page, /Enterprise-to-equity reconciliation/);
  assert.match(page, /= Fair value per share/);
  // The provenance line states in plain words which engine produced the estimate.
  assert.match(page, /Deterministic models from the stored company profile/);
  assert.match(page, /base weight × applicability × confidence × prior reliability weight/);
});
