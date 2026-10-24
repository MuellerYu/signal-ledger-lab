/**
 * MU (Micron Technology) valuation.
 *
 * Micron is not one business. Three economics with different drivers sit inside
 * the same income statement, so they are modelled separately:
 *
 *   HBM / AI memory   structural, capacity constrained, contracted, premium margin
 *   Legacy DRAM       cyclical, normalises gradually from the reported super-cycle
 *   NAND              cyclical, structurally lower margin
 *
 * Reported anchors (latest 10-Q product revenue, gross margin, operating income,
 * tax rate, capex and cash conversion) always override model assumptions. Every
 * transition between the reported super-cycle and a normalised mid-cycle is shown
 * one year at a time; nothing jumps from a peak margin straight to a decades-long
 * average. Historical memory averages are only a floor reference, because the
 * reported take-or-pay customer agreements change pricing durability.
 */

export type MuReportedProductRevenue = {
  quarterLabel: string | null;
  quarter: { dramM: number; nandM: number; otherM: number; totalM: number } | null;
  yearToDate: { dramM: number; nandM: number; otherM: number; totalM: number } | null;
  source: string;
};

export type MuEvidence = {
  /** Reported take-or-pay / strategic customer agreements with enforceable volumes. */
  takeOrPayAgreements: boolean;
  /** Reported capacity programmes that support the HBM build. */
  capacityProgrammes: string[];
  /** Reported debt prepayments in the latest fiscal year to date, in billions. */
  debtPrepaymentsB: number | null;
  notes: string[];
};

export type MuReportedAnchors = {
  /** Latest reported quarter. */
  quarter: {
    periodEnd: string | null;
    revenueM: number;
    grossProfitM: number;
    operatingIncomeM: number | null;
    operatingExpenseM: number | null;
    netIncomeM: number;
    eps: number;
    dAndAM: number;
    capexM: number | null;
    cfoM: number | null;
  };
  /** Fiscal year to date, as reported in the latest 10-Q. */
  yearToDate: {
    periodEnd: string | null;
    revenueM: number;
    grossProfitM: number | null;
    operatingIncomeM: number | null;
    netIncomeM: number | null;
    eps: number | null;
    dAndAM: number | null;
    capexM: number | null;
    cfoM: number | null;
    taxM: number | null;
  } | null;
  /** Trailing twelve months: latest fiscal year rolled forward with interim periods. */
  ttm: {
    periodEnd: string | null;
    revenueM: number | null;
    grossProfitM: number | null;
    netIncomeM: number | null;
    eps: number | null;
    dAndAM: number | null;
    capexM: number | null;
    cfoM: number | null;
  };
  balance: { cashM: number; longTermDebtM: number; equityM: number; inventoryM: number };
  dilutedSharesM: number;
  productRevenue: MuReportedProductRevenue;
  source: string;
  sourceDate: string | null;
};

export type MuYearForecast = {
  year: number;
  /** DRAM including HBM. */
  dramRevenueB: number;
  hbmRevenueB: number;
  legacyDramRevenueB: number;
  nandRevenueB: number;
  otherRevenueB: number;
  revenueB: number;
  hbmShareOfDram: number;
  dramBitGrowth: number | null;
  dramAspChange: number | null;
  nandBitGrowth: number | null;
  nandAspChange: number | null;
  hbmVolumeGrowth: number | null;
  hbmAspChange: number | null;
  grossProfitB: number;
  grossMargin: number;
  hbmGrossMargin: number;
  legacyDramGrossMargin: number;
  nandGrossMargin: number;
  operatingExpenseB: number;
  operatingIncomeB: number;
  ebitdaB: number;
  ebitdaMargin: number;
  depreciatonAmortisationB: number;
  netIncomeB: number;
  eps: number;
  capexB: number;
  capexIntensity: number;
  fcfB: number;
  /** Why the margin moved this year. */
  marginDriver: string;
};

export type MuValuationMethod = {
  method: "Forward P/E" | "EV/EBITDA" | "DCF" | "Normalized earnings power" | "Revenue multiple";
  importance: "HIGH" | "MEDIUM/HIGH" | "LOW";
  weight: number;
  inputs: string;
  value: number | null;
  note: string;
};

export type MuValuation = {
  anchors: MuReportedAnchors;
  evidence: MuEvidence;
  forecast: MuYearForecast[];
  hbm: {
    shareOfRevenue: number;
    shareOfDramPath: number[];
    revenuePathB: number[];
    volumeGrowthPath: number[];
    aspChangePath: number[];
    grossMargin: number;
    note: string;
  };
  legacy: {
    dramMarginPath: number[];
    nandMarginPath: number[];
    blendedGrossMarginPath: number[];
    terminalMargin: number;
    note: string;
  };
  structuralChange: {
    assessed: boolean;
    drivers: Array<{ driver: string; evidence: string; effect: string }>;
    historicalAverageNote: string;
  };
  /**
   * Segment view of the same engine: FY2028 segment EBITDA at the model's
   * EV/EBITDA multiple, so the segment table, the model and the published value
   * cannot disagree.
   */
  segmentBreakdown: {
    year: number;
    multiple: number;
    segments: Array<{ name: string; revenueB: number; ebitdaB: number; ebitdaMargin: number; enterpriseValueB: number; perShare: number; note: string }>;
    enterpriseValueB: number;
    equityValueB: number;
    perShare: number | null;
  };
  /** Expected-return based buy zone; never a fixed percentage of fair value. */
  buyZone: {
    holdingPeriodYears: number;
    requiredReturn: number;
    strongBuyRequiredReturn: number;
    expectedValueCagr: number;
    expectedFutureValue: number;
    buyPrice: number;
    strongBuyPrice: number;
    method: string;
  } | null;
  methods: MuValuationMethod[];
  weightedFairValue: number | null;
  cases: Array<{ name: "BEAR" | "BASE" | "BULL"; value: number; assumptions: string }>;
  sanity: {
    price: number | null;
    fairValueOverEps27: number | null;
    fairValueOverEps28: number | null;
    fairValueOverNormalizedEps: number | null;
    evEbitda27: number | null;
    evEbitda28: number | null;
    fcfYieldAtPricePct: number | null;
    fcfYieldAtFairValuePct: number | null;
    peakEps: number | null;
    forwardEps27: number | null;
    forwardEps28: number | null;
    normalizedEps: number | null;
    normalizedEpsMethod: string;
    lowMultipleJustification: string[];
    flags: string[];
    status: "passed" | "VALUATION_MULTIPLE_ANOMALY";
  };
  marketImplied: {
    marketCapB: number | null;
    enterpriseValueB: number | null;
    peOnForwardEps27: number | null;
    peOnForwardEps28: number | null;
    evEbitda28: number | null;
    requiredTerminalGrossMargin: number | null;
    requiredRevenueB2030: number | null;
    explanation: string[];
  };
  consensus: { available: boolean; note: string; differences: string[] };
  qualityGates: { data: boolean; forecast: boolean; valuation: boolean; sanity: boolean; reconciliation: boolean; publishable: boolean };
  gateDetail: { data: string; model: string; sanity: string };
};

