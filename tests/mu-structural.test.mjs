import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const root = new URL("../lib/", import.meta.url);
const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

async function transpile(path) {
  const code = await readFile(new URL(path, root), "utf8");
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

const mu = await import(dataUrl(await transpile("mu-valuation.ts")));

/* ------------------------------------------------------------------ */
/* Reported data fixtures                                              */
/* ------------------------------------------------------------------ */

const productTable = (rows) => [
  "<html><body>",
  ...Object.entries(rows).map(([id, { start, end, member }]) => `<xbrli:context id="${id}"><xbrli:period><xbrli:startDate>${start}</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period><xbrli:entity><xbrli:segment><xbrldi:explicitMember dimension="srt:ProductOrServiceAxis">${member}</xbrldi:explicitMember></xbrli:segment></xbrli:entity></xbrli:context>`),
  ...Object.entries(rows).map(([id, { value }]) => `<ix:nonFraction name="us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax" contextRef="${id}" scale="6">${value}</ix:nonFraction>`),
  "</body></html>",
].join("");

const FILING_HTML = productTable({
  "d-ytd": { start: "2025-08-29", end: "2026-05-28", member: "mu:DRAMProductsMember", value: "60,908" },
  "n-ytd": { start: "2025-08-29", end: "2026-05-28", member: "mu:NANDProductsMember", value: "17,683" },
  "o-ytd": { start: "2025-08-29", end: "2026-05-28", member: "mu:OtherProductSalesMember", value: "368" },
  "d-q": { start: "2026-02-27", end: "2026-05-28", member: "mu:DRAMProductsMember", value: "31,328" },
  "n-q": { start: "2026-02-27", end: "2026-05-28", member: "mu:NANDProductsMember", value: "9,943" },
  "o-q": { start: "2026-02-27", end: "2026-05-28", member: "mu:OtherProductSalesMember", value: "185" },
});

const FILING_TEXT = [
  "We recently executed certain strategic customer agreements. These agreements are structured as take-or-pay agreements, with binding commitments for specific volumes over the multi-year contract terms.",
  "Pricing for most agreements is either fixed, or is subject to minimum and maximum pricing.",
  "We broke ground in January 2025 on an HBM advanced packaging facility in Singapore to meaningfully expand our total advanced packaging capacity beginning in the first half of calendar 2027.",
  "In Taiwan, we are modernizing and expanding our production capacity for DRAM and HBM products to meet rising market demand.",
  "For the first nine months of 2026, net cash used for financing activities consisted primarily of $9.38 billion of repayments of debt.",
].join(" ");

const anchors = (overrides = {}) => ({
  quarter: {
    periodEnd: "2026-05-28",
    revenueM: 41_456,
    grossProfitM: 35_056,
    operatingIncomeM: 33_318,
    operatingExpenseM: 1_738,
    netIncomeM: 28_243,
    eps: 24.67,
    dAndAM: 2_364,
    capexM: 7_000,
    cfoM: 20_000,
  },
  yearToDate: {
    periodEnd: "2026-05-28",
    revenueM: 78_959,
    grossProfitM: 60_457,
    operatingIncomeM: 55_589,
    netIncomeM: 47_268,
    eps: 41.4,
    dAndAM: 6_862,
    capexM: 19_602,
    cfoM: 45_702,
    taxM: 8_178,
  },
  ttm: { periodEnd: "2026-05-28", revenueM: 90_274, grossProfitM: 65_511, netIncomeM: 50_469, eps: 44.24, dAndAM: 9_011, capexM: 25_260, cfoM: 51_432 },
  balance: { cashM: 24_995, longTermDebtM: 14_000, equityM: 100_724, inventoryM: 0 },
  dilutedSharesM: 1_145,
  productRevenue: mu.parseMuReportedProductRevenue(FILING_HTML),
  source: "fixture",
  sourceDate: "2026-06-25",
  ...overrides,
});

const evidence = mu.parseMuEvidence(FILING_TEXT);
const build = (options = {}) => mu.buildMuValuation({
  anchors: anchors(),
  assumptions: mu.MU_FORECAST_ASSUMPTIONS,
  valuation: mu.MU_VALUATION_ASSUMPTIONS,
  evidence,
  price: 925.65,
  netCashB: 11,
  sharesM: 1_145,
  ...options,
});

/* ------------------------------------------------------------------ */
/* Reported inputs                                                     */
/* ------------------------------------------------------------------ */

test("MU quality: the reported product table fixes the DRAM/NAND split", () => {
  const parsed = mu.parseMuReportedProductRevenue(FILING_HTML);
  assert.equal(parsed.quarterLabel, "2026-05-28");
  assert.deepEqual(parsed.quarter, { dramM: 31_328, nandM: 9_943, otherM: 185, totalM: 41_456 });
  assert.deepEqual(parsed.yearToDate, { dramM: 60_908, nandM: 17_683, otherM: 368, totalM: 78_959 });
  // A filing without a product table returns nothing rather than a guess.
  assert.equal(mu.parseMuReportedProductRevenue("<html><body>no table</body></html>").quarter, null);
  assert.equal(mu.parseMuReportedProductRevenue(null).quarter, null);
});

test("MU quality: the structural overlay needs reported contract evidence", () => {
  const withEvidence = mu.parseMuEvidence(FILING_TEXT);
  assert.equal(withEvidence.takeOrPayAgreements, true);
  assert.ok(withEvidence.capacityProgrammes.some((item) => /HBM advanced packaging/i.test(item)));
  assert.ok(withEvidence.capacityProgrammes.some((item) => /Taiwan/i.test(item)));

  const withoutEvidence = mu.parseMuEvidence("Micron reported memory revenue for the quarter.");
  assert.equal(withoutEvidence.takeOrPayAgreements, false);
  assert.equal(withoutEvidence.capacityProgrammes.length, 0);
  // No evidence means the structural premium is switched off, not assumed.
  const noEvidence = build({ evidence: withoutEvidence });
  assert.ok(noEvidence.forecast.at(-1).grossMargin < 0.4, `without contract evidence the terminal margin must fall back, got ${noEvidence.forecast.at(-1).grossMargin}`);
  assert.ok(noEvidence.weightedFairValue < build().weightedFairValue);
});

/* ------------------------------------------------------------------ */
/* Model construction                                                  */
/* ------------------------------------------------------------------ */

test("MU quality: HBM is modelled as its own business, not a revenue multiple", () => {
  const output = build();
  const [fy26, fy27, fy30] = [output.forecast[0], output.forecast[1], output.forecast.at(-1)];
  assert.ok(fy27.hbmRevenueB > 0, "HBM must carry its own revenue line");
  assert.ok(fy30.hbmRevenueB > fy27.hbmRevenueB, "HBM revenue must grow on the reported capacity programme");
  assert.ok(fy27.hbmGrossMargin > fy27.nandGrossMargin, "HBM must earn a premium to NAND");
  assert.ok(fy30.hbmShareOfDram > fy26.hbmShareOfDram, "HBM must become a larger share of DRAM");
  // DRAM is the reported product line: HBM plus legacy DRAM must add up to it.
  for (const row of output.forecast) {
    assert.ok(Math.abs(row.hbmRevenueB + row.legacyDramRevenueB - row.dramRevenueB) < 0.05, `FY${row.year} DRAM split must reconcile`);
  }
  // The anchor year uses the reported product mix, not an assumed one.
  assert.ok(Math.abs(fy26.dramRevenueB / fy26.revenueB - 31_328 / 41_456) < 0.002);
  assert.ok(Math.abs(fy26.nandRevenueB / fy26.revenueB - 9_943 / 41_456) < 0.002);
});

test("MU quality: legacy memory normalises one year at a time instead of jumping", () => {
  const output = build();
  const margins = output.forecast.map((row) => row.grossMargin);
  assert.ok(margins[0] > 0.75, "the anchor year keeps the reported margin");
  for (let index = 1; index < margins.length; index += 1) {
    assert.ok(margins[index] <= margins[index - 1], `FY${output.forecast[index].year} margin must not rise during normalisation`);
    assert.ok(margins[index - 1] - margins[index] < 0.12, `FY${output.forecast[index].year} must not reset the margin in a single step`);
  }
  // The structural floor sits above the historical fallback, but far below the peak.
  assert.ok(margins.at(-1) > mu.MU_FORECAST_ASSUMPTIONS.blendedGrossMarginWithoutStructuralSupport.at(-1));
  assert.ok(margins.at(-1) < margins[0] - 0.2);
  assert.equal(output.legacy.terminalMargin, margins.at(-1));
  assert.equal(output.structuralChange.assessed, true);
});

test("MU quality: the published value is the weighted method result and the segment view agrees", () => {
  const output = build();
  assert.equal(output.qualityGates.publishable, true);
  const weightTotal = output.methods.reduce((sum, method) => sum + method.weight, 0);
  assert.ok(Math.abs(weightTotal - 1) < 0.01, `weights must sum to 1, got ${weightTotal}`);
  const weighted = output.methods.reduce((sum, method) => sum + method.value * method.weight, 0);
  assert.ok(Math.abs(weighted - output.weightedFairValue) < 1, `published ${output.weightedFairValue} must equal the weighted methods ${weighted}`);
  // Forward P/E and EV/EBITDA must carry the largest weights; revenue the least.
  const byWeight = [...output.methods].sort((left, right) => right.weight - left.weight);
  assert.ok(["Forward P/E", "EV/EBITDA"].includes(byWeight[0].method));
  assert.equal(byWeight.at(-1).method, "Revenue multiple");
  // The segment table is the same engine, so it cannot disagree by construction.
  const segmentEv = output.segmentBreakdown.segments.reduce((sum, segment) => sum + segment.enterpriseValueB, 0);
  assert.ok(Math.abs(segmentEv - output.segmentBreakdown.enterpriseValueB) < 0.5);
  const segmentEquity = output.segmentBreakdown.enterpriseValueB + 11;
  assert.ok(Math.abs(segmentEquity - output.segmentBreakdown.equityValueB) < 0.5);
  assert.ok(Math.abs(output.segmentBreakdown.perShare - segmentEquity / 1.145) < 0.5);
  // The gap between the segment cross-check and the published value is small and explainable.
  assert.ok(Math.abs(output.segmentBreakdown.perShare - output.weightedFairValue) / output.weightedFairValue < 0.15);
});

test("MU quality: cases are re-run models, not multipliers", () => {
  const output = build();
  const bear = output.cases.find((item) => item.name === "BEAR");
  const base = output.cases.find((item) => item.name === "BASE");
  const bull = output.cases.find((item) => item.name === "BULL");
  assert.ok(bear.value < base.value && base.value < bull.value);
  assert.equal(base.value, output.weightedFairValue);
  assert.match(bear.assumptions, /HBM volume growth/i);
  assert.match(bull.assumptions, /capital intensity/i);
});

/* ------------------------------------------------------------------ */
/* Sanity and reverse solve                                            */
/* ------------------------------------------------------------------ */

test("MU quality: a low implied P/E must be justified or rejected", () => {
  const output = build();
  assert.equal(output.sanity.status, "passed");
  assert.equal(output.sanity.flags.length, 0);
  assert.ok(output.sanity.fairValueOverEps27 > 6, "the published value must not imply a distressed multiple");
  assert.ok(output.sanity.lowMultipleJustification.length >= 3);
  assert.ok(output.sanity.lowMultipleJustification.some((reason) => /peak-cycle/i.test(reason)));
  assert.ok(output.sanity.lowMultipleJustification.some((reason) => /ceiling prices/i.test(reason)));

  // Force the anomaly: capitalising peak earnings at a distressed multiple has
  // to be caught instead of published.
  const distressed = build({ valuation: { ...mu.MU_VALUATION_ASSUMPTIONS, forwardPe: 1, normalizedPe: 1, evEbitdaMultiple: 1, revenueMultiple: 0.2 } });
  assert.equal(distressed.sanity.status, "VALUATION_MULTIPLE_ANOMALY");
  assert.ok(distressed.sanity.flags.length > 0);
  assert.equal(distressed.qualityGates.sanity, false);
  assert.equal(distressed.qualityGates.publishable, false);
  assert.equal(distressed.buyZone, null, "a rejected valuation must not publish a buy zone");
});

test("MU quality: the reverse solve states what the market price requires", () => {
  const output = build();
  assert.ok(output.marketImplied.requiredTerminalGrossMargin !== null);
  assert.ok(
    output.marketImplied.requiredTerminalGrossMargin > output.legacy.terminalMargin,
    "a price above fair value must require a higher normalised margin",
  );
  assert.ok(output.marketImplied.requiredRevenueB2030 > output.forecast.at(-1).revenueB);
  assert.ok(output.marketImplied.explanation.some((line) => /super-cycle would have to be permanent/i.test(line)));
  assert.equal(output.marketImplied.peOnForwardEps27 !== null, true);
  // No analyst target is invented when no consensus feed is configured.
  assert.equal(output.consensus.available, false);
  assert.match(output.consensus.note, /no licensed consensus|neither copies/i);
});

test("MU quality: the homepage snapshot and the valuation page must publish one number", async () => {
  const workstation = await readFile(new URL("../app/fair-value/workstation.tsx", import.meta.url), "utf8");
  assert.match(workstation, /HBM, legacy DRAM and NAND modelled separately/);
  assert.match(workstation, /mu\.forecast\.map/);
  assert.match(workstation, /mu\.segmentBreakdown\.segments\.map/);
  assert.match(workstation, /Why the implied P\/E is justified/);
  assert.match(workstation, /Model triangulation: SOTP primary, DCF and forward multiples as cross-checks/);
  assert.match(workstation, /Market-implied expectations: what the current price requires/);
});

test("MU quality: the buy zone is expected-return based, not a percentage of fair value", () => {
  const output = build();
  assert.ok(output.buyZone, "a publishable model must carry a buy zone");
  assert.ok(output.buyZone.buyPrice < output.weightedFairValue);
  assert.ok(output.buyZone.strongBuyPrice < output.buyZone.buyPrice);
  const years = output.buyZone.holdingPeriodYears;
  assert.ok(Math.abs(output.buyZone.expectedFutureValue - output.weightedFairValue * (1 + output.buyZone.expectedValueCagr) ** years) < 1);
  assert.ok(Math.abs(output.buyZone.buyPrice - output.buyZone.expectedFutureValue / (1 + output.buyZone.requiredReturn) ** years) < 1);
  assert.ok(Math.abs(output.buyZone.strongBuyPrice - output.buyZone.expectedFutureValue / (1 + output.buyZone.strongBuyRequiredReturn) ** years) < 1);
  // The growth input is the model's own mature-year revenue growth.
  const rows = output.forecast;
  assert.ok(Math.abs(output.buyZone.expectedValueCagr - (rows.at(-1).revenueB / rows.at(-2).revenueB - 1)) < 0.0002);
  assert.match(output.buyZone.method, /expected-return based/i);
});
