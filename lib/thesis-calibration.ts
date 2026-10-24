/** Local research calibration. Pure calculations; no target-price input, network,
 * storage, or production side effects. USD billions except unit prices and shares. */
export const CALIBRATION_VERSION = "thesis-calibration-2026-09-30.1";
export const BUSINESS_IDS = ["automotive", "energy", "services", "fsd", "robotaxi", "optimus"] as const;
export type BusinessId = typeof BUSINESS_IDS[number];
export type BusinessCase = {
  id: BusinessId; name: string;
  status: "included" | "unmodeled" | "excluded";
  driver: "growth" | "units";
  baseAnnualRevenueB: number | null;
  growth: number | null;
  unitsM: number | null;
  annualRevenuePerUnitUsd: number | null;
  captureRate: number | null;
  launchYear: number | null;
  rampYears: number | null;
  ebitdaMargin: number | null;
  depreciationRate: number | null;
  maintenanceCapexRate: number | null;
  workingCapitalRate: number | null;
  taxRate: number | null;
  discountRate: number | null;
  terminalMultiple: number | null;
  successProbability: number | null;
  investmentPvB: number | null;
  failureCostPvB: number | null;
  incrementalOnly: boolean;
  rationale: string;
  falsification: string;
  provenance: "legacy_assumption" | "demo_assumption" | "owner_assumption";
};
export type CalibrationCase = {
  version: 1; ticker: "TSLA";
  valuationDate: string; revenueAnchorDate: string; maturityDate: string;
  sharesB: number; additionalDilution: number;
  netCashB: number; operatingCashReserveB: number;
  businesses: BusinessCase[];
};
export type ForecastRow = {
  year: number; date: string; fraction: number; revenueB: number;
  ebitdaB: number; ebitB: number; taxB: number; depreciationB: number;
  capexB: number; workingCapitalB: number; fcffB: number; pvFcffB: number;
};
export type BusinessResult = {
  id: BusinessId; name: string; status: BusinessCase["status"];
  ready: boolean; issues: string[]; forecast: ForecastRow[];
  terminalEvB: number | null; successEvPvB: number | null;
  probability: number | null; investmentPvB: number | null; failureCostPvB: number | null;
  expectedEvPvB: number | null; perShareUsd: number | null;
};
export type CalibrationResult = {
  complete: boolean; valid: boolean; issues: string[]; missingBusinesses: string[];
  rows: BusinessResult[]; dilutedSharesB: number | null;
  capitalBridgeB: number | null; modeledEquityB: number | null;
  modeledPerShareUsd: number | null; method: "fcff_with_terminal_ebitda";
};

const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
const years = (start: string, end: string) => (time(end) - time(start)) / (365.25 * 86400000);

export function validateCase(input: CalibrationCase): string[] {
  const problems: string[] = [];
  if (input?.version !== 1 || input.ticker !== "TSLA") return ["Unsupported case version or ticker."];
  if (!validDate(input.valuationDate) || !validDate(input.revenueAnchorDate) || !validDate(input.maturityDate))
    problems.push("估值日、收入锚定日和终值日必须是有效日期。");
  else if (years(input.valuationDate, input.maturityDate) < 1 || years(input.valuationDate, input.maturityDate) > 20 ||
    time(input.revenueAnchorDate) > time(input.valuationDate)) problems.push("终值日须在估值日之后 1–20 年；收入锚定日不能在未来。");
  if (!finite(input.sharesB, 0.001, 100) || !finite(input.additionalDilution, 0, 2)) problems.push("股本与新增稀释输入无效。");
  if (!finite(input.netCashB, -10000, 10000) || !finite(input.operatingCashReserveB, 0, 10000)) problems.push("资本桥输入无效。");
  if (!Array.isArray(input.businesses) || input.businesses.length !== BUSINESS_IDS.length ||
    BUSINESS_IDS.some((id) => input.businesses.filter((b) => b?.id === id).length !== 1)) problems.push("六项业务必须分别且仅出现一次。");
  else if (input.businesses.some((b) => typeof b.name !== "string" || typeof b.rationale !== "string" ||
    typeof b.falsification !== "string" || typeof b.incrementalOnly !== "boolean" ||
    !["legacy_assumption", "demo_assumption", "owner_assumption"].includes(b.provenance))) problems.push("业务说明或假设来源结构无效。");
  return problems;
}

