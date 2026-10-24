import type { BusinessCase, CalibrationCase } from "../../lib/thesis-calibration";

export const SOURCE_URL = "https://www.sec.gov/Archives/edgar/data/1318605/000162828026049270/tsla-20260630.htm";
export const EVIDENCE_VERSION = "TSLA-10Q-20260630-000162828026049270";
export const EVIDENCE = [
  { id: "tsla-q2-revenue", label: "Q2 2026 收入 · 申报事实", detail: "三个月截至 2026-06-30：汽车 20.516、能源 3.139、服务及其他 4.581，合计 28.236 USD B。汽车收入包括现有软件收入，三条收入线互不重叠。", locator: "Consolidated Statements of Operations, revenue rows" },
  { id: "tsla-q2-capital", label: "现金与债权 · 申报事实", detail: "现金 15.219、短期投资 28.305、债务本金 9.080、融资租赁 0.281、少数股东及可赎回少数权益 0.661 USD B。净桥接 33.502 USD B；经营现金保留另设假设。", locator: "Balance sheet; Note 8 Debt; noncontrolling interests" },
  { id: "tsla-july-shares", label: "2026-07-16 股本 · 申报事实", detail: "已发行普通股 3,949,547,394 股，包含已发行的条件性限制股。不是 Q2 加权平均 EPS 股数；未另加同一笔 CEO 股权奖励。新增稀释独立建模。", locator: "Form 10-Q cover; common stock and stock-based compensation notes" },
  { id: "tsla-ai-business", label: "AI 业务存在 · 公司叙述", detail: "公司讨论 FSD (Supervised)、Robotaxi 与 Optimus 商业化。叙述没有证明未来独立付费用户、车队规模、机器人销量、利润率或成功概率；当前确认的 FSD 收入不能再全额重复计入。", locator: "Management's Discussion and Analysis, Overview and Key Trends" },
  { id: "tsla-h1-cash", label: "H1 2026 现金流 · 申报事实", detail: "六个月经营现金流 8.634、购置固定资产支出 8.282 USD B。不能把半年数当作单季；EBITDA 不等于自由现金流。", locator: "Consolidated Statements of Cash Flows, six months ended June 30" },
];

const base = (id: BusinessCase["id"], name: string): BusinessCase => ({
  id, name, status: "unmodeled", driver: "units", baseAnnualRevenueB: null, growth: null,
  unitsM: null, annualRevenuePerUnitUsd: null, captureRate: null, launchYear: null, rampYears: null,
  ebitdaMargin: null, depreciationRate: null, maintenanceCapexRate: null, workingCapitalRate: null,
  taxRate: null, discountRate: null, terminalMultiple: null, successProbability: null,
  investmentPvB: null, failureCostPvB: null, incrementalOnly: false,
  rationale: "", falsification: "", provenance: "demo_assumption",
});

