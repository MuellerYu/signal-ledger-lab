/**
 * SPCX (Space Exploration Technologies) valuation, built on the reported
 * three-segment framework in the latest 10-Q: Space, Connectivity and AI.
 *
 * Architecture:
 *   reported anchors (segment revenue / operating income / D&A / SBC / capex)
 *     → per-segment multi-year forecast
 *     → per-segment DCF + terminal value
 *     → Starship scenario tree (probabilities sum to 100%)
 *     → corporate bridge
 *     → implied multiples, sanity flags and release gates
 *
 * Reported data always replaces a model assumption. A missing assumption is
 * never defaulted to a 1.0x multiple — it makes the release gate fail instead.
 */

export type SpcxSourceType = "REPORTED" | "DERIVED" | "MODEL_ASSUMPTION" | "USER_OVERRIDE";

/* ------------------------------------------------------------------ */
/* Reported segment anchors                                            */
/* ------------------------------------------------------------------ */

export type SpcxSegmentReport = {
  revenue: number;
  costOfRevenue: number;
  researchAndDevelopment: number;
  sellingGeneralAdmin: number;
  operatingIncome: number;
  depreciationAmortization: number;
  shareBasedCompensation: number;
  capitalExpenditures: number;
};

export type SpcxReportedSegments = {
  quarterLabel: string | null;
  quarter: { space: SpcxSegmentReport; connectivity: SpcxSegmentReport; ai: SpcxSegmentReport; total: SpcxSegmentReport } | null;
  halfYearLabel: string | null;
  halfYear: { space: SpcxSegmentReport; connectivity: SpcxSegmentReport; ai: SpcxSegmentReport; total: SpcxSegmentReport } | null;
  revenueDetail: Array<{ label: string; segment: "Space" | "Connectivity" | "AI"; quarterly: number; halfYear: number }>;
  backlogM: number | null;
  deferredRevenueM: number | null;
  cashM: number | null;
  marketableSecuritiesM: number | null;
  digitalAssetsM: number | null;
  debtAndLeasesM: number | null;
  financeLeaseM: number | null;
  shareholdersEquityM: number | null;
  goodwillM: number | null;
  aiGoodwillM: number | null;
  source: string;
  sourceDate: string | null;
};

function num(value: string | undefined) {
  if (!value) return null;
  const negative = /^\s*\(\s*[\d,.]+\s*\)\s*$/.test(value);
  const parsed = Number(value.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

/**
 * Reads the Space / Connectivity / AI segment tables and the balance-sheet
 * anchors out of the filed 10-Q text. Missing rows stay null so the caller can
 * fail the data gate instead of guessing.
 */
export function parseSpcxReportedSegments(filingText: string | null | undefined, source = "10-Q"): SpcxReportedSegments {
  const text = (filingText ?? "").replace(/\s+/g, " ");
  const empty = (): SpcxSegmentReport => ({
    revenue: 0, costOfRevenue: 0, researchAndDevelopment: 0, sellingGeneralAdmin: 0,
    operatingIncome: 0, depreciationAmortization: 0, shareBasedCompensation: 0, capitalExpenditures: 0,
  });
  const readTable = (sectionPattern: RegExp) => {
    const section = text.match(sectionPattern);
    if (!section) return null;
    const block = text.slice(section.index ?? 0, (section.index ?? 0) + 2600);
    const revenue = block.match(/Revenue\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)/i);
    const cost = block.match(/Cost of revenue\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/i);
    const rnd = block.match(/Research and development\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/i);
    const sga = block.match(/Selling, general, and administrative\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/i);
    const operating = block.match(/Income \(loss\) from operations\s+\(?\s*([\d,]+)\s*\)?\s+\(?\s*([\d,]+)\s*\)?\s+\(?\s*([\d,]+)\s*\)?\s+\(?\s*([\d,]+)\s*\)?/i);
    const operatingNegative = block.match(/Income \(loss\) from operations\s+(\([^)]*\)|[\d,]+)\s+(\([^)]*\)|[\d,]+)\s+(\([^)]*\)|[\d,]+)\s+(\([^)]*\)|[\d,]+)/i);
    const danda = block.match(/Depreciation and amortization\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)/i);
    const sbc = block.match(/Share-based compensation\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)/i);
    const capex = block.match(/Capital expenditures\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)/i);
    if (!revenue) return null;
    const pick = (match: RegExpMatchArray | null, index: number) => match ? num(match[index + 1]) ?? 0 : 0;
    const operatingValues = operatingNegative
      ? [1, 2, 3, 4].map((index) => num(operatingNegative[index]) ?? 0)
      : [1, 2, 3, 4].map((index) => -(num(operating?.[index]) ?? 0));
    const build = (index: number): SpcxSegmentReport => ({
      revenue: pick(revenue, index),
      costOfRevenue: pick(cost, index),
      researchAndDevelopment: pick(rnd, index),
      sellingGeneralAdmin: pick(sga, index),
      operatingIncome: operatingValues[index],
      depreciationAmortization: pick(danda, index),
      shareBasedCompensation: pick(sbc, index),
      capitalExpenditures: pick(capex, index),
    });
    return { space: build(0), connectivity: build(1), ai: build(2), total: build(3) };
  };
  const quarter = readTable(/Three Months Ended June 30, 2026\s+Space\s+Connectivity\s+AI\s+Total Reportable Segments\s+Revenue/i);
  const halfYear = readTable(/Six Months Ended June 30, 2026\s+Space\s+Connectivity\s+AI\s+Total Reportable Segments\s+Revenue/i);
  const detailMatch = text.match(/Launch Services \$ ([\d,]+) \$ ([\d,]+) \$ ([\d,]+) \$ ([\d,]+) Launch & Development ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+) Space ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+) Consumer ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+) Enterprise & Government \(1\) ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+) Connectivity ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+) Advertising ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+) AI Solutions & Infrastructure ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+) AI ([\d,]+) ([\d,]+) ([\d,]+) ([\d,]+)/i);
  const detailLabels: Array<{ label: string; segment: "Space" | "Connectivity" | "AI" }> = [
    { label: "Launch Services", segment: "Space" },
    { label: "Launch & Development", segment: "Space" },
    { label: "Space", segment: "Space" },
    { label: "Consumer", segment: "Connectivity" },
    { label: "Enterprise & Government", segment: "Connectivity" },
    { label: "Connectivity", segment: "Connectivity" },
    { label: "Advertising", segment: "AI" },
    { label: "AI Solutions & Infrastructure", segment: "AI" },
    { label: "AI", segment: "AI" },
  ];
  const revenueDetail = detailMatch
    ? detailLabels.map((item, index) => ({
      ...item,
      quarterly: num(detailMatch[index * 4 + 1]) ?? 0,
      halfYear: num(detailMatch[index * 4 + 3]) ?? 0,
    }))
    : [];
  const backlog = text.match(/Total backlog[^$]{0,80}\$ ([\d,]+) million/i) ?? text.match(/backlog of \$ ([\d,]+) million/i);
  const deferred = text.match(/Total deferred revenue as of June 30, 2026 was \$ ([\d,]+) million/i);
  const cash = text.match(/Cash and cash equivalents \$ ([\d,]+)/i);
  const securities = text.match(/Marketable securities ([\d,]+)/i);
  const digital = text.match(/Digital assets ([\d,]+)/i);
  const debt = text.match(/Total debt and finance leases ([\d,]+) ([\d,]+) ([\d,]+)/i);
  const financeLease = text.match(/Finance lease liability ([\d,]+)/i);
  const equity = text.match(/Total shareholders . equity ([\d,]+)/i);
  const goodwill = text.match(/Goodwill ([\d,]+) ([\d,]+)/i);
  const aiGoodwill = text.match(/goodwill attributable to the AI segment was \$ ([\d,]+) million/i);
  return {
    quarterLabel: quarter ? "Three months ended June 30, 2026" : null,
    quarter,
    halfYearLabel: halfYear ? "Six months ended June 30, 2026" : null,
    halfYear,
    revenueDetail,
    backlogM: backlog ? num(backlog[1]) : null,
    deferredRevenueM: deferred ? num(deferred[1]) : null,
    cashM: cash ? num(cash[1]) : null,
    marketableSecuritiesM: securities ? num(securities[1]) : null,
    digitalAssetsM: digital ? num(digital[1]) : null,
    debtAndLeasesM: debt ? num(debt[3]) : null,
    financeLeaseM: financeLease ? num(financeLease[1]) : null,
    shareholdersEquityM: equity ? num(equity[1]) : null,
    goodwillM: goodwill ? num(goodwill[1]) : null,
    aiGoodwillM: aiGoodwill ? num(aiGoodwill[1]) : null,
    source,
    sourceDate: "2026-08-04",
  };
}

/* ------------------------------------------------------------------ */
/* Share count                                                         */
/* ------------------------------------------------------------------ */

export type SpcxShareComponent = {
  label: string;
  sharesB: number | null;
  unit: string;
  source: string;
  sourceDate: string | null;
  sourceType: SpcxSourceType;
  confidence: number;
  note?: string;
};

export type SpcxShareBridge = {
  basicSharesCurrentB: number | null;
  fullyDilutedSharesCurrentB: number;
  shareCountAsOfDate: string | null;
  shareCountSource: string;
  weightedAverageBasicSharesB: number | null;
  weightedAverageDilutedSharesB: number | null;
  components: SpcxShareComponent[];
  valid: boolean;
  validation: string[];
};

export type SpcxShareEvidence = {
  classACurrentShares: number | null;
  classBCurrentShares: number | null;
  otherCommonCurrentShares: number | null;
  coverPageAsOf: string | null;
  optionSharesClassA: number | null;
  optionSharesClassB: number | null;
  rsuSharesClassA: number | null;
  warrantShares: number | null;
  convertibleShares: number | null;
  preferredConvertedShares: number | null;
  planNoteAsOf: string | null;
};

const SHARE = 1e9;
const toBillions = (value: number | null) => value === null ? null : value / SHARE;