export function evaluateBusiness(input: CalibrationCase, business: BusinessCase): BusinessResult {
  const output: BusinessResult = { id: business.id, name: business.name, status: business.status,
    ready: false, issues: [], forecast: [], terminalEvB: null, successEvPvB: null, probability: null,
    investmentPvB: null, failureCostPvB: null, expectedEvPvB: null, perShareUsd: null };
  if (!["included", "unmodeled", "excluded"].includes(business.status)) { output.issues.push("业务状态无效。"); return output; }
  if (business.status === "unmodeled") { output.issues.push("未建模：缺少可检验的经营假设，价值未知。"); return output; }
  if (business.status === "excluded") {
    if (!business.rationale.trim()) { output.issues.push("明确排除业务需要记录理由。"); return output; }
    return { ...output, ready: true, expectedEvPvB: 0, perShareUsd: 0 };
  }
  const fields: Array<[keyof BusinessCase, number, number, string]> = [
    ["ebitdaMargin", -1, 0.95, "EBITDA 利润率"], ["depreciationRate", 0, 1, "折旧占收入"],
    ["maintenanceCapexRate", 0, 2, "持续 CapEx 占收入"], ["workingCapitalRate", 0, 1, "新增营运资本率"],
    ["taxRate", 0, 0.6, "税率"], ["discountRate", 0.01, 0.6, "折现率"],
    ["terminalMultiple", 0.1, 150, "终值 EV/EBITDA"], ["successProbability", 0, 1, "成功概率"],
    ["investmentPvB", 0, 10000, "额外建设资金现值"], ["failureCostPvB", 0, 10000, "失败额外损失现值"],
  ];
  for (const [field, min, max, label] of fields) if (!finite(business[field], min, max)) output.issues.push(`请填写有效的${label}。`);
  if (business.driver === "growth") {
    if (!finite(business.baseAnnualRevenueB, 0, 10000) || !finite(business.growth, -0.95, 2)) output.issues.push("基准年收入或增长率无效。");
  } else if (business.driver === "units") {
    if (!finite(business.unitsM, 0, 10000) || !finite(business.annualRevenuePerUnitUsd, 0.01, 1e7) ||
      !finite(business.captureRate, 0.001, 1)) output.issues.push("成熟期规模、单单位年收入或收入获取比例缺失。");
    const firstYear = Number(input.valuationDate.slice(0, 4));
    if (!Number.isInteger(business.launchYear) || !finite(business.launchYear, firstYear, firstYear + 20) ||
      !Number.isInteger(business.rampYears) || !finite(business.rampYears, 1, 15)) output.issues.push("商业化年份和爬坡年数无效。");
    if (business.launchYear! > Number(input.maturityDate.slice(0, 4))) output.issues.push("商业化开始在终值日之后；请延长预测期。");
    if (!business.incrementalOnly) output.issues.push("需要确认仅计独立增量业务，避免与汽车、FSD、Robotaxi 重复计算。");
  } else output.issues.push("收入驱动类型无效。");
  if (!business.rationale.trim()) output.issues.push("请记录经营假设的理由。");
  if (!business.falsification.trim()) output.issues.push("请记录可观察的反证条件。");
  if (output.issues.length || validateCase(input).length) return output;

  const revenueAt = (date: string) => business.driver === "growth"
    ? business.baseAnnualRevenueB! * (1 + business.growth!) ** years(input.revenueAnchorDate, date)
    : business.unitsM! * business.annualRevenuePerUnitUsd! / 1000 * business.captureRate!
      * Math.max(0, Math.min(1, (Number(date.slice(0, 4)) - business.launchYear! + 1) / business.rampYears!));
  const dates: string[] = [];
  for (let year = Number(input.valuationDate.slice(0, 4)); year <= Number(input.maturityDate.slice(0, 4)); year++) {
    const end = `${year}-12-31`;
    if (time(end) > time(input.valuationDate)) dates.push(time(end) <= time(input.maturityDate) ? end : input.maturityDate);
  }
  if (dates.at(-1) !== input.maturityDate) dates.push(input.maturityDate);
  let previousDate = input.valuationDate;
  let previousRevenue = business.driver === "units" ? 0 : revenueAt(input.valuationDate);
  for (const date of [...new Set(dates)]) {
    const fraction = years(previousDate, date);
    const revenueB = revenueAt(date);
    const ebitdaB = revenueB * business.ebitdaMargin!;
    const depreciationB = revenueB * business.depreciationRate!;
    const ebitB = ebitdaB - depreciationB;
    // No credit for hypothetical tax losses. EBITDA is never equated to FCFF.
    const taxB = Math.max(0, ebitB) * business.taxRate!;
    const capexB = revenueB * business.maintenanceCapexRate!;
    const workingCapitalB = (revenueB - previousRevenue) * business.workingCapitalRate!;
    const fcffB = (ebitB - taxB + depreciationB - capexB) * fraction - workingCapitalB;
    output.forecast.push({ year: Number(date.slice(0, 4)), date, fraction, revenueB, ebitdaB, ebitB, taxB,
      depreciationB, capexB, workingCapitalB, fcffB, pvFcffB: fcffB / (1 + business.discountRate!) ** years(input.valuationDate, date) });
    previousDate = date; previousRevenue = revenueB;
  }
  const terminalEvB = output.forecast.at(-1)!.ebitdaB * business.terminalMultiple!;
  if (terminalEvB <= 0) { output.issues.push("终值 EBITDA 不为正，EV/EBITDA 方法不适用；需要其他终值方法。"); return output; }
  const successEvPvB = output.forecast.reduce((sum, row) => sum + row.pvFcffB, 0)
    + terminalEvB / (1 + business.discountRate!) ** years(input.valuationDate, input.maturityDate);
  // Committed setup cost is incurred in both success and failure states; the
  // failure-only cost is separate. Probability is applied once, not as a discount premium.
  const expectedEvPvB = business.successProbability! * successEvPvB - business.investmentPvB!
    - (1 - business.successProbability!) * business.failureCostPvB!;
  const dilutedSharesB = input.sharesB * (1 + input.additionalDilution);
  if (![successEvPvB, expectedEvPvB, dilutedSharesB, ...output.forecast.map((r) => r.fcffB)].every(Number.isFinite)) {
    output.issues.push("计算超出有效数值范围。"); return output;
  }
  return { ...output, ready: true, terminalEvB, successEvPvB, probability: business.successProbability,
    investmentPvB: business.investmentPvB, failureCostPvB: business.failureCostPvB,
    expectedEvPvB, perShareUsd: expectedEvPvB / dilutedSharesB };
}

