import type { CheckProvenance } from "./research-isolation";
import { getVerifiedIssuerProfile, VERIFIED_MAJOR_STOCK_TICKERS } from "./issuer-intelligence";
import type { AiExposureProfile } from "./ai-exposure";
import type { SpcxShareBridge, SpcxValuation } from "./spcx-valuation";
import type { MuValuation } from "./mu-valuation";
import type { CapitalCostEstimate } from "./valuation-capital-cost";

export type ModelFamilyId =
  | "ai_compute_platform"
  | "ai_semiconductor"
  | "cyclical_semiconductor"
  | "mature_semiconductor"
  | "foundry_semiconductor"
  | "semiconductor_infrastructure"
  | "consumer_tech_platform"
  | "digital_platform"
  | "commerce_cloud_hybrid"
  | "ecommerce_platform"
  | "saas_growth"
  | "mature_software"
  | "cloud_software_hybrid"
  | "cloud_software_platform"
  | "stablecoin_network"
  | "crypto_exchange"
  | "bank"
  | "insurance"
  | "asset_manager"
  | "payments"
  | "reit"
  | "utility"
  | "oil_gas"
  | "commodity_producer"
  | "industrial"
  | "airline"
  | "auto"
  | "auto_energy_optionality_sotp"
  | "integrated_space_connectivity_ai_platform"
  | "bitcoin_treasury"
  | "advanced_nuclear_project_npv"
  | "memory_cycle_semiconductor"
  | "biotech"
  | "pharma"
  | "medtech"
  | "consumer_staples"
  | "consumer_discretionary"
  | "telecom"
  | "media"
  | "general_equity";

export type ValuationModelId =
  | "dcf"
  | "normalized_dcf"
  | "forward_pe"
  | "ev_ebitda"
  | "ev_fcf"
  | "ev_sales"
  | "sotp"
  | "residual_income"
  | "p_tbv"
  | "nav"
  | "affo"
  | "rnpv"
  | "project_npv"
  | "bitcoin_nav"
  | "commodity_scenario"
  | "reverse_dcf";

export type Rating = "STRONG BUY" | "BUY" | "WATCH" | "REDUCE" | "SELL";

export type CompanyClassification = {
  ticker: string;
  companyName: string;
  sector: string;
  businessModel: string;
  growthStage: string;
  profitability: string;
  capitalIntensity: string;
  valuationDrivers: string[];
  modelFamily: ModelFamilyId;
  rationale: string;
};

export type CompanyHint = Partial<Omit<CompanyClassification, "ticker" | "modelFamily" | "rationale">>;

export type SotPSegment = {
  name: string;
  metric: string;
  metricValueB: number;
  multiple: number;
  probability?: number;
  ownership?: number;
  /** Reported vs model-derived origin of the driver. */
  driverSource?: "reported" | "company_guidance" | "consensus" | "model_derived";
  /** Valuation method applied to this segment. */
  method?: "dcf" | "revenue_multiple" | "fcf_multiple" | "ebitda_multiple" | "probability_weighted_option" | "capital_based" | "equity_claim";
  /** Margin or discount-rate assumption behind the segment, when one applies. */
  marginAssumption?: number;
  discountRate?: number;
  /** Reporting layer used by the readable segment table. */
  layer?: "core" | "growth" | "optionality";
  /** Explicit enterprise/equity flag so the corporate bridge is applied once. */
  valuationBasis?: "ENTERPRISE_VALUE" | "EQUITY_VALUE";
  /** Segment revenue base, growth and cash flow used for the audit trail. */
  currentRevenueB?: number;
  growthCagr?: number;
  cashFlowB?: number;
};

export type RnpvAsset = {
  name: string;
  unadjustedNpvB: number;
  probability: number;
};

export type ProjectNpvAsset = {
  name: string;
  npvB: number;
  probability: number;
};

/**
 * How the operating cash-flow stream was derived, and therefore which discount
 * rate it correctly pairs with. This is the P0 financial口径 boundary: a stream
 * tagged `fcff_ebit_bridge` is unlevered and must be discounted at WACC, while
 * `cfo_capex_proxy` is a levered reported proxy that already nets interest and
 * working-capital cash and must be labelled as an approximation, never silently
 * presented as FCFF.
 */
export type CashFlowBasis =
  | "fcff_ebit_bridge"   // EBIT×(1−tax) + D&A − CapEx − ΔNWC (complete); discounts at WACC + net cash bridge
  | "fcff_before_nwc"    // EBIT×(1−tax) + D&A − CapEx, ΔNWC omitted (pre-working-capital proxy); discounts at WACC
  | "fcfe_equity"        // free cash flow to equity; discounts at cost of equity, no net-cash bridge
  | "cfo_capex_proxy"    // reported CFO − CapEx: levered proxy, conversion method and limits stated
  | "analyst_fcff"       // imported research FCFF path; discounts at WACC + net cash bridge
  | "derived_proxy"      // normalized/forecast proxy with a stated conversion method
  | "not_applicable";

export type ValuationAssumptions = {
  /** Sustainable final-year flow before separately modelled one-off investments. */
  terminalCashFlowB?: number;
  cashFlows?: number[];
  normalizedCashFlows?: number[];
  netCashB?: number;
  dilutedSharesB?: number;
  wacc?: number;
  terminalGrowth?: number;
  forwardEps?: number;
  forwardPe?: number;
  normalizedEbitdaB?: number;
  evEbitdaMultiple?: number;
  forwardFcfB?: number;
  evFcfMultiple?: number;
  forwardRevenueB?: number;
  evSalesMultiple?: number;
  fcfMargin?: number;
  sotpSegments?: SotPSegment[];
  bookValuePerShare?: number;
  tangibleBookValuePerShare?: number;
  returnOnEquity?: number;
  costOfEquity?: number;
  residualGrowth?: number;
  priceToTangibleBook?: number;
  navB?: number;
  navPerShare?: number;
  affoPerShare?: number;
  priceToAffo?: number;
  rnpvAssets?: RnpvAsset[];
  projectNpvAssets?: ProjectNpvAsset[];
  bitcoinHoldings?: number;
  bitcoinPriceUsd?: number;
  otherAssetValueB?: number;
  commodityScenarios?: {
    bearEquityValueB: number;
    baseEquityValueB: number;
    bullEquityValueB: number;
    bearProbability?: number;
    bullProbability?: number;
  };
  /** Basis of `cashFlows`, `normalizedCashFlows` and `forwardFcfB`; controls eligible rates and multiples. */
  cashFlowBasis?: CashFlowBasis;
  /** Assumed pre-tax cost of debt behind the levered cost of equity. */
  preTaxCostOfDebt?: number;
  /** Blended effective tax rate used in the unlevered FCFF bridge and the cost of equity. */
  effectiveTaxRate?: number;
  /** Provenance of `effectiveTaxRate`: `book_ebt` (tax ÷ pre-tax income), `ebit_fallback` (tax ÷ EBIT) or `statutory`. */
  taxRateBasis?: "book_ebt" | "ebit_fallback" | "statutory";
  /** Cash tax rate (income taxes paid ÷ pre-tax income) when reported, else null. */
  cashTaxRate?: number | null;
  /** CAPM retains explicitly labelled ERP/spread assumptions even with sourced rate and beta. */
  costOfEquitySource?: "policy_heuristic" | "capm_market_inputs";
};

export type ThesisAdjustments = {
  growthDelta: number;
  marginDelta: number;
  multipleDelta: number;
  note: string;
};

export type ModelRegistryEntry = {
  model: ValuationModelId;
  baseWeight: number;
  /** Weight-of-prior from comparable prior research; not a backtested hit rate. */
  priorReliability: number;
  role: "valuation" | "diagnostic";
};

export type ModelFamily = {
  id: ModelFamilyId;
  label: string;
  models: ModelRegistryEntry[];
  uncertainty: number;
  buyZoneDiscount: number;
  strongBuyZoneDiscount: number;
  primaryQuestion: string;
};

type ReferencePrice = {
  value: number;
  asOf: string;
  source: string;
};

export type CapitalBridge = {
  cashB: number;
  investmentsB: number;
  debtB: number;
  preferredClaimsB?: number;
  minorityInterestB?: number;
  otherClaimsB: number;
  stockCompB: number | null;
  /** Explains a family-specific treatment of the bridge, when one applies. */
  note?: string;
};

export type InputSourceKind =
  | "reported"
  | "company_guidance"
  | "consensus"
  | "internal_forecast"
  | "derived"
  | "analyst_estimate";

export type InputSourceDetail = {
  unit: string;
  asOf: string;
  sourceType: "reported" | "consensus" | "guidance" | "model_derived";
  /** Reported history → normalization → forecast assumption, in plain language. */
  transformation: string;
  confidence: number;
  filingId?: string | null;
};

/** Probability-weighted company-level scenarios compiled from a ResearchPlan. */
export type ScenarioWeightedProfile = {
  /** Each company-level scenario and its own compiled operating baseline. */
  scenarios: Array<{ id: string; name: string; probability: number; baseline: ValuationAssumptions }>;
  /** 1 − Σ(probabilities): the probability of the base (no-scenario) case. */
  residualProbability: number;
};

export type ValuationProfile = {
  classification: CompanyClassification;
  capitalCost?: CapitalCostEstimate | null;
  referencePrice?: ReferencePrice;
  /** When present, the published value is the probability-weighted expectation
   * across company-level scenarios, not the plain ensemble blend. */
  scenarioWeighted?: ScenarioWeightedProfile;
  /** Gross capital-bridge components behind net cash or net debt, when reported. */
  capitalBridge?: CapitalBridge;
  /** Deterministic AI exposure classification (never a valuation of its own). */
  aiExposure?: AiExposureProfile;
  /** Company-specific three-layer detail (SPCX rebuild). */
  spcx?: SpcxValuation & { shareBridge: SpcxShareBridge };
  /** Company-specific structural memory model (MU rebuild). */
  mu?: MuValuation;
  /** Frozen imported research snapshot kept for historical comparison. The
   * current valuation is driven by verified SEC evidence; this reference is
   * surfaced in the provenance but never silently substituted for it. */
  importedResearch?: {
    asOf: string;
    source: string;
    baseline: ValuationAssumptions;
    thesis: ThesisAdjustments;
    modelConfidence: Partial<Record<ValuationModelId, number>>;
    evidenceMissing: string[];
  } | null;
  baseline: ValuationAssumptions;
  thesis: ThesisAdjustments;
  modelConfidence: Partial<Record<ValuationModelId, number>>;
  modelApplicability?: Partial<Record<ValuationModelId, number>>;
  sourcePosture: "analyst_estimate" | "reported_internal_forecast" | "illustrative" | "input_required";
  inputSources?: Partial<Record<keyof ValuationAssumptions, {
    kind: InputSourceKind;
    label: string;
    asOf?: string;
    url?: string;
    /** Provenance labelling: reported history → transformation → forecast. */
    unit?: string;
    sourceType?: InputSourceDetail["sourceType"];
    transformation?: string;
    confidence?: number;
    filingId?: string | null;
  }>>;
  evidenceMissing: string[];
  variantPath: string;
  downsideMechanism: string;
  evidenceGate: string;
  dataQuality?: DataQualityReport;
};

export type DataQualityCheck = {
  provenance?: CheckProvenance;
  id: string;
  label: string;
  status: "passed" | "warning" | "failed";
  detail: string;
};

export type DataQualityReport = {
  status: "passed" | "warning" | "failed";
  valuationRelease: "released" | "screening_only" | "withheld";
  checks: DataQualityCheck[];
};

export type ModelOutput = {
  model: ValuationModelId;
  label: string;
  role: "valuation" | "diagnostic";
  status: "calculated" | "input_required";
  value: number | null;
  baseWeight: number;
  applicability: number;
  confidence: number;
  priorReliability: number;
  effectiveWeight: number;
  explanation: string;
  missingInputs: string[];
  diagnostics?: Record<string, number | null>;
};

