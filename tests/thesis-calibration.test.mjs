import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const compile = async (path) => "data:text/javascript;base64," + Buffer.from(ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64");
const engine = await import(await compile("../lib/thesis-calibration.ts"));
const { BASELINE, EVIDENCE, illustrativeCase } = await import(await compile("../dev/thesis-demo/data.ts"));
const { calculateCase, calculateHorizon, reverseHorizonUnits, researchContext, redactValuationClaims, validateProposal, validDate } = engine;
const close = (a, b, epsilon = 1e-8) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

test("disclosed revenue and capital bridges reconcile, while option values remain unknown", () => {
  close(BASELINE.businesses.slice(0, 3).reduce((s, b) => s + b.baseAnnualRevenueB / 4, 0), 28.236);
  close(BASELINE.netCashB, 15.219 + 28.305 - 9.080 - .281 - .661);
  const output = calculateCase(BASELINE);
  assert.equal(output.valid, true); assert.equal(output.complete, false);
  assert.deepEqual(output.missingBusinesses, ["FSD 增量订阅与授权", "Robotaxi 增量平台", "Optimus 对外销售"]);
  assert.equal(output.rows.find((r) => r.id === "robotaxi").expectedEvPvB, null);
  assert.ok(output.modeledPerShareUsd > 0);
});

test("success probability and committed/failure capital are counted exactly once", () => {
  const scenario = illustrativeCase();
  const output = calculateCase(scenario);
  assert.equal(output.complete, true); assert.equal(output.valid, true);
  for (const row of output.rows) {
    const b = scenario.businesses.find((b) => b.id === row.id);
    close(row.expectedEvPvB, row.successEvPvB * b.successProbability - b.investmentPvB - (1 - b.successProbability) * b.failureCostPvB);
  }
  close(output.modeledEquityB, output.rows.reduce((s, r) => s + r.expectedEvPvB, 0) + scenario.netCashB - scenario.operatingCashReserveB);
  close(output.modeledPerShareUsd, output.modeledEquityB / (scenario.sharesB * (1 + scenario.additionalDilution)));
});

test("Robotaxi bookings use the platform capture rate, not gross bookings as company sales", () => {
  const scenario = illustrativeCase();
  const row = calculateCase(scenario).rows.find((r) => r.id === "robotaxi");
  close(row.forecast.at(-1).revenueB, 5 * 75000 / 1000 * .30);
});

test("cash-flow conversion subtracts tax, capex and working capital; a stub period is not a whole year", () => {
  const output = calculateCase(illustrativeCase());
  const row = output.rows.find((r) => r.id === "automotive").forecast[0];
  close(row.fcffB, (row.ebitB - row.taxB + row.depreciationB - row.capexB) * row.fraction - row.workingCapitalB);
  assert.ok(row.fraction > .24 && row.fraction < .26);
  assert.ok(row.fcffB < row.ebitdaB * row.fraction);
});

test("future conditional value consumes remaining cash flows and rolls capital once", () => {
  const scenario = illustrativeCase();
  const current = calculateCase(scenario), future = calculateHorizon(scenario, "2027-09-30");
  assert.equal(future.valid, true); assert.equal(future.complete, true);
  close(future.initialInvestmentB, scenario.businesses.reduce((s, b) => s + b.investmentPvB + (1 - b.successProbability) * b.failureCostPvB, 0));
  close(future.capitalBridgeB, current.capitalBridgeB - future.initialInvestmentB + future.earnedFcffB);
  close(future.equityB, future.rows.reduce((s, r) => s + r.futureEvB, 0) + future.capitalBridgeB);
  close(future.perShareUsd, future.equityB / current.dilutedSharesB);
  assert.notEqual(future.perShareUsd, current.modeledPerShareUsd * 1.08);
  assert.ok(future.fundingGapB > 0);
});

test("future-date validation prevents comparison to past dates or dates beyond terminal horizon", () => {
  for (const target of ["2026-01-01", "2035-12-31", "2040-01-01", "2027-02-30"]) assert.equal(calculateHorizon(illustrativeCase(), target).valid, false);
  assert.equal(validDate("2027-02-30"), false);
});

test("reverse target reproduces the requested conditional value without mutating inputs", () => {
  const scenario = illustrativeCase(), before = JSON.stringify(scenario);
  const required = reverseHorizonUnits(scenario, "robotaxi", "2027-09-30", 500);
  assert.equal(required.ready, true); assert.ok(required.requiredUnitsM > 0);
  const altered = structuredClone(scenario); altered.businesses.find((b) => b.id === "robotaxi").unitsM = required.requiredUnitsM;
  close(calculateHorizon(altered, "2027-09-30").perShareUsd, 500, 1e-5);
  assert.equal(JSON.stringify(scenario), before);
  assert.equal(reverseHorizonUnits(BASELINE, "robotaxi", "2027-09-30", 500).ready, false);
});

test("target prices never enter the operating calculator or researcher whitelist", () => {
  const scenario = illustrativeCase(), before = calculateCase(scenario);
  scenario.targetPrice = 500; scenario.fairValue = 900; scenario.marketPrice = 400;
  assert.deepEqual(calculateCase(scenario), before);
  const context = researchContext(scenario, "我认为目标价500美元。Robotaxi 应重点看活跃车队和单位经济。", [], EVIDENCE);
  assert.ok(!JSON.stringify(context).includes("targetPrice")); assert.ok(!JSON.stringify(context).includes("fairValue"));
  assert.ok(!context.thesis.includes("500")); assert.ok(context.thesis.includes("Robotaxi"));
  assert.ok(redactValuationClaims("Robotaxi 成熟规模500万辆。需要验证付费运营。").includes("500万辆"));
});

test("only confirmed, scoped and unexpired feedback is reused", () => {
  const rules = [{ scope: "TSLA", text: "不要用全公司收入代替 Robotaxi 单位经济。", expiresAt: "2027-09-30" },
    { scope: "TSLA", text: "已过期研究规则", expiresAt: "2026-09-01" }, { scope: "NVDA", text: "其他公司规则", expiresAt: "2027-09-30" }];
  const context = researchContext(BASELINE, "关注商业化与融资", rules, EVIDENCE);
  assert.equal(context.confirmedMethodology.length, 1);
});

test("double-counting confirmation, negative economics and invalid probability prevent misleading totals", () => {
  const scenario = illustrativeCase();
  scenario.businesses.find((b) => b.id === "robotaxi").incrementalOnly = false;
  assert.equal(calculateCase(scenario).valid, false); assert.equal(calculateCase(scenario).modeledPerShareUsd, null);
  scenario.businesses.find((b) => b.id === "robotaxi").incrementalOnly = true;
  scenario.businesses.find((b) => b.id === "robotaxi").successProbability = 1.1;
  assert.equal(calculateCase(scenario).valid, false);
  scenario.businesses.find((b) => b.id === "robotaxi").successProbability = 0;
  const row = calculateCase(scenario).rows.find((r) => r.id === "robotaxi");
  close(row.expectedEvPvB, -70); // Committed 60B + 10B failure cost; never floored at zero.
});

test("unknown differs from explicitly excluded; invalid structures fail without producing output", () => {
  const scenario = structuredClone(BASELINE);
  for (const b of scenario.businesses.slice(3)) { b.status = "excluded"; b.rationale = "测试明确排除"; }
  assert.equal(calculateCase(scenario).complete, true);
  assert.equal(calculateCase(scenario).rows.find((r) => r.id === "fsd").expectedEvPvB, 0);
  scenario.businesses.push(scenario.businesses[0]);
  assert.equal(calculateCase(scenario).valid, false);
});

test("review rejects invented evidence and fields outside the operating whitelist", () => {
  const proposal = { summary: "验证 Robotaxi", methodology: [], disagreements: [], focus: [{ businessId: "robotaxi", belief: "运营规模重要",
    direction: "investigate", fields: ["unitsM"], evidenceIds: ["tsla-ai-business"], question: "运营车队多大？", falsification: "许可与单位经济不成立" }] };
  const ids = new Set(EVIDENCE.map((e) => e.id));
  assert.deepEqual(validateProposal(proposal, ids), []);
  proposal.focus[0].fields = ["targetPrice"];
  assert.ok(validateProposal(proposal, ids).length);
  proposal.focus[0].fields = ["unitsM"]; proposal.focus[0].evidenceIds = ["made-up"];
  assert.ok(validateProposal(proposal, ids).length);
});

test("delayed commercialization, capital costs and dilution reduce value with other assumptions unchanged", () => {
  const original = illustrativeCase();
  const now = calculateHorizon(original, "2027-09-30").perShareUsd;
  const delay = structuredClone(original); delay.businesses.filter((b) => b.driver === "units").forEach((b) => b.launchYear += 2);
  assert.ok(calculateHorizon(delay, "2027-09-30").perShareUsd < now);
  const investment = structuredClone(original); investment.businesses.find((b) => b.id === "robotaxi").investmentPvB += 10;
  close(calculateHorizon(investment, "2027-09-30").perShareUsd, now - 10 / calculateCase(original).dilutedSharesB);
  const dilution = structuredClone(original); dilution.additionalDilution += .10;
  assert.ok(calculateHorizon(dilution, "2027-09-30").perShareUsd < now);
});