export function calculateCase(input: CalibrationCase): CalibrationResult {
  const issues = validateCase(input);
  const empty: CalibrationResult = { complete: false, valid: false, issues, missingBusinesses: [], rows: [],
    dilutedSharesB: null, capitalBridgeB: null, modeledEquityB: null, modeledPerShareUsd: null, method: "fcff_with_terminal_ebitda" };
  if (issues.length) return empty;
  const rows = input.businesses.map((b) => evaluateBusiness(input, b));
  const invalid = rows.filter((row) => !row.ready && row.status !== "unmodeled");
  const missingBusinesses = rows.filter((row) => !row.ready).map((row) => row.name);
  const dilutedSharesB = input.sharesB * (1 + input.additionalDilution);
  const capitalBridgeB = input.netCashB - input.operatingCashReserveB;
  const modeledEquityB = rows.reduce((sum, row) => sum + (row.expectedEvPvB ?? 0), 0) + capitalBridgeB;
  return { ...empty, rows, valid: invalid.length === 0,
    complete: missingBusinesses.length === 0, missingBusinesses, dilutedSharesB, capitalBridgeB,
    issues: invalid.flatMap((row) => row.issues.map((issue) => `${row.name}：${issue}`)),
    modeledEquityB: invalid.length ? null : modeledEquityB,
    modeledPerShareUsd: invalid.length ? null : modeledEquityB / dilutedSharesB };
}

/** A separate diagnostic; it does not alter the case or feed the researcher. */
export function reverseUnits(input: CalibrationCase, id: BusinessId, targetPerShareUsd: number) {
  const result = calculateCase(input);
  const business = input.businesses.find((b) => b.id === id);
  if (!finite(targetPerShareUsd, 0.01, 100000) || !result.complete || !result.valid || !business || business.driver !== "units" || business.status !== "included")
    return { ready: false, requiredUnitsM: null, message: "先完成六项业务（或明确排除），再做条件反推。" };
  const zero = evaluateBusiness(input, { ...business, unitsM: 0.000001 });
  const one = evaluateBusiness(input, { ...business, unitsM: 1.000001 });
  if (!zero.ready || !one.ready) return { ready: false, requiredUnitsM: null, message: "该业务缺少可计算的单位经济。" };
  const slope = one.expectedEvPvB! - zero.expectedEvPvB!;
  if (slope <= 0) return { ready: false, requiredUnitsM: null, message: "当前单位经济不增加价值，提高规模不能支持该价格。" };
  const otherValueB = result.modeledEquityB! - result.rows.find((r) => r.id === id)!.expectedEvPvB!;
  const intercept = zero.expectedEvPvB! - slope * 0.000001;
  const requiredUnitsM = Math.max(0, (targetPerShareUsd * result.dilutedSharesB! - otherValueB - intercept) / slope);
  return { ready: true, requiredUnitsM, message: requiredUnitsM === 0
    ? "其余业务已覆盖该比较值；无需额外规模。" : "只改变该项规模、其余假设固定的条件要求；它不是预测或自动修改。" };
}