export type UniversalValuationOutput = {
  ticker: string;
  status: "decision-grade" | "provisional" | "screening" | "high-uncertainty" | "unavailable";
  classification: CompanyClassification;
  currentPrice: {
    value: number | null;
    asOf: string | null;
    source: string;
  };
  aiBaseline: {
    assumptions: ValuationAssumptions;
    sourcePosture: ValuationProfile["sourcePosture"];
    inputSources: ValuationProfile["inputSources"];
  };
  signalLedgerThesis: {
    adjustments: ThesisAdjustments;
    adjustedAssumptions: ValuationAssumptions;
  };
  models: ModelOutput[];
  ensemble: {
    fairValue: number | null;
    expectedReturn: number | null;
    confidence: number;
    probabilityDistribution: {
      p10: number | null;
      p25: number | null;
      p50: number | null;
      p75: number | null;
      p90: number | null;
    };
    scenarios: {
      bear: number | null;
      base: number | null;
      bull: number | null;
    };
  };
  /** Research Bear/Base/Bull scenario values, probabilities and the probability-
   * weighted expectation. Distinct from `ensemble.scenarios`, which remains the
   * Monte Carlo p10/base/p90 distribution — the two are never conflated. */
  researchScenarios?: {
    baseValue: number | null;
    expectedValue: number | null;
    residualProbability: number;
    scenarios: Array<{ id: string; name: string; probability: number; value: number | null }>;
  };
  marketImpliedExpectations: {
    headline: string;
    impliedFcfCagr: number | null;
    terminalFcfB: number | null;
    impliedRevenueB: number | null;
    impliedForwardPe: number | null;
    /** What the current price requires, quantified rather than described. */
    requiredGrowthPct: number | null;
    requiredMarginPct: number | null;
    requiredRevenueB: number | null;
    requiredSegmentValueB: number | null;
    requiredSuccessProbability: number | null;
  };
  rating: {
    value: Rating;
    riskAdjustedUpside: number | null;
    buyZone: number | null;
    strongBuyZone: number | null;
    rationale: string;
  };
  investorRead: {
    variantPath: string;
    downsideMechanism: string;
    evidenceGate: string;
    evidenceMissing: string[];
  };
  dataQuality: DataQualityReport;
  valuationScenarios: ValuationScenarioSet;
  confidenceLabel: "Decision grade" | "Standard" | "Low confidence";
  /** Confidence is derived from named components, never a single vague score. */
  confidenceBreakdown: {
    dataQuality: number;
    forecastQuality: number;
    modelAgreement: number;
    sourceProvenance: number;
    evidenceFreshness: number;
    total: number;
  };
  /** Deterministic AI exposure classification for this issuer. */
  aiExposure: AiExposureProfile | null;
  /** Spec-facing family id; internal segment suffixes are not exposed. */
  valuationFamilyAlias: string;
  /** Company-specific detail (SPCX three-layer rebuild). */
  spcx: (SpcxValuation & { shareBridge: SpcxShareBridge }) | null;
  /** Company-specific structural memory detail (MU). */
  mu: MuValuation | null;
  /**
   * Global valuation quality control: data / model / sanity gates, implied
   * multiples, divergence review and the "why are we different" comparison.
   * A fair value may only be presented as published research when these pass.
   */
  qualityReview: {
    status: "passed" | "MODEL_CHECK_REQUIRED" | "MODEL_DIVERGENCE_REVIEW";
    publishable: boolean;
    gates: Array<{ id: string; label: string; status: "passed" | "failed"; detail: string }>;
    impliedMultiples: {
      fairValueEvRevenue: number | null;
      fairValueEvEbitda: number | null;
      fairValueFcfYieldPct: number | null;
      marketEvRevenue: number | null;
      marketEvEbitda: number | null;
      flags: string[];
    };
    divergence: { gapPct: number | null; threshold: number; status: "within_bounds" | "MODEL_DIVERGENCE_REVIEW"; explanation: string[] };
    whyDifferent: Array<{ metric: string; signalLedger: string; market: string; publicResearch: string }>;
    externalResearch: Array<{ institution: string; date: string; target: number | null; method: string | null; assumptions: string | null; sourceUrl: string | null }>;
    /** Preliminary number kept for Model Audit when publication is blocked. */
    preliminaryFairValue: number | null;
  };
  /** Hard release gate: a valuation is only directional when the bridge closes. */
  releaseGate: "passed" | "model_check_required";
  releaseGateDetail: string;
  /** Published capital bridge, so the per-share result can be checked by hand. */
  capitalBridge: CapitalBridge | null;
  reconciliation: {
    segmentValueB: number | null;
    enterpriseValueB: number | null;
    cashB: number | null;
    investmentsB: number | null;
    debtB: number | null;
    preferredClaimsB: number | null;
    minorityInterestB: number | null;
    otherClaimsB: number | null;
    dilutionB: number | null;
    equityValueB: number | null;
    basicSharesB: number | null;
    dilutedSharesB: number | null;
    perShare: number | null;
    differencePct: number | null;
    warnings: string[];
    bridgeInputsConsistent: boolean;
    matchesFairValue: boolean;
  };
  engine: {
    family: ModelFamily;
    capitalCost: CapitalCostEstimate | null;
    simulationCount: number;
    simulation: ValuationSimulation["audit"];
    formula: string;
    modelsCalculated: number;
    modelsIncluded: number;
    valuationModelsRouted: number;
    /** Which route produced the published number. */
    publishedBasis: "reconciled_segment_sotp" | "ensemble";
    publishedModel: ValuationModelId | null;
  };
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const formatUsdB = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : `$${value.toFixed(2)}`;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;

const model = (
  name: ValuationModelId,
  baseWeight: number,
  priorReliability: number,
  role: "valuation" | "diagnostic" = "valuation",
): ModelRegistryEntry => ({ model: name, baseWeight, priorReliability, role });

/** Year-one growth implied by the routed cash-flow path, used only to explain a model-to-price gap. */
function nextGrowthFromAssumptions(assumptions: ValuationAssumptions) {
  const path = assumptions.normalizedCashFlows ?? assumptions.cashFlows;
  if (!path || path.length < 2 || !positive(path[0]) || !finite(path[1])) return 0;
  return clamp(path[1] / path[0] - 1, -1, 3);
}

export type ValuationScenarioSet = {
  method: "segment_sotp" | "distribution";
  bear: { value: number | null; assumptions: string };
  base: { value: number | null; assumptions: string };
  bull: { value: number | null; assumptions: string };
  weights: { bear: number; base: number; bull: number };
  weighted: number | null;
};

/**
 * Bear / Base / Bull are generated from separable economic drivers before they
 * are probability weighted, so the three cases differ for stated reasons rather
 * than as percentiles of one blended number.
 */
function buildValuationScenarios(
  familyId: ModelFamilyId,
  assumptions: ValuationAssumptions,
  distribution: { p10: number | null; p50: number | null; p90: number | null },
  useSegments = true,
): ValuationScenarioSet {
  const weights = { bear: 0.25, base: 0.5, bull: 0.25 };
  const anchors = PRIMARY_ANCHORS[familyId] ?? [];
  const segments = assumptions.sotpSegments;
  if (useSegments && anchors.includes("sotp") && segments?.length) {
    const rescale = (mode: "bear" | "base" | "bull") => ({
      ...assumptions,
      sotpSegments: segments.map((segment) => {
        if (mode === "base") return { ...segment };
        const optionality = (segment.probability ?? 1) < 1;
        if (mode === "bear") {
          return {
            ...segment,
            probability: optionality ? clamp((segment.probability ?? 1) * 0.5, 0, 1) : segment.probability,
            metricValueB: segment.metricValueB * 0.9,
            multiple: segment.multiple * 0.85,
          };
        }
        return {
          ...segment,
          probability: optionality ? clamp((segment.probability ?? 1) * 1.35, 0, 1) : segment.probability,
          metricValueB: segment.metricValueB * 1.08,
          multiple: segment.multiple * 1.15,
        };
      }),
    });
    const valueOf = (mode: "bear" | "base" | "bull") => VALUATION_MODELS.sotp.run(rescale(mode), null).value;
    const bear = valueOf("bear");
    const base = valueOf("base");
    const bull = valueOf("bull");
    const weighted = bear !== null && base !== null && bull !== null
      ? bear * weights.bear + base * weights.base + bull * weights.bull
      : null;
    return {
      method: "segment_sotp",
      bear: { value: bear, assumptions: "Development-optionality delivery probabilities halved, segment revenue 10% below base and segment multiples 15% lower." },
      base: { value: base, assumptions: "Reported segment mix with the stated delivery probabilities and through-cycle multiples." },
      bull: { value: bull, assumptions: "Optionality probabilities 1.35× base (capped at certainty), segment revenue 8% above base and multiples 15% higher." },
      weights,
      weighted,
    };
  }
  const weighted = distribution.p10 !== null && distribution.p50 !== null && distribution.p90 !== null
    ? distribution.p10 * weights.bear + distribution.p50 * weights.base + distribution.p90 * weights.bull
    : null;
  return {
    method: "distribution",
    bear: { value: distribution.p10, assumptions: "10th percentile of the deterministic model distribution across included models." },
    base: { value: distribution.p50, assumptions: "Median of the deterministic model distribution across included models." },
    bull: { value: distribution.p90, assumptions: "90th percentile of the deterministic model distribution across included models." },
    weights,
    weighted,
  };
}

export const PRIMARY_ANCHORS: Partial<Record<ModelFamilyId, ValuationModelId[]>> = {
  cyclical_semiconductor: ["sotp", "normalized_dcf", "ev_ebitda"],
  memory_cycle_semiconductor: ["normalized_dcf", "ev_ebitda", "sotp"],
  foundry_semiconductor: ["sotp"],
  reit: ["nav", "affo"],
  biotech: ["rnpv"],
  pharma: ["normalized_dcf", "rnpv"],
  oil_gas: ["commodity_scenario", "nav", "normalized_dcf"],
  commodity_producer: ["commodity_scenario", "nav", "normalized_dcf"],
  auto_energy_optionality_sotp: ["sotp"],
  integrated_space_connectivity_ai_platform: ["sotp"],
  bitcoin_treasury: ["bitcoin_nav"],
  advanced_nuclear_project_npv: ["project_npv"],
  stablecoin_network: ["sotp"],
};

export const MODEL_FAMILIES: Record<ModelFamilyId, ModelFamily> = {
  ai_compute_platform: {
    id: "ai_compute_platform",
    label: "AI Compute Platform / Structural Growth",
    models: [model("dcf", 0.28, 0.73), model("forward_pe", 0.24, 0.76), model("ev_fcf", 0.2, 0.71), model("ev_sales", 0.1, 0.61), model("reverse_dcf", 0, 0.74, "diagnostic")],
    uncertainty: 0.25,
    buyZoneDiscount: 0.09,
    strongBuyZoneDiscount: 0.18,
    primaryQuestion: "How much durable compute growth, software mix and cash conversion is already priced in?",
  },
  ai_semiconductor: {
    id: "ai_semiconductor",
    label: "AI Semiconductor / Structural Growth",
    models: [model("sotp", 0.32, 0.7), model("dcf", 0.3, 0.72), model("forward_pe", 0.2, 0.75), model("ev_fcf", 0.18, 0.69), model("ev_sales", 0.12, 0.61), model("reverse_dcf", 0, 0.74, "diagnostic")],
    uncertainty: 0.24,
    buyZoneDiscount: 0.08,
    strongBuyZoneDiscount: 0.17,
    primaryQuestion: "How much durable accelerator growth and cash conversion is already capitalized?",
  },
  cyclical_semiconductor: {
    id: "cyclical_semiconductor",
    label: "Cyclical Semiconductor / Segment Normalization",
    models: [model("sotp", 0.32, 0.7), model("normalized_dcf", 0.28, 0.72), model("ev_ebitda", 0.22, 0.73), model("forward_pe", 0.12, 0.68), model("reverse_dcf", 0, 0.69, "diagnostic")],
    uncertainty: 0.29,
    buyZoneDiscount: 0.12,
    strongBuyZoneDiscount: 0.23,
    primaryQuestion: "What are the segments worth on normalized utilization, earnings and capital intensity through the cycle?",
  },
  mature_semiconductor: {
    id: "mature_semiconductor",
    label: "Mature / Cyclical Semiconductor",
    models: [model("dcf", 0.32, 0.77), model("forward_pe", 0.25, 0.79), model("ev_fcf", 0.23, 0.75), model("ev_sales", 0.1, 0.58), model("reverse_dcf", 0, 0.72, "diagnostic")],
    uncertainty: 0.18,
    buyZoneDiscount: 0.1,
    strongBuyZoneDiscount: 0.2,
    primaryQuestion: "Where are normalized earnings and cash flow in the cycle?",
  },
  foundry_semiconductor: {
    id: "foundry_semiconductor",
    label: "Integrated Device + Foundry Turnaround",
    models: [model("sotp", 0.52, 0.69), model("normalized_dcf", 0.2, 0.65), model("ev_ebitda", 0.18, 0.66), model("forward_pe", 0.1, 0.61), model("reverse_dcf", 0, 0.68, "diagnostic")],
    uncertainty: 0.31,
    buyZoneDiscount: 0.13,
    strongBuyZoneDiscount: 0.25,
    primaryQuestion: "What are products, data center and foundry worth under normalized utilization, margin and capital intensity?",
  },
  semiconductor_infrastructure: {
    id: "semiconductor_infrastructure",
    label: "Semiconductor Infrastructure / Diversified",
    models: [model("normalized_dcf", 0.3, 0.75), model("forward_pe", 0.25, 0.77), model("ev_fcf", 0.23, 0.73), model("ev_sales", 0.1, 0.58), model("reverse_dcf", 0, 0.71, "diagnostic")],
    uncertainty: 0.2,
    buyZoneDiscount: 0.09,
    strongBuyZoneDiscount: 0.18,
    primaryQuestion: "How durable are infrastructure demand, mix and normalized cash conversion across the cycle?",
  },
  consumer_tech_platform: {
    id: "consumer_tech_platform",
    label: "Consumer Technology Platform",
    models: [model("normalized_dcf", 0.32, 0.78), model("forward_pe", 0.28, 0.8), model("ev_fcf", 0.25, 0.79), model("ev_sales", 0.05, 0.54), model("reverse_dcf", 0, 0.75, "diagnostic")],
    uncertainty: 0.17,
    buyZoneDiscount: 0.08,
    strongBuyZoneDiscount: 0.16,
    primaryQuestion: "What growth, ecosystem durability, margin and capital return does the market price imply?",
  },
  digital_platform: {
    id: "digital_platform",
    label: "Digital Platform / Advertising + AI",
    models: [model("normalized_dcf", 0.34, 0.76), model("forward_pe", 0.24, 0.77), model("ev_fcf", 0.25, 0.75), model("ev_sales", 0.07, 0.57), model("reverse_dcf", 0, 0.73, "diagnostic")],
    uncertainty: 0.21,
    buyZoneDiscount: 0.09,
    strongBuyZoneDiscount: 0.18,
    primaryQuestion: "Can platform growth and AI investment sustain normalized cash returns?",
  },
  commerce_cloud_hybrid: {
    id: "commerce_cloud_hybrid",
    label: "Commerce + Cloud Hybrid",
    models: [model("normalized_dcf", 0.3, 0.72), model("sotp", 0.27, 0.72), model("ev_fcf", 0.22, 0.69), model("ev_sales", 0.11, 0.58), model("reverse_dcf", 0, 0.7, "diagnostic")],
    uncertainty: 0.24,
    buyZoneDiscount: 0.1,
    strongBuyZoneDiscount: 0.2,
    primaryQuestion: "How much value comes from cloud, commerce and advertising after segment capital intensity?",
  },
  ecommerce_platform: {
    id: "ecommerce_platform",
    label: "E-commerce + Cloud Platform",
    models: [model("normalized_dcf", 0.3, 0.72), model("sotp", 0.3, 0.74), model("ev_fcf", 0.2, 0.69), model("ev_sales", 0.1, 0.58), model("reverse_dcf", 0, 0.7, "diagnostic")],
    uncertainty: 0.24,
    buyZoneDiscount: 0.1,
    strongBuyZoneDiscount: 0.2,
    primaryQuestion: "How much value comes from commerce, cloud and advertising after segment-specific margins and capital intensity?",
  },
  saas_growth: {
    id: "saas_growth",
    label: "SaaS Growth",
    models: [model("normalized_dcf", 0.25, 0.68), model("ev_sales", 0.34, 0.72), model("ev_fcf", 0.22, 0.7), model("forward_pe", 0.09, 0.55), model("reverse_dcf", 0, 0.7, "diagnostic")],
    uncertainty: 0.26,
    buyZoneDiscount: 0.1,
    strongBuyZoneDiscount: 0.2,
    primaryQuestion: "Does durable growth convert into margin, retention and free cash flow?",
  },
  cloud_software_hybrid: {
    id: "cloud_software_hybrid",
    label: "Cloud Infrastructure + Mature Software",
    models: [model("normalized_dcf", 0.35, 0.72), model("forward_pe", 0.27, 0.77), model("sotp", 0.25, 0.69), model("ev_fcf", 0.13, 0.7), model("reverse_dcf", 0, 0.73, "diagnostic")],
    uncertainty: 0.22,
    buyZoneDiscount: 0.08,
    strongBuyZoneDiscount: 0.17,
    primaryQuestion: "Can cloud growth earn enough return to offset the capital and financing burden?",
  },
  cloud_software_platform: {
    id: "cloud_software_platform",
    label: "Cloud + Software Platform",
    models: [model("normalized_dcf", 0.34, 0.78), model("forward_pe", 0.28, 0.8), model("ev_fcf", 0.24, 0.77), model("ev_sales", 0.04, 0.55), model("reverse_dcf", 0, 0.75, "diagnostic")],
    uncertainty: 0.18,
    buyZoneDiscount: 0.08,
    strongBuyZoneDiscount: 0.16,
    primaryQuestion: "How durable are recurring software economics and cloud cash conversion?",
  },
  mature_software: {
    id: "mature_software",
    label: "Mature Software / Recurring Cash Flow",
    models: [model("normalized_dcf", 0.36, 0.79), model("forward_pe", 0.28, 0.79), model("ev_fcf", 0.26, 0.77), model("reverse_dcf", 0, 0.75, "diagnostic")],
    uncertainty: 0.16,
    buyZoneDiscount: 0.08,
    strongBuyZoneDiscount: 0.16,
    primaryQuestion: "How durable are maintenance, subscription and free-cash-flow economics after normalization?",
  },
  stablecoin_network: {
    id: "stablecoin_network",
    label: "Stablecoin Network / Reserve Economics",
    models: [model("sotp", 0.78, 0.68), model("forward_pe", 0.12, 0.5), model("ev_sales", 0.1, 0.46), model("reverse_dcf", 0, 0.55, "diagnostic")],
    uncertainty: 0.36,
    buyZoneDiscount: 0.15,
    strongBuyZoneDiscount: 0.28,
    primaryQuestion: "What are reserve income, distribution costs and network optionality worth across rate and USDC scenarios?",
  },
  crypto_exchange: {
    id: "crypto_exchange",
    label: "Crypto Exchange + Financial Network",
    models: [model("sotp", 0.38, 0.66), model("normalized_dcf", 0.28, 0.64), model("ev_ebitda", 0.2, 0.6), model("reverse_dcf", 0, 0.62, "diagnostic")],
    uncertainty: 0.35,
    buyZoneDiscount: 0.15,
    strongBuyZoneDiscount: 0.28,
    primaryQuestion: "What are cycle-normalized transaction economics, subscription revenue and network assets worth?",
  },
  bank: {
    id: "bank",
    label: "Bank / Balance-Sheet Compounder",
    models: [model("residual_income", 0.45, 0.82), model("p_tbv", 0.4, 0.84), model("forward_pe", 0.15, 0.76)],
    uncertainty: 0.16,
    buyZoneDiscount: 0.09,
    strongBuyZoneDiscount: 0.18,
    primaryQuestion: "What sustainable ROE can the balance sheet earn above its cost of equity?",
  },
  insurance: {
    id: "insurance",
    label: "Insurance / Book Value + Float",
    models: [model("residual_income", 0.42, 0.8), model("p_tbv", 0.33, 0.78), model("forward_pe", 0.2, 0.75)],
    uncertainty: 0.18,
    buyZoneDiscount: 0.09,
    strongBuyZoneDiscount: 0.18,
    primaryQuestion: "What underwriting returns and investment income can book value compound at through the cycle?",
  },
  asset_manager: {
    id: "asset_manager",
    label: "Asset Manager / Fee Earnings",
    models: [model("normalized_dcf", 0.34, 0.74), model("forward_pe", 0.3, 0.78), model("ev_ebitda", 0.26, 0.73), model("reverse_dcf", 0, 0.69, "diagnostic")],
    uncertainty: 0.21,
    buyZoneDiscount: 0.1,
    strongBuyZoneDiscount: 0.19,
    primaryQuestion: "How durable are fee-related earnings, performance revenue and capital returns across market cycles?",
  },
  payments: {
    id: "payments",
    label: "Payments Network / Transaction Compounder",
    models: [model("normalized_dcf", 0.34, 0.81), model("forward_pe", 0.3, 0.81), model("ev_fcf", 0.26, 0.79), model("reverse_dcf", 0, 0.77, "diagnostic")],
    uncertainty: 0.17,
    buyZoneDiscount: 0.08,
    strongBuyZoneDiscount: 0.16,
    primaryQuestion: "Do payment volume, cross-border mix and operating leverage support the priced earnings duration?",
  },
  reit: {
    id: "reit",
    label: "REIT / Asset + Cash Distribution",
    models: [model("nav", 0.42, 0.82), model("affo", 0.43, 0.84), model("dcf", 0.15, 0.68)],
    uncertainty: 0.17,
    buyZoneDiscount: 0.08,
    strongBuyZoneDiscount: 0.16,
    primaryQuestion: "What are the private-market asset value and sustainable AFFO stream?",
  },
  utility: {
    id: "utility",
    label: "Regulated Utility / Rate-Base Compounder",
    models: [model("dcf", 0.36, 0.78), model("forward_pe", 0.27, 0.76), model("ev_ebitda", 0.27, 0.75), model("reverse_dcf", 0, 0.7, "diagnostic")],
    uncertainty: 0.15,
    buyZoneDiscount: 0.07,
    strongBuyZoneDiscount: 0.14,
    primaryQuestion: "Can rate-base growth and allowed returns exceed financing and execution risk?",
  },
  oil_gas: {
    id: "oil_gas",
    label: "Oil & Gas / Commodity Scenarios",
    models: [model("commodity_scenario", 0.38, 0.76), model("nav", 0.25, 0.75), model("normalized_dcf", 0.22, 0.7), model("ev_ebitda", 0.15, 0.68)],
    uncertainty: 0.27,
    buyZoneDiscount: 0.12,
    strongBuyZoneDiscount: 0.23,
    primaryQuestion: "What is the equity worth across commodity-price, volume, cost and capital-return scenarios?",
  },
  commodity_producer: {
    id: "commodity_producer",
    label: "Commodity Producer / Cycle + NAV",
    models: [model("commodity_scenario", 0.38, 0.73), model("nav", 0.25, 0.72), model("normalized_dcf", 0.22, 0.68), model("ev_ebitda", 0.15, 0.65)],
    uncertainty: 0.3,
    buyZoneDiscount: 0.13,
    strongBuyZoneDiscount: 0.25,
    primaryQuestion: "What does the asset base earn across cycle-normalized price, volume and cost scenarios?",
  },
  industrial: {
    id: "industrial",
    label: "Industrial / Cycle-Normalized Earnings",
    models: [model("normalized_dcf", 0.34, 0.77), model("forward_pe", 0.27, 0.77), model("ev_ebitda", 0.29, 0.76), model("reverse_dcf", 0, 0.71, "diagnostic")],
    uncertainty: 0.2,
    buyZoneDiscount: 0.09,
    strongBuyZoneDiscount: 0.18,
    primaryQuestion: "What normalized margin, backlog conversion and reinvestment returns persist through the cycle?",
  },
  airline: {
    id: "airline",
    label: "Airline / Cycle + Balance Sheet",
    models: [model("normalized_dcf", 0.34, 0.61), model("ev_ebitda", 0.38, 0.7), model("forward_pe", 0.18, 0.62), model("reverse_dcf", 0, 0.58, "diagnostic")],
    uncertainty: 0.32,
    buyZoneDiscount: 0.15,
    strongBuyZoneDiscount: 0.28,
    primaryQuestion: "What normalized capacity, unit revenue, fuel cost and leverage can equity withstand through the cycle?",
  },
  auto: {
    id: "auto",
    label: "Automotive / Cycle-Normalized Earnings",
    models: [model("normalized_dcf", 0.32, 0.68), model("ev_ebitda", 0.3, 0.71), model("forward_pe", 0.23, 0.68), model("reverse_dcf", 0, 0.64, "diagnostic")],
    uncertainty: 0.26,
    buyZoneDiscount: 0.12,
    strongBuyZoneDiscount: 0.23,
    primaryQuestion: "What normalized volume, pricing, margin and capital intensity support equity value?",
  },
  biotech: {
    id: "biotech",
    label: "Biotech / Probability-Weighted Pipeline",
    models: [model("rnpv", 0.72, 0.68), model("dcf", 0.13, 0.55), model("ev_sales", 0.15, 0.52)],
    uncertainty: 0.38,
    buyZoneDiscount: 0.14,
    strongBuyZoneDiscount: 0.27,
    primaryQuestion: "Which clinical and commercial probabilities create the equity value?",
  },
  pharma: {
    id: "pharma",
    label: "Pharmaceuticals / Portfolio + Pipeline",
    models: [model("normalized_dcf", 0.33, 0.76), model("forward_pe", 0.27, 0.76), model("rnpv", 0.3, 0.69), model("reverse_dcf", 0, 0.68, "diagnostic")],
    uncertainty: 0.24,
    buyZoneDiscount: 0.1,
    strongBuyZoneDiscount: 0.2,
    primaryQuestion: "Can the marketed portfolio and probability-weighted pipeline offset patent expiry and pricing risk?",
  },
  medtech: {
    id: "medtech",
    label: "Medical Technology / Procedure Compounder",
    models: [model("normalized_dcf", 0.34, 0.77), model("forward_pe", 0.3, 0.78), model("ev_ebitda", 0.26, 0.75), model("reverse_dcf", 0, 0.69, "diagnostic")],
    uncertainty: 0.2,
    buyZoneDiscount: 0.09,
    strongBuyZoneDiscount: 0.18,
    primaryQuestion: "Do procedure volumes, product adoption and margin support durable cash compounding?",
  },
  consumer_staples: {
    id: "consumer_staples",
    label: "Consumer Staples / Durable Cash Flow",
    models: [model("dcf", 0.36, 0.81), model("forward_pe", 0.3, 0.81), model("ev_fcf", 0.24, 0.79), model("reverse_dcf", 0, 0.75, "diagnostic")],
    uncertainty: 0.14,
    buyZoneDiscount: 0.07,
    strongBuyZoneDiscount: 0.14,
    primaryQuestion: "Can volume, pricing and brand durability support the priced cash-flow duration?",
  },
  consumer_discretionary: {
    id: "consumer_discretionary",
    label: "Consumer Discretionary / Cycle + Brand",
    models: [model("normalized_dcf", 0.34, 0.73), model("forward_pe", 0.28, 0.75), model("ev_ebitda", 0.28, 0.72), model("reverse_dcf", 0, 0.68, "diagnostic")],
    uncertainty: 0.22,
    buyZoneDiscount: 0.1,
    strongBuyZoneDiscount: 0.2,
    primaryQuestion: "What normalized demand, unit economics and brand or network durability support value?",
  },
  telecom: {
    id: "telecom",
    label: "Telecom / Subscriber Cash Flow",
    models: [model("normalized_dcf", 0.34, 0.75), model("forward_pe", 0.22, 0.71), model("ev_ebitda", 0.34, 0.77), model("reverse_dcf", 0, 0.7, "diagnostic")],
    uncertainty: 0.18,
    buyZoneDiscount: 0.09,
    strongBuyZoneDiscount: 0.18,
    primaryQuestion: "Can subscriber economics and network investment support cash returns after leverage?",
  },
  media: {
    id: "media",
    label: "Media / Segment + Content Economics",
    models: [model("sotp", 0.36, 0.7), model("normalized_dcf", 0.3, 0.69), model("ev_ebitda", 0.24, 0.7), model("reverse_dcf", 0, 0.64, "diagnostic")],
    uncertainty: 0.27,
    buyZoneDiscount: 0.12,
    strongBuyZoneDiscount: 0.23,
    primaryQuestion: "What are subscription, advertising, content and physical-experience segments worth separately?",
  },
  auto_energy_optionality_sotp: {
    id: "auto_energy_optionality_sotp",
    label: "Auto + Energy + Optionality SOTP",
    models: [model("sotp", 0.62, 0.67), model("normalized_dcf", 0.2, 0.58), model("ev_fcf", 0.18, 0.56), model("forward_pe", 0, 0.45, "diagnostic"), model("reverse_dcf", 0, 0.66, "diagnostic")],
    uncertainty: 0.34,
    buyZoneDiscount: 0.13,
    strongBuyZoneDiscount: 0.25,
    primaryQuestion: "How much auto, energy and probability-weighted optionality value is priced in before deployment is proven?",
  },
  integrated_space_connectivity_ai_platform: {
    id: "integrated_space_connectivity_ai_platform",
    label: "Aerospace + Connectivity Optionality SOTP",
    models: [model("sotp", 0.55, 0.58), model("ev_sales", 0.25, 0.54), model("dcf", 0.2, 0.5)],
    uncertainty: 0.42,
    buyZoneDiscount: 0.18,
    strongBuyZoneDiscount: 0.32,
    primaryQuestion: "What are launch, connectivity and development optionality worth after probability and liquidity discounts?",
  },
  bitcoin_treasury: {
    id: "bitcoin_treasury",
    label: "Bitcoin Treasury / NAV + Financing Claims",
    models: [model("bitcoin_nav", 0.58, 0.66), model("ev_sales", 0.18, 0.55), model("forward_pe", 0.24, 0.6), model("reverse_dcf", 0, 0.52, "diagnostic")],
    uncertainty: 0.4,
    buyZoneDiscount: 0.16,
    strongBuyZoneDiscount: 0.3,
    primaryQuestion: "What are reported bitcoin holdings, financing claims, dilution and software cash flows worth per share?",
  },
  advanced_nuclear_project_npv: {
    id: "advanced_nuclear_project_npv",
    label: "Advanced Nuclear / Project NPV",
    models: [model("project_npv", 0.46, 0.6), model("normalized_dcf", 0.24, 0.55), model("ev_sales", 0.3, 0.58), model("reverse_dcf", 0, 0.52, "diagnostic")],
    uncertainty: 0.42,
    buyZoneDiscount: 0.18,
    strongBuyZoneDiscount: 0.32,
    primaryQuestion: "What are licensed, funded and development-stage nuclear projects worth after delivery probability and capital cost?",
  },
  memory_cycle_semiconductor: {
    id: "memory_cycle_semiconductor",
    label: "Memory Semiconductor / Cycle Normalization",
    models: [model("normalized_dcf", 0.28, 0.7), model("ev_ebitda", 0.24, 0.72), model("sotp", 0.24, 0.66), model("forward_pe", 0.12, 0.64), model("reverse_dcf", 0, 0.66, "diagnostic")],
    uncertainty: 0.3,
    buyZoneDiscount: 0.13,
    strongBuyZoneDiscount: 0.25,
    primaryQuestion: "Where do DRAM and NAND pricing, bit shipments and normalized margins settle through the memory cycle?",
  },
  general_equity: {
    id: "general_equity",
    label: "General Equity / Fundamental Fallback",
    models: [model("normalized_dcf", 0.3, 0.66), model("forward_pe", 0.24, 0.68), model("ev_fcf", 0.24, 0.66), model("ev_sales", 0.12, 0.54), model("reverse_dcf", 0, 0.62, "diagnostic")],
    uncertainty: 0.23,
    buyZoneDiscount: 0.1,
    strongBuyZoneDiscount: 0.2,
    primaryQuestion: "What normalized growth, cash conversion and valuation multiple does the current price require?",
  },
};

const known: Record<string, Omit<CompanyClassification, "ticker">> = {
  AMD: { companyName: "Advanced Micro Devices", sector: "Semiconductors", businessModel: "Fabless compute and accelerator semiconductor", growthStage: "Structural growth", profitability: "Profitable", capitalIntensity: "Medium", valuationDrivers: ["Data Center revenue", "AI accelerator adoption", "gross margin", "FCF conversion"], modelFamily: "ai_semiconductor", rationale: "AI and data-center growth dominate near-term value, but cash conversion and the terminal multiple remain binding." },
  NVDA: { companyName: "NVIDIA", sector: "Semiconductors", businessModel: "Accelerated-computing platform", growthStage: "Structural growth", profitability: "Highly profitable", capitalIntensity: "Medium", valuationDrivers: ["accelerator demand", "networking", "software mix", "FCF durability"], modelFamily: "ai_compute_platform", rationale: "The router emphasizes growth durability, cash conversion and market-implied expectations." },
  AAPL: { companyName: "Apple", sector: "Consumer Technology", businessModel: "Device ecosystem plus recurring services platform", growthStage: "Mature platform growth", profitability: "Highly profitable", capitalIntensity: "Moderate", valuationDrivers: ["installed base", "services mix", "gross margin", "capital return"], modelFamily: "consumer_tech_platform", rationale: "Ecosystem durability, services mix, cash conversion and buybacks require a platform model rather than a generic equity fallback." },
  MSFT: { companyName: "Microsoft", sector: "Software & Cloud", businessModel: "Enterprise software and hyperscale cloud platform", growthStage: "Structural growth", profitability: "Highly profitable", capitalIntensity: "Rising with AI infrastructure", valuationDrivers: ["Azure growth", "recurring software", "AI monetization", "FCF conversion"], modelFamily: "cloud_software_platform", rationale: "Recurring software economics and cloud capital intensity must be modeled together." },
  GOOGL: { companyName: "Alphabet", sector: "Digital Platforms", businessModel: "Advertising, cloud and AI platform", growthStage: "Mature structural growth", profitability: "Highly profitable", capitalIntensity: "Rising with AI infrastructure", valuationDrivers: ["search monetization", "cloud margin", "AI CapEx", "FCF"], modelFamily: "digital_platform", rationale: "Advertising durability and AI investment must translate into normalized cash returns." },
  META: { companyName: "Meta Platforms", sector: "Digital Platforms", businessModel: "Advertising and social platform with AI investment", growthStage: "Mature structural growth", profitability: "Highly profitable", capitalIntensity: "Rising with AI infrastructure", valuationDrivers: ["ad monetization", "engagement", "AI CapEx", "FCF"], modelFamily: "digital_platform", rationale: "Advertising growth, engagement and AI capital intensity drive normalized cash value." },
  AMZN: { companyName: "Amazon", sector: "Commerce & Cloud", businessModel: "Commerce, cloud and advertising hybrid", growthStage: "Structural growth", profitability: "Profitable; mix dependent", capitalIntensity: "High", valuationDrivers: ["AWS growth", "retail margin", "advertising", "CapEx"], modelFamily: "commerce_cloud_hybrid", rationale: "AWS, commerce and advertising have different economics and should not be collapsed into one generic margin." },
  AVGO: { companyName: "Broadcom", sector: "Semiconductors & Infrastructure Software", businessModel: "Semiconductor infrastructure plus recurring software", growthStage: "Structural and acquisitive growth", profitability: "Highly profitable", capitalIntensity: "Moderate", valuationDrivers: ["AI networking", "custom silicon", "software cash flow", "leverage"], modelFamily: "semiconductor_infrastructure", rationale: "Infrastructure growth, software cash flow and leverage require normalized cross-cycle valuation." },
  CRCL: { companyName: "Circle Internet Group", sector: "Financial Technology", businessModel: "Stablecoin network, reserve income and payments infrastructure", growthStage: "High growth", profitability: "Rate and scale sensitive", capitalIntensity: "Low physical; regulatory intensive", valuationDrivers: ["USDC circulation", "reserve yield", "distribution costs", "network optionality"], modelFamily: "stablecoin_network", rationale: "Circle is not a bank: value depends on reserve economics and network optionality across rate and circulation scenarios." },
  INTC: { companyName: "Intel", sector: "Semiconductors", businessModel: "Integrated device manufacturer and foundry", growthStage: "Turnaround / cyclical", profitability: "Cyclically pressured", capitalIntensity: "Very high", valuationDrivers: ["client products", "data-center products", "foundry utilization", "normalized margin", "CapEx"], modelFamily: "foundry_semiconductor", rationale: "Intel requires a segment SOTP and normalized turnaround economics; consolidated FCF and sales multiples are not valid primary anchors during the foundry buildout." },
  ORCL: { companyName: "Oracle Corporation", sector: "Software & Cloud", businessModel: "Enterprise software plus AI cloud infrastructure", growthStage: "Hybrid growth", profitability: "Profitable; investment-heavy", capitalIntensity: "High during cloud buildout", valuationDrivers: ["OCI growth", "RPO conversion", "normalized FCF", "net debt"], modelFamily: "cloud_software_hybrid", rationale: "Current FCF is distorted by infrastructure buildout, so normalized DCF, earnings and SOTP must be triangulated." },
  SNOW: { companyName: "Snowflake", sector: "Software", businessModel: "Consumption-based cloud data platform", growthStage: "High growth", profitability: "FCF positive / GAAP margin developing", capitalIntensity: "Low", valuationDrivers: ["product revenue", "net retention", "remaining obligations", "FCF margin"], modelFamily: "saas_growth", rationale: "Revenue durability and margin conversion make EV/Sales and normalized cash flow more useful than near-term P/E." },
  JPM: { companyName: "JPMorgan Chase", sector: "Banks", businessModel: "Diversified bank", growthStage: "Mature", profitability: "Profitable", capitalIntensity: "Regulated balance sheet", valuationDrivers: ["ROTCE", "tangible book", "credit costs", "capital return"], modelFamily: "bank", rationale: "Residual income and P/TBV connect value to sustainable excess returns on regulated equity." },
  PLD: { companyName: "Prologis", sector: "REIT", businessModel: "Industrial real-estate owner and operator", growthStage: "Mature growth", profitability: "AFFO positive", capitalIntensity: "Asset intensive", valuationDrivers: ["NAV", "AFFO", "occupancy", "cap rates"], modelFamily: "reit", rationale: "Private-market NAV and recurring AFFO are the primary anchors." },
  PLTR: { companyName: "Palantir Technologies", sector: "Software", businessModel: "Government and commercial AI software platform", growthStage: "Structural growth", profitability: "Profitable", capitalIntensity: "Low physical capital; stock compensation matters", valuationDrivers: ["government revenue", "commercial revenue", "customer growth", "stock compensation dilution", "FCF conversion"], modelFamily: "saas_growth", rationale: "Government and commercial adoption need separate evidence, while stock compensation and cash conversion constrain per-share value." },
  REGN: { companyName: "Regeneron", sector: "Biotechnology", businessModel: "Commercial biotechnology plus development pipeline", growthStage: "Profitable pipeline", profitability: "Profitable", capitalIntensity: "R&D intensive", valuationDrivers: ["pipeline probability", "patent duration", "launch curves", "rNPV"], modelFamily: "biotech", rationale: "Probability-weighted asset value is the primary anchor; aggregate multiples are secondary." },
  TSLA: { companyName: "Tesla", sector: "Automotive & Energy", businessModel: "Auto, energy and autonomy optionality", growthStage: "Growth with optionality", profitability: "Profitable", capitalIntensity: "High", valuationDrivers: ["auto volume and margin", "energy", "autonomy probability", "CapEx"], modelFamily: "auto_energy_optionality_sotp", rationale: "Distinct business lines and optionality require a segment SOTP with explicit probability assumptions." },
  SPCX: { companyName: "Space Exploration Technologies", sector: "Aerospace & Connectivity", businessModel: "Launch services, Starlink connectivity and Starship-driven launch-cost optionality", growthStage: "Public growth", profitability: "Segment dependent; connectivity cash generative", capitalIntensity: "Very high", valuationDrivers: ["Starlink subscribers and ARPU", "launch cadence and price per kilogram", "Starship reusability and cost", "direct-to-device connectivity", "net cash or debt and dilution"], modelFamily: "integrated_space_connectivity_ai_platform", rationale: "Launch, connectivity and development optionality have different economics, so each segment carries its own multiple and probability." },
  MSTR: { companyName: "Strategy", sector: "Digital Assets", businessModel: "Bitcoin treasury plus enterprise software operations", growthStage: "Capital-markets driven", profitability: "Dilution and mark-to-market sensitive", capitalIntensity: "Balance-sheet intensive", valuationDrivers: ["bitcoin holdings", "reference bitcoin price", "debt and preferred claims", "share dilution", "software cash flow"], modelFamily: "bitcoin_treasury", rationale: "A bitcoin treasury is not a software multiple: holdings, financing claims and dilution must be bridged to equity value explicitly." },
  OKLO: { companyName: "Oklo", sector: "Advanced Nuclear", businessModel: "Advanced fission reactor design, licensing and power projects", growthStage: "Pre-revenue development", profitability: "Not yet profitable", capitalIntensity: "Project financed", valuationDrivers: ["licensed project pipeline", "delivery probability", "capital cost", "power purchase economics"], modelFamily: "advanced_nuclear_project_npv", rationale: "Pre-revenue reactor developers require probability-weighted project NPV rather than trailing cash-flow multiples." },
  MU: { companyName: "Micron Technology", sector: "Semiconductors", businessModel: "DRAM and NAND memory producer with cycle-sensitive pricing", growthStage: "Cyclical", profitability: "Cycle dependent", capitalIntensity: "Very high", valuationDrivers: ["DRAM pricing", "NAND pricing", "bit shipments", "normalized margin", "capital expenditure"], modelFamily: "memory_cycle_semiconductor", rationale: "Memory earnings are cycle-driven, so normalized DCF and normalized EBITDA carry the valuation rather than a single up-cycle P/E." },
};

// Alphabet's two listed share classes are one issuer and must route through the
// same operating model. Quotes remain security-specific downstream.
known.GOOG = { ...known.GOOGL };

function inferFamily(hint: CompanyHint): ModelFamilyId | null {
  const text = `${hint.sector ?? ""} ${hint.businessModel ?? ""} ${hint.growthStage ?? ""} ${hint.profitability ?? ""}`.toLowerCase();
  if (/stablecoin|usdc|digital currency network/.test(text)) return "stablecoin_network";
  if (/bitcoin treasury|digital asset treasury|bitcoin holdings/.test(text)) return "bitcoin_treasury";
  if (/nuclear|small modular reactor|reactor design/.test(text)) return "advanced_nuclear_project_npv";
  if (/memory|dram|nand/.test(text)) return "memory_cycle_semiconductor";
  if (/crypto exchange|digital asset exchange/.test(text)) return "crypto_exchange";
  if (/payment|card network/.test(text)) return "payments";
  if (/insurance|underwriting/.test(text)) return "insurance";
  if (/asset manager|wealth management|investment management/.test(text)) return "asset_manager";
  if (/bank|depository|financial institution/.test(text)) return "bank";
  if (/reit|real estate investment trust/.test(text)) return "reit";
  if (/biotech|biopharma|clinical stage/.test(text)) return "biotech";
  if (/pharma|pharmaceutical/.test(text)) return "pharma";
  if (/medical device|medtech/.test(text)) return "medtech";
  if (/oil|gas|petroleum|exploration/.test(text)) return "oil_gas";
  if (/mining|commodity producer|metals/.test(text)) return "commodity_producer";
  if (/electric utility|regulated utility|power generation/.test(text)) return "utility";
  if (/airline|air transport/.test(text)) return "airline";
  if (/aerospace|space|launch|satellite|connectivity/.test(text) && /private|optionality/.test(text)) return "integrated_space_connectivity_ai_platform";
  if (/robotaxi|autonomy|robotics optionality|optionality/.test(text)) return "auto_energy_optionality_sotp";
  if (/auto|vehicle/.test(text)) return "auto";
  if (/telecom|wireless communications/.test(text)) return "telecom";
  if (/media|streaming|entertainment/.test(text)) return "media";
  if (/consumer staple|food|beverage|household product/.test(text)) return "consumer_staples";
  if (/retail|restaurant|consumer discretionary/.test(text)) return "consumer_discretionary";
  if (/saas|subscription software|cloud data/.test(text)) return "saas_growth";
  if (/cloud/.test(text) && /software|enterprise/.test(text)) return "cloud_software_hybrid";
  if (/foundry/.test(text) && /integrated|device manufacturer|turnaround/.test(text)) return "foundry_semiconductor";
  if (/semiconductor|chip|foundry/.test(text)) return /high growth|structural|ai/.test(text) ? "ai_semiconductor" : "mature_semiconductor";
  if (/industrial|machinery|aerospace|defense/.test(text)) return "industrial";
  return hint.companyName ? "general_equity" : null;
}

export function classifyCompany(ticker: string, hint: CompanyHint = {}): CompanyClassification | null {
  const symbol = ticker.trim().toUpperCase();
  const verified = getVerifiedIssuerProfile(symbol);
  if (verified) return {
    ticker: symbol,
    companyName: verified.canonicalName,
    // A raw SEC SIC description is not a sector label, so a verified issuer's
    // family supplies the display sector when the hint is just filing taxonomy.
    sector: hint.sector && !/services-|data processing|etc\.|public company/i.test(hint.sector)
      ? hint.sector
      : MODEL_FAMILIES[verified.valuationFamily].label.split(" /")[0].replace(/ (Optionality )?SOTP$/, ""),
    businessModel: verified.businessModel,
    growthStage: hint.growthStage ?? "Company-specific",
    profitability: hint.profitability ?? "Derived from reported financials",
    capitalIntensity: hint.capitalIntensity ?? "Company-specific",
    valuationDrivers: verified.driverSchema,
    modelFamily: verified.valuationFamily,
    rationale: verified.investmentQuestion,
  };
  const preset = known[symbol];
  if (preset) return { ticker: symbol, ...preset };
  const modelFamily = inferFamily(hint);
  if (!modelFamily || !hint.companyName) return null;
  const family = MODEL_FAMILIES[modelFamily];
  return {
    ticker: symbol,
    companyName: hint.companyName,
    sector: hint.sector ?? "Unclassified",
    businessModel: hint.businessModel ?? "Evidence required",
    growthStage: hint.growthStage ?? "Evidence required",
    profitability: hint.profitability ?? "Evidence required",
    capitalIntensity: hint.capitalIntensity ?? "Evidence required",
    valuationDrivers: hint.valuationDrivers ?? [],
    modelFamily,
    rationale: family.primaryQuestion,
  };
}

function missing(assumptions: ValuationAssumptions, fields: Array<keyof ValuationAssumptions>) {
  return fields.filter((field) => assumptions[field] === undefined).map(String);
}

function discountedValue(cashFlows: number[], wacc: number, terminalGrowth: number, netCashB: number, sharesB: number, terminalCashFlowB?: number) {
  if (!cashFlows.length || !positive(sharesB) || !positive(wacc) || !finite(terminalGrowth) || wacc <= terminalGrowth || !finite(netCashB) || cashFlows.some((value) => !finite(value))) return null;
  const presentValue = cashFlows.reduce((sum, cashFlow, index) => sum + cashFlow / (1 + wacc) ** (index + 1), 0);
  const terminalCashFlow = (terminalCashFlowB ?? cashFlows.at(-1)!) * (1 + terminalGrowth);
  if (terminalCashFlow <= 0) return null;
  const terminalValue = terminalCashFlow / (wacc - terminalGrowth);
  return (presentValue + terminalValue / (1 + wacc) ** cashFlows.length + netCashB) / sharesB;
}

/** A levered stream (already nets interest and working-capital cash) discounts at the cost of equity with no net-cash bridge. */
function isEquityCashFlowBasis(basis: CashFlowBasis | undefined): boolean {
  return basis === "cfo_capex_proxy" || basis === "fcfe_equity";
}

/** Human label that names the stream's conversion method for the model explanation. */
function basisSuffix(basis: CashFlowBasis | undefined): string {
  switch (basis) {
    case "cfo_capex_proxy": return " (reported CFO−CapEx levered proxy, discounted at the cost of equity)";
    case "fcfe_equity": return " (free cash flow to equity, discounted at the cost of equity)";
    case "fcff_ebit_bridge": return " (EBIT×(1−tax)+D&A−CapEx−ΔNWC, discounted at WACC)";
    case "fcff_before_nwc": return " (EBIT×(1−tax)+D&A−CapEx before working-capital changes, discounted at WACC)";
    case "analyst_fcff": return " (unlevered analyst FCFF, discounted at WACC)";
    case "derived_proxy": return " (derived proxy, discounted at WACC)";
    default: return "";
  }
}

/**
 * Discounts a cash-flow path at the rate its口径 pairs with: an unlevered stream
 * at WACC bridged to equity with net cash, or a levered stream at the cost of
 * equity with no net-cash bridge (interest and working-capital cash are already
 * inside the stream). This is what makes `cashFlowBasis` control the discount
 * rate and the equity bridge instead of only changing the label.
 */
function discountStream(assumptions: ValuationAssumptions, path: number[] | undefined): number | null {
  if (!path) return null;
  const equityBasis = isEquityCashFlowBasis(assumptions.cashFlowBasis);
  const rate = equityBasis ? assumptions.costOfEquity : assumptions.wacc;
  const terminalGrowth = assumptions.terminalGrowth;
  const sharesB = assumptions.dilutedSharesB;
  if (!positive(rate) || !finite(terminalGrowth) || !positive(sharesB)) return null;
  if (equityBasis) return discountedValue(path, rate, terminalGrowth, 0, sharesB, assumptions.terminalCashFlowB);
  const netCashB = assumptions.netCashB;
  if (!finite(netCashB)) return null;
  return discountedValue(path, rate, terminalGrowth, netCashB, sharesB, assumptions.terminalCashFlowB);
}

export function enterpriseToEquityPerShare(enterpriseValueB: number, netCashB: number, dilutedSharesB: number) {
  return finite(enterpriseValueB) && finite(netCashB) && positive(dilutedSharesB)
    ? (enterpriseValueB + netCashB) / dilutedSharesB
    : null;
}

type Calculation = { value: number | null; explanation: string; missingInputs: string[]; diagnostics?: Record<string, number | null> };

export const VALUATION_MODELS: Record<ValuationModelId, { label: string; run: (assumptions: ValuationAssumptions, currentPrice: number | null) => Calculation }> = {
  dcf: {
    label: "FCFF DCF",
    run: (a) => {
      const equityBasis = isEquityCashFlowBasis(a.cashFlowBasis);
      const value = discountStream(a, a.cashFlows);
      return { value, explanation: `Discounted ${equityBasis ? "levered cash flow to equity at the cost of equity, with no enterprise bridge" : "FCFF at WACC plus net cash, divided by diluted shares"}${basisSuffix(a.cashFlowBasis)}.`, missingInputs: missing(a, equityBasis ? ["cashFlows", "costOfEquity", "terminalGrowth", "dilutedSharesB"] : ["cashFlows", "wacc", "terminalGrowth", "netCashB", "dilutedSharesB"]) };
    },
  },
  normalized_dcf: {
    label: "Normalized DCF",
    run: (a) => {
      const equityBasis = isEquityCashFlowBasis(a.cashFlowBasis);
      const value = discountStream(a, a.normalizedCashFlows);
      return { value, explanation: `Uses a normalized cash-flow path when current investment or cyclicality distorts reported FCF, discounted ${equityBasis ? "at the cost of equity with no enterprise bridge" : "at WACC plus net cash"}${basisSuffix(a.cashFlowBasis)}.`, missingInputs: missing(a, equityBasis ? ["normalizedCashFlows", "costOfEquity", "terminalGrowth", "dilutedSharesB"] : ["normalizedCashFlows", "wacc", "terminalGrowth", "netCashB", "dilutedSharesB"]) };
    },
  },
  forward_pe: {
    label: "Forward P/E",
    run: (a) => ({ value: positive(a.forwardEps) && positive(a.forwardPe) ? a.forwardEps * a.forwardPe : null, explanation: "Forward EPS multiplied by the justified forward earnings multiple.", missingInputs: missing(a, ["forwardEps", "forwardPe"]) }),
  },
  ev_ebitda: {
    label: "Normalized EV / EBITDA",
    run: (a) => ({ value: positive(a.normalizedEbitdaB) && positive(a.evEbitdaMultiple) && finite(a.netCashB) && positive(a.dilutedSharesB) ? (a.normalizedEbitdaB * a.evEbitdaMultiple + a.netCashB) / a.dilutedSharesB : null, explanation: "Capitalizes normalized EBITDA and bridges enterprise value to equity; used when current FCF is distorted by a buildout or cycle.", missingInputs: missing(a, ["normalizedEbitdaB", "evEbitdaMultiple", "netCashB", "dilutedSharesB"]) }),
  },
  ev_fcf: {
    label: "EV / FCF",
    run: (a) => {
      const unlevered = a.cashFlowBasis === "fcff_ebit_bridge" || a.cashFlowBasis === "analyst_fcff" || a.cashFlowBasis === "fcff_before_nwc";
      if (!unlevered) return {
        value: null,
        explanation: "EV/FCF requires an explicitly unlevered cash-flow basis. Levered or unspecified proxies cannot be capitalized as enterprise value and then bridged to equity.",
        missingInputs: ["unlevered forwardFcfB"],
      };
      return { value: positive(a.forwardFcfB) && positive(a.evFcfMultiple) && finite(a.netCashB) && positive(a.dilutedSharesB) ? (a.forwardFcfB * a.evFcfMultiple + a.netCashB) / a.dilutedSharesB : null, explanation: `Forward unlevered FCF capitalized at an EV/FCF multiple, bridged to equity${a.cashFlowBasis === "fcff_before_nwc" ? "; pre-working-capital proxy: ΔNWC is not included" : ""}.`, missingInputs: missing(a, ["forwardFcfB", "evFcfMultiple", "netCashB", "dilutedSharesB"]) };
    },
  },
  ev_sales: {
    label: "EV / Sales",
    run: (a) => ({ value: positive(a.forwardRevenueB) && positive(a.evSalesMultiple) && finite(a.netCashB) && positive(a.dilutedSharesB) ? (a.forwardRevenueB * a.evSalesMultiple + a.netCashB) / a.dilutedSharesB : null, explanation: "Forward revenue capitalized at an EV/Sales multiple, with profitability checked separately.", missingInputs: missing(a, ["forwardRevenueB", "evSalesMultiple", "netCashB", "dilutedSharesB"]) }),
  },
  sotp: {
    label: "Sum of the Parts",
    run: (a) => ({ value: a.sotpSegments?.length && finite(a.netCashB) && positive(a.dilutedSharesB) ? (a.sotpSegments.reduce((sum, segment) => sum + segment.metricValueB * segment.multiple * clamp(segment.probability ?? 1, 0, 1) * clamp(segment.ownership ?? 1, 0, 1), 0) + a.netCashB) / a.dilutedSharesB : null, explanation: "Values each operating segment on its own driver and multiple, probability-weights optionality, then applies the equity bridge.", missingInputs: missing(a, ["sotpSegments", "netCashB", "dilutedSharesB"]) }),
  },
  residual_income: {
    label: "Residual Income",
    run: (a) => ({ value: positive(a.bookValuePerShare) && finite(a.returnOnEquity) && positive(a.costOfEquity) && finite(a.residualGrowth) && a.costOfEquity > a.residualGrowth ? a.bookValuePerShare + ((a.returnOnEquity - a.costOfEquity) * a.bookValuePerShare) / (a.costOfEquity - a.residualGrowth) : null, explanation: "Book value plus the present value of sustainable returns above the cost of equity.", missingInputs: missing(a, ["bookValuePerShare", "returnOnEquity", "costOfEquity", "residualGrowth"]) }),
  },
  p_tbv: {
    label: "P / TBV",
    run: (a) => ({ value: positive(a.tangibleBookValuePerShare) && positive(a.priceToTangibleBook) ? a.tangibleBookValuePerShare * a.priceToTangibleBook : null, explanation: "Tangible book value per share at a justified multiple linked to ROTCE and risk.", missingInputs: missing(a, ["tangibleBookValuePerShare", "priceToTangibleBook"]) }),
  },
  nav: {
    label: "Net Asset Value",
    run: (a) => ({ value: positive(a.navPerShare) ? a.navPerShare : finite(a.navB) && positive(a.dilutedSharesB) ? a.navB / a.dilutedSharesB : null, explanation: "Asset value net of liabilities, expressed per diluted share.", missingInputs: a.navPerShare === undefined && (a.navB === undefined || a.dilutedSharesB === undefined) ? ["navPerShare or navB + dilutedSharesB"] : [] }),
  },
  affo: {
    label: "P / AFFO",
    run: (a) => ({ value: positive(a.affoPerShare) && positive(a.priceToAffo) ? a.affoPerShare * a.priceToAffo : null, explanation: "Forward AFFO per share capitalized at a justified P/AFFO multiple.", missingInputs: missing(a, ["affoPerShare", "priceToAffo"]) }),
  },
  rnpv: {
    label: "Risk-adjusted NPV",
    run: (a) => ({ value: a.rnpvAssets?.length && finite(a.otherAssetValueB) && positive(a.dilutedSharesB) ? (a.rnpvAssets.reduce((sum, asset) => sum + asset.unadjustedNpvB * clamp(asset.probability, 0, 1), 0) + a.otherAssetValueB) / a.dilutedSharesB : null, explanation: "Pipeline asset NPVs weighted by technical and commercial probability, plus other net assets.", missingInputs: missing(a, ["rnpvAssets", "otherAssetValueB", "dilutedSharesB"]) }),
  },
  project_npv: {
    label: "Project NPV",
    run: (a) => a.projectNpvAssets?.length && finite(a.otherAssetValueB) && positive(a.dilutedSharesB)
      ? {
        value: (a.projectNpvAssets.reduce((sum, project) => sum + project.npvB * clamp(project.probability, 0, 1), 0) + a.otherAssetValueB) / a.dilutedSharesB,
        explanation: "Development-stage project NPVs weighted by delivery probability, plus other net assets and the equity bridge.",
        missingInputs: [],
        diagnostics: { projectsWeighted: a.projectNpvAssets.length },
      }
      : { value: null, explanation: "Development-stage project NPVs weighted by delivery probability, plus other net assets and the equity bridge.", missingInputs: missing(a, ["projectNpvAssets", "otherAssetValueB", "dilutedSharesB"]) },
  },
  bitcoin_nav: {
    label: "Bitcoin NAV",
    run: (a) => positive(a.bitcoinHoldings) && positive(a.bitcoinPriceUsd) && positive(a.dilutedSharesB)
      ? (() => {
        const bitcoinAssetsB = (a.bitcoinHoldings! * a.bitcoinPriceUsd!) / 1e9;
        const netCashB = finite(a.netCashB) ? a.netCashB : 0;
        const otherAssetValueB = finite(a.otherAssetValueB) ? a.otherAssetValueB : 0;
        return {
          value: (bitcoinAssetsB + otherAssetValueB + netCashB) / a.dilutedSharesB!,
          explanation: "Reported bitcoin holdings marked at the reference price, plus other net assets, financing claims and the diluted equity bridge.",
          missingInputs: [],
          diagnostics: { bitcoinAssetsB, otherAssetValueB, netCashB },
        };
      })()
      : { value: null, explanation: "Reported bitcoin holdings marked at the reference price, plus other net assets, financing claims and the diluted equity bridge.", missingInputs: missing(a, ["bitcoinHoldings", "bitcoinPriceUsd", "dilutedSharesB"]) },
  },
  commodity_scenario: {
    label: "Commodity Scenario Value",
    run: (a) => {
      const scenarios = a.commodityScenarios;
      if (!scenarios || !positive(a.dilutedSharesB)) return { value: null, explanation: "Probability-weights bear, base and bull commodity-cycle equity values.", missingInputs: missing(a, ["commodityScenarios", "dilutedSharesB"]) };
      const bearProbability = clamp(scenarios.bearProbability ?? 0.25, 0, 1);
      const bullProbability = clamp(scenarios.bullProbability ?? 0.25, 0, 1);
      const baseProbability = 1 - bearProbability - bullProbability;
      if (baseProbability < 0 || ![scenarios.bearEquityValueB, scenarios.baseEquityValueB, scenarios.bullEquityValueB].every(finite)) return { value: null, explanation: "Commodity scenario probabilities or equity values are invalid.", missingInputs: ["valid commodity scenarios"] };
      const equityValueB = scenarios.bearEquityValueB * bearProbability + scenarios.baseEquityValueB * baseProbability + scenarios.bullEquityValueB * bullProbability;
      return { value: equityValueB / a.dilutedSharesB, explanation: "Probability-weighted commodity-price, production, cost and capital-return scenarios.", missingInputs: [], diagnostics: { bearProbability, baseProbability, bullProbability } };
    },
  },
  reverse_dcf: {
    label: "Reverse DCF",
    run: (a, currentPrice) => {
      const cashFlows = a.normalizedCashFlows ?? a.cashFlows;
      const equityBasis = isEquityCashFlowBasis(a.cashFlowBasis);
      const needed = missing(a, equityBasis ? ["costOfEquity", "terminalGrowth", "dilutedSharesB"] : ["wacc", "terminalGrowth", "netCashB", "dilutedSharesB"]);
      if (!cashFlows) needed.unshift("cashFlows or normalizedCashFlows");
      if (!positive(currentPrice)) needed.unshift("currentPrice");
      if (needed.length || !cashFlows || cashFlows.length < 3 || !positive(currentPrice) || !finite(a.terminalGrowth) || !positive(a.dilutedSharesB)) return { value: null, explanation: "Solves for the operating path required to justify the selected price.", missingInputs: needed };
      const first = cashFlows[0];
      const second = cashFlows[1];
      const years = cashFlows.length - 2;
      const valueAt = (growth: number) => {
        const path = [first, second];
        for (let index = 1; index <= years; index += 1) path.push(second * (1 + growth) ** index);
        return { path, value: discountStream(a, path) };
      };
      let low = -0.5;
      let high = 1.5;
      if ((valueAt(low).value ?? Infinity) > currentPrice || (valueAt(high).value ?? -Infinity) < currentPrice) return { value: null, explanation: "Selected price is outside the searchable operating range.", missingInputs: [], diagnostics: { impliedFcfCagr: null, terminalFcfB: null, impliedRevenueB: null } };
      for (let iteration = 0; iteration < 80; iteration += 1) {
        const midpoint = (low + high) / 2;
        if ((valueAt(midpoint).value ?? -Infinity) < currentPrice) low = midpoint;
        else high = midpoint;
      }
      const impliedFcfCagr = (low + high) / 2;
      const terminalFcfB = valueAt(impliedFcfCagr).path.at(-1)!;
      return { value: null, explanation: "Diagnostic only: the implied growth path is not blended into fair value.", missingInputs: [], diagnostics: { impliedFcfCagr, terminalFcfB, impliedRevenueB: positive(a.fcfMargin) ? terminalFcfB / a.fcfMargin : null } };
    },
  },
};

const profile = (ticker: string): ValuationProfile => {
  const classification = classifyCompany(ticker);
  if (!classification) throw new Error(`No classification profile for ${ticker}.`);
  if (ticker === "AMD") return {
    classification,
    referencePrice: { value: 516.11, asOf: "2026-09-11", source: "Imported Sep 11 research snapshot" },
    baseline: { cashFlowBasis: "analyst_fcff", cashFlows: [16, 30, 36, 43, 52, 63], netCashB: 9.885, dilutedSharesB: 1.632, wacc: 0.105, terminalGrowth: 0.035, forwardEps: 15.61, forwardPe: 32, forwardFcfB: 30, evFcfMultiple: 24, forwardRevenueB: 87.7, evSalesMultiple: 8.5, fcfMargin: 0.34 },
    thesis: { growthDelta: 0, marginDelta: 0, multipleDelta: 0, note: "Signal Ledger currently adopts the imported AI baseline without an incremental overlay." },
    modelConfidence: { dcf: 0.78, forward_pe: 0.76, ev_fcf: 0.72, ev_sales: 0.64, reverse_dcf: 0.76 },
    sourcePosture: "analyst_estimate",
    evidenceMissing: ["Live consensus estimates", "A filing-linked multi-year FCFF bridge", "A comparable-company multiple set"],
    variantPath: "FCFF must rise from $16B to $63B while accelerator and EPYC mix support margin and cash conversion.",
    downsideMechanism: "A slower accelerator ramp cuts revenue and margin together; a higher discount rate then compresses terminal value.",
    evidenceGate: "Re-underwrite after each filing when data-center growth, gross margin, cash conversion or consensus revisions move materially.",
  };
  if (ticker === "ORCL") return {
    classification,
    referencePrice: { value: 150.24, asOf: "2026-09-11", source: "Imported Sep 11 research snapshot" },
    baseline: { cashFlowBasis: "analyst_fcff", normalizedCashFlows: [-4.5, 3.4, 13.4, 27.7, 40, 49.7, 57.7, 63.8], netCashB: -88.3, dilutedSharesB: 3, wacc: 0.09, terminalGrowth: 0.035, forwardEps: 8.1, forwardPe: 24.5, forwardFcfB: 49.7, evFcfMultiple: 14, fcfMargin: 0.29, sotpSegments: [{ name: "OCI", metric: "normalized revenue", metricValueB: 40, multiple: 10 }, { name: "Cloud applications", metric: "normalized revenue", metricValueB: 20, multiple: 7 }, { name: "Database & support", metric: "normalized revenue", metricValueB: 40, multiple: 6 }, { name: "Hardware & services", metric: "normalized revenue", metricValueB: 7, multiple: 1 }] },
    thesis: { growthDelta: 0, marginDelta: 0, multipleDelta: 0, note: "The imported baseline assumes cloud growth ultimately converts into normalized FCF." },
    modelConfidence: { normalized_dcf: 0.64, forward_pe: 0.76, sotp: 0.65, ev_fcf: 0.62, reverse_dcf: 0.7 },
    sourcePosture: "analyst_estimate",
    evidenceMissing: ["Live consensus history", "Audited segment-level capital intensity", "A filing-linked normalized FCF bridge"],
    variantPath: "OCI growth and RPO conversion must lift normalized FCF after the current infrastructure buildout.",
    downsideMechanism: "CapEx stays elevated while cloud unit economics fail to scale, leaving leverage high and equity FCF delayed.",
    evidenceGate: "Watch OCI growth, cloud gross margin, signed capacity, CapEx funding and the timing of normalized cash conversion.",
  };
  if (ticker === "TSLA") return {
    classification,
    baseline: {
      cashFlowBasis: "analyst_fcff",
      normalizedCashFlows: [-9.85, 0, 8, 16, 25, 35],
      netCashB: 33.4,
      dilutedSharesB: 3.52,
      wacc: 0.11,
      terminalGrowth: 0.03,
      sotpSegments: [
        { name: "Automotive", metric: "2026 consensus revenue", metricValueB: 74.295, multiple: 6 },
        { name: "Energy generation & storage", metric: "2026 consensus revenue", metricValueB: 15.533, multiple: 10 },
        { name: "Services & other", metric: "2026 consensus revenue", metricValueB: 15.393, multiple: 3 },
        { name: "FSD software & licensing", metric: "unadjusted option value", metricValueB: 100, multiple: 1, probability: 0.45 },
        { name: "Robotaxi network", metric: "unadjusted option value", metricValueB: 220, multiple: 1, probability: 0.3 },
        { name: "Optimus", metric: "unadjusted option value", metricValueB: 150, multiple: 1, probability: 0.15 },
      ],
      fcfMargin: 0.12,
    },
    thesis: { growthDelta: 0, marginDelta: 0, multipleDelta: 0, note: "The baseline keeps operating businesses separate from probability-weighted autonomy and robotics optionality." },
    modelConfidence: { sotp: 0.62, normalized_dcf: 0.44, reverse_dcf: 0.58 },
    sourcePosture: "reported_internal_forecast",
    inputSources: {
      sotpSegments: { kind: "consensus", label: "Tesla-published Q2 2026 company-compiled consensus plus explicit Signal Ledger optionality probabilities", asOf: "2026-07-20", url: "https://ir.tesla.com/press-release/earnings-consensus-second-quarter-2026" },
      normalizedCashFlows: { kind: "internal_forecast", label: "Cash-flow normalization from Tesla-published 2026 operating cash flow and CapEx consensus", asOf: "2026-07-20", url: "https://ir.tesla.com/press-release/earnings-consensus-second-quarter-2026" },
      netCashB: { kind: "consensus", label: "Tesla-published company-compiled cash and securities estimate", asOf: "2026-07-20", url: "https://ir.tesla.com/press-release/earnings-consensus-second-quarter-2026" },
    },
    evidenceMissing: ["Verified autonomy deployment economics", "Robotaxi utilization and insurance loss curves", "Segment-level invested capital"],
    variantPath: "Auto and energy revenue must scale while autonomy moves from an option value to evidenced unit economics.",
    downsideMechanism: "Auto margin compression and delayed autonomy deployment reduce both operating value and probability-weighted optionality.",
    evidenceGate: "Re-run on deliveries, storage deployments, segment gross margin, CapEx and verified autonomy deployment milestones.",
  };
  if (ticker === "INTC") return {
    classification,
    baseline: {
      cashFlowBasis: "analyst_fcff",
      normalizedCashFlows: [4, 7, 11, 15, 19, 23],
      netCashB: -25,
      dilutedSharesB: 4.45,
      wacc: 0.11,
      terminalGrowth: 0.025,
      forwardEps: 1.7,
      forwardPe: 24,
      normalizedEbitdaB: 15,
      evEbitdaMultiple: 10,
      sotpSegments: [
        { name: "Client Computing", metric: "Q2 revenue annualized", metricValueB: 35.508, multiple: 5 },
        { name: "Data Center & AI", metric: "Q2 revenue annualized", metricValueB: 25.048, multiple: 8 },
        { name: "Intel Foundry", metric: "reported segment revenue annualized", metricValueB: 23.06, multiple: 3, probability: 0.5 },
        { name: "All Other", metric: "Q2 revenue annualized", metricValueB: 2.8, multiple: 3 },
      ],
      fcfMargin: 0.16,
    },
    thesis: { growthDelta: 0, marginDelta: 0, multipleDelta: 0, note: "The baseline separates product franchises from a probability-weighted foundry turnaround rather than capitalizing depressed consolidated FCF." },
    modelConfidence: { sotp: 0.62, normalized_dcf: 0.48, ev_ebitda: 0.58, forward_pe: 0.46, reverse_dcf: 0.55 },
    sourcePosture: "reported_internal_forecast",
    inputSources: {
      sotpSegments: { kind: "reported", label: "Intel Q2 2026 reported segment revenue; annualization and multiples are explicit model assumptions", asOf: "2026-06-27", url: "https://www.intc.com/news-events/press-releases/detail/1776/intel-reports-second-quarter-2026-financial-results" },
      normalizedCashFlows: { kind: "internal_forecast", label: "Turnaround cash-flow path; current foundry buildout FCF is not treated as steady state", asOf: "2026-06-27" },
      netCashB: { kind: "internal_forecast", label: "Screening capital bridge pending latest filing tie-out", asOf: "2026-06-27" },
    },
    evidenceMissing: ["Foundry external-customer ramp and utilization", "Segment-level normalized operating margins", "Verified capital bridge and subsidy timing"],
    variantPath: "Client and data-center franchises must fund the foundry ramp while foundry utilization improves toward a sustainable return on invested capital.",
    downsideMechanism: "Foundry losses and CapEx persist while product share and pricing weaken, delaying normalized cash conversion.",
    evidenceGate: "Re-run on segment revenue, foundry external mix, gross margin, CapEx, subsidies and normalized operating-margin guidance.",
  };
  if (ticker === "CRCL") return {
    classification,
    baseline: {
      netCashB: 1.83,
      dilutedSharesB: 0.269,
      wacc: 0.12,
      terminalGrowth: 0.025,
      forwardEps: 0.72,
      forwardPe: 28,
      sotpSegments: [
        { name: "Net reserve economics", metric: "Q2 reserve income less distribution costs, annualized", metricValueB: 1.029, multiple: 18 },
        { name: "Other revenue", metric: "Q2 revenue annualized", metricValueB: 0.134, multiple: 10 },
        { name: "Payments / network optionality", metric: "unadjusted option value", metricValueB: 10, multiple: 1, probability: 0.4 },
      ],
      forwardRevenueB: 2.805,
      evSalesMultiple: 7,
      fcfMargin: 0.2,
    },
    thesis: { growthDelta: 0, marginDelta: 0, multipleDelta: 0, note: "The baseline values reserve contribution separately from non-reserve revenue and probability-weighted network optionality." },
    modelConfidence: { sotp: 0.66, forward_pe: 0.38, ev_sales: 0.42, reverse_dcf: 0.45 },
    sourcePosture: "reported_internal_forecast",
    inputSources: {
      sotpSegments: { kind: "reported", label: "Circle Q2 2026 reserve income, distribution costs and other revenue with explicit model multiples and probability", asOf: "2026-06-30", url: "https://www.sec.gov/Archives/edgar/data/1876042/000187604226000246/augustepr-circle_q22026f.htm" },
      netCashB: { kind: "reported", label: "Corporate cash only; stablecoin-holder reserves are excluded from equity net cash", asOf: "2026-06-30", url: "https://www.sec.gov/Archives/edgar/data/1876042/000187604226000246/augustepr-circle_q22026f.htm" },
    },
    evidenceMissing: ["Forward reserve yield curve", "USDC circulation scenarios", "Verified fee-bearing network adoption"],
    variantPath: "USDC circulation and reserve spread must offset lower rates while non-reserve network revenue becomes economically material.",
    downsideMechanism: "Lower short rates or slower USDC growth compress reserve economics while distribution and regulatory costs remain elevated.",
    evidenceGate: "Re-run on USDC circulation, reserve yield, net reserve margin, distribution costs and non-reserve revenue.",
  };
  return {
    classification,
    baseline: {},
    thesis: { growthDelta: 0, marginDelta: 0, multipleDelta: 0, note: "No Signal Ledger thesis is published until the baseline evidence is complete." },
    modelConfidence: {},
    sourcePosture: "input_required",
    evidenceMissing: ["Current market price or transaction mark", "Forecast financial statements", "Capital structure and diluted share count", "Model-specific operating drivers"],
    variantPath: "A variant path has not been published because the fundamental baseline is incomplete.",
    downsideMechanism: "Downside cannot be measured responsibly until the operating and capital-structure inputs are supplied.",
    evidenceGate: "Complete the company-specific evidence pack before publishing fair value or a rating.",
  };
};

export const SUPPORTED_TICKERS = Object.freeze([...new Set([...Object.keys(known), ...VERIFIED_MAJOR_STOCK_TICKERS])].sort());

export function getCuratedValuationProfile(ticker: string): ValuationProfile | null {
  const symbol = ticker.trim().toUpperCase();
  return symbol === "AMD" || symbol === "ORCL" ? profile(symbol) : null;
}

export function applyThesisAdjustments(baseline: ValuationAssumptions, thesis: ThesisAdjustments): ValuationAssumptions {
  const adjusted: ValuationAssumptions = structuredClone(baseline);
  const growthDelta = clamp(thesis.growthDelta, -0.2, 0.2);
  const marginDelta = clamp(thesis.marginDelta, -0.15, 0.15);
  const multipleDelta = clamp(thesis.multipleDelta, -0.5, 0.5);
  const marginBase = positive(baseline.fcfMargin) ? baseline.fcfMargin : 0.25;
  const marginFactor = clamp(1 + marginDelta / marginBase, 0.5, 1.5);
  const adjustPath = (path: number[] | undefined) => path?.map((value, index) => value * (1 + growthDelta) ** (index + 1) * marginFactor);
  adjusted.cashFlows = adjustPath(baseline.cashFlows);
  adjusted.normalizedCashFlows = adjustPath(baseline.normalizedCashFlows);
  if (positive(baseline.forwardEps)) adjusted.forwardEps = baseline.forwardEps * (1 + growthDelta) * marginFactor;
  if (positive(baseline.forwardFcfB)) adjusted.forwardFcfB = baseline.forwardFcfB * (1 + growthDelta) * marginFactor;
  if (positive(baseline.forwardRevenueB)) adjusted.forwardRevenueB = baseline.forwardRevenueB * (1 + growthDelta);
  const multipleFactor = clamp(1 + multipleDelta, 0.5, 1.5);
  if (positive(baseline.normalizedEbitdaB)) adjusted.normalizedEbitdaB = baseline.normalizedEbitdaB * (1 + growthDelta) * marginFactor;
  for (const key of ["forwardPe", "evEbitdaMultiple", "evFcfMultiple", "evSalesMultiple", "priceToTangibleBook", "priceToAffo"] as const) if (positive(baseline[key])) adjusted[key] = baseline[key] * multipleFactor;
  if (finite(baseline.terminalCashFlowB)) adjusted.terminalCashFlowB = baseline.terminalCashFlowB * (1 + growthDelta) ** (baseline.cashFlows ?? baseline.normalizedCashFlows ?? []).length * marginFactor;
  if (baseline.sotpSegments) adjusted.sotpSegments = baseline.sotpSegments.map((segment) => ({ ...segment, metricValueB: segment.metricValueB * (1 + growthDelta) * marginFactor, multiple: segment.multiple * multipleFactor }));
  if (finite(baseline.returnOnEquity)) adjusted.returnOnEquity = clamp(baseline.returnOnEquity + marginDelta, -0.25, 0.6);
  return adjusted;
}

function seedFromTicker(ticker: string) {
  return [...ticker].reduce((seed, character) => Math.imul(seed ^ character.charCodeAt(0), 16777619), 2166136261) >>> 0;
}

function randomNormal(seed: number) {
  let state = seed >>> 0;
  let spare: number | null = null;
  const uniform = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    if (spare !== null) { const value = spare; spare = null; return value; }
    const radius = Math.sqrt(-2 * Math.log(Math.max(uniform(), Number.EPSILON)));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

function quantile(values: number[], probability: number) {
  const position = (values.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] * (upper - position) + values[upper] * (position - lower);
}

type SimulationShocks = { growth: number; conversion: number; rate: number; multiple: number; probability: number; assetPrice: number };
type SimulationModel = Pick<ModelOutput, "model" | "role" | "effectiveWeight">;
export type ValuationSimulation = {
  percentiles: UniversalValuationOutput["ensemble"]["probabilityDistribution"];
  audit: {
    method: "business_input_sensitivity_v1";
    status: "computed" | "insufficient_valid_draws" | "not_run";
    seed: number;
    requestedDraws: number;
    validDraws: number;
    rejectedDraws: number;
    zeroEquityDraws: number;
    sampledInputs: string[];
    limitations: string[];
    reference: "ensemble" | "reconciled_segment_sotp" | "routed_cross_checks";
  };
};

/** Policy sensitivities on supplied forecasts, not fitted return volatilities.
 * One draw is shared by all models; balance-sheet facts/claims are held fixed.
 * Imported PVs without their underlying forecasts must NOT be jittered.
 */
export function sampleValuationAssumptions(a: ValuationAssumptions, shocks: SimulationShocks, uncertainty: number): ValuationAssumptions {
  const u = clamp(uncertainty, 0, 0.6);
  const growthFactor = Math.exp(shocks.growth * u * 0.2);
  const conversionChange = clamp(shocks.conversion * u * 0.5, -0.9, 0.9);
  const multipleFactor = Math.exp(shocks.multiple * u * 0.5);
  const result = { ...a };
  const adjustFlow = (value: number, year: number) => (value + Math.abs(value) * conversionChange) * growthFactor ** year;
  result.cashFlows = a.cashFlows?.map((value, index) => adjustFlow(value, index + 1));
  result.normalizedCashFlows = a.normalizedCashFlows?.map((value, index) => adjustFlow(value, index + 1));
  if (finite(a.terminalCashFlowB)) result.terminalCashFlowB = adjustFlow(a.terminalCashFlowB, (a.cashFlows ?? a.normalizedCashFlows ?? []).length);
  for (const key of ["forwardEps", "forwardFcfB", "normalizedEbitdaB", "affoPerShare"] as const) {
    if (finite(a[key])) result[key] = adjustFlow(a[key], 1);
  }
  if (finite(a.forwardRevenueB)) result.forwardRevenueB = a.forwardRevenueB * growthFactor;
  if (finite(a.fcfMargin)) result.fcfMargin = a.fcfMargin + Math.abs(a.fcfMargin) * conversionChange;
  for (const key of ["forwardPe", "evEbitdaMultiple", "evFcfMultiple", "evSalesMultiple", "priceToTangibleBook", "priceToAffo"] as const) {
    if (positive(a[key])) result[key] = a[key] * multipleFactor;
  }
  // Preserve FCFF/WACC and equity-stream/Ke pairing in the model itself.
  for (const key of ["wacc", "costOfEquity"] as const) {
    if (finite(a[key])) result[key] = clamp(a[key] + shocks.rate * u * 0.03, 0.04, 0.3);
  }
  for (const key of ["terminalGrowth", "residualGrowth"] as const) {
    if (finite(a[key])) result[key] = clamp(a[key] + shocks.growth * u * 0.01, 0, 0.06);
  }
  if (finite(a.returnOnEquity)) result.returnOnEquity = clamp(a.returnOnEquity + shocks.conversion * u * 0.08, -0.5, 0.8);
  const probability = (p: number) => p > 0 && p < 1 ? 1 / (1 + Math.exp(-(Math.log(p / (1 - p)) + shocks.probability * u * 2))) : p;
  result.sotpSegments = a.sotpSegments?.map((segment) => {
    if (segment.method === "equity_claim" || segment.metricValueB <= 0) return { ...segment };
    // DCF segment metrics are already present values, not revenue or profit.
    const fixedValue = segment.method === "dcf" || segment.method === "capital_based" || segment.method === "probability_weighted_option"
      || /unadjusted|present value|option value|npv/i.test(segment.metric);
    const revenueMetric = segment.method === "revenue_multiple" || /revenue|sales/i.test(segment.metric);
    return {
      ...segment,
      metricValueB: fixedValue ? segment.metricValueB : revenueMetric ? segment.metricValueB * growthFactor : adjustFlow(segment.metricValueB, 1),
      multiple: fixedValue ? segment.multiple : segment.multiple * multipleFactor,
      ...(segment.probability === undefined ? {} : { probability: probability(segment.probability) }),
    };
  });
  result.rnpvAssets = a.rnpvAssets?.map((asset) => ({ ...asset, probability: probability(asset.probability) }));
  result.projectNpvAssets = a.projectNpvAssets?.map((asset) => ({ ...asset, probability: probability(asset.probability) }));
  if (positive(a.bitcoinPriceUsd)) result.bitcoinPriceUsd = a.bitcoinPriceUsd * Math.exp(shocks.assetPrice * u);
  return result;
}

/** Re-run the eligible mathematical models per draw. Never perturb a fair-value
 * output, remove a losing draw, or silently reweight models when a draw fails.
 */
export function simulateValuationDistribution(
  seedKey: string, assumptions: ValuationAssumptions, outputs: SimulationModel[], uncertainty: number, count: number,
  reference: ValuationSimulation["audit"]["reference"] = "ensemble",
): ValuationSimulation {
  const calculated = outputs.filter((output) => output.role === "valuation" && output.effectiveWeight > 0);
  const weightSum = calculated.reduce((sum, output) => sum + output.effectiveWeight, 0);
  const active = new Set(calculated.map((output) => output.model));
  const seed = seedFromTicker(seedKey);
  const result: ValuationSimulation = {
    percentiles: { p10: null, p25: null, p50: null, p75: null, p90: null },
    audit: {
      method: "business_input_sensitivity_v1", status: "not_run", seed,
      requestedDraws: finite(count) ? clamp(Math.round(count), 1, 100_000) : 25_000,
      validDraws: 0, rejectedDraws: 0, zeroEquityDraws: 0, sampledInputs: [], reference,
      limitations: ["Family-policy sensitivity ranges and correlations are assumptions, not empirically calibrated probabilities or price forecasts. Reported balances, share counts and financing claims are held fixed."],
    },
  };
  if (!calculated.length || !positive(weightSum)) return result;
  const u = clamp(uncertainty, 0, 0.6);
  result.audit.limitations.push(`Policy one-standard-deviation inputs: annual cash-flow growth log-shift ${(u * 0.2 * 100).toFixed(2)}%; relative cash-conversion change ${(u * 0.5 * 100).toFixed(2)}%; multiple log-shift ${(u * 0.5 * 100).toFixed(2)}%; discount-rate shift ${(u * 0.03 * 100).toFixed(2)} percentage points; terminal-growth shift ${(u * 0.01 * 100).toFixed(2)} percentage points; success-probability log-odds shift ${(u * 2).toFixed(3)}; bitcoin-price log-shift ${(u * 100).toFixed(2)}%. Growth/conversion correlation 0.50; rate/multiple correlation −0.35. Only inputs used by selected models affect the result.`);
  const fields = result.audit.sampledInputs;
  if (active.has("dcf") || active.has("normalized_dcf")) {
    fields.push("forecast cash-flow growth", "cash conversion", isEquityCashFlowBasis(assumptions.cashFlowBasis) ? "cost of equity" : "WACC", "terminal growth");
    result.audit.limitations.push("Cash-flow paths use growth and cash-conversion sensitivities; separate revenue, CapEx and working-capital forecasts are not reconstructed from missing data.");
  }
  if (["forward_pe", "ev_ebitda", "ev_fcf", "ev_sales", "affo"].some((id) => active.has(id as ValuationModelId))) fields.push("forward operating drivers", "valuation multiples");
  if (active.has("residual_income")) fields.push("sustainable ROE", "cost of equity", "residual growth");
  if (active.has("p_tbv")) fields.push("P/TBV multiple");
  if (active.has("sotp")) {
    fields.push("eligible segment operating drivers and multiples", "segment success probabilities");
    result.audit.limitations.push("Precomputed DCF/capital/project values stay fixed when their underlying forecast paths are unavailable; only supplied operating drivers and probabilities are sampled.");
  }
  if (active.has("rnpv") || active.has("project_npv")) {
    fields.push("project success probability assumptions");
    result.audit.limitations.push("This varies estimated success probabilities, not realized binary clinical/project outcomes. Supplied project NPVs stay fixed.");
  }
  if (active.has("bitcoin_nav")) fields.push("bitcoin reference-price scenario");
  if (active.has("nav") || active.has("commodity_scenario")) result.audit.limitations.push("Supplied NAV and commodity scenario valuations stay fixed: underlying asset/cycle drivers are not available to simulate.");
  if (reference === "routed_cross_checks") result.audit.limitations.push("Routed-model sensitivity only; the dedicated company headline model is not simulated by this distribution.");
  const normal = randomNormal(seed);
  const values: number[] = [];
  for (let index = 0; index < result.audit.requestedDraws; index += 1) {
    const growth = normal();
    const rate = normal();
    const draw = sampleValuationAssumptions(assumptions, {
      growth, rate,
      conversion: 0.5 * growth + Math.sqrt(0.75) * normal(),
      multiple: -0.35 * rate + Math.sqrt(1 - 0.35 ** 2) * normal(),
      probability: normal(), assetPrice: normal(),
    }, uncertainty);
    let value = 0;
    let valid = true;
    for (const output of calculated) {
      const computed = VALUATION_MODELS[output.model].run(draw, null).value;
      if (!finite(computed)) { valid = false; break; }
      value += computed * output.effectiveWeight / weightSum;
    }
    if (!valid || !finite(value)) { result.audit.rejectedDraws += 1; continue; }
    // Common-equity limited liability. Insolvency is a zero, NOT a discarded draw.
    if (value <= 0) result.audit.zeroEquityDraws += 1;
    values.push(Math.max(0, value));
  }
  result.audit.validDraws = values.length;
  result.audit.status = values.length >= result.audit.requestedDraws * 0.95 ? "computed" : "insufficient_valid_draws";
  if (result.audit.status !== "computed") return result;
  values.sort((left, right) => left - right);
  result.percentiles = { p10: quantile(values, 0.1), p25: quantile(values, 0.25), p50: quantile(values, 0.5), p75: quantile(values, 0.75), p90: quantile(values, 0.9) };
  return result;
}

function auditValuationInputs(profile: ValuationProfile, assumptions: ValuationAssumptions): DataQualityCheck[] {
  const checks: DataQualityCheck[] = [...(profile.dataQuality?.checks ?? [])];
  const ratePass = finite(assumptions.wacc) && assumptions.wacc >= 0.04 && assumptions.wacc <= 0.2
    && finite(assumptions.terminalGrowth) && assumptions.terminalGrowth >= 0 && assumptions.terminalGrowth <= 0.06
    && assumptions.wacc > assumptions.terminalGrowth;
  checks.push({
    id: "discount-rate-range", provenance: "operating",
    label: "Discount-rate ranges",
    status: ratePass ? "passed" : "failed",
    detail: ratePass ? "WACC and terminal growth are within model guardrails." : "WACC or terminal growth is missing, outside guardrails, or internally inconsistent.",
  });
  const sharePass = positive(assumptions.dilutedSharesB) && assumptions.dilutedSharesB < 500;
  checks.push({
    id: "share-scale", provenance: "operating",
    label: "Share-count scale",
    status: sharePass ? "passed" : "failed",
    detail: sharePass ? "Diluted shares are stored in billions and pass the scale check." : "Diluted share count is missing or has an implausible scale.",
  });
  const marginPass = assumptions.fcfMargin === undefined || (finite(assumptions.fcfMargin) && Math.abs(assumptions.fcfMargin) <= 0.8);
  checks.push({
    id: "cash-margin-range", provenance: "operating",
    label: "Cash-margin range",
    status: marginPass ? "passed" : "failed",
    detail: marginPass ? "The forecast FCF margin is inside the permitted range." : "The forecast FCF margin is outside the permitted range.",
  });
  const earningsScalePass = !positive(assumptions.forwardEps) || !positive(assumptions.dilutedSharesB) || !positive(assumptions.forwardRevenueB)
    || assumptions.forwardEps * assumptions.dilutedSharesB <= assumptions.forwardRevenueB * 0.6;
  checks.push({
    id: "earnings-scale", provenance: "operating",
    label: "EPS and revenue scale",
    status: earningsScalePass ? "passed" : "failed",
    detail: earningsScalePass ? "EPS × diluted shares is dimensionally consistent with forecast revenue." : "EPS, diluted shares and revenue do not reconcile dimensionally.",
  });
  checks.push({
    id: "source-posture", provenance: "operating",
    label: "Forecast source posture",
    status: profile.sourcePosture === "analyst_estimate" ? "passed" : "warning",
    detail: profile.sourcePosture === "analyst_estimate"
      ? "A company-specific research forecast is present."
      : profile.sourcePosture === "reported_internal_forecast"
        ? "The forecast is generated from reported history and is screening-grade until guidance and consensus are connected."
        : "A company-specific forecast is incomplete; any surviving output is labelled screening-grade.",
  });
  return checks;
}

export function runRatingEngine(currentPrice: number | null, fairValue: number | null, confidence: number, buyZone: number | null, strongBuyZone: number | null) {
  if (!positive(fairValue) || !positive(buyZone) || !positive(strongBuyZone)) return { value: "WATCH" as Rating, riskAdjustedUpside: null, rationale: "The available evidence does not yet support a fair-value rating." };
  if (!positive(currentPrice)) return { value: "WATCH" as Rating, riskAdjustedUpside: null, rationale: "Fair value is available, but a current market price is required for a rating." };
  const expectedReturn = fairValue / currentPrice - 1;
  const riskAdjustedUpside = expectedReturn * confidence;
  if (currentPrice <= strongBuyZone && riskAdjustedUpside >= 0.22) return { value: "STRONG BUY" as Rating, riskAdjustedUpside, rationale: "Price is below the risk-adjusted strong-buy threshold and upside survives the confidence haircut." };
  if (currentPrice <= buyZone && riskAdjustedUpside >= 0.1) return { value: "BUY" as Rating, riskAdjustedUpside, rationale: "Price offers a sufficient discount to the model distribution after the confidence haircut." };
  if (riskAdjustedUpside <= -0.2) return { value: "SELL" as Rating, riskAdjustedUpside, rationale: "The selected price is materially above risk-adjusted fair value." };
  if (riskAdjustedUpside <= -0.08) return { value: "REDUCE" as Rating, riskAdjustedUpside, rationale: "The valuation premium is larger than the model confidence supports." };
  return { value: "WATCH" as Rating, riskAdjustedUpside, rationale: "The valuation gap is not large enough to clear the model's uncertainty and evidence hurdle." };
}

export type UniversalValuationOptions = { currentPrice?: number | null; priceAsOf?: string | null; priceSource?: string; thesis?: Partial<ThesisAdjustments>; simulationCount?: number };

type EnsembleResult = {
  models: ModelOutput[];
  valuationModels: ModelOutput[];
  includedModels: ModelOutput[];
  rawFairValue: number | null;
};

type ScenarioWeightedResult = {
  baseValue: number | null;
  expectedValue: number | null;
  residualProbability: number;
  scenarios: Array<{ id: string; name: string; probability: number; value: number | null }>;
};

/**
 * The model ensemble for one operating baseline: the weighted fair value plus the
 * per-model table. Extracted so the same computation that prices the base case can
 * also price each company-level scenario, guaranteeing the two are consistent.
 */
function computeEnsemble(
  selectedProfile: ValuationProfile,
  baseline: ValuationAssumptions,
  thesis: ThesisAdjustments,
  currentPrice: number | null,
): EnsembleResult {
  const classification = selectedProfile.classification;
  const family = MODEL_FAMILIES[classification.modelFamily];
  const adjustedAssumptions = applyThesisAdjustments(baseline, thesis);
  const rawOutputs: ModelOutput[] = family.models.map((entry) => {
    const calculation = VALUATION_MODELS[entry.model].run(adjustedAssumptions, currentPrice);
    const confidence = clamp(selectedProfile.modelConfidence[entry.model] ?? 0, 0, 1);
    const applicability = clamp(selectedProfile.modelApplicability?.[entry.model] ?? 1, 0, 1);
    return { model: entry.model, label: VALUATION_MODELS[entry.model].label, role: entry.role, status: positive(calculation.value) || (entry.role === "diagnostic" && calculation.missingInputs.length === 0) ? "calculated" : "input_required", value: positive(calculation.value) ? calculation.value : null, baseWeight: entry.baseWeight, applicability, confidence, priorReliability: entry.priorReliability, effectiveWeight: 0, explanation: calculation.explanation, missingInputs: calculation.missingInputs, diagnostics: calculation.diagnostics };
  });
  const requiredAnchors = PRIMARY_ANCHORS[classification.modelFamily] ?? [];
  const calculatedModels = rawOutputs.filter((output) => output.role === "valuation" && positive(output.value));
  const anchorModels = calculatedModels.filter((output) => requiredAnchors.includes(output.model));
  // A model the company profile explicitly disabled (applicability 0) is not a
  // comparability reference: it must not drag the center away from the
  // company-specific anchor that replaced it.
  const centerValues = (anchorModels.length ? anchorModels : calculatedModels.filter((output) => output.applicability > 0)).map((output) => output.value!).sort((left, right) => left - right);
  const center = centerValues.length
    ? centerValues.length % 2
      ? centerValues[Math.floor(centerValues.length / 2)]
      : (centerValues[centerValues.length / 2 - 1] + centerValues[centerValues.length / 2]) / 2
    : null;
  const includedIds = new Set(calculatedModels
    .filter((output) => requiredAnchors.includes(output.model) || !positive(center) || (output.value! >= center * 0.4 && output.value! <= center * 2.5))
    .map((output) => output.model));
  const rawWeight = rawOutputs.reduce((sum, output) => sum + (includedIds.has(output.model) ? output.baseWeight * output.applicability * output.confidence * output.priorReliability : 0), 0);
  const models = rawOutputs.map((output) => ({
    ...output,
    effectiveWeight: rawWeight > 0 && includedIds.has(output.model) ? output.baseWeight * output.applicability * output.confidence * output.priorReliability / rawWeight : 0,
    explanation: output.role === "valuation" && positive(output.value) && !includedIds.has(output.model)
      ? `${output.explanation} Excluded from the ensemble because it is not comparable with the company-specific anchor${
        (classification.modelFamily === "memory_cycle_semiconductor" || classification.modelFamily === "cyclical_semiconductor") && output.model === "forward_pe"
          ? ": a peak-earnings multiple cannot be blended with cycle-normalized economics."
          : "."
      }`
      : output.explanation,
  }));
  const valuationModels = models.filter((output) => output.role === "valuation" && positive(output.value));
  const includedModels = valuationModels.filter((output) => output.effectiveWeight > 0);
  const rawFairValue = includedModels.length ? includedModels.reduce((sum, output) => sum + output.value! * output.effectiveWeight, 0) : null;
  return { models, valuationModels, includedModels, rawFairValue };
}

/** Quantitative narrative is rendered from the actual same-run inputs. */
function describeForecast(assumptions: ValuationAssumptions): string {
  const revenue = finite(assumptions.forwardRevenueB) ? `$${assumptions.forwardRevenueB.toFixed(2)}B` : "unavailable";
  const path = assumptions.cashFlows ?? assumptions.normalizedCashFlows ?? [];
  return `forward revenue ${revenue}; forecast cash flows ${path.map((value) => `$${value.toFixed(2)}B`).join(" → ") || "unavailable"}. These are model estimates.`;
}

/** The sole return boundary: late bridge checks must govern every published
 * value just as early input checks do. Preliminary FV remains audit-only. */
function finalizeValuationPublication(candidate: UniversalValuationOutput): UniversalValuationOutput {
  const failed = candidate.dataQuality.valuationRelease === "withheld" || candidate.releaseGate !== "passed"
    || candidate.dataQuality.checks.some((check) => check.status === "failed");
  if (!failed) return candidate;
  const withheldCase = { value: null, assumptions: "Withheld because a required release check failed." };
  return {
    ...candidate,
    status: "unavailable",
    dataQuality: { ...candidate.dataQuality, status: "failed", valuationRelease: "withheld" },
    releaseGate: "model_check_required",
    models: candidate.models.map((model) => model.role === "valuation"
      ? { ...model, value: null, effectiveWeight: 0, status: "input_required", missingInputs: ["release checks"], explanation: "Output withheld because a required release check failed." } : model),
    ensemble: { fairValue: null, expectedReturn: null, confidence: 0, probabilityDistribution: { p10: null, p25: null, p50: null, p75: null, p90: null }, scenarios: { bear: null, base: null, bull: null } },
    ...(candidate.researchScenarios ? { researchScenarios: { ...candidate.researchScenarios, baseValue: null, expectedValue: null, scenarios: candidate.researchScenarios.scenarios.map((scenario) => ({ ...scenario, value: null })) } } : {}),
    valuationScenarios: { ...candidate.valuationScenarios, bear: withheldCase, base: withheldCase, bull: withheldCase, weighted: null },
    rating: { value: "WATCH", riskAdjustedUpside: null, buyZone: null, strongBuyZone: null, rationale: "Valuation withheld because a required release check failed." },
    marketImpliedExpectations: { headline: candidate.marketImpliedExpectations.headline, impliedFcfCagr: null, terminalFcfB: null, impliedRevenueB: null, impliedForwardPe: null, requiredGrowthPct: null, requiredMarginPct: null, requiredRevenueB: null, requiredSegmentValueB: null, requiredSuccessProbability: null },
    qualityReview: { ...candidate.qualityReview, status: "MODEL_CHECK_REQUIRED", publishable: false, preliminaryFairValue: candidate.qualityReview.preliminaryFairValue ?? candidate.ensemble.fairValue,
      gates: candidate.qualityReview.gates.map((gate) => gate.id === "data" ? { ...gate, status: "failed", detail: "A required final release check failed." } : gate) },
    reconciliation: { ...candidate.reconciliation, segmentValueB: null, enterpriseValueB: null, equityValueB: null, perShare: null, differencePct: null, matchesFairValue: false },
    confidenceLabel: "Low confidence",
    confidenceBreakdown: { ...candidate.confidenceBreakdown, total: 0 },
    spcx: null, mu: null,
    engine: { ...candidate.engine, modelsIncluded: 0, publishedModel: null },
  };
}

export function runValuationProfile(selectedProfile: ValuationProfile, options: UniversalValuationOptions = {}): UniversalValuationOutput {
  const classification = selectedProfile.classification;
  const symbol = classification.ticker;
  const family = MODEL_FAMILIES[classification.modelFamily];
  const thesis = { ...selectedProfile.thesis, ...options.thesis };
  const adjustedAssumptions = applyThesisAdjustments(selectedProfile.baseline, thesis);
  const currentPrice = positive(options.currentPrice) ? options.currentPrice : selectedProfile.referencePrice?.value ?? null;
  const { models, valuationModels, includedModels, rawFairValue } = computeEnsemble(selectedProfile, selectedProfile.baseline, thesis, currentPrice);
  // Probability-weighted company-level scenarios. Each scenario is priced through
  // the SAME ensemble as the base case, then the declared probabilities produce the
  // expectation — the one place scenario probabilities may move the published value.
  let scenarioWeightedResult: ScenarioWeightedResult | null = null;
  let incompleteScenario = false;
  if (selectedProfile.scenarioWeighted && selectedProfile.scenarioWeighted.scenarios.length > 0) {
    const sw = selectedProfile.scenarioWeighted;
    const scenarios = sw.scenarios.map((scenario) => {
      const ens = computeEnsemble(selectedProfile, scenario.baseline, thesis, currentPrice);
      return { id: scenario.id, name: scenario.name, probability: scenario.probability, value: ens.rawFairValue };
    });
    const residualProbability = clamp(sw.residualProbability, 0, 1);
    incompleteScenario = (residualProbability > 0 && !finite(rawFairValue))
      || scenarios.some((scenario) => scenario.probability > 0 && !finite(scenario.value));
    // Null means uncomputed, never an economic zero. Zero-weight states do not
    // contribute; every positive-weight state must be computable before release.
    const expectedValue = incompleteScenario ? null : (residualProbability > 0 ? residualProbability * rawFairValue! : 0)
      + scenarios.reduce((sum, scenario) => sum + (scenario.probability > 0 ? scenario.probability * scenario.value! : 0), 0);
    scenarioWeightedResult = { baseValue: rawFairValue, expectedValue, residualProbability, scenarios };
  }
  // When a reconciled segment SOTP dominates the ensemble it becomes the
  // published value, so the published number and the equity bridge cannot drift
  // apart. Other models stay visible as cross-checks with their own numbers.
  const sotpOutput = includedModels.find((output) => output.model === "sotp") ?? null;
  const segmentDominant = Boolean(sotpOutput && sotpOutput.effectiveWeight >= 0.6);
  const muDetailProfile = selectedProfile.mu;
  const muGoverns = Boolean(muDetailProfile?.qualityGates.publishable && muDetailProfile.weightedFairValue);
  const publishedFairValue = scenarioWeightedResult?.expectedValue != null
    ? scenarioWeightedResult.expectedValue
    : muGoverns
      ? muDetailProfile!.weightedFairValue
      : segmentDominant && sotpOutput?.value ? sotpOutput.value : rawFairValue;
  const publishedBasis: "reconciled_segment_sotp" | "ensemble" = segmentDominant ? "reconciled_segment_sotp" : "ensemble";
  const modelConfidence = includedModels.length ? includedModels.reduce((sum, output) => sum + output.confidence * output.priorReliability * output.effectiveWeight, 0) : 0;
  const routedCount = family.models.filter((entry) => entry.role === "valuation").length;
  const coverage = routedCount ? includedModels.length / routedCount : 0;
  const requiredAnchors = PRIMARY_ANCHORS[classification.modelFamily] ?? [];
  const anchorSatisfied = !requiredAnchors.length || requiredAnchors.some((anchor) => includedModels.some((output) => output.model === anchor));
  const qualityChecks = auditValuationInputs(selectedProfile, adjustedAssumptions);
  if (incompleteScenario) qualityChecks.push({ id: "scenario-computation", provenance: "operating", label: "Scenario completeness", status: "failed", detail: "A positive-probability scenario could not be calculated; null cannot contribute an invented zero." });
  qualityChecks.push({
    id: "primary-model-anchor", provenance: "operating",
    label: "Company-specific valuation anchor",
    status: anchorSatisfied ? "passed" : "warning",
    detail: anchorSatisfied ? "The routed primary valuation anchor is present." : `Primary anchor unavailable; the engine switched to surviving compatible models: ${requiredAnchors.map((anchor) => VALUATION_MODELS[anchor].label).join(" / ")}.`,
  });
  const calculatedValues = valuationModels.map((output) => output.value!).filter(positive);
  const valuedModelCount = calculatedValues.length;
  const dispersion = calculatedValues.length > 1 ? Math.max(...calculatedValues) / Math.max(0.01, Math.min(...calculatedValues)) : null;
  const excludedCount = valuationModels.length - includedModels.length;
  qualityChecks.push({
    id: "model-dispersion", provenance: "operating",
    label: "Cross-model dispersion",
    status: dispersion === null || dispersion <= 2.5 ? "passed" : "warning",
    detail: dispersion === null
      ? "Only one model calculated; dispersion is not measurable."
      : excludedCount
        ? `Highest model output is ${dispersion.toFixed(1)}× the lowest; ${excludedCount} non-comparable model${excludedCount === 1 ? " was" : "s were"} excluded from the ensemble.`
        : `Highest model output is ${dispersion.toFixed(1)}× the lowest; uncertainty is reflected in confidence and the valuation range.`,
  });
  // Sanity checks below detect broken models. They never anchor fair value to
  // the market price; they explain, downweight or reject a result that cannot
  // be reconciled with reported scale.
  const marketCapB = positive(currentPrice) && positive(adjustedAssumptions.dilutedSharesB)
    ? currentPrice * adjustedAssumptions.dilutedSharesB
    : null;
  const revenueScaleB = positive(adjustedAssumptions.forwardRevenueB) ? adjustedAssumptions.forwardRevenueB : null;
  // Asset-backed and pre-revenue families cannot be cross-checked against
  // revenue, so the scale reference follows the economics actually in use.
  const bitcoinAssetsB = positive(adjustedAssumptions.bitcoinHoldings) && positive(adjustedAssumptions.bitcoinPriceUsd)
    ? (adjustedAssumptions.bitcoinHoldings! * adjustedAssumptions.bitcoinPriceUsd!) / 1e9
    : null;
  const scaleReferenceB = classification.modelFamily === "bitcoin_treasury" ? bitcoinAssetsB : revenueScaleB && revenueScaleB >= 0.05 ? revenueScaleB : null;
  const priceToSales = marketCapB !== null && scaleReferenceB ? marketCapB / scaleReferenceB : null;
  // Unit identities: the same quantities must agree across price, shares,
  // enterprise value and the reported capital bridge before publication.
  const unitIdentities: string[] = [];
  const unitIdentityFailed: string[] = [];
  if (positive(currentPrice) && positive(adjustedAssumptions.dilutedSharesB)) {
    unitIdentities.push(`market cap = price × diluted shares = ${formatUsdB(marketCapB)}B`);
  } else if (!positive(adjustedAssumptions.dilutedSharesB)) unitIdentityFailed.push("diluted shares missing for the per-share identity");
  else unitIdentities.push("market-cap comparison unavailable: no current price supplied");
  if (finite(adjustedAssumptions.wacc) && adjustedAssumptions.wacc >= 0.04 && adjustedAssumptions.wacc <= 0.2 && finite(adjustedAssumptions.terminalGrowth) && adjustedAssumptions.terminalGrowth >= 0 && adjustedAssumptions.terminalGrowth < adjustedAssumptions.wacc) {
    unitIdentities.push("discount rate and terminal growth inside guardrails");
  } else unitIdentityFailed.push("discount rate or terminal growth outside guardrails");
  if (adjustedAssumptions.fcfMargin === undefined || (finite(adjustedAssumptions.fcfMargin) && Math.abs(adjustedAssumptions.fcfMargin) <= 0.8)) {
    unitIdentities.push("cash margin inside plausible bounds");
  } else unitIdentityFailed.push("cash margin outside plausible bounds");
  if (positive(adjustedAssumptions.forwardEps) && positive(adjustedAssumptions.dilutedSharesB) && positive(adjustedAssumptions.forwardRevenueB)) {
    const impliedEps = (adjustedAssumptions.forwardEps * adjustedAssumptions.dilutedSharesB) / adjustedAssumptions.forwardRevenueB;
    if (impliedEps > 0 && impliedEps <= 0.6) unitIdentities.push("EPS × shares reconciles with revenue scale");
    else unitIdentityFailed.push("EPS × shares does not reconcile with revenue scale");
  }

  const splitConsistent = priceToSales === null || (priceToSales >= 0.02 && priceToSales <= 100);
  qualityChecks.push({
    id: "unit-identities", provenance: "mixed",
    label: "Unit identities",
    status: unitIdentityFailed.length === 0 ? "passed" : "failed",
    detail: unitIdentityFailed.length === 0
      ? `Verified: ${unitIdentities.join("; ")}.`
      : `Failed: ${unitIdentityFailed.join("; ")}.`,
  });
  qualityChecks.push({
    id: "split-and-share-count", provenance: "market",
    label: "Split and share-count check",
    status: splitConsistent ? "passed" : "failed",
    detail: priceToSales === null
      ? "Market capitalization could not be cross-checked against a comparable value base; no split or share-count claim is made."
      : splitConsistent
        ? `Price × diluted shares implies ${priceToSales.toFixed(1)}× the family's value base, consistent with a correctly scaled share count.`
        : `Price × diluted shares implies ${priceToSales.toFixed(1)}× the family's value base. That is outside the plausible range and usually means a stale share count, an unadjusted split or a mismatched unit.`,
  });
  const bridgeConsistent = marketCapB === null || !finite(adjustedAssumptions.netCashB)
    || Math.abs(adjustedAssumptions.netCashB) <= Math.max(1, marketCapB * 3);
  qualityChecks.push({
    id: "ev-equity-bridge", provenance: "market",
    label: "EV / equity bridge check",
    status: bridgeConsistent ? "passed" : "failed",
    detail: marketCapB === null
      ? "No market capitalization was available for the enterprise-to-equity bridge check."
      : bridgeConsistent
        ? "Net cash or net debt is within a plausible scale relative to market capitalization."
        : "Net cash or net debt exceeds three times market capitalization; the enterprise-to-equity bridge is not usable.",
  });
  const reverseDiagnostics = models.find((output) => output.model === "reverse_dcf")?.diagnostics ?? null;
  const impliedGrowth = reverseDiagnostics?.impliedFcfCagr ?? null;
  const impliedRevenueB = reverseDiagnostics?.impliedRevenueB ?? null;
  const impliedGrowthPlausible = impliedGrowth === null || Math.abs(impliedGrowth) <= 0.6;
  const impliedMarginPlausible = impliedRevenueB === null || !revenueScaleB || impliedRevenueB <= revenueScaleB * 5;
  qualityChecks.push({
    id: "implied-expectations", provenance: "market",
    label: "Implied growth and margin check",
    status: impliedGrowthPlausible && impliedMarginPlausible ? "passed" : "warning",
    detail: impliedGrowth === null
      ? "No reverse-DCF diagnostic was available, so implied expectations were not tested."
      : impliedGrowthPlausible && impliedMarginPlausible
        ? `The selected price requires roughly ${(impliedGrowth * 100).toFixed(1)}% implied FCF growth${impliedRevenueB ? ` and about $${impliedRevenueB.toFixed(1)}B of revenue at the exit multiple` : ""}.`
        : `The selected price implies ${(impliedGrowth * 100).toFixed(1)}% FCF growth${impliedRevenueB ? ` and $${impliedRevenueB.toFixed(1)}B of revenue` : ""}, outside the range this model can defend with the available evidence.`,
  });
  const modelGapPct = positive(publishedFairValue) && positive(currentPrice) ? publishedFairValue / currentPrice - 1 : null;
  const gapWithinBand = modelGapPct === null || Math.abs(modelGapPct) <= 0.4;
  qualityChecks.push({
    id: "market-implied-reconciliation", provenance: "market",
    label: "Market-price reconciliation",
    status: gapWithinBand ? "passed" : "warning",
    detail: modelGapPct === null
      ? "No market price was supplied, so the model could not be reconciled against the price the market is paying."
      : gapWithinBand
        ? `The model is ${(modelGapPct * 100).toFixed(1)}% from the market price, inside the reconciliation band for this family.`
        : `The model is ${(modelGapPct * 100).toFixed(1)}% ${modelGapPct < 0 ? "below" : "above"} the market price. The gap is only justified if ${family.primaryQuestion.toLowerCase()}${impliedGrowth === null ? "" : ` In practice the market price implies roughly ${(impliedGrowth * 100).toFixed(1)}% FCF growth, against a model path of ${(nextGrowthFromAssumptions(adjustedAssumptions) * 100).toFixed(1)}% in year one.`} Until that evidence exists, the model output is a screen rather than a claim that the market is wrong.`,
  });
  const hasFailedCheck = selectedProfile.dataQuality?.valuationRelease === "withheld" || qualityChecks.some((check) => check.status === "failed");
  const hasWarning = qualityChecks.some((check) => check.status === "warning");
  const valuationRelease: DataQualityReport["valuationRelease"] = hasFailedCheck
    ? "withheld"
    : selectedProfile.sourcePosture === "analyst_estimate" && !hasWarning
      ? "released"
      : "screening_only";
  const dataQuality: DataQualityReport = {
    status: hasFailedCheck ? "failed" : hasWarning ? "warning" : "passed",
    valuationRelease,
    checks: qualityChecks,
  };
  const fairValue = valuationRelease === "withheld" ? null : publishedFairValue;
  // Confidence is a named aggregate, not one opaque number.
  const meanModelConfidence = includedModels.length ? includedModels.reduce((sum, output) => sum + output.confidence, 0) / includedModels.length : 0;
  const postureFactor = selectedProfile.sourcePosture === "analyst_estimate" ? 1
    : selectedProfile.sourcePosture === "reported_internal_forecast" ? 0.85
      : 0.6;
  const confidenceComponents = {
    dataQuality: dataQuality.status === "passed" ? 0.9 : dataQuality.status === "warning" ? 0.7 : 0.3,
    // Forecast quality is the weighted quality of the forecasts themselves,
    // discounted when the package is model-derived rather than analyst-grade.
    forecastQuality: clamp(modelConfidence * postureFactor, 0.05, 1),
    // Agreement is measured across every model that calculated, including the
    // ones excluded from the ensemble, and a single model demonstrates nothing.
    modelAgreement: valuedModelCount < 2 ? 0.15 : dispersion === null ? 0.5 : clamp(1 - (dispersion - 1) / 3, 0.15, 1),
    sourceProvenance: (() => {
      const sources = Object.values(selectedProfile.inputSources ?? {});
      if (!sources.length) return 0.35;
      const reported = sources.filter((source) => source?.kind === "reported" || source?.kind === "company_guidance" || source?.kind === "consensus").length;
      return clamp(0.35 + (reported / sources.length) * 0.6, 0.15, 0.95);
    })(),
    evidenceFreshness: (() => {
      const asOf = Object.values(selectedProfile.inputSources ?? {}).map((source) => source?.asOf).filter((value): value is string => Boolean(value)).sort().at(-1);
      if (!asOf) return 0.45;
      const ageDays = (Date.now() - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000;
      return Number.isFinite(ageDays) ? clamp(1 - ageDays / 400, 0.3, 1) : 0.45;
    })(),
  };
  // Weighted geometric mean: a weak component pulls the total down instead of
  // being averaged away by the components that happen to score well.
  const confidenceWeights = { dataQuality: 0.2, forecastQuality: 0.35, modelAgreement: 0.2, sourceProvenance: 0.15, evidenceFreshness: 0.1 };
  const ensembleConfidence = clamp(
    (Object.keys(confidenceWeights) as Array<keyof typeof confidenceWeights>)
      .reduce((product, key) => product * Math.max(0.05, confidenceComponents[key]) ** confidenceWeights[key], 1),
    0,
    0.95,
  );
  // SPCX publishes its own structured confidence. That value IS the canonical
  // one, so the headline and the model audit can never disagree about it; the
  // generic ensemble score only applies to families that do not bring their own.
  const confidence = selectedProfile.spcx?.confidence.overall ?? ensembleConfidence;
  const simulationCount = clamp(Math.round(finite(options.simulationCount) ? options.simulationCount : 25_000), 1_000, 100_000);
  const simulation = simulateValuationDistribution(
    classification.companyName, adjustedAssumptions,
    valuationRelease === "withheld" ? [] : segmentDominant ? models.filter((item) => item.model === "sotp") : models,
    family.uncertainty * (anchorSatisfied ? 1 : 1.35), simulationCount,
    muGoverns ? "routed_cross_checks" : publishedBasis,
  );
  const probabilityDistribution = simulation.percentiles;
  // The SPCX and MU buy zones are expected-return based (see the company-specific
  // models); every other family keeps the distribution-percentile zone.
  const spcxDetail = selectedProfile.spcx;
  const muBuyZone = selectedProfile.mu?.buyZone ?? null;
  const qualityBlocked = false; // set below once the quality review is computed
  const buyZone = spcxDetail?.buyZone ? spcxDetail.buyZone.buyPrice : muBuyZone ? muBuyZone.buyPrice : positive(probabilityDistribution.p25) ? probabilityDistribution.p25 * (1 - family.buyZoneDiscount) : null;
  const strongBuyZone = spcxDetail?.buyZone ? spcxDetail.buyZone.strongBuyPrice : muBuyZone ? muBuyZone.strongBuyPrice : positive(probabilityDistribution.p10) ? probabilityDistribution.p10 * (1 - family.strongBuyZoneDiscount) : null;
  const status: UniversalValuationOutput["status"] = valuationRelease === "withheld"
    ? "unavailable"
    : includedModels.length >= 3 && anchorSatisfied && selectedProfile.sourcePosture === "analyst_estimate" && dataQuality.status === "passed"
    ? "decision-grade"
    : !anchorSatisfied || (dispersion !== null && dispersion > 3.5)
      ? "high-uncertainty"
    : includedModels.length >= 2
      ? "provisional"
      : includedModels.length >= 1
        ? "screening"
        : "unavailable";
  // Published reconciliation: segments (or the model enterprise value) + cash
  // and investments − debt − other claims − dilution = equity value, divided by
  // fully diluted shares. Every route must close, not only the SOTP route.
  const capitalBridge = selectedProfile.capitalBridge ?? null;
  const bridgeSegments = adjustedAssumptions.sotpSegments;
  const dilutionB = bridgeSegments?.filter((segment) => /dilution|stock-based/i.test(segment.name))
    .reduce((sum, segment) => sum + segment.metricValueB * segment.multiple * clamp(segment.probability ?? 1, 0, 1), 0) ?? null;
  const segmentValueB = bridgeSegments?.length
    ? bridgeSegments.reduce((sum, segment) => sum + segment.metricValueB * segment.multiple * clamp(segment.probability ?? 1, 0, 1), 0)
    : null;
  const sharesB = positive(adjustedAssumptions.dilutedSharesB) ? adjustedAssumptions.dilutedSharesB! : null;
  const netCashUsedB = finite(adjustedAssumptions.netCashB) ? adjustedAssumptions.netCashB! : null;
  const preferredClaimsB = capitalBridge?.preferredClaimsB ?? 0;
  const minorityInterestB = capitalBridge?.minorityInterestB ?? 0;
  const itemizedNetCashB = capitalBridge
    ? capitalBridge.cashB + capitalBridge.investmentsB - capitalBridge.debtB - preferredClaimsB - minorityInterestB - capitalBridge.otherClaimsB
    : null;
  // The itemized bridge must agree with the net cash the models actually used.
  // Three situations are legitimately different rather than wrong:
  //  • balance-sheet businesses (banks, insurers, asset managers, REITs,
  //    utilities) are not valued through an enterprise-value bridge;
  //  • a curated research baseline and the latest filing are different vintages;
  //  • a family-specific policy may deliberately replace net cash.
  // Those cases are labelled instead of failing; everything else keeps the
  // tolerance check that catches a real sign error or a missing claim.
  const bridgeToleranceB = itemizedNetCashB === null ? 0 : Math.max(1, Math.abs(itemizedNetCashB) * 0.25);
  const balanceSheetFamily = ["bank", "insurance", "asset_manager", "reit", "utility"].includes(classification.modelFamily);
  const bridgeDifferenceB = itemizedNetCashB === null || netCashUsedB === null ? 0 : Math.abs(itemizedNetCashB - netCashUsedB);
  const bridgeInputsConsistent = itemizedNetCashB === null || netCashUsedB === null
    || balanceSheetFamily
    || Boolean(capitalBridge?.note)
    || classification.modelFamily === "stablecoin_network"
    || selectedProfile.sourcePosture === "analyst_estimate"
    || bridgeDifferenceB <= bridgeToleranceB;
  // The bridge always reconciles the PUBLISHED per-share value. When a segment
  // SOTP governs the publication the two are the same computation, so the
  // segment sum is retained as an independent view rather than a second answer.
  const equityValueB = positive(fairValue) && sharesB
    ? fairValue! * sharesB
    : segmentValueB !== null && netCashUsedB !== null ? segmentValueB + netCashUsedB : null;
  const enterpriseValueB = equityValueB !== null && netCashUsedB !== null ? equityValueB - netCashUsedB : segmentValueB;
  const reconciliationPerShare = equityValueB !== null && sharesB ? equityValueB / sharesB : null;
  const reconciliation = {
    segmentValueB,
    enterpriseValueB,
    cashB: capitalBridge ? capitalBridge.cashB : null,
    investmentsB: capitalBridge ? capitalBridge.investmentsB : null,
    debtB: capitalBridge ? capitalBridge.debtB : null,
    preferredClaimsB: capitalBridge ? preferredClaimsB : null,
    minorityInterestB: capitalBridge ? minorityInterestB : null,
    otherClaimsB: capitalBridge ? capitalBridge.otherClaimsB : null,
    // Only report a dilution line when the routed models actually subtract it;
    // otherwise the run-rate is shown as information, not as an applied claim.
    dilutionB: dilutionB !== null && dilutionB < 0 ? Math.abs(dilutionB) : null,
    equityValueB,
    basicSharesB: sharesB,
    dilutedSharesB: sharesB,
    perShare: reconciliationPerShare,
    differencePct: reconciliationPerShare !== null && positive(fairValue) ? ((reconciliationPerShare - fairValue!) / fairValue!) * 100 : null,
    warnings: [
      ...(balanceSheetFamily ? ["This family is valued on equity directly: an enterprise-value bridge is not the applicable framework, so the bridge is presented as equity value ÷ diluted shares."] : []),
      ...(capitalBridge?.note ? [capitalBridge.note] : []),
      ...(itemizedNetCashB !== null && netCashUsedB !== null && Math.abs(itemizedNetCashB - netCashUsedB) > bridgeToleranceB && !balanceSheetFamily ? [`The itemized capital bridge (${formatUsdB(itemizedNetCashB)}B net cash) differs from the net cash the models used (${formatUsdB(netCashUsedB)}B); this is expected when a curated research baseline and the latest filing are different vintages.`] : []),
      ...(capitalBridge === null ? ["Capital bridge is not itemized for this route, so the bridge is shown at the equity value implied by the published per-share result."] : []),
    ],
    bridgeInputsConsistent,
    matchesFairValue: reconciliationPerShare !== null
      && positive(fairValue)
      && bridgeInputsConsistent
      && Math.abs(reconciliationPerShare - fairValue!) <= Math.max(0.02, Math.abs(fairValue!) * 0.005),
  };
  const releaseGate: UniversalValuationOutput["releaseGate"] = valuationRelease !== "withheld" && positive(fairValue) && reconciliation.matchesFairValue
    && (selectedProfile.aiExposure?.doubleCountCheckPassed ?? true)
    ? "passed"
    : "model_check_required";
  const releaseGateDetail = releaseGate === "passed"
    ? `Equity bridge closes: ${formatUsdB(equityValueB)} equity value ÷ ${sharesB?.toFixed(3) ?? "—"}B diluted shares = ${formatUsdB(reconciliationPerShare)} per share${segmentDominant ? ", published from the reconciled segment SOTP" : publishedBasis === "ensemble" && segmentValueB !== null ? "; the segment SOTP is shown as an independent cross-check" : ""}.`
    : valuationRelease === "withheld"
      ? "Valuation withheld because a required unit or data-integrity check failed."
      : reconciliation.perShare === null
        ? "The equity bridge could not be completed: a usable diluted share count or equity value is missing."
      : !reconciliation.bridgeInputsConsistent
          ? `The itemized capital bridge does not agree with the net cash used by the models (${formatUsdB(itemizedNetCashB)} vs ${formatUsdB(netCashUsedB)}).`
          : selectedProfile.aiExposure && !selectedProfile.aiExposure.doubleCountCheckPassed
            ? "The AI double-count check failed: standalone AI value is also present inside another segment or the terminal multiple."
            : `The bridge value ${formatUsdB(reconciliationPerShare)} does not reconcile to the published ${formatUsdB(fairValue)} per share.`;
  if (releaseGate === "model_check_required") {
    qualityChecks.push({
      id: "release-gate", provenance: "mixed",
      label: "Release gate",
      status: "failed",
      detail: releaseGateDetail,
    });
  }
  const impliedForwardPe = valuationRelease !== "withheld" && positive(currentPrice) && positive(adjustedAssumptions.forwardEps) ? currentPrice / adjustedAssumptions.forwardEps : null;
  // ---------------------------------------------------------------
  // Global valuation quality control
  // ---------------------------------------------------------------
  const qualityEbitdaB = positive(adjustedAssumptions.normalizedEbitdaB)
    ? adjustedAssumptions.normalizedEbitdaB!
    : positive(adjustedAssumptions.forwardRevenueB) && positive(adjustedAssumptions.fcfMargin)
      ? adjustedAssumptions.forwardRevenueB! * (adjustedAssumptions.fcfMargin! + 0.08)
      : null;
  const qualityRevenueB = positive(adjustedAssumptions.forwardRevenueB) ? adjustedAssumptions.forwardRevenueB! : null;
  const marketCapQualityB = positive(currentPrice) && sharesB ? currentPrice! * sharesB : null;
  const marketEvB = marketCapQualityB !== null && netCashUsedB !== null ? marketCapQualityB - netCashUsedB : null;
  const publishedEvB = positive(fairValue) && sharesB && netCashUsedB !== null ? fairValue! * sharesB - netCashUsedB : null;
  const qualityFlags: string[] = [];
  const evEbitdaPublished = publishedEvB !== null && qualityEbitdaB ? publishedEvB / qualityEbitdaB : null;
  const evRevenuePublished = publishedEvB !== null && qualityRevenueB ? publishedEvB / qualityRevenueB : null;
  const fcfYieldPublished = positive(fairValue) && sharesB && finite(adjustedAssumptions.forwardFcfB) && adjustedAssumptions.forwardFcfB! > 0
    ? (adjustedAssumptions.forwardFcfB! / (fairValue! * sharesB)) * 100
    : null;
  if (evEbitdaPublished !== null && evEbitdaPublished < 3) {
    qualityFlags.push(`The published value implies EV/EBITDA of ${evEbitdaPublished.toFixed(1)}× on forward EBITDA, which is implausibly low for a going-concern equity valuation.`);
  }
  if (evEbitdaPublished !== null && evEbitdaPublished > 45) {
    qualityFlags.push(`The published value implies EV/EBITDA of ${evEbitdaPublished.toFixed(1)}×, which requires the full forecast path to be achieved.`);
  }
  if (evRevenuePublished !== null && evRevenuePublished < 0.2) {
    qualityFlags.push(`The published value implies EV/Revenue of ${evRevenuePublished.toFixed(2)}×, below liquidation-style multiples for an operating business.`);
  }
  const divergenceGapPct = positive(fairValue) && positive(currentPrice) ? (fairValue! / currentPrice! - 1) * 100 : null;
  const divergenceThresholdPct = 50;
  const divergenceTriggered = divergenceGapPct !== null && Math.abs(divergenceGapPct) > divergenceThresholdPct;
  const spcxGates = selectedProfile.spcx?.qualityGates;
  const muGates = selectedProfile.mu?.qualityGates;
  const dataGatePassed = !hasFailedCheck && (spcxGates ? spcxGates.data.status === "passed" : muGates ? muGates.data : true);
  const modelGatePassed = spcxGates ? spcxGates.model.status === "passed" : muGates ? muGates.forecast && muGates.valuation : qualityFlags.length === 0;
  const sanityGatePassed = spcxGates
    ? spcxGates.sanity.status === "passed"
    : muGates
      ? muGates.sanity && qualityFlags.length === 0
      : qualityFlags.length === 0;
  const publishable = valuationRelease !== "withheld" && releaseGate === "passed" && positive(fairValue) && dataGatePassed && modelGatePassed && sanityGatePassed;
  const qualityStatus: UniversalValuationOutput["qualityReview"]["status"] = publishable
    ? "passed"
    : divergenceTriggered && dataGatePassed
      ? "MODEL_DIVERGENCE_REVIEW"
      : "MODEL_CHECK_REQUIRED";
  const qualityReview: UniversalValuationOutput["qualityReview"] = {
    status: qualityStatus,
    publishable,
    gates: [
      { id: "data", label: "Data gate", status: dataGatePassed ? "passed" : "failed", detail: spcxGates?.data.detail ?? (muGates ? `Reported quarter anchored: revenue ${selectedProfile.mu!.anchors.quarter.revenueM.toFixed(0)}M, gross profit ${selectedProfile.mu!.anchors.quarter.grossProfitM.toFixed(0)}M, EPS ${selectedProfile.mu!.anchors.quarter.eps.toFixed(2)}, diluted shares ${selectedProfile.mu!.anchors.dilutedSharesM.toFixed(0)}M.` : `Required units, share count and reported anchors present (${qualityChecks.filter((check) => check.status === "passed").length}/${qualityChecks.length} checks passed).`) },
      { id: "model", label: "Model gate", status: modelGatePassed ? "passed" : "failed", detail: spcxGates?.model.detail ?? (muGates ? `Five-year forecast built with HBM held structural and legacy DRAM/NAND normalised annually; ${selectedProfile.mu!.methods.filter((method) => method.value !== null).length} valuation methods reconciled.` : qualityFlags.length ? qualityFlags.join(" ") : "Every model reconciled to its own arithmetic and no placeholder multiple was required.") },
      { id: "sanity", label: "Sanity gate", status: sanityGatePassed ? "passed" : "failed", detail: spcxGates?.sanity.detail ?? (muGates && selectedProfile.mu!.sanity.flags.length ? selectedProfile.mu!.sanity.flags.join(" ") : qualityFlags.length ? qualityFlags.join(" ") : "Implied multiples and the market comparison are inside plausible bands.") },
    ],
    impliedMultiples: {
      fairValueEvRevenue: evRevenuePublished,
      fairValueEvEbitda: evEbitdaPublished,
      fairValueFcfYieldPct: fcfYieldPublished,
      marketEvRevenue: marketEvB !== null && qualityRevenueB ? marketEvB / qualityRevenueB : null,
      marketEvEbitda: marketEvB !== null && qualityEbitdaB ? marketEvB / qualityEbitdaB : null,
      flags: qualityFlags,
    },
    divergence: {
      gapPct: divergenceGapPct,
      threshold: divergenceThresholdPct,
      status: divergenceTriggered ? "MODEL_DIVERGENCE_REVIEW" : "within_bounds",
      explanation: [
        divergenceGapPct === null
          ? "No market price was available for the divergence comparison."
          : `Published fair value is ${divergenceGapPct.toFixed(1)}% away from the market price (review threshold ±${divergenceThresholdPct}%).`,
        `Revenue used: ${qualityRevenueB === null ? "—" : `${qualityRevenueB.toFixed(1)}B forward`}; EBITDA used: ${qualityEbitdaB === null ? "—" : `${qualityEbitdaB.toFixed(1)}B`}; net cash ${netCashUsedB === null ? "—" : `${netCashUsedB.toFixed(1)}B`}.`,
        `Market price implies EV/EBITDA ${marketEvB !== null && qualityEbitdaB ? `${(marketEvB / qualityEbitdaB).toFixed(1)}×` : "—"} versus ${evEbitdaPublished === null ? "—" : `${evEbitdaPublished.toFixed(1)}×`} on the published value.`,
        "The engine never moves the value toward the market price; it reports the difference and the assumptions that would have to change.",
      ],
    },
    whyDifferent: selectedProfile.spcx?.whyDifferent ?? [
      { metric: "Revenue", signalLedger: qualityRevenueB === null ? "—" : `${qualityRevenueB.toFixed(1)}B forward`, market: marketEvB !== null && qualityRevenueB && evRevenuePublished ? `${((marketEvB / qualityRevenueB) / Math.max(0.01, evRevenuePublished) * qualityRevenueB).toFixed(1)}B at the published multiple` : "—", publicResearch: "not captured yet" },
      { metric: "EBITDA", signalLedger: qualityEbitdaB === null ? "—" : `${qualityEbitdaB.toFixed(1)}B forward`, market: "—", publicResearch: "not captured yet" },
      { metric: "Implied EV/EBITDA", signalLedger: evEbitdaPublished === null ? "—" : `${evEbitdaPublished.toFixed(1)}×`, market: marketEvB !== null && qualityEbitdaB ? `${(marketEvB / qualityEbitdaB).toFixed(1)}×` : "—", publicResearch: "not captured yet" },
    ],
    externalResearch: selectedProfile.spcx?.externalResearch ?? [],
    preliminaryFairValue: publishable ? null : fairValue,
  };
  if (!publishable && divergenceTriggered) {
    qualityChecks.push({
      id: "model-divergence",
      label: "Model divergence review",
      status: "warning",
      detail: `MODEL_DIVERGENCE_REVIEW: the published value is ${divergenceGapPct?.toFixed(1)}% away from the market price. ${qualityFlags.join(" ")}`,
    });
  }

  const calculatedRating = runRatingEngine(currentPrice, fairValue, confidence, buyZone, strongBuyZone);
  // Directional labels require the stronger evidence bucket: a closed bridge,
  // corroboration from at least two contributing models, and confidence ≥ 0.60.
  // Below that the publication is a provisional screening reference.
  const directionalAllowed = releaseGate === "passed" && confidence >= 0.6 && includedModels.length >= 2;
  const rating = valuationRelease === "withheld" || !directionalAllowed
    ? {
      value: "WATCH" as Rating,
      riskAdjustedUpside: calculatedRating.riskAdjustedUpside,
      rationale: releaseGate === "model_check_required"
        ? "MODEL CHECK REQUIRED: the equity bridge does not reconcile, so no directional rating is published."
        : valuationRelease === "withheld"
          ? "Valuation is withheld because a required unit or data-integrity check failed."
          : "Confidence and multi-model agreement are too low for a directional rating; the valuation remains a screening reference.",
    }
    : calculatedRating;
  const reverse = models.find((output) => output.model === "reverse_dcf");
  const valuationScenarios = valuationRelease === "withheld"
    ? {
      method: "distribution" as const,
      bear: { value: null, assumptions: "Bear case withheld because a required release check failed." },
      base: { value: null, assumptions: "Base case withheld because a required release check failed." },
      bull: { value: null, assumptions: "Bull case withheld because a required release check failed." },
      weights: { bear: 0.25, base: 0.5, bull: 0.25 },
      weighted: null,
    }
    // The Base case must always equal the published fair value. Only a
    // segment-governed publication uses the re-priced segment cases; a blended
    // publication uses its own distribution so the two cannot disagree.
    : buildValuationScenarios(classification.modelFamily, adjustedAssumptions, probabilityDistribution, segmentDominant);
  // A confident single number is only honest when the evidence supports it.
  const confidenceLabel: UniversalValuationOutput["confidenceLabel"] = confidence >= 0.4
    ? status === "decision-grade" ? "Decision grade" : "Standard"
    : "Low confidence";
  const ensembleScenarios = valuationScenarios.method === "segment_sotp"
    ? { bear: valuationScenarios.bear.value, base: valuationScenarios.base.value, bull: valuationScenarios.bull.value }
    : { bear: probabilityDistribution.p10, base: fairValue, bull: probabilityDistribution.p90 };
  // Reverse valuation: state the economics the current price requires instead of
  // only saying that the market is pricing optionality.
  const impliedEquityB = positive(currentPrice) && sharesB ? currentPrice! * sharesB : null;
  const impliedEnterpriseB = impliedEquityB !== null && netCashUsedB !== null ? impliedEquityB - netCashUsedB : null;
  const requiredRevenueB = impliedEnterpriseB !== null && positive(adjustedAssumptions.evSalesMultiple)
    ? impliedEnterpriseB / adjustedAssumptions.evSalesMultiple!
    : null;
  const requiredGrowthPct = reverse?.diagnostics?.impliedFcfCagr ?? null;
  const requiredMarginPct = (() => {
    if (impliedEnterpriseB === null || !positive(currentPrice) || !adjustedAssumptions.cashFlows && !adjustedAssumptions.normalizedCashFlows) return null;
    const path = adjustedAssumptions.normalizedCashFlows ?? adjustedAssumptions.cashFlows;
    if (!path || !positive(adjustedAssumptions.wacc) || !finite(adjustedAssumptions.terminalGrowth) || !finite(adjustedAssumptions.netCashB) || !positive(adjustedAssumptions.dilutedSharesB)) return null;
    const baseMargin = positive(adjustedAssumptions.fcfMargin) ? adjustedAssumptions.fcfMargin! : 0.15;
    const baseRevenue = path[path.length - 1] / baseMargin;
    if (!positive(baseRevenue)) return null;
    const valueAt = (margin: number) => discountedValue(path.map((_, index) => baseRevenue * (1 + (adjustedAssumptions.terminalGrowth ?? 0.025)) ** (index + 1) * margin), adjustedAssumptions.wacc!, adjustedAssumptions.terminalGrowth!, adjustedAssumptions.netCashB!, adjustedAssumptions.dilutedSharesB!);
    let low = 0;
    let high = 0.9;
    if ((valueAt(low) ?? Infinity) > currentPrice! || (valueAt(high) ?? -Infinity) < currentPrice!) return null;
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const midpoint = (low + high) / 2;
      if ((valueAt(midpoint) ?? -Infinity) < currentPrice!) low = midpoint;
      else high = midpoint;
    }
    return (low + high) / 2;
  })();
  const segmentContracts = (adjustedAssumptions.sotpSegments ?? []).map((segment) => ({
    value: segment.metricValueB * segment.multiple * clamp(segment.probability ?? 1, 0, 1),
    unweighted: segment.metricValueB * segment.multiple,
    optionality: (segment.probability ?? 1) < 1,
  }));
  const normalizedSegmentValueB = segmentContracts.filter((segment) => !segment.optionality).reduce((sum, segment) => sum + segment.value, 0);
  const optionalityUnweightedB = segmentContracts.filter((segment) => segment.optionality).reduce((sum, segment) => sum + segment.unweighted, 0);
  const requiredSegmentValueB = impliedEnterpriseB !== null && segmentContracts.length ? impliedEnterpriseB - normalizedSegmentValueB : null;
  const requiredSuccessProbability = requiredSegmentValueB !== null && optionalityUnweightedB > 0
    ? clamp(requiredSegmentValueB / optionalityUnweightedB, 0, 1)
    : null;
  const expectedReturn = positive(currentPrice) && positive(fairValue) ? fairValue / currentPrice - 1 : null;
  const source = positive(options.currentPrice) ? options.priceSource ?? "Selected market-price input" : selectedProfile.referencePrice?.source ?? "No market price supplied";
  const releasedModels = valuationRelease === "withheld"
    ? models.map((output) => output.role === "valuation" && output.value !== null ? { ...output, status: "input_required" as const, value: null, effectiveWeight: 0, explanation: "Output withheld because the model package failed a required release check.", missingInputs: ["release checks"] } : output)
    : models;
  const candidate: UniversalValuationOutput = {
    ticker: symbol,
    status,
    classification,
    currentPrice: { value: currentPrice, asOf: positive(options.currentPrice) ? options.priceAsOf ?? null : selectedProfile.referencePrice?.asOf ?? null, source },
    aiBaseline: { assumptions: selectedProfile.baseline, sourcePosture: selectedProfile.sourcePosture, inputSources: selectedProfile.inputSources ?? {} },
    signalLedgerThesis: { adjustments: thesis, adjustedAssumptions },
    models: releasedModels,
    ensemble: { fairValue, expectedReturn, confidence: valuationRelease === "withheld" ? 0 : confidence, probabilityDistribution, scenarios: ensembleScenarios },
    ...(scenarioWeightedResult ? { researchScenarios: scenarioWeightedResult } : {}),
    marketImpliedExpectations: { headline: family.primaryQuestion, impliedFcfCagr: valuationRelease === "withheld" ? null : reverse?.diagnostics?.impliedFcfCagr ?? null, terminalFcfB: valuationRelease === "withheld" ? null : reverse?.diagnostics?.terminalFcfB ?? null, impliedRevenueB: valuationRelease === "withheld" ? null : reverse?.diagnostics?.impliedRevenueB ?? null, impliedForwardPe, requiredGrowthPct, requiredMarginPct, requiredRevenueB, requiredSegmentValueB, requiredSuccessProbability },
    rating: {
      ...(qualityReview.publishable
        ? rating
        : {
          value: "WATCH" as Rating,
          riskAdjustedUpside: rating.riskAdjustedUpside,
          rationale: qualityReview.status === "MODEL_DIVERGENCE_REVIEW"
            ? "MODEL REVIEW REQUIRED: the internal value diverges materially from the market price and the difference is not yet explained. Preliminary result is shown in the Model Audit only."
            : "MODEL REVIEW REQUIRED: a data, model or sanity gate has not passed, so no fair value or directional rating is published.",
        }),
      buyZone: qualityReview.publishable ? buyZone : null,
      strongBuyZone: qualityReview.publishable ? strongBuyZone : null,
    },
    investorRead: { variantPath: selectedProfile.sourcePosture === "reported_internal_forecast"
      ? `Operating baseline: ${describeForecast(selectedProfile.baseline)}${thesis.growthDelta || thesis.marginDelta || thesis.multipleDelta ? ` Signal Ledger adjusted inputs used for valuation: ${describeForecast(adjustedAssumptions)}` : ""}`
      : selectedProfile.variantPath, downsideMechanism: selectedProfile.downsideMechanism, evidenceGate: selectedProfile.evidenceGate, evidenceMissing: selectedProfile.evidenceMissing },
    dataQuality,
    valuationScenarios,
    confidenceLabel,
    confidenceBreakdown: { ...confidenceComponents, total: confidence },
    aiExposure: selectedProfile.aiExposure ?? null,
    spcx: selectedProfile.spcx ?? null,
    mu: selectedProfile.mu ?? null,
    qualityReview,
    valuationFamilyAlias: classification.modelFamily.replace(/_sotp$/, ""),
    releaseGate,
    releaseGateDetail,
    capitalBridge,
    reconciliation,
    engine: {
      family,
      capitalCost: selectedProfile.capitalCost ?? null,
      simulationCount,
      simulation: simulation.audit,
      formula: "company anchor → comparable-model filter → normalized weight = base weight × applicability × confidence × prior reliability weight",
      modelsCalculated: valuationModels.length,
      modelsIncluded: valuationRelease === "withheld" ? 0 : includedModels.length,
      valuationModelsRouted: routedCount,
      publishedBasis,
      publishedModel: publishedBasis === "reconciled_segment_sotp" ? "sotp" : null,
    },
  };
  return finalizeValuationPublication(candidate);
}

export function runUniversalValuation(ticker: string, options: UniversalValuationOptions = {}): UniversalValuationOutput | null {
  const symbol = ticker.trim().toUpperCase();
  const classification = classifyCompany(symbol);
  if (!classification) return null;
  return runValuationProfile(profile(symbol), options);
}