// Growth / margins / terminal multiples reuse the existing TSLA screen. The
// FCFF conversion rates and reserve below are explicit demo assumptions, not
// company disclosures, consensus, or a reproduced $70 published run.
export const BASELINE: CalibrationCase = {
  version: 1, ticker: "TSLA", valuationDate: "2026-09-30", revenueAnchorDate: "2026-06-30", maturityDate: "2030-12-31",
  sharesB: 3.949547394, additionalDilution: 0.015, netCashB: 33.502, operatingCashReserveB: 10,
  businesses: [
    { ...base("automotive", "汽车与现有软件"), status: "included", driver: "growth", baseAnnualRevenueB: 20.516 * 4,
      growth: 0.08, ebitdaMargin: 0.12, depreciationRate: 0.04, maintenanceCapexRate: 0.045, workingCapitalRate: 0.03,
      taxRate: 0.21, discountRate: 0.12, terminalMultiple: 12, successProbability: 1, investmentPvB: 0, failureCostPvB: 0,
      incrementalOnly: true, provenance: "legacy_assumption",
      rationale: "沿用现有 TSLA 研究中 8% 增长、12% EBITDA 利润率、12× 终值、12% 折现率。Q2×4 仅是年化代理。折旧、税、持续 CapEx、营运资本和额外投资零值是本地演示假设。",
      falsification: "交付和售价持续下降，或制造成本与新车型投入无法支持 12% EBITDA 利润率。" },
    { ...base("energy", "能源与储能"), status: "included", driver: "growth", baseAnnualRevenueB: 3.139 * 4,
      growth: 0.20, ebitdaMargin: 0.14, depreciationRate: 0.03, maintenanceCapexRate: 0.045, workingCapitalRate: 0.05,
      taxRate: 0.21, discountRate: 0.13, terminalMultiple: 14, successProbability: 1, investmentPvB: 0, failureCostPvB: 0,
      incrementalOnly: true, provenance: "legacy_assumption",
      rationale: "沿用 20% 增长、14% EBITDA 利润率、14× 终值、13% 折现率。其余 FCFF 转换参数为演示假设。储能部署量与收入不能简单等同。",
      falsification: "新增部署无法转化为收入，或价格与保修成本压低长期利润和现金流。" },
    { ...base("services", "充电、服务与其他"), status: "included", driver: "growth", baseAnnualRevenueB: 4.581 * 4,
      growth: 0.12, ebitdaMargin: 0.10, depreciationRate: 0.025, maintenanceCapexRate: 0.035, workingCapitalRate: 0.02,
      taxRate: 0.21, discountRate: 0.12, terminalMultiple: 9, successProbability: 1, investmentPvB: 0, failureCostPvB: 0,
      incrementalOnly: true, provenance: "legacy_assumption",
      rationale: "沿用 12% 增长、10% EBITDA 利润率、9× 终值、12% 折现率。其余 FCFF 转换参数为演示假设；服务收入与汽车收入仅计一次。",
      falsification: "充电利用率、人工和维修支出导致服务业务现金转换低于假设。" },
    base("fsd", "FSD 增量订阅与授权"), base("robotaxi", "Robotaxi 增量平台"), base("optimus", "Optimus 对外销售"),
  ],
};

/** Illustrative operating case. Never fitted to a target or treated as the owner's approved view. */
export function illustrativeCase(): CalibrationCase {
  const scenario = structuredClone(BASELINE);
  scenario.maturityDate = "2035-12-31";
  scenario.additionalDilution = 0.10;
  const seeds = {
    fsd: { unitsM: 30, annualRevenuePerUnitUsd: 1600, captureRate: 1, launchYear: 2027, rampYears: 8,
      ebitdaMargin: 0.65, depreciationRate: 0.02, maintenanceCapexRate: 0.04, workingCapitalRate: 0.01,
      discountRate: 0.13, terminalMultiple: 30, successProbability: 0.70, investmentPvB: 10, failureCostPvB: 3,
      rationale: "演示：30M 个独立增量付费授权 × 每年 $1,600。排除已在汽车计入的软件和 Robotaxi 平台内部授权。不是已签约用户或管理层指引。",
      falsification: "独立授权采用低于预期，客户流失或法规要求使软件单位经济无法成立。" },
    robotaxi: { unitsM: 5, annualRevenuePerUnitUsd: 75000, captureRate: 0.30, launchYear: 2027, rampYears: 8,
      ebitdaMargin: 0.35, depreciationRate: 0.04, maintenanceCapexRate: 0.08, workingCapitalRate: 0.02,
      discountRate: 0.15, terminalMultiple: 30, successProbability: 0.55, investmentPvB: 60, failureCostPvB: 10,
      rationale: "演示：第三方运营平台 5M 辆活跃车 × 每年 $75,000 订单额 × 30% 平台获取率。第三方承担车辆购置；平台基础设施投资另计。不计与 FSD 业务重复的软件收费。",
      falsification: "城市许可、每车运营订单额、平台获取率或保险和远程运营成本无法达到商业化要求。" },
    optimus: { unitsM: 10, annualRevenuePerUnitUsd: 20000, captureRate: 1, launchYear: 2028, rampYears: 8,
      ebitdaMargin: 0.20, depreciationRate: 0.04, maintenanceCapexRate: 0.07, workingCapitalRate: 0.05,
      discountRate: 0.17, terminalMultiple: 25, successProbability: 0.35, investmentPvB: 20, failureCostPvB: 5,
      rationale: "演示：成熟年对外销售 10M 台 × 每台 $20,000。内部使用不计对外收入，也不重复增加汽车业务的自动化收益。",
      falsification: "无法取得付费外部订单，或制造、维护与安全成本使对外销售利润率不成立。" },
  };
  scenario.businesses = scenario.businesses.map((b) => b.id in seeds ? { ...b,
    ...seeds[b.id as keyof typeof seeds], status: "included", taxRate: 0.21, incrementalOnly: true,
    provenance: "demo_assumption" } : b);
  return scenario;
}