export function compareCases(baseline: CalibrationCase, view: CalibrationCase) {
  const before = calculateCase(baseline), after = calculateCase(view);
  const rows = BUSINESS_IDS.map((id) => {
    const b = before.rows.find((r) => r.id === id), a = after.rows.find((r) => r.id === id);
    return { id, name: a?.name ?? b?.name ?? id, before: b?.perShareUsd ?? null, after: a?.perShareUsd ?? null,
      delta: b?.perShareUsd != null && a?.perShareUsd != null ? a.perShareUsd - b.perShareUsd : null };
  });
  const capitalBefore = before.capitalBridgeB != null && before.dilutedSharesB ? before.capitalBridgeB / before.dilutedSharesB : null;
  const capitalAfter = after.capitalBridgeB != null && after.dilutedSharesB ? after.capitalBridgeB / after.dilutedSharesB : null;
  return { before, after, rows, capitalBefore, capitalAfter };
}

export type HorizonResult = { valid: boolean; complete: boolean; targetDate: string;
  perShareUsd: number | null; equityB: number | null; capitalBridgeB: number | null;
  earnedFcffB: number | null; initialInvestmentB: number | null; fundingGapB: number | null;
  rows: Array<{ id: BusinessId; futureEvB: number | null; earnedFcffB: number | null; perShareUsd: number | null }> };

/** Conditional value at a future date under unchanged operating hypotheses.
 * FCFF accrues uniformly within each forecast interval and is retained as cash.
 * Setup investment and expected failure cost are modeled as current cash outlays;
 * no dividend, cash yield, new financing or information update is assumed. */
export function calculateHorizon(input: CalibrationCase, targetDate: string): HorizonResult {
  const current = calculateCase(input);
  const blank: HorizonResult = { valid: false, complete: false, targetDate, perShareUsd: null, equityB: null,
    capitalBridgeB: null, earnedFcffB: null, initialInvestmentB: null, fundingGapB: null, rows: [] };
  if (!current.valid || !validDate(targetDate) || time(targetDate) <= time(input.valuationDate) ||
    time(targetDate) >= time(input.maturityDate)) return blank;
  let initialInvestmentB = 0, earnedFcffB = 0;
  const rows = input.businesses.map((business) => {
    const result = current.rows.find((row) => row.id === business.id)!;
    if (!result.ready) return { id: business.id, futureEvB: null, earnedFcffB: null, perShareUsd: null };
    if (business.status === "excluded") return { id: business.id, futureEvB: 0, earnedFcffB: 0, perShareUsd: 0 };
    let priorDate = input.valuationDate, earned = 0, remainingPv = 0;
    for (const row of result.forecast) {
      const ratio = Math.min(1, Math.max(0, (time(targetDate) - time(priorDate)) / (time(row.date) - time(priorDate))));
      earned += row.fcffB * ratio;
      if (ratio < 1) remainingPv += row.fcffB * (1 - ratio) / (1 + business.discountRate!) ** years(targetDate, row.date);
      priorDate = row.date;
    }
    remainingPv += result.terminalEvB! / (1 + business.discountRate!) ** years(targetDate, input.maturityDate);
    const futureEvB = remainingPv * business.successProbability!;
    const expectedEarned = earned * business.successProbability!;
    initialInvestmentB += business.investmentPvB! + (1 - business.successProbability!) * business.failureCostPvB!;
    earnedFcffB += expectedEarned;
    return { id: business.id, futureEvB, earnedFcffB: expectedEarned, perShareUsd: futureEvB / current.dilutedSharesB! };
  });
  const capitalBridgeB = current.capitalBridgeB! - initialInvestmentB + earnedFcffB;
  const equityB = rows.reduce((sum, row) => sum + (row.futureEvB ?? 0), 0) + capitalBridgeB;
  return { valid: true, complete: current.complete, targetDate, rows, equityB, capitalBridgeB,
    earnedFcffB, initialInvestmentB, fundingGapB: Math.max(0, initialInvestmentB - current.capitalBridgeB!),
    perShareUsd: equityB / current.dilutedSharesB! };
}