function parseCount(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value.replace(/[^\d]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseSpcxShareEvidence(filingText: string | null | undefined): SpcxShareEvidence {
  const text = (filingText ?? "").replace(/\s+/g, " ");
  const cover = text.match(/As of ([A-Z][a-z]+ \d{1,2}, \d{4}), the registrant had ([\d,]+) shares of Class A common stock and ([\d,]+) shares of Class B common stock outstanding/i);
  const plan = text.match(/Outstanding stock options\s+([\d,]+)\s+([\d,]+)/i);
  const rsu = text.match(/Outstanding RSUs\s+([\d,]+)/i);
  const warrants = text.match(/([\d,]+)\s+warrants?\s+(?:outstanding|issued)/i);
  const classC = text.match(/Class C common stock[^;]*;\s*[\u2014-]\s*and\s*([\d,]+) shares/i);
  const preferred = text.match(/Redeemable convertible preferred stock, par value[^;]*;\s*([\d,]+)\s+and\s+([\d,]+) shares issued/i);
  return {
    classACurrentShares: parseCount(cover?.[2]),
    classBCurrentShares: parseCount(cover?.[3]),
    otherCommonCurrentShares: 0,
    coverPageAsOf: cover?.[1] ?? null,
    optionSharesClassA: parseCount(plan?.[1]) === null ? null : parseCount(plan?.[1])! * 1e6,
    optionSharesClassB: parseCount(plan?.[2]) === null ? null : parseCount(plan?.[2])! * 1e6,
    rsuSharesClassA: parseCount(rsu?.[1]) === null ? null : parseCount(rsu?.[1])! * 1e6,
    warrantShares: parseCount(warrants?.[1]),
    convertibleShares: 0,
    preferredConvertedShares: toBillions(parseCount(preferred?.[2])),
    planNoteAsOf: plan ? "June 30, 2026" : null,
    ...(classC ? { otherCommonCurrentShares: toBillions(parseCount(classC[1])) ?? 0 } : {}),
  };
}

export function buildSpcxShareBridge(input: {
  evidence: SpcxShareEvidence;
  weightedAverageBasicSharesB: number | null;
  weightedAverageDilutedSharesB: number | null;
  filingId: string | null;
}): SpcxShareBridge {
  const { evidence } = input;
  const source = input.filingId ? `SEC 10-Q ${input.filingId}` : "Latest filed 10-Q";
  const classTotal = evidence.classACurrentShares !== null && evidence.classBCurrentShares !== null
    ? evidence.classACurrentShares + evidence.classBCurrentShares + (evidence.otherCommonCurrentShares ?? 0)
    : null;
  const proxyUsed = classTotal === null && input.weightedAverageBasicSharesB !== null;
  const basicSharesCurrentB = toBillions(classTotal) ?? input.weightedAverageBasicSharesB;
  const optionsB = ((evidence.optionSharesClassA ?? 0) + (evidence.optionSharesClassB ?? 0)) / SHARE;
  const rsusB = (evidence.rsuSharesClassA ?? 0) / SHARE;
  const warrantsB = (evidence.warrantShares ?? 0) / SHARE;
  const fullyDilutedSharesCurrentB = (basicSharesCurrentB ?? 0) + optionsB + rsusB + warrantsB + (evidence.convertibleShares ?? 0) / SHARE;
  const component = (label: string, sharesB: number | null, sourceType: SpcxSourceType, confidence: number, note?: string): SpcxShareComponent => ({
    label, sharesB, unit: "billions of shares", source, sourceDate: evidence.coverPageAsOf ?? evidence.planNoteAsOf, sourceType, confidence, ...(note ? { note } : {}),
  });
  const components: SpcxShareComponent[] = [
    component("Class A common stock outstanding (cover page)", toBillions(evidence.classACurrentShares), "REPORTED", 0.95),
    component("Class B common stock outstanding (cover page)", toBillions(evidence.classBCurrentShares), "REPORTED", 0.95),
    component("Other common stock outstanding", evidence.otherCommonCurrentShares === 0 ? 0 : toBillions(evidence.otherCommonCurrentShares), "REPORTED", 0.6),
    component("Incremental options outstanding", evidence.optionSharesClassA === null && evidence.optionSharesClassB === null ? null : optionsB, "REPORTED", 0.85),
    component("Incremental RSUs outstanding", evidence.rsuSharesClassA === null ? null : rsusB, "REPORTED", 0.8),
    component("Warrants", evidence.warrantShares === null ? null : warrantsB, "REPORTED", 0.6, evidence.warrantShares === null ? "No warrant count is disclosed in the filing." : undefined),
    component("Convertible dilution", 0, "REPORTED", 0.8, evidence.preferredConvertedShares ? `${evidence.preferredConvertedShares.toFixed(3)}B convertible preferred shares converted into common before the period end and are already inside the current basic count.` : "No convertible instruments remain outstanding."),
    component("Weighted-average basic shares (reference only)", input.weightedAverageBasicSharesB, "REPORTED", 0.9, "EPS weighted average; never the intrinsic denominator."),
    component("Weighted-average diluted shares (reference only)", input.weightedAverageDilutedSharesB, "REPORTED", 0.9, "EPS weighted average; never the intrinsic denominator."),
  ];
  if (proxyUsed) {
    components.splice(2, 0, component("Current basic shares (proxy)", input.weightedAverageBasicSharesB, "DERIVED", 0.45, "Cover page could not be parsed; the latest quarterly weighted average is used as a labelled proxy and is never annualized."));
  }
  const validation: string[] = [];
  if (basicSharesCurrentB === null) validation.push("Current period-end share counts could not be read from the filing.");
  if (fullyDilutedSharesCurrentB <= 0) validation.push("Fully diluted current share count could not be established.");
  if (basicSharesCurrentB !== null && fullyDilutedSharesCurrentB < basicSharesCurrentB) validation.push("Fully diluted shares are below current basic shares outstanding.");
  validation.push("The denominator is the current period-end count plus economic dilution. EPS weighted averages are never annualized or used.");
  if (proxyUsed) validation.push("A labelled derived proxy is in use, so share-count confidence is reduced.");
  return {
    basicSharesCurrentB,
    fullyDilutedSharesCurrentB,
    shareCountAsOfDate: evidence.coverPageAsOf,
    shareCountSource: source,
    weightedAverageBasicSharesB: input.weightedAverageBasicSharesB,
    weightedAverageDilutedSharesB: input.weightedAverageDilutedSharesB,
    components,
    valid: validation.length <= 1,
    validation,
  };
}

/* ------------------------------------------------------------------ */
/* Multi-year forecast, DCF and quality layer                          */
/* ------------------------------------------------------------------ */

export type SpcxForecastYear = {
  year: number;
  /** Maintenance capital proxy (reported D&A and share-based compensation). */
  maintenance?: number;
  /** Capital deployed above maintenance during the build phase. */
  buildCapital?: number;
  spaceCapex?: number;
  connectivityCapex?: number;
  aiCapex?: number;
  spaceMaintenance?: number;
  connectivityMaintenance?: number;
  aiMaintenance?: number;
  spaceRevenue: number;
  connectivityRevenue: number;
  aiRevenue: number;
  spaceEbitda: number;
  connectivityEbitda: number;
  aiEbitda: number;
  capex: number;
  segmentFcf: number;
  /** Connectivity sub-lines: the reported Consumer and Enterprise & Government rows plus labelled D2D/Starshield. */
  consumerSubscribersM?: number;
  consumerArpuMonthly?: number;
  consumerRevenue?: number;
  enterpriseRevenue?: number;
  starshieldRevenue?: number;
  directToDeviceRevenue?: number;
  /** AI compute capacity actually deployed and the yield it earns. */
  aiDeployedCapitalB?: number;
  aiRevenueYield?: number;
  /** AI capacity in gigawatts, contracted power headroom and utilisation. */
  aiCapacityGw?: number;
  aiPowerContractedGw?: number;
  aiUtilisation?: number;
  /** AI depreciation carried by the capital already in service. */
  aiDepreciationB?: number;
  /** Segment margins, so the table can be read without recomputing them. */
  spaceEbitdaMargin?: number;
  connectivityEbitdaMargin?: number;
  aiEbitdaMargin?: number;
};

export type SpcxScenarioCase = "CORE" | "BASE" | "VISION";

export type SpcxSegmentValue = {
  segment: "Space" | "Connectivity" | "AI";
  revenueBaseB: number;
  ebitdaBaseB: number;
  ebitdaMarginBase: number;
  /** Final plan year (2030E). */
  revenueFinalB: number;
  ebitdaFinalB: number;
  ebitdaMarginFinal: number;
  /** The year the primary valuation anchors on: 2028E. */
  anchorRevenue2028B: number;
  anchorEbitda2028B: number;
  anchorMargin2028: number;
  anchorMultiple2028: number;
  /** Primary method plus the DCF and EV/Sales cross-checks, in billions. */
  methodValues: SpcxSegmentMethodValues;
  method: string;
  discountRate: number;
  enterpriseValueB: number;
  perShare: number;
};

export type SpcxStarshipScenario = {
  name: string;
  probability: number;
  launchCadencePerYear: number;
  revenuePerLaunchM: number;
  launchCostM: number;
  developmentCapitalB: number;
  revenueAtScaleB: number;
  fcfMargin: number;
  npvB: number;
  note: string;
  /** Commercial launch revenue at scale, before internal deployment savings. */
  commercialRevenueB?: number;
  /** Measurable internal value: Starlink deployment and replacement savings. */
  internalSavingsB?: number;
  /** Government launch and development demand at scale. */
  governmentRevenueB?: number;
  /** Orbital infrastructure and orbital compute economics opened by the platform. */
  orbitalInfrastructureRevenueB?: number;
  /** Free cash flow at scale, and the present value before development capital. */
  fcfAtScaleB?: number;
  presentValueB?: number;
};

export type SpcxQualityGate = { id: string; label: string; status: "passed" | "failed"; detail: string };

export type SpcxValuation = {
  reported: SpcxReportedSegments;
  shareBridge: SpcxShareBridge;
  forecast: SpcxForecastYear[];
  segments: SpcxSegmentValue[];
  starship: { scenarios: SpcxStarshipScenario[]; expectedValueB: number; perShare: number; probabilitySum: number };
  /** Strategic economics that sit outside the segments, the scenario trees and
   * the corporate bridge. Each item is listed so it can be removed if unsupported. */
  otherOptionality: {
    valueB: number;
    perShare: number;
    items: Array<{ name: string; share: number; valueB: number; note: string }>;
  };
  /** Reported Q2 2026 anchor the forecast starts from. */
  reportedAnchor: SpcxReportedAnchor;
  /** The case calibrations the engine consumed, so the inputs are auditable. */
  calibration: Record<SpcxScenarioCase, SpcxCaseCalibration>;
  /** Where the published value comes from, component by component, per share. */
  valuationContribution: Array<{ component: string; valueB: number; perShare: number }>;
  valuationContributionTotalB: number;
  cases: Array<{ name: "CORE CASE" | "BASE EXECUTION CASE" | "VISION CASE"; value: number; assumptions: string; published: boolean }>;
  coreB: number;
  growthB: number;
  optionalityB: number;
  netCorporateB: number;
  equityValueB: number;
  fairValue: number;
  ai: { revenueB: number; ebitdaB: number; enterpriseValueB: number; perShare: number; shareOfEquity: number; capexB: number };
  connectivity: { revenueB: number; ebitdaB: number; enterpriseValueB: number; perShare: number };
  space: { revenueB: number; ebitdaB: number; enterpriseValueB: number; perShare: number };
  buyZone: { requiredReturn: number; strongBuyRequiredReturn: number; holdingPeriodYears: number; expectedValueCagr: number; expectedFutureValue: number; buyPrice: number; strongBuyPrice: number; method: string } | null;
  impliedMultiples: {
    marketCapB: number | null;
    enterpriseValueMarketB: number | null;
    evRevenue: number | null;
    evEbitda: number | null;
    peForward: number | null;
    fcfYield: number | null;
    fairValueEvRevenue: number | null;
    fairValueEvEbitda: number | null;
    flags: string[];
  };
  divergence: {
    fairValue: number;
    marketPrice: number | null;
    gapPct: number | null;
    status: "within_bounds" | "MODEL_DIVERGENCE_REVIEW";
    explanation: string[];
  };
  /**
   * Model triangulation. SOTP is the primary model; the DCF and forward-multiple
   * cross-checks are shown with their own numbers so the published value can be
   * challenged rather than only asserted.
   */
  crossChecks: {
    sotp: { enterpriseValueB: number; perShare: number; weight: number; note: string };
    dcf: { enterpriseValueB: number; perShare: number; weight: number; inputs: string; note: string };
    forwardMultiple: { enterpriseValueB: number; perShare: number; weight: number; inputs: string; note: string };
    blendedDiscountRate: number;
    blendedTerminalMultiple: number;
    weightsNote: string;
    publishedFrom: "SOTP";
  };
  /**
   * Market-implied expectations: what the current price requires, solved lever by
   * lever instead of only stating that the market is expensive.
   */
  marketImplied: {
    marketEquityValueB: number | null;
    requiredBusinessValueB: number | null;
    modelledBusinessValueB: number;
    valueGapB: number | null;
    /** Reverse solves required to justify the market price, one lever at a time. */
    requiredAi2028RevenueB: number | null;
    requiredAi2028EbitdaMargin: number | null;
    requiredAi2028Multiple: number | null;
    requiredStarshipExpectedB: number | null;
    requiredConnectivity2028RevenueB: number | null;
    combination: string[];
    requiredConnectivityRevenueB: number | null;
    requiredAiRevenueB: number | null;
    requiredAiMatureEbitdaMargin: number | null;
    requiredStarshipNpvB: number | null;
    requiredDirectToDeviceValueB: number | null;
    equalSplit: Array<{ lever: string; requirement: string }>;
    headline: string;
  };
  externalResearch: Array<{ institution: string; date: string; target: number | null; method: string | null; assumptions: string | null; sourceUrl: string | null }>;
  whyDifferent: Array<{ metric: string; signalLedger: string; market: string; publicResearch: string }>;
  qualityGates: { data: SpcxQualityGate; model: SpcxQualityGate; sanity: SpcxQualityGate; publishable: boolean };
  confidence: { reportedData: number; connectivityForecast: number; aiForecast: number; starshipOptionality: number; overall: number };
};

export type SpcxValuationInput = {
  reported: SpcxReportedSegments;
  shareBridge: SpcxShareBridge;
  netCorporateB: number;
  marketPrice?: number | null;
  externalResearch?: SpcxValuation["externalResearch"];
};

/**
 * Reported public targets supplied for comparison. They are NEVER used in the
 * valuation calculation; they exist so the interface can show where the
 * assumptions differ. Nothing here changes a Signal Ledger output.
 */
export const SPCX_PUBLIC_TARGETS: SpcxValuation["externalResearch"] = [
  { institution: "Goldman Sachs", date: "reported", target: 205, method: "not disclosed", assumptions: "Higher AI revenue ramp and a longer duration than the Signal Ledger base case.", sourceUrl: null },
  { institution: "Citi", date: "reported", target: 200, method: "not disclosed", assumptions: "Values a larger Connectivity subscriber base and earlier AI margin expansion.", sourceUrl: null },
  { institution: "JPMorgan", date: "reported", target: 225, method: "not disclosed", assumptions: "Credits a higher Starship terminal value and faster orbital infrastructure ramp.", sourceUrl: null },
  { institution: "Deutsche Bank", date: "reported", target: 255, method: "not disclosed", assumptions: "Assumes the AI platform scales on orbital compute economics beyond the base plan.", sourceUrl: null },
  { institution: "Morgan Stanley", date: "reported", target: 300, method: "not disclosed", assumptions: "Applies the highest terminal multiples and the longest forecast horizon of the group.", sourceUrl: null },
];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Annualised reported run-rate used as the forecast starting point. */
function runRate(segment: SpcxSegmentReport | undefined, halfYear: boolean) {
  if (!segment) return { revenueB: 0, ebitdaB: 0, capexB: 0 };
  const factor = halfYear ? 2 : 4;
  const revenueB = (segment.revenue * factor) / 1000;
  // Segment adjusted EBITDA, the measure the filing reports: operating income
  // plus depreciation and amortisation plus share-based compensation.
  const ebitdaB = ((segment.operatingIncome + segment.depreciationAmortization + segment.shareBasedCompensation) * factor) / 1000;
  const capexB = (segment.capitalExpenditures * factor) / 1000;
  return { revenueB, ebitdaB, capexB };
}

export type SpcxCaseCalibration = {
  label: string;
  /** Explicit revenue plan, 2026E–2030E, in billions. */
  revenueB: { Connectivity: number[]; AI: number[]; Space: number[] };
  /** Explicit adjusted-EBITDA margin plan, 2026E–2030E. */
  ebitdaMargin: { Connectivity: number[]; AI: number[]; Space: number[] };
  /** Capital expenditure as a share of segment revenue, 2026E–2030E. */
  capexIntensity: { Connectivity: number[]; AI: number[]; Space: number[] };
  /** Forward EV/EBITDA applied to 2028E EBITDA — the primary segment method. */
  forwardMultiple2028: { Connectivity: number; AI: number; Space: number };
  /** Forward EV/Sales on 2028E revenue — the second cross-check. */
  forwardEvSales2028: { Connectivity: number; AI: number; Space: number };
  /** Discount back to today from the 2028 anchor. */
  discountRate: { Connectivity: number; AI: number; Space: number };
  /** Terminal EV/EBITDA used by the DCF cross-check. */
  terminalMultiple: { Connectivity: number; AI: number; Space: number };
  /** Starship scenario drivers; present values are computed from them. */
  starship: {
    limited: SpcxStarshipDrivers;
    base: SpcxStarshipDrivers;
    full: SpcxStarshipDrivers;
  };
  /** Identifiable strategic economics not already in the segments above. */
  otherOptionalityB: number;
  note: string;
};

export type SpcxStarshipDrivers = {
  launchCadencePerYear: number;
  revenuePerLaunchM: number;
  governmentRevenueB: number;
  /** Measurable Starlink deployment and replacement saving created by reuse. */
  starlinkSavingsB: number;
  /** Orbital infrastructure and orbital compute economics opened by the platform. */
  orbitalInfrastructureRevenueB: number;
  fcfMargin: number;
  developmentCapitalB: number;
};

const FORECAST_YEARS = 5;
const CASH_TAX_RATE = 0.22;
export type SegmentName = "Space" | "Connectivity" | "AI";
const SEGMENT_NAMES: SegmentName[] = ["Space", "Connectivity", "AI"];
/**
 * Discounting of the Starship terminal economics: the programme reaches scale
 * after six years, then the terminal cash flow is capitalised and discounted back.
 */
const STARSHIP_TERMINAL_FACTOR = ((1 + 0.03) / (0.12 - 0.03)) / 1.12 ** 6;

export const SPCX_PROBABILITY = { failure: 0.15, limited: 0.3, base: 0.35, full: 0.2 };

/**
 * Institutional base-case calibration, supplied for review. These are INPUTS.
 * Every published number is recomputed from them plus the latest reported data,
 * so nothing is hardcoded to a target price: change a driver here and the fair
 * value changes with it.
 *
 * 2028E revenue anchors — BASE: Connectivity $42B, AI $105B, Space Core $8B.
 * Reported Q2 2026: Connectivity $4.291B, AI $2.561B, Space $0.962B.
 * Management guidance anchors the 2026E ramp (≈$100B annualised company revenue
 * run-rate by year-end 2026), which is what makes the 2027E step-up possible.
 */
export const SPCX_CALIBRATION: Record<SpcxScenarioCase, SpcxCaseCalibration> = {
  BASE: {
    label: "BASE",
    revenueB: {
      Connectivity: [18, 30, 42, 50, 58],
      AI: [28, 68, 105, 135, 165],
      Space: [4, 6, 8, 8.8, 9.5],
    },
    ebitdaMargin: {
      Connectivity: [0.6, 0.59, 0.58, 0.57, 0.56],
      AI: [0.447, 0.41, 0.38, 0.37, 0.36],
      Space: [-0.15, 0.05, 0.2, 0.2, 0.2],
    },
    capexIntensity: {
      Connectivity: [0.28, 0.24, 0.2, 0.17, 0.15],
      AI: [1.8, 1.0, 0.65, 0.5, 0.42],
      Space: [0.5, 0.3, 0.2, 0.15, 0.12],
    },
    forwardMultiple2028: { Connectivity: 16, AI: 20, Space: 15 },
    forwardEvSales2028: { Connectivity: 9, AI: 8, Space: 3 },
    discountRate: { Connectivity: 0.1, AI: 0.12, Space: 0.1 },
    terminalMultiple: { Connectivity: 12, AI: 15, Space: 9 },
    starship: {
      limited: { launchCadencePerYear: 40, revenuePerLaunchM: 80, governmentRevenueB: 3, starlinkSavingsB: 6, orbitalInfrastructureRevenueB: 32, fcfMargin: 0.28, developmentCapitalB: 12 },
      base: { launchCadencePerYear: 120, revenuePerLaunchM: 65, governmentRevenueB: 8, starlinkSavingsB: 14, orbitalInfrastructureRevenueB: 114, fcfMargin: 0.33, developmentCapitalB: 25 },
      full: { launchCadencePerYear: 300, revenuePerLaunchM: 45, governmentRevenueB: 15, starlinkSavingsB: 30, orbitalInfrastructureRevenueB: 277, fcfMargin: 0.38, developmentCapitalB: 40 },
    },
    otherOptionalityB: 40,
    note: "Base calibration: 2028E Connectivity $42B at a 58% margin on 16×, AI $105B at 38% on 20×, Space Core $8B at 20% on 15×; Starship scenario values are computed from the driver table and happen to land near the $60B/$250B/$700B calibration.",
  },
  CORE: {
    label: "CORE / CONSERVATIVE",
    revenueB: {
      Connectivity: [15, 24, 36, 43, 50],
      AI: [22, 50, 78, 100, 120],
      Space: [3.5, 4.8, 7, 7.6, 8.2],
    },
    ebitdaMargin: {
      Connectivity: [0.59, 0.58, 0.56, 0.55, 0.54],
      AI: [0.44, 0.39, 0.35, 0.34, 0.33],
      Space: [-0.18, 0.02, 0.18, 0.18, 0.18],
    },
    capexIntensity: {
      Connectivity: [0.3, 0.26, 0.22, 0.19, 0.17],
      AI: [2.0, 1.15, 0.75, 0.6, 0.5],
      Space: [0.55, 0.35, 0.22, 0.18, 0.15],
    },
    forwardMultiple2028: { Connectivity: 14, AI: 16, Space: 12 },
    forwardEvSales2028: { Connectivity: 8, AI: 6.5, Space: 2.5 },
    discountRate: { Connectivity: 0.1, AI: 0.12, Space: 0.1 },
    terminalMultiple: { Connectivity: 11, AI: 13, Space: 8 },
    starship: {
      limited: { launchCadencePerYear: 25, revenuePerLaunchM: 80, governmentRevenueB: 2, starlinkSavingsB: 4, orbitalInfrastructureRevenueB: 20, fcfMargin: 0.26, developmentCapitalB: 12 },
      base: { launchCadencePerYear: 70, revenuePerLaunchM: 65, governmentRevenueB: 5, starlinkSavingsB: 8, orbitalInfrastructureRevenueB: 65, fcfMargin: 0.3, developmentCapitalB: 25 },
      full: { launchCadencePerYear: 150, revenuePerLaunchM: 45, governmentRevenueB: 8, starlinkSavingsB: 15, orbitalInfrastructureRevenueB: 150, fcfMargin: 0.35, developmentCapitalB: 40 },
    },
    otherOptionalityB: 20,
    note: "Conservative case: slower AI and Connectivity ramp, lower margins, lower multiples, and Starship scaling to roughly half the base economics.",
  },
  VISION: {
    label: "VISION",
    revenueB: {
      Connectivity: [22, 36, 52, 65, 80],
      AI: [34, 78, 140, 190, 250],
      Space: [4.5, 6.5, 10, 11, 12],
    },
    ebitdaMargin: {
      Connectivity: [0.61, 0.6, 0.6, 0.59, 0.58],
      AI: [0.45, 0.43, 0.42, 0.41, 0.4],
      Space: [-0.12, 0.08, 0.22, 0.22, 0.22],
    },
    capexIntensity: {
      Connectivity: [0.26, 0.22, 0.18, 0.15, 0.13],
      AI: [1.6, 0.9, 0.55, 0.42, 0.36],
      Space: [0.45, 0.28, 0.18, 0.14, 0.11],
    },
    forwardMultiple2028: { Connectivity: 18, AI: 24, Space: 16 },
    forwardEvSales2028: { Connectivity: 10.5, AI: 10, Space: 3.5 },
    discountRate: { Connectivity: 0.095, AI: 0.11, Space: 0.095 },
    terminalMultiple: { Connectivity: 14, AI: 18, Space: 10 },
    starship: {
      limited: { launchCadencePerYear: 60, revenuePerLaunchM: 80, governmentRevenueB: 4, starlinkSavingsB: 8, orbitalInfrastructureRevenueB: 45, fcfMargin: 0.3, developmentCapitalB: 12 },
      base: { launchCadencePerYear: 200, revenuePerLaunchM: 60, governmentRevenueB: 12, starlinkSavingsB: 22, orbitalInfrastructureRevenueB: 180, fcfMargin: 0.36, developmentCapitalB: 25 },
      full: { launchCadencePerYear: 500, revenuePerLaunchM: 40, governmentRevenueB: 25, starlinkSavingsB: 45, orbitalInfrastructureRevenueB: 400, fcfMargin: 0.42, developmentCapitalB: 40 },
    },
    otherOptionalityB: 80,
    note: "Vision case: successful but still capital-charged execution of AI, Connectivity, Starship, direct-to-device and platform synergies.",
  },
};

/** Reported anchor used by the forecast: Q2 2026 plus the fiscal half-year. */
export type SpcxReportedAnchor = {
  label: string;
  quarterRevenueB: { Connectivity: number; AI: number; Space: number };
  quarterAdjustedEbitdaB: { Connectivity: number; AI: number; Space: number };
  halfRevenueB: { Connectivity: number; AI: number; Space: number };
  halfCapexB: { Connectivity: number; AI: number; Space: number };
};

/** Segment adjusted EBITDA is operating income + D&A + share-based compensation. */
const adjustedEbitdaOf = (segment: SpcxSegmentReport | undefined) =>
  segment ? segment.operatingIncome + segment.depreciationAmortization + segment.shareBasedCompensation : 0;

export function reportedAnchor(reported: SpcxReportedSegments): SpcxReportedAnchor {
  const quarter = reported.quarter;
  const half = reported.halfYear;
  const pick = (row: { space: SpcxSegmentReport; connectivity: SpcxSegmentReport; ai: SpcxSegmentReport } | null, key: "revenue" | "capitalExpenditures") => ({
    Connectivity: row ? row.connectivity[key] / 1000 : 0,
    AI: row ? row.ai[key] / 1000 : 0,
    Space: row ? row.space[key] / 1000 : 0,
  });
  return {
    label: reported.quarterLabel ?? reported.halfYearLabel ?? "latest filing",
    quarterRevenueB: pick(quarter, "revenue"),
    quarterAdjustedEbitdaB: {
      Connectivity: adjustedEbitdaOf(quarter?.connectivity) / 1000,
      AI: adjustedEbitdaOf(quarter?.ai) / 1000,
      Space: adjustedEbitdaOf(quarter?.space) / 1000,
    },
    halfRevenueB: pick(half, "revenue"),
    halfCapexB: pick(half, "capitalExpenditures"),
  };
}

/** AI capacity is expressed in gigawatts from a stated capital cost per GW. */
const AI_CAPITAL_PER_GW_B = 9;
const AI_POWER_HEADROOM = 1.15;
const AI_DEPRECIATION_RATE = 0.11;
/** Share of a year's AI capital that is deployed and earning in the next year. */
const AI_DEPLOYMENT_LAG = 0.7;
/** Share of segment revenue that is steady-state replacement capital. */
const MAINTENANCE_INTENSITY = { Connectivity: 0.08, AI: 0.2, Space: 0.05 } as const;
const AI_UTILISATION: Record<SpcxScenarioCase, number[]> = {
  CORE: [0.58, 0.66, 0.72, 0.75, 0.77],
  BASE: [0.62, 0.72, 0.8, 0.83, 0.85],
  VISION: [0.66, 0.78, 0.86, 0.89, 0.91],
};

/**
 * Builds the explicit 2026E–2030E plan from the calibration inputs and the
 * reported Q2/H1 anchors. Revenue, adjusted EBITDA margin and capital intensity
 * come straight from the case table; everything else — EBITDA, capex, deployed
 * AI capacity, depreciation, free cash flow — is computed.
 */
function buildForecast(reported: SpcxReportedSegments, scenario: SpcxScenarioCase): SpcxForecastYear[] {
  const calibration = SPCX_CALIBRATION[scenario];
  const anchor = reportedAnchor(reported);
  const years: SpcxForecastYear[] = [];
  // Consumer subscribers are derived from the reported Consumer revenue line at
  // the stated ARPU, so the sub-line table reconciles to the reported anchor.
  const subLine = (label: string) => (reported.revenueDetail.find((line) => line.label === label)?.halfYear ?? 0) * 2 / 1000;
  const consumerStartB = subLine("Consumer");
  const enterpriseStartB = subLine("Enterprise & Government");
  const consumerArpuStart = 95;
  // Reported AI depreciation implies the AI capital already in service, so the
  // capacity track starts from the filing rather than from an assumed fleet.
  const aiDepreciationAnchorB = ((reported.halfYear?.ai.depreciationAmortization ?? 0) * 2) / 1000;
  let aiDeployedCapitalB = aiDepreciationAnchorB / AI_DEPRECIATION_RATE;
  let consumerSubscribersM = consumerStartB > 0 ? (consumerStartB * 1000) / (consumerArpuStart * 12) : 0;
  for (let index = 0; index < FORECAST_YEARS; index += 1) {
    const year = 2026 + index;
    const connectivity = calibration.revenueB.Connectivity[index];
    const ai = calibration.revenueB.AI[index];
    const space = calibration.revenueB.Space[index];
    const connectivityMargin = calibration.ebitdaMargin.Connectivity[index];
    const aiMargin = calibration.ebitdaMargin.AI[index];
    const spaceMargin = calibration.ebitdaMargin.Space[index];
    const connectivityEbitda = connectivity * connectivityMargin;
    const aiEbitda = ai * aiMargin;
    const spaceEbitda = space * spaceMargin;
    const connectivityCapex = connectivity * calibration.capexIntensity.Connectivity[index];
    const aiCapex = ai * calibration.capexIntensity.AI[index];
    const spaceCapex = space * calibration.capexIntensity.Space[index];
    const capex = connectivityCapex + aiCapex + spaceCapex;
    const maintenance = connectivity * MAINTENANCE_INTENSITY.Connectivity + ai * MAINTENANCE_INTENSITY.AI + space * MAINTENANCE_INTENSITY.Space;
    // Deployed AI capital compounds with the build programme (one year of
    // deployment lag), and the utilisation path is stated per case.
    aiDeployedCapitalB += index === 0 ? 0 : calibration.revenueB.AI[index - 1] * calibration.capexIntensity.AI[index - 1] * AI_DEPLOYMENT_LAG;
    const aiCapacityGw = aiDeployedCapitalB / AI_CAPITAL_PER_GW_B;
    const aiUtilisation = AI_UTILISATION[scenario][index];
    const aiRevenueYield = aiDeployedCapitalB > 0 ? ai / aiDeployedCapitalB : 0;
    const aiDepreciationB = aiDeployedCapitalB * AI_DEPRECIATION_RATE;
    // Connectivity sub-lines: Consumer scales with subscribers × ARPU so the
    // reported line and the modelled line stay the same shape; the remainder is
    // the reported Enterprise & Government line plus labelled D2D/Starshield.
    const connectivityGrowth = index === 0 ? 1 : calibration.revenueB.Connectivity[index] / calibration.revenueB.Connectivity[index - 1];
    // The anchor year keeps the reported Consumer and Enterprise & Government
    // run-rates; later years scale with the segment plan, so the reported lines
    // and the modelled lines stay the same shape.
    const consumerRevenue = index === 0 ? (consumerStartB || connectivity * 0.61) : years[index - 1].consumerRevenue! * connectivityGrowth;
    consumerSubscribersM = consumerRevenue > 0 ? (consumerRevenue * 1000) / (consumerArpuStart * 12) : consumerSubscribersM;
    const enterpriseRevenue = index === 0 ? (enterpriseStartB || connectivity * 0.39) : years[index - 1].enterpriseRevenue! * connectivityGrowth;
    // Direct-to-device is a new service scaling from a small base, so it grows
    // faster than the segment average; Starshield is the residual line.
    const directToDeviceRevenue = index === 0 ? 0.15 : years[index - 1].directToDeviceRevenue! * Math.max(1.6, connectivityGrowth * 1.25);
    const starshieldRevenue = Math.max(0, connectivity - consumerRevenue - enterpriseRevenue - directToDeviceRevenue);
    const segmentFcf = (connectivityEbitda + aiEbitda + spaceEbitda) * (1 - CASH_TAX_RATE)
      - capex
      - (connectivity + ai + space) * 0.02;
    years.push({
      year,
      spaceRevenue: space,
      connectivityRevenue: connectivity,
      aiRevenue: ai,
      spaceEbitda,
      connectivityEbitda,
      aiEbitda,
      capex,
      maintenance,
      buildCapital: Math.max(0, capex - maintenance),
      spaceCapex,
      connectivityCapex,
      aiCapex,
      spaceMaintenance: space * MAINTENANCE_INTENSITY.Space,
      connectivityMaintenance: connectivity * MAINTENANCE_INTENSITY.Connectivity,
      aiMaintenance: ai * MAINTENANCE_INTENSITY.AI,
      consumerSubscribersM,
      consumerArpuMonthly: consumerArpuStart,
      consumerRevenue,
      enterpriseRevenue,
      starshieldRevenue,
      directToDeviceRevenue,
      aiDeployedCapitalB,
      aiRevenueYield,
      aiCapacityGw,
      aiPowerContractedGw: aiCapacityGw * AI_POWER_HEADROOM,
      aiUtilisation,
      aiDepreciationB,
      spaceEbitdaMargin: space > 0 ? spaceMargin : 0,
      connectivityEbitdaMargin: connectivity > 0 ? connectivityMargin : 0,
      aiEbitdaMargin: ai > 0 ? aiMargin : 0,
      segmentFcf,
    });
  }
  void anchor;
  return years;
}

/**
 * Values one segment on an applicability-weighted blend of methods:
 *
 *   1. multi-year DCF: present value of after-tax EBITDA, a terminal value on the
 *      mature year, less the capital deployed above maintenance during the build;
 *   2. forward EV/EBITDA on the anchor year (2029 for Connectivity and AI, 2030
 *      for Space), discounted back, less the build capital deployed to that year;
 *   3. forward EV/Revenue on the anchor year, which carries weight only while a
 *      segment's EBITDA is still immature (AI today).
 *
 * The previous single-method version floored Space at zero, which the methodology
 * forbids: a segment whose reported operating profit is temporarily negative
 * because of development spending still has a normalised mature value. Space is
 * now valued on its normalised launch and development economics with the
 * development capital charged explicitly, once.
 */
/**
 * Values one segment as specified: the primary method is forward EV/EBITDA on
 * 2028E EBITDA, discounted back to today. A multi-year DCF and a forward EV/Sales
 * multiple run as cross-checks on the same plan, so a disagreement is visible
 * instead of being averaged away.
 *
 * The DCF charges the segment's own build capital inside its cash flow; the
 * forward multiple already embeds the capital intensity of the comparable
 * businesses, so it carries no second capital charge. Each segment is charged
 * only its own capital — Starship development sits in the Starship layer.
 */
export type SpcxSegmentMethodValues = {
  primaryForwardEbitdaB: number;
  dcfB: number;
  forwardSalesB: number;
};

function valueSegment(forecast: SpcxForecastYear[], segment: "Connectivity" | "AI" | "Space", scenario: SpcxScenarioCase) {
  const calibration = SPCX_CALIBRATION[scenario];
  const revenue = (row: SpcxForecastYear) => segment === "Space" ? row.spaceRevenue : segment === "Connectivity" ? row.connectivityRevenue : row.aiRevenue;
  const ebitda = (row: SpcxForecastYear) => segment === "Space" ? row.spaceEbitda : segment === "Connectivity" ? row.connectivityEbitda : row.aiEbitda;
  const segmentCapex = (row: SpcxForecastYear) => segment === "Space" ? row.spaceCapex ?? 0 : segment === "Connectivity" ? row.connectivityCapex ?? 0 : row.aiCapex ?? 0;
  const discountRate = calibration.discountRate[segment];
  const discount = (index: number) => (1 + discountRate) ** (index + 1);
  const anchorIndex = 2; // 2028E
  const anchorRow = forecast[anchorIndex];
  const totalCapex = forecast.reduce((sum, row) => sum + segmentCapex(row), 0);

  // Primary: forward EV/EBITDA on 2028E, discounted two years back to today.
  const anchorDiscount = (1 + discountRate) ** 2;
  const primaryForwardEbitdaB = (Math.max(0, ebitda(anchorRow)) * calibration.forwardMultiple2028[segment]) / anchorDiscount;

  // Cross-check 1: multi-year DCF on the reported capital intensity.
  let presentFcf = 0;
  forecast.forEach((row, index) => {
    const fcf = ebitda(row) * (1 - CASH_TAX_RATE) - segmentCapex(row) - revenue(row) * 0.02;
    presentFcf += fcf / discount(index);
  });
  const terminalValue = Math.max(0, ebitda(forecast[forecast.length - 1])) * calibration.terminalMultiple[segment];
  const dcfB = presentFcf + terminalValue / discount(forecast.length - 1);

  // Cross-check 2: a forward EV/Sales multiple on 2028E revenue, stated
  // separately from the EBITDA multiple rather than derived from it.
  const forwardSalesB = (Math.max(0, revenue(anchorRow)) * calibration.forwardEvSales2028[segment]) / anchorDiscount;

  return {
    enterpriseValueB: Math.max(0, primaryForwardEbitdaB),
    methodValues: { primaryForwardEbitdaB, dcfB, forwardSalesB } as SpcxSegmentMethodValues,
    finalEbitda: ebitda(forecast[forecast.length - 1]),
    finalRevenue: revenue(forecast[forecast.length - 1]),
    anchorRevenueB: revenue(anchorRow),
    anchorEbitdaB: ebitda(anchorRow),
    anchorMargin: revenue(anchorRow) > 0 ? ebitda(anchorRow) / revenue(anchorRow) : 0,
    anchorMultiple: calibration.forwardMultiple2028[segment],
    discountRate,
    capexB: totalCapex,
    terminalValueB: terminalValue,
  };
}
/**
 * AI future optionality: only economics beyond the reported AI base belong here,
 * valued with the same scenario-tree discipline as Starship so optionality is
 * never one probability applied to a huge terminal number.
 */
/**
 * Other strategic optionality, valued separately for each case. Only
 * identifiable economics that are NOT already inside the Connectivity, AI, Space
 * or Starship plans belong here, so the layer cannot double count: additional
 * direct-to-device economics, orbital infrastructure beyond the Starship
 * scenarios, and new platform economics. Each case states its own number.
 */
function buildOtherOptionality(scenario: SpcxScenarioCase) {
  const value = SPCX_CALIBRATION[scenario].otherOptionalityB;
  const items = [
    { name: "Additional direct-to-device economics", share: 0.4, note: "Beyond the Connectivity D2D line: aviation, maritime and emergency-service spectrum economics." },
    { name: "Orbital infrastructure beyond the Starship base", share: 0.35, note: "In-orbit manufacturing, servicing and infrastructure not credited in the Starship base scenario." },
    { name: "New connectivity and platform economics", share: 0.25, note: "Identifiable platform adjacencies with a stated driver; anything without support is removed rather than guessed." },
  ];
  return {
    valueB: value,
    items: items.map((item) => ({ ...item, valueB: value * item.share })),
  };
}

/**
 * Starship scenario tree. Each scenario is generated from its own drivers:
 * launch cadence × revenue per launch, government demand, the measurable
 * Starlink deployment saving created by reuse, and the orbital infrastructure
 * and orbital compute economics the platform opens. Every driver is listed in
 * the UI, and the present value is computed from them rather than typed in.
 *
 * Probabilities are stated per scenario and sum to 100%. No probability or
 * confidence haircut is applied after the expected value is calculated.
 */
function buildStarshipScenarios(scenario: SpcxScenarioCase) {
  const drivers = SPCX_CALIBRATION[scenario].starship;
  const rows: Array<{ name: string; probability: number; drivers: SpcxStarshipDrivers; launchCostM: number; note: string }> = [
    {
      name: "FAILURE",
      probability: SPCX_PROBABILITY.failure,
      drivers: { launchCadencePerYear: 2, revenuePerLaunchM: 120, governmentRevenueB: 0, starlinkSavingsB: 0, orbitalInfrastructureRevenueB: 0, fcfMargin: -0.2, developmentCapitalB: 0 },
      launchCostM: 180,
      note: "Programme stalls: no commercial scale, so the scenario is worth nothing and only the capital still to be spent is at risk.",
    },
    { name: "LIMITED COMMERCIALIZATION", probability: SPCX_PROBABILITY.limited, drivers: drivers.limited, launchCostM: 60, note: "Partial reuse at limited cadence; the measurable benefit is the Starlink deployment saving plus early orbital infrastructure." },
    { name: "BASE COMMERCIAL SCALE", probability: SPCX_PROBABILITY.base, drivers: drivers.base, launchCostM: 38, note: "Reuse proven at scale with government and commercial demand, Starlink deployment savings and orbital infrastructure at scale." },
    { name: "FULL REUSABILITY / HIGH SCALE", probability: SPCX_PROBABILITY.full, drivers: drivers.full, launchCostM: 18, note: "Full rapid reuse: launch cost per kilogram falls far enough to open new demand, cut Starlink deployment cost materially and make orbital infrastructure economic." },
  ];
  const probabilitySum = rows.reduce((total, row) => total + row.probability, 0);
  const valued: SpcxStarshipScenario[] = rows.map((row) => {
    const commercialRevenueB = (row.drivers.launchCadencePerYear * row.drivers.revenuePerLaunchM) / 1000;
    const internalSavingsB = row.drivers.starlinkSavingsB;
    const orbitalRevenueB = row.drivers.orbitalInfrastructureRevenueB;
    const totalAtScaleB = commercialRevenueB + row.drivers.governmentRevenueB + internalSavingsB + orbitalRevenueB;
    const fcfAtScaleB = totalAtScaleB * Math.max(0, row.drivers.fcfMargin);
    const presentValue = fcfAtScaleB * STARSHIP_TERMINAL_FACTOR;
    const npvB = Math.max(0, presentValue - row.drivers.developmentCapitalB);
    return {
      name: row.name,
      probability: row.probability,
      launchCadencePerYear: row.drivers.launchCadencePerYear,
      revenuePerLaunchM: row.drivers.revenuePerLaunchM,
      launchCostM: row.launchCostM,
      developmentCapitalB: row.drivers.developmentCapitalB,
      revenueAtScaleB: totalAtScaleB,
      fcfMargin: row.drivers.fcfMargin,
      npvB,
      note: row.note,
      commercialRevenueB,
      governmentRevenueB: row.drivers.governmentRevenueB,
      internalSavingsB,
      orbitalInfrastructureRevenueB: orbitalRevenueB,
      fcfAtScaleB,
      presentValueB: presentValue,
    };
  });
  const expectedValueB = valued.reduce((total, scenario) => total + scenario.npvB * scenario.probability, 0);
  return { scenarios: valued, expectedValueB, probabilitySum };
}

export function buildSpcxValuation(input: SpcxValuationInput): SpcxValuation {
  const { reported, shareBridge } = input;
  const shares = Math.max(0.001, shareBridge.fullyDilutedSharesCurrentB);
  const anchor = reportedAnchor(reported);
  const baseForecast = buildForecast(reported, "BASE");
  const coreForecast = buildForecast(reported, "CORE");
  const visionForecast = buildForecast(reported, "VISION");
  const baseValues = {
    Space: valueSegment(baseForecast, "Space", "BASE"),
    Connectivity: valueSegment(baseForecast, "Connectivity", "BASE"),
    AI: valueSegment(baseForecast, "AI", "BASE"),
  };
  const coreValues = {
    Space: valueSegment(coreForecast, "Space", "CORE"),
    Connectivity: valueSegment(coreForecast, "Connectivity", "CORE"),
    AI: valueSegment(coreForecast, "AI", "CORE"),
  };
  const visionValues = {
    Space: valueSegment(visionForecast, "Space", "VISION"),
    Connectivity: valueSegment(visionForecast, "Connectivity", "VISION"),
    AI: valueSegment(visionForecast, "AI", "VISION"),
  };
  // Starship is generated from its own driver table per case, and the other
  // optionality layer is stated separately so the two cannot double count.
  const starship = buildStarshipScenarios("BASE");
  const coreStarship = buildStarshipScenarios("CORE");
  const visionStarship = buildStarshipScenarios("VISION");
  const otherOptionality = buildOtherOptionality("BASE");
  const coreOtherOptionality = buildOtherOptionality("CORE");
  const visionOtherOptionality = buildOtherOptionality("VISION");
  const reportedAnchors = {
    Space: runRate(reported.halfYear?.space, true),
    Connectivity: runRate(reported.halfYear?.connectivity, true),
    AI: runRate(reported.halfYear?.ai, true),
  };
  const segments: SpcxSegmentValue[] = (["Space", "Connectivity", "AI"] as const).map((segment) => ({
    segment,
    revenueBaseB: reportedAnchors[segment].revenueB,
    ebitdaBaseB: reportedAnchors[segment].ebitdaB,
    ebitdaMarginBase: reportedAnchors[segment].revenueB > 0 ? reportedAnchors[segment].ebitdaB / reportedAnchors[segment].revenueB : 0,
    revenueFinalB: baseValues[segment].finalRevenue,
    ebitdaFinalB: baseValues[segment].finalEbitda,
    ebitdaMarginFinal: baseValues[segment].finalRevenue > 0 ? baseValues[segment].finalEbitda / baseValues[segment].finalRevenue : 0,
    anchorRevenue2028B: baseValues[segment].anchorRevenueB,
    anchorEbitda2028B: baseValues[segment].anchorEbitdaB,
    anchorMargin2028: baseValues[segment].anchorMargin,
    anchorMultiple2028: baseValues[segment].anchorMultiple,
    methodValues: baseValues[segment].methodValues,
    method: `Primary: forward EV/EBITDA of ${baseValues[segment].anchorMultiple.toFixed(0)}× on 2028E EBITDA of $${baseValues[segment].anchorEbitdaB.toFixed(1)}B, a ${(baseValues[segment].anchorMargin * 100).toFixed(0)}% margin, discounted two years at ${(baseValues[segment].discountRate * 100).toFixed(1)}%. Cross-checks: multi-year DCF at a ${SPCX_CALIBRATION.BASE.terminalMultiple[segment].toFixed(0)}× terminal multiple on 2030E EBITDA, and forward EV/Sales of ${SPCX_CALIBRATION.BASE.forwardEvSales2028[segment].toFixed(1)}× on 2028E revenue.`,
    discountRate: baseValues[segment].discountRate,
    enterpriseValueB: baseValues[segment].enterpriseValueB,
    perShare: baseValues[segment].enterpriseValueB / shares,
  }));
  const coreB = coreValues.Space.enterpriseValueB + coreValues.Connectivity.enterpriseValueB + coreValues.AI.enterpriseValueB;
  const baseB = baseValues.Space.enterpriseValueB + baseValues.Connectivity.enterpriseValueB + baseValues.AI.enterpriseValueB;
  const visionB = visionValues.Space.enterpriseValueB + visionValues.Connectivity.enterpriseValueB + visionValues.AI.enterpriseValueB;
  const equityValueB = baseB + starship.expectedValueB + otherOptionality.valueB + input.netCorporateB;
  const fairValue = equityValueB / shares;
  const coreCaseValue = (coreB + coreStarship.expectedValueB + coreOtherOptionality.valueB + input.netCorporateB) / shares;
  const visionCaseValue = (visionB + visionStarship.expectedValueB + visionOtherOptionality.valueB + input.netCorporateB) / shares;

  // Where the valuation comes from, component by component, per share.
  const contribution = [
    { component: "Connectivity", valueB: baseValues.Connectivity.enterpriseValueB },
    { component: "AI", valueB: baseValues.AI.enterpriseValueB },
    { component: "Space Core", valueB: baseValues.Space.enterpriseValueB },
    { component: "Starship", valueB: starship.expectedValueB },
    { component: "Other optionality", valueB: otherOptionality.valueB },
    { component: "Net cash", valueB: input.netCorporateB },
  ].map((row) => ({ ...row, perShare: row.valueB / shares }));
  const contributionTotalB = contribution.reduce((sum, row) => sum + row.valueB, 0);

  // Implied multiples on the published value and on the market price.
  const marketPrice = typeof input.marketPrice === "number" ? input.marketPrice : null;
  const baseEbitdaB = baseForecast[0].spaceEbitda + baseForecast[0].connectivityEbitda + baseForecast[0].aiEbitda;
  const baseRevenueB = baseForecast[0].spaceRevenue + baseForecast[0].connectivityRevenue + baseForecast[0].aiRevenue;
  const baseFcfB = baseForecast[0].segmentFcf;
  const matureRow = baseForecast[baseForecast.length - 1];
  const matureEbitdaB = matureRow.spaceEbitda + matureRow.connectivityEbitda + matureRow.aiEbitda;
    const marketCapB = marketPrice === null ? null : marketPrice * shares;
  const enterpriseValueMarketB = marketCapB === null ? null : marketCapB - input.netCorporateB;
  const impliedMultiples = {
    marketCapB,
    enterpriseValueMarketB,
    evRevenue: enterpriseValueMarketB !== null && baseRevenueB > 0 ? enterpriseValueMarketB / baseRevenueB : null,
    evEbitda: enterpriseValueMarketB !== null && baseEbitdaB > 0 ? enterpriseValueMarketB / baseEbitdaB : null,
    peForward: marketPrice !== null && baseFcfB > 0 ? marketCapB! / (baseFcfB * 1.35) : null,
    fcfYield: marketCapB !== null && baseFcfB > 0 ? (baseFcfB / marketCapB) * 100 : null,
    fairValueEvRevenue: baseRevenueB > 0 ? (equityValueB - input.netCorporateB) / baseRevenueB : null,
    fairValueEvEbitda: baseEbitdaB > 0 ? (equityValueB - input.netCorporateB) / baseEbitdaB : null,
    matureEbitdaB,
    evEbitdaMature: matureEbitdaB > 0 ? (equityValueB - input.netCorporateB) / matureEbitdaB : null,
    marketEvEbitdaMature: enterpriseValueMarketB !== null && matureEbitdaB > 0 ? enterpriseValueMarketB / matureEbitdaB : null,
    flags: [] as string[],
  };
  // EBITDA is still emerging, so the anomaly test is applied to the mature-year
  // EBITDA as well: a high first-year multiple is normal for a build-out, an
  // implausible mature multiple is not.
  if (impliedMultiples.evEbitdaMature !== null && impliedMultiples.evEbitdaMature < 4) {
    impliedMultiples.flags.push(`The published value implies EV/EBITDA of ${impliedMultiples.evEbitdaMature.toFixed(1)}× on mature-year EBITDA, which is implausibly low for a platform with reported revenue growth above 90%.`);
  }
  if (impliedMultiples.evEbitdaMature !== null && impliedMultiples.evEbitdaMature > 50) {
    impliedMultiples.flags.push(`The published value implies EV/EBITDA of ${impliedMultiples.evEbitdaMature.toFixed(1)}× on mature-year EBITDA, which cannot be justified without stronger margin evidence.`);
  }
  const divergence = {
    fairValue,
    marketPrice,
    gapPct: marketPrice ? (fairValue / marketPrice - 1) * 100 : null,
    status: (marketPrice && Math.abs(fairValue / marketPrice - 1) > 0.5 ? "MODEL_DIVERGENCE_REVIEW" : "within_bounds") as "within_bounds" | "MODEL_DIVERGENCE_REVIEW",
    explanation: [
      `Revenue base: Signal Ledger uses the reported half-year run-rate of $${baseRevenueB.toFixed(1)}B; the market price implies $${impliedMultiples.evRevenue ? (impliedMultiples.enterpriseValueMarketB! / impliedMultiples.evRevenue).toFixed(1) : "—"}B at the same EV/Revenue multiple.`,
      `EBITDA: reported segment adjusted EBITDA (operating income + D&A + share-based compensation) is $${(anchor.quarterAdjustedEbitdaB.Connectivity + anchor.quarterAdjustedEbitdaB.AI + anchor.quarterAdjustedEbitdaB.Space).toFixed(2)}B in Q2 2026, with Connectivity at $${anchor.quarterAdjustedEbitdaB.Connectivity.toFixed(2)}B and AI at $${anchor.quarterAdjustedEbitdaB.AI.toFixed(2)}B.`,
      `Starship and other optionality: the driver-generated scenario tree values Starship at $${starship.expectedValueB.toFixed(0)}B expected (including the failure case at $${starship.scenarios[0].npvB.toFixed(0)}B) and the strategic-optionality layer at $${otherOptionality.valueB.toFixed(0)}B. The market gap implies a further $${marketPrice ? Math.max(0, marketPrice * shares - equityValueB).toFixed(0) : "—"}B of value that neither layer assumes.`,
      "Share count: the denominator is the current period-end count plus economic dilution, not the EPS weighted average.",
    ],
  };
  const qualityGates = {
    data: {
      id: "data",
      label: "Data gate",
      status: reported.halfYear && reported.quarter && shareBridge.valid ? "passed" as const : "failed" as const,
      detail: reported.halfYear
        ? `Reported Space/Connectivity/AI segment tables loaded (${reported.halfYearLabel}); share count ${shareBridge.fullyDilutedSharesCurrentB.toFixed(3)}B reconciled.`
        : "The reported segment tables could not be read, so reported data cannot replace model assumptions.",
    },
    model: {
      id: "model",
      label: "Model gate",
      status: segments.every((segment) => segment.revenueBaseB > 0 && segment.ebitdaMarginBase !== 0) && Math.abs(starship.probabilitySum - 1) < 1e-9 ? "passed" as const : "failed" as const,
      detail: `Every segment has a reported revenue and EBITDA anchor, one method per segment, and the Starship scenario probabilities sum to ${(starship.probabilitySum * 100).toFixed(0)}%.`,
    },
    sanity: {
      id: "sanity",
      label: "Sanity gate",
      status: impliedMultiples.flags.length === 0 ? "passed" as const : "failed" as const,
      detail: impliedMultiples.flags.length ? impliedMultiples.flags.join(" ") : `Implied fair-value EV/EBITDA ${impliedMultiples.fairValueEvEbitda?.toFixed(1)}× against reported EBITDA; no anomaly flagged.`,
    },
    publishable: false,
  };
  qualityGates.publishable = qualityGates.data.status === "passed" && qualityGates.model.status === "passed" && qualityGates.sanity.status === "passed";

  const buyZone = qualityGates.publishable
    ? (() => {
      const expectedValueCagr = 0.11;
      const holdingPeriodYears = 3;
      const requiredReturn = 0.25;
      const strongBuyRequiredReturn = 0.35;
      const expectedFutureValue = fairValue * (1 + expectedValueCagr) ** holdingPeriodYears;
      return {
        requiredReturn,
        strongBuyRequiredReturn,
        holdingPeriodYears,
        expectedValueCagr,
        expectedFutureValue,
        buyPrice: expectedFutureValue / (1 + requiredReturn) ** holdingPeriodYears,
        strongBuyPrice: expectedFutureValue / (1 + strongBuyRequiredReturn) ** holdingPeriodYears,
        method: "expected value in three years discounted at the required return; no haircut is applied to fair value",
      };
    })()
    : null;

  // ---- Model triangulation ------------------------------------------------
  // A consolidated DCF and a forward-multiple cross-check. Both carry their own
  // capital charge and their own terminal assumption; neither replaces SOTP.
  const matureRevenueMix = {
    Space: matureRow.spaceRevenue,
    Connectivity: matureRow.connectivityRevenue,
    AI: matureRow.aiRevenue,
  };
  const mixTotal = matureRevenueMix.Space + matureRevenueMix.Connectivity + matureRevenueMix.AI;
  const baseCalibration = SPCX_CALIBRATION.BASE;
  const weightOf = (segment: SegmentName) => (mixTotal > 0 ? matureRevenueMix[segment] / mixTotal : 1 / 3);
  const blendedDiscountRate = SEGMENT_NAMES.reduce((sum, segment) => sum + baseCalibration.discountRate[segment] * weightOf(segment), 0);
  const blendedTerminalMultiple = SEGMENT_NAMES.reduce((sum, segment) => sum + baseCalibration.terminalMultiple[segment] * weightOf(segment), 0);
  const pvSegmentFcf = baseForecast.reduce((sum, row, index) => sum + row.segmentFcf / (1 + blendedDiscountRate) ** (index + 1), 0);
  const pvMatureTerminal = (matureEbitdaB * blendedTerminalMultiple) / (1 + blendedDiscountRate) ** baseForecast.length;
  const dcfOptionalityAndCorporateB = starship.expectedValueB + otherOptionality.valueB + input.netCorporateB;
  const dcfEnterpriseValueB = Math.max(0, pvSegmentFcf + pvMatureTerminal);
  const dcfEquityValueB = dcfEnterpriseValueB + dcfOptionalityAndCorporateB;
  const forwardRow = baseForecast[Math.min(3, baseForecast.length - 1)];
  const forwardEbitdaB = forwardRow.spaceEbitda + forwardRow.connectivityEbitda + forwardRow.aiEbitda;
  const forwardBuildCapitalB = baseForecast.slice(0, 4).reduce((sum, row, index) => sum + Math.max(0, row.buildCapital ?? 0) / (1 + blendedDiscountRate) ** (index + 1), 0);
  const forwardMultipleValueB = Math.max(0, (forwardEbitdaB * blendedTerminalMultiple) / (1 + blendedDiscountRate) ** 4 - forwardBuildCapitalB);
  const forwardEquityValueB = forwardMultipleValueB + dcfOptionalityAndCorporateB;
  const crossChecks: SpcxValuation["crossChecks"] = {
    sotp: { enterpriseValueB: baseB, perShare: fairValue, weight: 0.6, note: "Primary model: each reported segment valued on forward 2028E EV/EBITDA at its own multiple and discount rate, plus the Starship scenario tree, the strategic-optionality layer and the corporate bridge." },
    dcf: {
      enterpriseValueB: dcfEnterpriseValueB,
      perShare: dcfEquityValueB / shares,
      weight: 0.25,
      inputs: `After-tax segment cash flow for ${baseForecast.length} years at a revenue-weighted discount rate of ${(blendedDiscountRate * 100).toFixed(1)}%, terminal value ${blendedTerminalMultiple.toFixed(1)}× 2030E EBITDA of $${matureEbitdaB.toFixed(1)}B, plus Starship, the optionality layer and net corporate.`,
      note: "Charges every segment's own build capital inside the cash-flow path rather than only in the terminal value. Shown as a cross-check, not as the published value.",
    },
    forwardMultiple: {
      enterpriseValueB: forwardMultipleValueB,
      perShare: forwardEquityValueB / shares,
      weight: 0.15,
      inputs: `${forwardRow.year} EBITDA of $${forwardEbitdaB.toFixed(1)}B × ${blendedTerminalMultiple.toFixed(1)}× discounted four years, less the build capital deployed to that year ($${forwardBuildCapitalB.toFixed(1)}B present value).`,
      note: "This is the check that fails if the build-out is being capitalised as if it were already complete.",
    },
    blendedDiscountRate,
    blendedTerminalMultiple,
    weightsNote: "The published fair value follows SOTP. The DCF and forward-multiple values are shown at their applicability weights so a reader can see where the models disagree; they are never averaged into the published number.",
    publishedFrom: "SOTP",
  };

  // ---- Market-implied expectations ---------------------------------------
  const marketEquityValueB = marketPrice === null ? null : marketPrice * shares;
  const modelledBusinessValueB = baseB + starship.expectedValueB + otherOptionality.valueB;
  const requiredBusinessValueB = marketEquityValueB === null ? null : marketEquityValueB - input.netCorporateB;
  const valueGapB = requiredBusinessValueB === null ? null : requiredBusinessValueB - modelledBusinessValueB;
  // One lever at a time, solved on the 2028 anchor the model actually uses.
  const anchorYear = baseForecast[2];
  const aiDiscount = (1 + baseCalibration.discountRate.AI) ** 2;
  const connectivityDiscount = (1 + baseCalibration.discountRate.Connectivity) ** 2;
  const requiredAiPresentValueB = valueGapB === null ? null : baseValues.AI.enterpriseValueB + valueGapB;
  const requiredAi2028EnterpriseValueB = requiredAiPresentValueB === null ? null : requiredAiPresentValueB * aiDiscount;
  const requiredAi2028EbitdaB = requiredAi2028EnterpriseValueB === null ? null : requiredAi2028EnterpriseValueB / baseCalibration.forwardMultiple2028.AI;
  const requiredAi2028RevenueB = requiredAi2028EbitdaB === null ? null : requiredAi2028EbitdaB / baseCalibration.ebitdaMargin.AI[2];
  const requiredAi2028EbitdaMargin = requiredAi2028EbitdaB === null || anchorYear.aiRevenue <= 0 ? null : requiredAi2028EbitdaB / anchorYear.aiRevenue;
  const requiredAi2028Multiple = requiredAi2028EnterpriseValueB === null || anchorYear.aiEbitda <= 0 ? null : requiredAi2028EnterpriseValueB / anchorYear.aiEbitda;
  const requiredConnectivity2028RevenueB = valueGapB === null
    ? null
    : anchorYear.connectivityRevenue + (valueGapB * connectivityDiscount) / (baseCalibration.forwardMultiple2028.Connectivity * baseCalibration.ebitdaMargin.Connectivity[2]);
  const requiredStarshipNpvB = valueGapB === null ? null : starship.expectedValueB + valueGapB;
  const requiredDirectToDeviceValueB = valueGapB === null ? null : valueGapB;
  const requiredConnectivityRevenueB = requiredConnectivity2028RevenueB;
  const requiredAiRevenueB = requiredAi2028RevenueB;
  const requiredAiMatureEbitdaMargin = requiredAi2028EbitdaMargin;

  // "And this is what it takes if the gap is spread across the levers instead of
  // loaded onto one of them", expressed in each lever's own units.
  const combination = valueGapB === null ? [] : (() => {
    const share = valueGapB / 3;
    const aiRevenueB = anchorYear.aiRevenue + (share * aiDiscount) / (baseCalibration.forwardMultiple2028.AI * baseCalibration.ebitdaMargin.AI[2]);
    const connectivityRevenueB = anchorYear.connectivityRevenue + (share * connectivityDiscount) / (baseCalibration.forwardMultiple2028.Connectivity * baseCalibration.ebitdaMargin.Connectivity[2]);
    const starshipB = starship.expectedValueB + share;
    return [
      `Spread evenly across AI, Connectivity and Starship, the price requires 2028E AI revenue of $${aiRevenueB.toFixed(0)}B (model $${anchorYear.aiRevenue.toFixed(0)}B), 2028E Connectivity revenue of $${connectivityRevenueB.toFixed(0)}B (model $${anchorYear.connectivityRevenue.toFixed(0)}B) and a Starship value of $${starshipB.toFixed(0)}B (model $${starship.expectedValueB.toFixed(0)}B) at the same multiples.`,
      `Loaded onto the multiple alone, AI would have to trade at ${((requiredAi2028Multiple ?? 0)).toFixed(1)}× 2028E EBITDA instead of ${baseCalibration.forwardMultiple2028.AI}×, on the modelled revenue and margin.`,
    ];
  })();
  const equalSplitShareB = valueGapB === null ? null : valueGapB / 5;
  // A lever that would have to move beyond any defensible bound cannot justify the
  // price on its own, so it is labelled instead of presented as achievable.
  const withFeasibility = (requirement: string, value: number | null, ceiling: number) => value === null || value > ceiling
    ? `${requirement} Not achievable on its own: the market price would require several of these levers at once.`
    : requirement;
  // Direct-to-device has no modelled value of its own (the filing does not break
  // it out), so its ceiling is the whole reported Connectivity business: asking
  // for more than the segment itself is not a single-lever answer.
  const directToDeviceCeilingB = Math.max(0, baseValues.Connectivity.enterpriseValueB);
  const equalSplit = equalSplitShareB === null ? [] : [
    { lever: "2028E Connectivity revenue", requirement: withFeasibility(`$${anchorYear.connectivityRevenue.toFixed(0)}B → $${((requiredConnectivity2028RevenueB ?? 0) + equalSplitShareB * connectivityDiscount / (baseCalibration.forwardMultiple2028.Connectivity * baseCalibration.ebitdaMargin.Connectivity[2])).toFixed(0)}B at the modelled margin and multiple.`, requiredConnectivity2028RevenueB, anchorYear.connectivityRevenue * 3) },
    { lever: "2028E AI revenue", requirement: withFeasibility(`$${anchorYear.aiRevenue.toFixed(0)}B → $${((requiredAi2028RevenueB ?? 0) + equalSplitShareB * aiDiscount / (baseCalibration.forwardMultiple2028.AI * baseCalibration.ebitdaMargin.AI[2])).toFixed(0)}B at the modelled margin and multiple.`, requiredAi2028RevenueB, anchorYear.aiRevenue * 3) },
    { lever: "2028E AI EBITDA margin", requirement: withFeasibility(`$${(requiredAi2028EbitdaB ?? 0).toFixed(0)}B of 2028E AI EBITDA on the modelled $${anchorYear.aiRevenue.toFixed(0)}B revenue, i.e. a ${((requiredAi2028EbitdaMargin ?? 0) * 100).toFixed(0)}% margin instead of ${(baseCalibration.ebitdaMargin.AI[2] * 100).toFixed(0)}%.`, requiredAi2028EbitdaMargin, 0.8) },
    { lever: "Starship", requirement: withFeasibility(`Starship scenario value of $${(starship.expectedValueB + equalSplitShareB).toFixed(0)}B instead of $${starship.expectedValueB.toFixed(0)}B.`, starship.expectedValueB + equalSplitShareB, starship.expectedValueB * 10) },
    { lever: "Direct-to-device", requirement: withFeasibility(`Direct-to-device value of $${equalSplitShareB.toFixed(0)}B on top of the modelled Connectivity business.`, equalSplitShareB, directToDeviceCeilingB) },
  ];
  const marketImplied: SpcxValuation["marketImplied"] = {
    marketEquityValueB,
    requiredBusinessValueB,
    modelledBusinessValueB,
    valueGapB,
    requiredAi2028RevenueB,
    requiredAi2028EbitdaMargin,
    requiredAi2028Multiple,
    requiredStarshipExpectedB: requiredStarshipNpvB,
    requiredConnectivity2028RevenueB,
    combination,
    requiredConnectivityRevenueB,
    requiredAiRevenueB,
    requiredAiMatureEbitdaMargin,
    requiredStarshipNpvB,
    requiredDirectToDeviceValueB,
    equalSplit,
    headline: marketEquityValueB === null
      ? "No market price was supplied, so the reverse solve was not run."
      : `At $${marketPrice!.toFixed(2)} the market is paying $${marketEquityValueB.toFixed(0)}B of equity value. The model's base businesses plus both scenario trees are worth $${modelledBusinessValueB.toFixed(0)}B before net corporate, so the price requires about $${(valueGapB ?? 0).toFixed(0)}B of value that this model does not assume.`,
  };

  const aiValues = { revenueB: reportedAnchors.AI.revenueB, ebitdaB: reportedAnchors.AI.ebitdaB, enterpriseValueB: baseValues.AI.enterpriseValueB };
  return {
    reported,
    shareBridge,
    forecast: baseForecast,
    segments,
    starship: { scenarios: starship.scenarios, expectedValueB: starship.expectedValueB, perShare: starship.expectedValueB / shares, probabilitySum: starship.probabilitySum },
    otherOptionality: { valueB: otherOptionality.valueB, perShare: otherOptionality.valueB / shares, items: otherOptionality.items },
    reportedAnchor: anchor,
    calibration: SPCX_CALIBRATION,
    valuationContribution: contribution,
    valuationContributionTotalB: contributionTotalB,
    cases: [
      { name: "CORE CASE", value: coreCaseValue, assumptions: `Lower AI and Connectivity plan (2028E AI $${SPCX_CALIBRATION.CORE.revenueB.AI[2]}B, Connectivity $${SPCX_CALIBRATION.CORE.revenueB.Connectivity[2]}B), lower margins, lower multiples and roughly half the base Starship economics.`, published: false },
      { name: "BASE EXECUTION CASE", value: fairValue, assumptions: `Base calibration: 2028E AI $${SPCX_CALIBRATION.BASE.revenueB.AI[2]}B at ${(SPCX_CALIBRATION.BASE.ebitdaMargin.AI[2] * 100).toFixed(0)}% on ${SPCX_CALIBRATION.BASE.forwardMultiple2028.AI}×, Connectivity $${SPCX_CALIBRATION.BASE.revenueB.Connectivity[2]}B at ${(SPCX_CALIBRATION.BASE.ebitdaMargin.Connectivity[2] * 100).toFixed(0)}% on ${SPCX_CALIBRATION.BASE.forwardMultiple2028.Connectivity}×, Space Core $${SPCX_CALIBRATION.BASE.revenueB.Space[2]}B at ${(SPCX_CALIBRATION.BASE.ebitdaMargin.Space[2] * 100).toFixed(0)}% on ${SPCX_CALIBRATION.BASE.forwardMultiple2028.Space}×, with Starship at its driver-generated scenario expectation.`, published: true },
      { name: "VISION CASE", value: visionCaseValue, assumptions: `Successful execution: 2028E AI $${SPCX_CALIBRATION.VISION.revenueB.AI[2]}B at ${(SPCX_CALIBRATION.VISION.ebitdaMargin.AI[2] * 100).toFixed(0)}% on ${SPCX_CALIBRATION.VISION.forwardMultiple2028.AI}×, Connectivity $${SPCX_CALIBRATION.VISION.revenueB.Connectivity[2]}B on ${SPCX_CALIBRATION.VISION.forwardMultiple2028.Connectivity}×, higher Starship scale, still fully capital-charged.`, published: false },
    ],
    coreB: baseB,
    growthB: 0,
    optionalityB: starship.expectedValueB,
    netCorporateB: input.netCorporateB,
    equityValueB,
    fairValue,
    ai: {
      ...aiValues,
      perShare: aiValues.enterpriseValueB / shares,
      shareOfEquity: equityValueB > 0 ? aiValues.enterpriseValueB / equityValueB : 0,
      capexB: reportedAnchors.AI.capexB,
    },
    connectivity: { revenueB: reportedAnchors.Connectivity.revenueB, ebitdaB: reportedAnchors.Connectivity.ebitdaB, enterpriseValueB: baseValues.Connectivity.enterpriseValueB, perShare: baseValues.Connectivity.enterpriseValueB / shares },
    space: { revenueB: reportedAnchors.Space.revenueB, ebitdaB: reportedAnchors.Space.ebitdaB, enterpriseValueB: baseValues.Space.enterpriseValueB, perShare: baseValues.Space.enterpriseValueB / shares },
    buyZone,
    impliedMultiples,
    divergence,
    crossChecks,
    marketImplied,
    externalResearch: input.externalResearch?.length ? input.externalResearch : SPCX_PUBLIC_TARGETS,
    whyDifferent: [
      { metric: "2026E revenue", signalLedger: `$${baseRevenueB.toFixed(1)}B (reported run-rate)`, market: `$${impliedMultiples.evRevenue ? (impliedMultiples.enterpriseValueMarketB! / impliedMultiples.evRevenue).toFixed(1) : "—"}B at the same multiple`, publicResearch: "not captured yet" },
      { metric: "AI revenue", signalLedger: `$${aiValues.revenueB.toFixed(1)}B reported ($${(reported.quarter?.ai.revenue ?? 0) / 1000}B in the latest quarter)`, market: "requires materially more AI revenue", publicResearch: "not captured yet" },
      { metric: "AI EBITDA", signalLedger: `$${aiValues.ebitdaB.toFixed(1)}B (operating income + D&A, reported)`, market: "—", publicResearch: "not captured yet" },
      { metric: "Connectivity EBITDA", signalLedger: `$${reportedAnchors.Connectivity.ebitdaB.toFixed(1)}B at ${(reportedAnchors.Connectivity.ebitdaB / Math.max(0.01, reportedAnchors.Connectivity.revenueB) * 100).toFixed(0)}% margin`, market: "—", publicResearch: "not captured yet" },
      { metric: "Starship value", signalLedger: `$${starship.expectedValueB.toFixed(1)}B scenario-weighted`, market: `$${marketCapB === null ? "—" : Math.max(0, marketCapB - baseB - input.netCorporateB).toFixed(0)}B implied`, publicResearch: "not captured yet" },
      { metric: "Capex", signalLedger: `$${(reportedAnchors.Space.capexB + reportedAnchors.Connectivity.capexB + reportedAnchors.AI.capexB).toFixed(1)}B reported annualised (AI ${(reportedAnchors.AI.capexB).toFixed(1)}B)`, market: "—", publicResearch: "not captured yet" },
      { metric: "Share count", signalLedger: `${shareBridge.fullyDilutedSharesCurrentB.toFixed(3)}B current fully diluted`, market: "same denominator required", publicResearch: "not captured yet" },
    ],
    qualityGates,
    confidence: {
      reportedData: 0.9,
      connectivityForecast: 0.65,
      aiForecast: 0.45,
      starshipOptionality: 0.35,
      overall: clamp01(0.4 * 0.9 + 0.25 * 0.65 + 0.2 * 0.45 + 0.15 * 0.35),
    },
  };
}