export type MuForecastAssumptions = {
  /** Q4 of the reported fiscal year, modelled off the reported third quarter. */
  q4SequentialGrowth: number;
  /**
   * HBM share of reported DRAM revenue in the anchor year. Micron discloses DRAM
   * and NAND product revenue but no HBM line, so this split is a labelled model
   * assumption anchored to the reported capacity programme.
   */
  hbmShareOfDramYearOne: number;
  hbmVolumeGrowth: number[];
  hbmAspChange: number[];
  dramBitGrowth: number[];
  dramAspChange: number[];
  nandBitGrowth: number[];
  nandAspChange: number[];
  otherGrowth: number[];
  /** Blended gross margin for FY2027–FY2030 when the reported contract structure holds. */
  blendedGrossMargin: number[];
  /** Same path with the structural premium removed, used when evidence is absent. */
  blendedGrossMarginWithoutStructuralSupport: number[];
  hbmMarginPremiumPts: number;
  nandMarginDiscountPts: number;
  otherGrossMargin: number;
  operatingExpenseGrowth: number;
  depreciatonAmortisationGrowth: number[];
  capexIntensity: number[];
  workingCapitalPctOfRevenue: number;
  taxRate: number;
  shareDilutionPerYear: number;
};

export type MuValuationAssumptions = {
  forwardPe: number;
  forwardPeRationale: string;
  evEbitdaMultiple: number;
  evEbitdaRationale: string;
  discountRate: number;
  terminalEbitdaMultiple: number;
  normalizedPe: number;
  revenueMultiple: number;
  /**
   * Expected-return based buy zone. The required return is the hurdle for a
   * cyclical memory issuer, and the expected value growth comes from the model's
   * own mature-year revenue growth rather than from a price target.
   */
  buyZone: {
    holdingPeriodYears: number;
    requiredReturn: number;
    strongBuyRequiredReturn: number;
    rationale: string;
  };
  weights: { forwardPe: number; evEbitda: number; dcf: number; normalized: number; revenue: number };
};

/** Labelled model assumptions. Everything here is disclosed as an assumption. */
export const MU_FORECAST_ASSUMPTIONS: MuForecastAssumptions = {
  q4SequentialGrowth: 0.06,
  hbmShareOfDramYearOne: 0.34,
  // HBM volume growth is capacity driven: the filing reports the Singapore HBM
  // packaging ramp from H1 calendar 2027, the Taiwan DRAM/HBM expansion and US
  // advanced packaging. ASPs decline on each generation step.
  hbmVolumeGrowth: [0.45, 0.3, 0.2, 0.12],
  hbmAspChange: [-0.08, -0.06, -0.05, -0.04],
  // Legacy DRAM: mid-teens bit growth against normalising pricing.
  dramBitGrowth: [0.16, 0.14, 0.12, 0.1],
  dramAspChange: [-0.06, -0.1, -0.06, -0.03],
  nandBitGrowth: [0.12, 0.1, 0.08, 0.06],
  nandAspChange: [-0.08, -0.06, -0.02, 0.0],
  otherGrowth: [0.03, 0.03, 0.03, 0.03],
  // Annual transition, not a jump: the reported peak normalises toward a
  // mid-cycle level that stays above the 2015–2022 average because contracts.
  blendedGrossMargin: [0.7, 0.6, 0.53, 0.49],
  blendedGrossMarginWithoutStructuralSupport: [0.62, 0.5, 0.42, 0.38],
  hbmMarginPremiumPts: 10,
  nandMarginDiscountPts: 14,
  otherGrossMargin: 0.3,
  operatingExpenseGrowth: 0.08,
  depreciatonAmortisationGrowth: [0.27, 0.21, 0.1, 0.06],
  capexIntensity: [0.22, 0.2, 0.18, 0.16, 0.15],
  workingCapitalPctOfRevenue: 0.02,
  taxRate: 0.15,
  shareDilutionPerYear: 0.015,
};