export function reverseHorizonUnits(input: CalibrationCase, id: BusinessId, targetDate: string, targetPerShareUsd: number) {
  const current = calculateCase(input), horizon = calculateHorizon(input, targetDate);
  const business = input.businesses.find((b) => b.id === id);
  const fail = (message: string) => ({ ready: false, requiredUnitsM: null, message });
  if (!finite(targetPerShareUsd, 0.01, 100000) || !current.complete || !horizon.valid || !business ||
    business.driver !== "units" || business.status !== "included") return fail("先完成六项业务（或明确排除），再做 12 个月条件反推。");
  const withUnits = (unitsM: number) => ({ ...input, businesses: input.businesses.map((b) => b.id === id ? { ...b, unitsM } : b) });
  const zero = calculateHorizon(withUnits(0.000001), targetDate), one = calculateHorizon(withUnits(1.000001), targetDate);
  if (!zero.valid || !one.valid) return fail("该业务缺少可计算的单位经济。");
  const slope = one.equityB! - zero.equityB!;
  if (slope <= 0) return fail("当前单位经济不增加价值，提高规模不能支持该目标。");
  const requiredUnitsM = Math.max(0, (targetPerShareUsd * current.dilutedSharesB! - zero.equityB!) / slope + 0.000001);
  return { ready: true, requiredUnitsM, message: "只改变该项成熟期规模、其余假设固定；这是支持目标所需的条件，不是规模预测。" };
}

export type FeedbackRule = { id: string; scope: "TSLA"; text: string; expiresAt: string; createdAt: string };
export type ThesisProposal = {
  summary: string; focus: Array<{ businessId: BusinessId; belief: string; direction: "increase" | "decrease" | "investigate";
    fields: string[]; evidenceIds: string[]; question: string; falsification: string }>;
  methodology: string[]; disagreements: string[];
};
export const ALLOWED_FIELDS = ["growth", "unitsM", "annualRevenuePerUnitUsd", "captureRate", "launchYear", "rampYears", "ebitdaMargin",
  "depreciationRate", "maintenanceCapexRate", "workingCapitalRate", "taxRate", "discountRate", "terminalMultiple",
  "successProbability", "investmentPvB", "failureCostPvB"] as const;

/** Price-bearing clauses are removed before the business researcher is called.
 * Quantities such as 500万辆 are retained. The target is a separate UI field. */
export function redactValuationClaims(text: string) {
  return text.split(/(?<=[。！？!?\n;；])/u).filter((clause) =>
    !/(?:目标价|公允价值|估值|值|股价|目标价格|fair\s*value|target\s*price|worth|price\s*target)[^。！？\n]*\d|\$\s*\d|\d[\d,.]*\s*(?:美元|美金|usd)(?:\s*\/\s*股)?/i.test(clause))
    .join(" ").trim();
}

/** Build a whitelist projection: saved prices, computed values, ratings, and
 * untrusted extra JSON fields never enter the research request. */
export function researchContext(input: CalibrationCase, thesis: string, rules: FeedbackRule[], evidence: Array<{ id: string; label: string; detail: string }>) {
  const now = input.valuationDate;
  return { ticker: input.ticker, valuationDate: now, maturityDate: input.maturityDate,
    thesis: redactValuationClaims(thesis),
    confirmedMethodology: rules.filter((r) => r.scope === input.ticker && validDate(r.expiresAt) && r.expiresAt >= now)
      .map((r) => ({ text: redactValuationClaims(r.text), expiresAt: r.expiresAt })),
    evidence: evidence.map((e) => ({ id: e.id, label: e.label, detail: e.detail })),
    operatingAssumptions: input.businesses.map((b) => ({ id: b.id, name: b.name, status: b.status, driver: b.driver,
      ...Object.fromEntries(ALLOWED_FIELDS.map((key) => [key, b[key]])), incrementalOnly: b.incrementalOnly })) };
}

export function validateProposal(value: ThesisProposal, validEvidenceIds: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  if (!value || typeof value.summary !== "string" || value.summary.length > 3000 || !Array.isArray(value.focus) || value.focus.length > 12 ||
    !Array.isArray(value.methodology) || !Array.isArray(value.disagreements)) return ["AI 观点结构无效。"]; 
  for (const f of value.focus) {
    if (!BUSINESS_IDS.includes(f.businessId) || !["increase", "decrease", "investigate"].includes(f.direction) ||
      !Array.isArray(f.fields) || f.fields.some((field) => !(ALLOWED_FIELDS as readonly string[]).includes(field)) ||
      !Array.isArray(f.evidenceIds) || f.evidenceIds.some((id) => !validEvidenceIds.has(id)) ||
      [f.belief, f.question, f.falsification].some((text) => typeof text !== "string" || text.length > 3000)) issues.push("AI 返回了越界字段或未经登记的证据。");
  }
  if ([...value.methodology, ...value.disagreements].some((s) => typeof s !== "string" || s.length > 3000)) issues.push("AI 研究说明无效。");
  return issues;
}