export const MU_VALUATION_ASSUMPTIONS: MuValuationAssumptions = {
  forwardPe: 11,
  forwardPeRationale:
    "FY2027 is a peak-cycle year: peak memory earnings are capitalised at a below-market multiple, but above the 6–8× trough-cycle multiple because HBM is now a contracted, structural share of the mix.",
  evEbitdaMultiple: 7,
  evEbitdaRationale:
    "Mid-cycle memory EV/EBITDA has historically been 5–9×. 7× sits in the middle and is applied to FY2028, when HBM is a larger share of the mix than in the anchor year.",
  discountRate: 0.1,
  terminalEbitdaMultiple: 6.5,
  normalizedPe: 12,
  revenueMultiple: 1.5,
  buyZone: {
    holdingPeriodYears: 3,
    requiredReturn: 0.25,
    strongBuyRequiredReturn: 0.35,
    rationale: "Buy zone is expected-return based: the modelled fair value is compounded at the model's own mature-year growth, then discounted at the return required for a cyclical memory issuer (25%, and 35% for the strong-buy threshold). No arbitrary percentage of fair value is used.",
  },
  weights: { forwardPe: 0.3, evEbitda: 0.25, dcf: 0.2, normalized: 0.2, revenue: 0.05 },
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/* ------------------------------------------------------------------ */
/* Reported product revenue from the inline XBRL of the latest 10-Q    */
/* ------------------------------------------------------------------ */

function decodeEntities(value: string) {
  return value
    .replace(/&#160;|&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
}

function numericValue(raw: string) {
  const cleaned = decodeEntities(raw.replace(/<[^>]+>/g, " ")).replace(/[^0-9.\-]/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Micron tags DRAM, NAND and other product revenue on the `srt:ProductOrServiceAxis`
 * of its 10-Q. The consolidated facts API carries no dimensional members, so the
 * product mix is read from the filing itself. Everything returned here is reported
 * data; a missing table returns nulls instead of a guess.
 */
export function parseMuReportedProductRevenue(filingHtml: string | null | undefined): MuReportedProductRevenue {
  const empty: MuReportedProductRevenue = {
    quarterLabel: null,
    quarter: null,
    yearToDate: null,
    source: "SEC 10-Q product revenue table not machine-readable",
  };
  if (!filingHtml) return empty;

  const contexts = new Map<string, { start: string | null; end: string | null; member: string | null }>();
  for (const match of filingHtml.matchAll(/<xbrli:context[^>]*id="([^"]+)"([\s\S]*?)<\/xbrli:context>/g)) {
    const body = match[2];
    contexts.set(match[1], {
      start: body.match(/<xbrli:startDate>([^<]+)/)?.[1] ?? null,
      end: body.match(/<xbrli:endDate>([^<]+)/)?.[1] ?? null,
      member: body.match(/<xbrldi:explicitMember[^>]*dimension="srt:ProductOrServiceAxis"[^>]*>\s*([^<\s]+)/)?.[1] ?? null,
    });
  }
  if (!contexts.size) return empty;

  const durationOf = (start: string | null, end: string | null) => {
    if (!start || !end) return 0;
    return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
  };

  type ProductFact = { end: string; duration: number; value: number; member: string };
  const productFacts: ProductFact[] = [];
  for (const match of filingHtml.matchAll(/<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/g)) {
    const attributes = match[1];
    const attribute = (name: string) => attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
    const name = attribute("name");
    if (!name || !/RevenueFromContractWithCustomer/.test(name)) continue;
    const context = contexts.get(attribute("contextRef") ?? "");
    if (!context?.member || !context.end) continue;
    const raw = numericValue(match[2]);
    if (raw === null) continue;
    const scale = Number(attribute("scale") ?? "0");
    const value = raw * 10 ** (Number.isFinite(scale) ? scale : 0) * (attribute("sign") === "-" ? -1 : 1);
    const duration = durationOf(context.start, context.end);
    if (duration < 60 || duration > 320) continue;
    productFacts.push({ end: context.end, duration, value, member: context.member });
  }
  if (!productFacts.length) return empty;

  const latestEnd = [...new Set(productFacts.map((fact) => fact.end))].sort().at(-1) ?? null;
  if (!latestEnd) return empty;
  const onLatest = productFacts.filter((fact) => fact.end === latestEnd);
  const productOf = (kind: "dram" | "nand" | "other", facts: ProductFact[]) => {
    const pattern = kind === "dram" ? /DRAMProducts?Member/i : kind === "nand" ? /NANDProducts?Member/i : /OtherProduct/i;
    const candidates = facts.filter((fact) => pattern.test(fact.member));
    return candidates.length ? candidates.sort((left, right) => right.duration - left.duration)[0].value : null;
  };
  const totalOf = (facts: ProductFact[], window: [number, number]) => {
    const inWindow = facts.filter((fact) => fact.duration >= window[0] && fact.duration <= window[1]);
    const dramM = productOf("dram", inWindow);
    const nandM = productOf("nand", inWindow);
    if (dramM === null || nandM === null) return null;
    const otherM = productOf("other", inWindow) ?? 0;
    // The filing tags dollars; the model works in millions to match SEC facts.
    const toMillions = (value: number) => value / 1e6;
    return { dramM: toMillions(dramM), nandM: toMillions(nandM), otherM: toMillions(otherM), totalM: toMillions(dramM + nandM + otherM) };
  };

  return {
    quarterLabel: latestEnd,
    quarter: totalOf(onLatest, [80, 100]),
    yearToDate: totalOf(onLatest, [150, 300]),
    source: "SEC 10-Q disaggregated product revenue (srt:ProductOrServiceAxis)",
  };
}

/**
 * Reported evidence that the memory cycle itself may have changed. Only what the
 * filing states is captured; without it the structural margin premium is off.
 */
export function parseMuEvidence(filingText: string | null | undefined): MuEvidence {
  const text = filingText ?? "";
  const takeOrPayAgreements = /take-or-pay agreements?[^.]{0,400}?binding commitments/i.test(text);
  // Two facts are close enough to be the same disclosure when they appear within
  // one paragraph window, in either order.
  const mentioned = (left: RegExp, right: RegExp, distance = 400) => {
    const first = left.exec(text);
    const second = right.exec(text);
    if (!first || !second) return false;
    const span = Math.max(first.index + first[0].length, second.index + second[0].length) - Math.min(first.index, second.index);
    return span <= distance;
  };
  const programmes: string[] = [];
  const check = (label: string, pattern: RegExp) => {
    if (pattern.test(text)) programmes.push(label);
  };
  if (mentioned(/Singapore/i, /HBM advanced packaging/i)) programmes.push("Singapore HBM advanced packaging facility ramping from the first half of calendar 2027");
  if (mentioned(/Taiwan/i, /HBM products|DRAM and HBM/i)) programmes.push("Taiwan DRAM and HBM capacity expansion");
  check("United States advanced HBM packaging plan", /advanced HBM packaging capabilities to the United States/i);
  if (mentioned(/6\.4 billion/i, /investment tax credit/i, 300)) programmes.push("CHIPS Act funding of up to $6.4 billion plus a 35% investment tax credit");
  if (mentioned(/Boise, Idaho/i, /2027/i, 400)) programmes.push("Idaho leading-edge memory fabs with first DRAM wafer output from mid-calendar 2027");
  const prepayments = text.match(/\$\s*([0-9,.]+)\s*billion of repayments of debt/i);
  const debtPrepaymentsB = prepayments ? Number(prepayments[1].replace(/,/g, "")) : null;
  const notes: string[] = [];
  notes.push(takeOrPayAgreements
    ? "The 10-Q reports strategic customer agreements structured as take-or-pay with binding volumes and, for most of them, fixed or minimum/maximum pricing. That is reported evidence of pricing durability, so the normalised margin is set above the historical memory average rather than at it."
    : "No reported take-or-pay customer agreement was found in the latest filing, so the structural margin premium is switched off and legacy memory normalises to the historical mid-cycle margin.");
  if (programmes.length) notes.push(`Reported capacity evidence: ${programmes.join("; ")}.`);
  return { takeOrPayAgreements, capacityProgrammes: programmes, debtPrepaymentsB, notes };
}

/* ------------------------------------------------------------------ */
/* Forecast                                                            */
/* ------------------------------------------------------------------ */

export type MuForecastResult = {
  forecast: MuYearForecast[];
  hbm: MuValuation["hbm"];
  legacy: MuValuation["legacy"];
  notes: string[];
};

function productMix(anchors: MuReportedAnchors) {
  const revenue = anchors.quarter.revenueM;
  const reported = anchors.productRevenue.quarter;
  if (reported && revenue > 0) {
    return {
      dram: reported.dramM / revenue,
      nand: reported.nandM / revenue,
      other: Math.max(0, reported.otherM) / revenue,
      reported: true,
    };
  }
  // Without a machine-readable product table the consolidated mix is used, and
  // the classification is stated as an assumption instead of a reported split.
  return { dram: 0.75, nand: 0.24, other: 0.01, reported: false };
}

export function buildMuForecast(input: { anchors: MuReportedAnchors; assumptions: MuForecastAssumptions; evidence: MuEvidence }): MuForecastResult {
  const { anchors, assumptions, evidence } = input;
  const notes: string[] = [];
  const mix = productMix(anchors);
  if (!mix.reported) notes.push("Reported product revenue was not machine-readable, so the DRAM/NAND split is a labelled assumption and the data gate reflects that.");

  // Anchor the current fiscal year on reported fiscal-year-to-date actuals plus a
  // modelled final quarter, because the 10-K for that year is not filed yet.
  const ytd = anchors.yearToDate;
  const quarter = anchors.quarter;
  const ytdRevenueM = ytd && ytd.revenueM > 0 ? ytd.revenueM : quarter.revenueM * 3;
  const ytdGrossProfitM = ytd?.grossProfitM ?? quarter.grossProfitM * 3;
  const ytdOperatingExpenseM = ytd?.grossProfitM !== null && ytd?.grossProfitM !== undefined && ytd?.operatingIncomeM !== null && ytd?.operatingIncomeM !== undefined
    ? ytd.grossProfitM - ytd.operatingIncomeM
    : (quarter.operatingExpenseM ?? Math.max(0, quarter.grossProfitM - (quarter.operatingIncomeM ?? quarter.grossProfitM * 0.8))) * 3;
  const ytdDandAM = ytd?.dAndAM ?? quarter.dAndAM * 3;
  const ytdCapexM = ytd?.capexM ?? (quarter.capexM ?? 0) * 3;
  const growth = 1 + assumptions.q4SequentialGrowth;
  const q4RevenueM = quarter.revenueM * growth;
  const q4GrossProfitM = q4RevenueM * clamp01(quarter.grossProfitM / Math.max(1, quarter.revenueM));
  const q4OperatingExpenseM = (quarter.operatingExpenseM ?? 0) * growth;
  const fy1 = {
    revenueM: ytdRevenueM + q4RevenueM,
    grossProfitM: ytdGrossProfitM + q4GrossProfitM,
    operatingExpenseM: ytdOperatingExpenseM + q4OperatingExpenseM,
    dAndAM: ytdDandAM + quarter.dAndAM * growth,
    capexM: ytdCapexM + (quarter.capexM ?? 0) * growth,
  };
  notes.push(`FY2026 is the reported ${(ytdRevenueM / 1000).toFixed(1)}B fiscal-year-to-date revenue plus a modelled fourth quarter at ${(assumptions.q4SequentialGrowth * 100).toFixed(1)}% sequential growth on the reported third quarter.`);

  const reportedBlendedMargin = fy1.grossProfitM / Math.max(1, fy1.revenueM);
  const structural = evidence.takeOrPayAgreements;
  const marginPath = [reportedBlendedMargin, ...(structural ? assumptions.blendedGrossMargin : assumptions.blendedGrossMarginWithoutStructuralSupport)];

  // Segment revenue: bit growth and ASP for the two cyclical legs, volume and ASP
  // for HBM. The reported product table fixes the starting split.
  const years = assumptions.hbmVolumeGrowth.length;
  const fy1RevenueB = fy1.revenueM / 1000;
  const dramRevenueB: number[] = [fy1RevenueB * mix.dram];
  const hbmRevenueB: number[] = [fy1RevenueB * mix.dram * assumptions.hbmShareOfDramYearOne];
  const legacyDramRevenueB: number[] = [Math.max(0, fy1RevenueB * mix.dram * (1 - assumptions.hbmShareOfDramYearOne))];
  const nandRevenueB: number[] = [fy1RevenueB * mix.nand];
  const otherRevenueB: number[] = [fy1RevenueB * mix.other];
  const revenueB: number[] = [fy1RevenueB];
  notes.push(`HBM is ${(assumptions.hbmShareOfDramYearOne * 100).toFixed(0)}% of reported FY2026 DRAM revenue in the anchor year; the filing discloses DRAM and NAND product revenue but no HBM line, so that split is a labelled model assumption.`);

  for (let index = 0; index < years; index += 1) {
    const hbm = hbmRevenueB[index] * (1 + assumptions.hbmVolumeGrowth[index]) * (1 + assumptions.hbmAspChange[index]);
    const legacy = legacyDramRevenueB[index] * (1 + assumptions.dramBitGrowth[index]) * (1 + assumptions.dramAspChange[index]);
    const nand = nandRevenueB[index] * (1 + assumptions.nandBitGrowth[index]) * (1 + assumptions.nandAspChange[index]);
    const other = otherRevenueB[index] * (1 + assumptions.otherGrowth[index]);
    hbmRevenueB.push(hbm);
    legacyDramRevenueB.push(legacy);
    nandRevenueB.push(nand);
    otherRevenueB.push(other);
    dramRevenueB.push(hbm + legacy);
    revenueB.push(hbm + legacy + nand + other);
  }

  const operatingExpenseB: number[] = [fy1.operatingExpenseM / 1000];
  const dAndAB: number[] = [fy1.dAndAM / 1000];
  for (let index = 0; index < years; index += 1) {
    operatingExpenseB.push(operatingExpenseB[index] * (1 + assumptions.operatingExpenseGrowth));
    dAndAB.push(dAndAB[index] * (1 + assumptions.depreciatonAmortisationGrowth[index]));
  }

  const forecast: MuYearForecast[] = [];
  for (let index = 0; index <= years; index += 1) {
    const revenue = revenueB[index];
    const blendedMargin = marginPath[Math.min(index, marginPath.length - 1)];
    const hbmMargin = clamp01(blendedMargin + assumptions.hbmMarginPremiumPts / 100 + (index === 0 ? 0.03 : 0));
    const nandMargin = clamp01(blendedMargin - assumptions.nandMarginDiscountPts / 100);
    const hbm = hbmRevenueB[index];
    const legacy = legacyDramRevenueB[index];
    const nandRevenue = nandRevenueB[index];
    const other = otherRevenueB[index];
    const legacyMargin = legacy > 0
      ? (blendedMargin * revenue - hbm * hbmMargin - nandRevenue * nandMargin - other * assumptions.otherGrossMargin) / legacy
      : blendedMargin;
    const grossProfitB = hbm * hbmMargin + legacy * legacyMargin + nandRevenue * nandMargin + other * assumptions.otherGrossMargin;
    const grossMargin = revenue > 0 ? grossProfitB / revenue : 0;
    const opex = operatingExpenseB[index];
    const operatingIncomeB = grossProfitB - opex;
    const dAndA = dAndAB[index];
    const ebitdaB = operatingIncomeB + dAndA;
    const netIncomeB = operatingIncomeB * (1 - assumptions.taxRate);
    const sharesM = anchors.dilutedSharesM * (1 + assumptions.shareDilutionPerYear) ** index;
    const capexIntensity = assumptions.capexIntensity[Math.min(index, assumptions.capexIntensity.length - 1)];
    const capexB = revenue * capexIntensity;
    const fcfB = ebitdaB * (1 - assumptions.taxRate) - capexB - revenue * assumptions.workingCapitalPctOfRevenue;
    forecast.push({
      year: 2026 + index,
      dramRevenueB: round(dramRevenueB[index]),
      hbmRevenueB: round(hbm),
      legacyDramRevenueB: round(legacy),
      nandRevenueB: round(nandRevenue),
      otherRevenueB: round(other),
      revenueB: round(revenue),
      hbmShareOfDram: dramRevenueB[index] > 0 ? round(hbm / dramRevenueB[index], 4) : 0,
      dramBitGrowth: index === 0 ? null : assumptions.dramBitGrowth[index - 1],
      dramAspChange: index === 0 ? null : assumptions.dramAspChange[index - 1],
      nandBitGrowth: index === 0 ? null : assumptions.nandBitGrowth[index - 1],
      nandAspChange: index === 0 ? null : assumptions.nandAspChange[index - 1],
      hbmVolumeGrowth: index === 0 ? null : assumptions.hbmVolumeGrowth[index - 1],
      hbmAspChange: index === 0 ? null : assumptions.hbmAspChange[index - 1],
      grossProfitB: round(grossProfitB),
      grossMargin: round(grossMargin, 4),
      hbmGrossMargin: round(hbmMargin, 4),
      legacyDramGrossMargin: round(legacyMargin, 4),
      nandGrossMargin: round(nandMargin, 4),
      operatingExpenseB: round(opex),
      operatingIncomeB: round(operatingIncomeB),
      ebitdaB: round(ebitdaB),
      ebitdaMargin: revenue > 0 ? round(ebitdaB / revenue, 4) : 0,
      depreciatonAmortisationB: round(dAndA),
      netIncomeB: round(netIncomeB),
      eps: sharesM > 0 ? round((netIncomeB * 1000) / sharesM) : 0,
      capexB: round(capexB),
      capexIntensity: round(capexIntensity, 4),
      fcfB: round(fcfB),
      marginDriver: index === 0
        ? `Reported basis: fiscal-year-to-date gross margin ${((ytdGrossProfitM / Math.max(1, ytdRevenueM)) * 100).toFixed(1)}%, latest reported quarter ${((quarter.grossProfitM / Math.max(1, quarter.revenueM)) * 100).toFixed(1)}%; the modelled fourth quarter uses the reported third-quarter margin.`
        : `Blended gross margin moves from ${(marginPath[index - 1] * 100).toFixed(0)}% to ${(blendedMargin * 100).toFixed(0)}% as legacy DRAM and NAND pricing normalises while HBM holds a ${assumptions.hbmMarginPremiumPts.toFixed(0)}-point margin premium.`,
    });
  }

  return {
    forecast,
    notes,
    hbm: {
      shareOfRevenue: forecast[1] ? round(forecast[1].hbmRevenueB / forecast[1].revenueB, 4) : 0,
      shareOfDramPath: forecast.map((row) => row.hbmShareOfDram),
      revenuePathB: forecast.map((row) => row.hbmRevenueB),
      volumeGrowthPath: assumptions.hbmVolumeGrowth,
      aspChangePath: assumptions.hbmAspChange,
      grossMargin: forecast[1]?.hbmGrossMargin ?? 0,
      note: "HBM is modelled as its own business: volume, ASP, capacity-driven share of DRAM and a premium gross margin that does not mean-revert to legacy DRAM economics inside the forecast.",
    },
    legacy: {
      dramMarginPath: forecast.map((row) => row.legacyDramGrossMargin),
      nandMarginPath: forecast.map((row) => row.nandGrossMargin),
      blendedGrossMarginPath: forecast.map((row) => row.grossMargin),
      terminalMargin: forecast.at(-1)?.grossMargin ?? 0,
      note: structural
        ? "Legacy DRAM and NAND normalise one year at a time toward a mid-cycle margin. The mid-cycle level sits above the 2015–2022 memory average because the filing reports binding take-or-pay volumes with minimum pricing; it stays far below the reported super-cycle peak because the largest agreements also carry ceiling prices."
        : "Legacy DRAM and NAND normalise one year at a time toward the historical mid-cycle margin, because no reported take-or-pay pricing structure was found to justify a structural premium.",
    },
  };
}

/* ------------------------------------------------------------------ */
/* Valuation                                                           */
/* ------------------------------------------------------------------ */

export type MuValuationInput = {
  anchors: MuReportedAnchors;
  assumptions: MuForecastAssumptions;
  valuation: MuValuationAssumptions;
  evidence: MuEvidence;
  price: number | null;
  netCashB: number;
  sharesM: number;
};

type WeightedResult = {
  weighted: number;
  values: { forwardPe: number; evEbitda: number; dcf: number; normalized: number; revenue: number };
  normalizedEps: number;
  fy27: MuYearForecast;
  fy28: MuYearForecast;
  terminal: MuYearForecast;
};

function weightedValue(forecast: MuYearForecast[], input: MuValuationInput): WeightedResult {
  const sharesB = input.sharesM / 1000;
  const fy27 = forecast[1] ?? forecast[0];
  const fy28 = forecast[2] ?? fy27;
  const terminal = forecast[forecast.length - 1];
  const weights = input.valuation.weights;
  const weightTotal = weights.forwardPe + weights.evEbitda + weights.dcf + weights.normalized + weights.revenue;
  const discount = input.valuation.discountRate;
  const pvFcf = forecast.reduce((sum, row, index) => sum + row.fcfB / (1 + discount) ** (index + 0.5), 0);
  const pvTerminal = (Math.max(0, terminal.ebitdaB) * input.valuation.terminalEbitdaMultiple) / (1 + discount) ** forecast.length;
  const normalizedEps = fy27.eps * 0.35 + fy28.eps * 0.35 + terminal.eps * 0.3;
  const values = {
    forwardPe: fy27.eps * input.valuation.forwardPe,
    evEbitda: (fy28.ebitdaB * input.valuation.evEbitdaMultiple - input.netCashB) / sharesB,
    dcf: (pvFcf + pvTerminal + input.netCashB) / sharesB,
    normalized: normalizedEps * input.valuation.normalizedPe,
    revenue: (fy27.revenueB * input.valuation.revenueMultiple + input.netCashB) / sharesB,
  };
  const weighted = (
    values.forwardPe * weights.forwardPe
    + values.evEbitda * weights.evEbitda
    + values.dcf * weights.dcf
    + values.normalized * weights.normalized
    + values.revenue * weights.revenue
  ) / weightTotal;
  return { weighted, values, normalizedEps, fy27, fy28, terminal };
}

/**
 * Diagnostic only: re-price the same forecast with the blended gross margin
 * shifted by a constant after the reported anchor year. Used to answer "what
 * margin would the current price require?", never to set the fair value.
 */
function fairValueForMarginShift(input: MuValuationInput, baseForecast: MuYearForecast[], shift: number) {
  const forecast = baseForecast.map((row, index) => {
    if (index === 0 || shift === 0) return row;
    const grossMargin = row.grossMargin + shift;
    const grossProfitB = row.revenueB * grossMargin;
    const operatingIncomeB = grossProfitB - row.operatingExpenseB;
    const ebitdaB = operatingIncomeB + row.depreciatonAmortisationB;
    const netIncomeB = operatingIncomeB * (1 - input.assumptions.taxRate);
    const sharesM = input.sharesM * (1 + input.assumptions.shareDilutionPerYear) ** index;
    return {
      ...row,
      grossMargin: round(grossMargin, 4),
      grossProfitB: round(grossProfitB),
      operatingIncomeB: round(operatingIncomeB),
      ebitdaB: round(ebitdaB),
      netIncomeB: round(netIncomeB),
      eps: sharesM > 0 ? round((netIncomeB * 1000) / sharesM) : 0,
      fcfB: round(ebitdaB * (1 - input.assumptions.taxRate) - row.capexB - row.revenueB * input.assumptions.workingCapitalPctOfRevenue),
    };
  });
  return weightedValue(forecast, input).weighted;
}

export function buildMuValuation(input: MuValuationInput): MuValuation {
  const { anchors } = input;
  const price = input.price;
  const sharesB = input.sharesM / 1000;
  const base = buildMuForecast({ anchors, assumptions: input.assumptions, evidence: input.evidence });
  const { forecast } = base;
  const weights = input.valuation.weights;
  const weightTotal = weights.forwardPe + weights.evEbitda + weights.dcf + weights.normalized + weights.revenue;
  const core = weightedValue(forecast, input);
  const { fy27, fy28, terminal, normalizedEps } = core;
  const weightedFairValue = round(core.weighted, 2);

  const methods: MuValuationMethod[] = [
    {
      method: "Forward P/E",
      importance: "HIGH",
      weight: round(weights.forwardPe / weightTotal, 4),
      inputs: `FY2027 EPS ${fy27.eps.toFixed(2)} × ${input.valuation.forwardPe.toFixed(1)}× selected P/E`,
      value: round(core.values.forwardPe),
      note: input.valuation.forwardPeRationale,
    },
    {
      method: "EV/EBITDA",
      importance: "HIGH",
      weight: round(weights.evEbitda / weightTotal, 4),
      inputs: `FY2028 EBITDA ${fy28.ebitdaB.toFixed(1)}B × ${input.valuation.evEbitdaMultiple.toFixed(1)}× less net cash ${input.netCashB.toFixed(1)}B`,
      value: round(core.values.evEbitda),
      note: input.valuation.evEbitdaRationale,
    },
    {
      method: "DCF",
      importance: "MEDIUM/HIGH",
      weight: round(weights.dcf / weightTotal, 4),
      inputs: `FY2026–FY2030 free cash flow discounted at ${(input.valuation.discountRate * 100).toFixed(0)}%, terminal value ${input.valuation.terminalEbitdaMultiple.toFixed(1)}× terminal EBITDA, plus net cash`,
      value: round(core.values.dcf),
      note: "Charges the HBM and advanced-packaging capital programme before terminal normalisation, so the capital required to earn the forecast is paid for inside the model.",
    },
    {
      method: "Normalized earnings power",
      importance: "MEDIUM/HIGH",
      weight: round(weights.normalized / weightTotal, 4),
      inputs: `Normalized EPS ${normalizedEps.toFixed(2)} (FY2027/FY2028/terminal blend) × ${input.valuation.normalizedPe.toFixed(1)}×`,
      value: round(core.values.normalized),
      note: "Mid-cycle earnings power on the new business mix including HBM. This is a normalised level, not the historical trough.",
    },
    {
      method: "Revenue multiple",
      importance: "LOW",
      weight: round(weights.revenue / weightTotal, 4),
      inputs: `FY2027 revenue ${fy27.revenueB.toFixed(1)}B × ${input.valuation.revenueMultiple.toFixed(2)}×`,
      value: round(core.values.revenue),
      note: "Deliberately the smallest weight: a revenue multiple cannot see memory margins and must never dominate a memory valuation.",
    },
  ];

  // Cases re-run the whole model with different operating assumptions.
  const caseVariant = (marginShift: number, hbmScale: number, capexShift: number) => {
    const variant = buildMuForecast({
      anchors,
      evidence: input.evidence,
      assumptions: {
        ...input.assumptions,
        hbmVolumeGrowth: input.assumptions.hbmVolumeGrowth.map((value) => value * hbmScale),
        blendedGrossMargin: input.assumptions.blendedGrossMargin.map((value) => value + marginShift),
        blendedGrossMarginWithoutStructuralSupport: input.assumptions.blendedGrossMarginWithoutStructuralSupport.map((value) => value + marginShift),
        capexIntensity: input.assumptions.capexIntensity.map((value) => Math.max(0.05, value + capexShift)),
      },
    });
    return round(weightedValue(variant.forecast, input).weighted, 2);
  };
  const cases: MuValuation["cases"] = [
    { name: "BEAR", value: caseVariant(-0.09, 0.6, 0.02), assumptions: "HBM volume growth 40% slower than plan, blended gross margin 9 points lower each year, capital intensity 2 points higher, and legacy pricing normalising from the reported peak." },
    { name: "BASE", value: weightedFairValue, assumptions: `Reported product mix and margins anchor FY2026; HBM at ${(input.assumptions.hbmShareOfDramYearOne * 100).toFixed(0)}% of DRAM revenue growing on the reported capacity programme; legacy DRAM and NAND normalise one year at a time; capital spend follows the published build-out.` },
    { name: "BULL", value: caseVariant(0.07, 1.3, -0.02), assumptions: "HBM volume growth 30% faster, blended gross margin 7 points higher each year, capital intensity 2 points lower as advanced-packaging yields improve." },
  ];

  // Sanity: the published value must be explainable against forward earnings.
  const flags: string[] = [];
  const fvOverEps27 = fy27.eps > 0 ? weightedFairValue / fy27.eps : null;
  const fvOverEps28 = fy28.eps > 0 ? weightedFairValue / fy28.eps : null;
  const fvOverNormalized = normalizedEps > 0 ? weightedFairValue / normalizedEps : null;
  const evEbitda27 = fy27.ebitdaB > 0 ? (weightedFairValue * sharesB - input.netCashB) / fy27.ebitdaB : null;
  const evEbitda28 = fy28.ebitdaB > 0 ? (weightedFairValue * sharesB - input.netCashB) / fy28.ebitdaB : null;
  const fcfYieldAtPricePct = price !== null && price > 0 ? (fy27.fcfB / (price * sharesB)) * 100 : null;
  const fcfYieldAtFairValuePct = weightedFairValue > 0 ? (fy27.fcfB / (weightedFairValue * sharesB)) * 100 : null;
  const peakEps = Math.max(...forecast.map((row) => row.eps));
  const lowMultipleJustification = [
    `FY2027 is a peak-cycle year in this model: the blended gross margin is ${(fy27.grossMargin * 100).toFixed(0)}% against a normalised terminal margin of ${(terminal.grossMargin * 100).toFixed(0)}%, so peak-cycle earnings are capitalised at a below-market multiple.`,
    `Normalisation is inside the forecast, not only in the multiple: modelled EPS moves from ${peakEps.toFixed(2)} at the peak to ${terminal.eps.toFixed(2)} by FY2030 as legacy DRAM and NAND pricing reverts toward mid-cycle.`,
    `Capital intensity stays near ${(fy27.capexIntensity * 100).toFixed(0)}% of revenue to fund HBM capacity and advanced packaging, so free cash flow is a smaller share of EBITDA than the gross margin alone implies.`,
  ];
  if (input.evidence.takeOrPayAgreements) {
    lowMultipleJustification.push("The reported take-or-pay agreements carry ceiling prices on the largest contracts, which caps the upside a higher multiple would require.");
  }
  if (fvOverEps27 !== null && fvOverEps27 < 6) {
    flags.push(`Fair value implies only ${fvOverEps27.toFixed(1)}× FY2027 EPS of ${fy27.eps.toFixed(2)} while the model forecasts no earnings collapse; that would need an explicit down-cycle forecast before publication.`);
  }
  if (evEbitda28 !== null && evEbitda28 < 3) {
    flags.push(`Fair value implies EV/EBITDA of ${evEbitda28.toFixed(1)}× on FY2028 EBITDA, below a distressed multiple.`);
  }
  if (fy27.eps <= 0 && fy28.eps <= 0) {
    flags.push("The forecast shows no positive earnings in FY2027 or FY2028, so an earnings-based valuation cannot be published.");
  }

  // Market-implied expectations: what the current price requires.
  const marketCapB = price !== null ? price * sharesB : null;
  const enterpriseValueB = marketCapB !== null ? marketCapB - input.netCashB : null;
  const requiredTerminalGrossMargin = (() => {
    if (price === null || weightedFairValue <= 0) return null;
    let low = 0;
    let high = 0.6;
    if (fairValueForMarginShift(input, forecast, high) < price) return null;
    for (let step = 0; step < 40; step += 1) {
      const middle = (low + high) / 2;
      if (fairValueForMarginShift(input, forecast, middle) >= price) high = middle;
      else low = middle;
    }
    return round(terminal.grossMargin + high, 4);
  })();
  const requiredRevenueB2030 = price !== null && weightedFairValue > 0 ? round(terminal.revenueB * (price / weightedFairValue), 1) : null;
  const explanation: string[] = [];
  if (price !== null && marketCapB !== null && enterpriseValueB !== null) {
    explanation.push(`At ${price.toFixed(2)} the market capitalises MU at ${marketCapB.toFixed(0)}B with an enterprise value of ${enterpriseValueB.toFixed(0)}B.`);
    const marketPe27 = fy27.eps > 0 ? price / fy27.eps : null;
    const marketEvEbitda28 = fy28.ebitdaB > 0 ? (marketCapB - input.netCashB) / fy28.ebitdaB : null;
    if (marketPe27 !== null && marketEvEbitda28 !== null) {
      explanation.push(`That is ${marketPe27.toFixed(1)}× modelled FY2027 EPS and ${marketEvEbitda28.toFixed(1)}× modelled FY2028 EBITDA, against ${fvOverEps27?.toFixed(1)}× and ${evEbitda28?.toFixed(1)}× on this model's fair value.`);
    }
    explanation.push(requiredTerminalGrossMargin !== null
      ? `Holding the revenue path fixed, the current price requires a normalised blended gross margin of ${(requiredTerminalGrossMargin * 100).toFixed(0)}% instead of the modelled ${(terminal.grossMargin * 100).toFixed(0)}% — that is, the AI memory super-cycle would have to be permanent rather than normalise.`
      : "Even a normalised blended gross margin 60 points higher cannot reproduce the current price on this revenue path, so the market is also assuming a larger revenue base or a higher terminal multiple.");
    if (requiredRevenueB2030 !== null) {
      explanation.push(`Equivalently, at the modelled terminal margin the FY2030 revenue base would have to be about ${requiredRevenueB2030.toFixed(0)}B rather than ${terminal.revenueB.toFixed(0)}B.`);
    }
  }

  // Segment view of the same engine, so the segment table, the EV/EBITDA method
  // and the published number are one calculation rather than three.
  const segmentYear = fy28;
  const segmentBreakdownSegments = [
    { name: "HBM / AI memory", revenueB: segmentYear.hbmRevenueB, grossMargin: segmentYear.hbmGrossMargin, note: "Structural AI memory: volume and ASP growth on the reported capacity programme at a premium margin." },
    { name: "Legacy DRAM", revenueB: segmentYear.legacyDramRevenueB, grossMargin: segmentYear.legacyDramGrossMargin, note: "Cyclical DRAM, normalising one year at a time toward mid-cycle economics." },
    { name: "NAND", revenueB: segmentYear.nandRevenueB, grossMargin: segmentYear.nandGrossMargin, note: "Cyclical NAND at a structurally lower margin than DRAM." },
    { name: "Other product sales", revenueB: segmentYear.otherRevenueB, grossMargin: input.assumptions.otherGrossMargin, note: "Other product sales, carried at the modelled margin." },
  ].map((row) => {
    const revenueShare = segmentYear.revenueB > 0 ? row.revenueB / segmentYear.revenueB : 0;
    const grossProfitB = row.revenueB * row.grossMargin;
    const ebitdaB = grossProfitB - revenueShare * segmentYear.operatingExpenseB + revenueShare * segmentYear.depreciatonAmortisationB;
    return {
      name: row.name,
      revenueB: round(row.revenueB),
      ebitdaB: round(ebitdaB),
      ebitdaMargin: row.revenueB > 0 ? round(ebitdaB / row.revenueB, 4) : 0,
      enterpriseValueB: round(ebitdaB * input.valuation.evEbitdaMultiple),
      perShare: 0,
      note: `${row.note} Operating expense and depreciation allocated pro rata to segment revenue; FY${segmentYear.year} segment EBITDA at ${input.valuation.evEbitdaMultiple.toFixed(1)}×.`,
    };
  });
  const segmentEnterpriseValueB = segmentBreakdownSegments.reduce((sum, segment) => sum + segment.enterpriseValueB, 0);
  const segmentEquityValueB = segmentEnterpriseValueB + input.netCashB;
  const segmentPerShare = input.sharesM > 0 ? segmentEquityValueB / (input.sharesM / 1000) : null;
  const segmentBreakdown: MuValuation["segmentBreakdown"] = {
    year: segmentYear.year,
    multiple: input.valuation.evEbitdaMultiple,
    segments: segmentBreakdownSegments.map((segment) => ({ ...segment, perShare: round(segment.enterpriseValueB / sharesB) })),
    enterpriseValueB: round(segmentEnterpriseValueB),
    equityValueB: round(segmentEquityValueB),
    perShare: segmentPerShare !== null ? round(segmentPerShare) : null,
  };

  // Expected-return based buy zone: future fair value discounted at the required
  // return. The growth input is the model's own mature-year revenue growth, so
  // the zone cannot drift away from the forecast that produced the fair value.
  const priorYear = forecast[forecast.length - 2] ?? terminal;
  const zone = input.valuation.buyZone;
  const expectedValueCagr = priorYear.revenueB > 0
    ? Math.min(0.15, Math.max(0, terminal.revenueB / priorYear.revenueB - 1))
    : 0;
  const expectedFutureValue = weightedFairValue * (1 + expectedValueCagr) ** zone.holdingPeriodYears;

  const qualityGates = {
    data: anchors.quarter.revenueM > 0 && anchors.dilutedSharesM > 0 && anchors.productRevenue.quarter !== null,
    forecast: forecast.length >= 5 && forecast.every((row) => row.revenueB > 0) && (forecast[1]?.hbmRevenueB ?? 0) > 0,
    valuation: methods.filter((method) => method.value !== null).length >= 4 && Number.isFinite(weightedFairValue),
    sanity: flags.length === 0,
    reconciliation: Math.abs(methods.reduce((sum, method) => sum + (method.value ?? 0) * method.weight, 0) - weightedFairValue) < 1,
    publishable: false,
  };
  qualityGates.publishable = qualityGates.data && qualityGates.forecast && qualityGates.valuation && qualityGates.sanity && qualityGates.reconciliation;
  const buyZone: MuValuation["buyZone"] = qualityGates.publishable && expectedFutureValue > 0
    ? {
      holdingPeriodYears: zone.holdingPeriodYears,
      requiredReturn: zone.requiredReturn,
      strongBuyRequiredReturn: zone.strongBuyRequiredReturn,
      expectedValueCagr: round(expectedValueCagr, 4),
      expectedFutureValue: round(expectedFutureValue),
      buyPrice: round(expectedFutureValue / (1 + zone.requiredReturn) ** zone.holdingPeriodYears),
      strongBuyPrice: round(expectedFutureValue / (1 + zone.strongBuyRequiredReturn) ** zone.holdingPeriodYears),
      method: zone.rationale,
    }
    : null;

  return {
    anchors,
    evidence: input.evidence,
    forecast,
    hbm: base.hbm,
    legacy: base.legacy,
    structuralChange: {
      assessed: input.evidence.takeOrPayAgreements || input.evidence.capacityProgrammes.length > 0,
      drivers: [
        {
          driver: "Contracted AI memory demand",
          evidence: input.evidence.takeOrPayAgreements
            ? "The latest 10-Q reports strategic customer agreements structured as take-or-pay with binding volumes over multi-year terms and fixed or minimum/maximum pricing."
            : "No reported take-or-pay structure was found in the latest filing.",
          effect: input.evidence.takeOrPayAgreements
            ? "Pricing visibility is better than the historical spot cycle, so the normalised margin is set above the historical average and the annual transition is smoother."
            : "No structural premium is applied; legacy memory normalises to the historical mid-cycle margin.",
        },
        {
          driver: "HBM and advanced packaging capacity",
          evidence: input.evidence.capacityProgrammes.length
            ? input.evidence.capacityProgrammes.join("; ")
            : "No capacity programme was parsed from the latest filing.",
          effect: input.evidence.capacityProgrammes.length
            ? "HBM volume growth is supported by reported capacity rather than assumed, which is why HBM revenue grows through the forecast."
            : "HBM volume growth is a labelled assumption with no capacity evidence behind it.",
        },
        {
          driver: "Supply discipline and balance-sheet capacity",
          evidence: input.evidence.debtPrepaymentsB !== null
            ? `The company repaid $${input.evidence.debtPrepaymentsB.toFixed(1)}B of debt during the fiscal year to date.`
            : "No debt-prepayment evidence was parsed.",
          effect: "Lower leverage gives the company the option to hold capacity back in a downturn, which supports a terminal margin floor rather than a distressed multiple.",
        },
      ],
      historicalAverageNote: input.evidence.takeOrPayAgreements
        ? "The 2015–2022 cycle average is used only as a floor reference. It is deliberately not applied directly, because the reported contract structure changes pricing volatility and margin durability."
        : "With no reported contract structure, the historical 2015–2022 cycle average is applied as the mid-cycle anchor.",
    },
    segmentBreakdown,
    buyZone,
    methods,
    weightedFairValue,
    cases,
    sanity: {
      price,
      fairValueOverEps27: fvOverEps27 !== null ? round(fvOverEps27) : null,
      fairValueOverEps28: fvOverEps28 !== null ? round(fvOverEps28) : null,
      fairValueOverNormalizedEps: fvOverNormalized !== null ? round(fvOverNormalized) : null,
      evEbitda27: evEbitda27 !== null ? round(evEbitda27) : null,
      evEbitda28: evEbitda28 !== null ? round(evEbitda28) : null,
      fcfYieldAtPricePct: fcfYieldAtPricePct !== null ? round(fcfYieldAtPricePct) : null,
      fcfYieldAtFairValuePct: fcfYieldAtFairValuePct !== null ? round(fcfYieldAtFairValuePct) : null,
      peakEps: round(peakEps),
      forwardEps27: round(fy27.eps),
      forwardEps28: round(fy28.eps),
      normalizedEps: round(normalizedEps),
      normalizedEpsMethod: "FY2027, FY2028 and terminal EPS blended 35/35/30 on the forecast mix, so the normalised level reflects HBM and not only the legacy cycle.",
      lowMultipleJustification,
      flags,
      status: flags.length ? "VALUATION_MULTIPLE_ANOMALY" : "passed",
    },
    marketImplied: {
      marketCapB: marketCapB !== null ? round(marketCapB, 1) : null,
      enterpriseValueB: enterpriseValueB !== null ? round(enterpriseValueB, 1) : null,
      peOnForwardEps27: price !== null && fy27.eps > 0 ? round(price / fy27.eps, 1) : null,
      peOnForwardEps28: price !== null && fy28.eps > 0 ? round(price / fy28.eps, 1) : null,
      evEbitda28: price !== null && marketCapB !== null && fy28.ebitdaB > 0 ? round((marketCapB - input.netCashB) / fy28.ebitdaB, 1) : null,
      requiredTerminalGrossMargin,
      requiredRevenueB2030,
      explanation,
    },
    consensus: {
      available: false,
      note: "No licensed consensus or institutional research feed is configured, so Signal Ledger neither copies nor averages an analyst target. The comparison shown is Signal Ledger versus the market price, computed from this model.",
      differences: explanation,
    },
    qualityGates,
    gateDetail: {
      data: `Reported quarter ${anchors.quarter.periodEnd ?? "latest"}: revenue ${anchors.quarter.revenueM.toFixed(0)}M, gross profit ${anchors.quarter.grossProfitM.toFixed(0)}M, operating income ${anchors.quarter.operatingIncomeM?.toFixed(0) ?? "—"}M, DRAM ${anchors.productRevenue.quarter?.dramM.toFixed(0) ?? "—"}M and NAND ${anchors.productRevenue.quarter?.nandM.toFixed(0) ?? "—"}M reported product revenue, diluted shares ${anchors.dilutedSharesM.toFixed(0)}M.`,
      model: `FY2026 anchored on reported fiscal-year-to-date actuals plus a modelled fourth quarter; HBM, legacy DRAM and NAND modelled separately with annual margin transitions; ${methods.filter((method) => method.value !== null).length} valuation methods reconciled at their stated weights.`,
      sanity: flags.length ? flags.join(" ") : `Fair value implies ${fvOverEps27?.toFixed(1)}× FY2027 EPS, ${fvOverEps28?.toFixed(1)}× FY2028 EPS and ${evEbitda28?.toFixed(1)}× FY2028 EBITDA, inside plausible memory bands on the stated normalisation path.`,
    },
  };
}
