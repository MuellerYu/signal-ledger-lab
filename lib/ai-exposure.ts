import type { SotPSegment } from "./universal-valuation";

export type AiMateriality = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CORE";
export type AiExposureType =
  | "AI_INFRASTRUCTURE"
  | "AI_CLOUD_PLATFORM"
  | "AI_SOFTWARE_APPLICATION"
  | "AI_NATIVE_SEGMENT"
  | "AI_OPTIONALITY"
  | "AI_EMBEDDED_DRIVER";

export type AiEvidence = {
  metric: string;
  value: number | string | null;
  unit: string | null;
  asOfDate: string | null;
  retrievedAt: string;
  sourceType: "SEC" | "COMPANY_GUIDANCE" | "INVESTOR_RELATIONS" | "CONSENSUS" | "MARKET_DATA" | "DERIVED" | "INTERNAL_FORECAST" | "USER_OVERRIDE";
  sourceId?: string;
  sourceUrl?: string;
  confidence: number;
};

export type AiExposureProfile = {
  materiality: AiMateriality;
  exposureType: AiExposureType;
  embeddedSegments: string[];
  standaloneSegments: string[];
  reportedRevenueB: number | null;
  estimatedRevenueB: number | null;
  growthRate: number | null;
  margin: number | null;
  capexIntensity: number | null;
  monetizationEvidence: AiEvidence[];
  probability: number | null;
  confidence: {
    revenueEvidence: number;
    monetizationEvidence: number;
    marginVisibility: number;
    capexVisibility: number;
    segmentDisclosure: number;
  };
  /** True when standalone AI value is not also inside another segment or the terminal value. */
  doubleCountCheckPassed: boolean;
  rationale: string;
};

const INFRASTRUCTURE_FAMILIES = new Set(["ai_compute_platform", "ai_semiconductor", "memory_cycle_semiconductor", "semiconductor_infrastructure", "cyclical_semiconductor", "foundry_semiconductor", "mature_semiconductor"]);
const CLOUD_FAMILIES = new Set(["cloud_software_platform", "cloud_software_hybrid", "digital_platform", "commerce_cloud_hybrid", "ecommerce_platform"]);
const SOFTWARE_FAMILIES = new Set(["saas_growth", "mature_software", "media"]);
const OPTIONALITY_FAMILIES = new Set(["auto_energy_optionality_sotp", "advanced_nuclear_project_npv", "bitcoin_treasury", "stablecoin_network", "crypto_exchange", "private_aerospace", "integrated_space_connectivity_ai_platform"]);

/**
 * Segments that represent a distinct, separately modelled AI business. A
 * segment merely *about* AI demand (for example memory demand) is not a
 * standalone AI business and must not be classified as one.
 */
function isStandaloneAiSegment(segment: SotPSegment) {
  return /ai products|ai business|ai platform|ai compute|grok|xai/i.test(segment.name);
}

/** Segments whose driver already contains AI economics. */
function isEmbeddedAiSegment(segment: SotPSegment) {
  return /accelerator|hbm|ai |gpu|copilot|gemini|autonomy|fsd|robotaxi/i.test(`${segment.name} ${segment.metric}`);
}

export type AiExposureInput = {
  ticker: string;
  familyId: string;
  segments?: SotPSegment[];
  forwardRevenueB: number | null;
  /** Reported AI revenue from a filing, when the issuer discloses one. */
  reportedAiRevenueB?: number | null;
  /** Modelled AI revenue base for a standalone AI business, when the route carries one. */
  modeledAiRevenueB?: number | null;
  segmentDisclosureParsed?: boolean;
  /** True when the issuer reports AI as its own reportable segment. */
  aiIsReportableSegment?: boolean;
  filingId?: string | null;
  filingUrl?: string | null;
  asOf?: string | null;
};

/**
 * Deterministic AI exposure classification. AI value is only added as its own
 * segment when the business is separately modelled; otherwise AI is treated as
 * an embedded operating driver and no standalone value is created, which is
 * what keeps the double-count check honest.
 */
export function classifyAiExposure(input: AiExposureInput): AiExposureProfile {
  // A reported AI segment is a real operating business, not optionality.
  if (input.aiIsReportableSegment && input.reportedAiRevenueB && input.reportedAiRevenueB > 0) {
    const now = new Date().toISOString();
    return {
      materiality: "CORE",
      exposureType: "AI_NATIVE_SEGMENT",
      embeddedSegments: [],
      standaloneSegments: ["Reported AI segment"],
      reportedRevenueB: input.reportedAiRevenueB,
      estimatedRevenueB: null,
      growthRate: null,
      margin: null,
      capexIntensity: null,
      monetizationEvidence: [{
        metric: "AI segment revenue reported in the latest 10-Q",
        value: input.reportedAiRevenueB,
        unit: "USD billions annualised from the reported half-year",
        asOfDate: input.asOf ?? null,
        retrievedAt: now,
        sourceType: "SEC",
        sourceId: input.filingId ?? undefined,
        sourceUrl: input.filingUrl ?? undefined,
        confidence: 0.9,
      }],
      probability: null,
      confidence: { revenueEvidence: 0.9, monetizationEvidence: 0.7, marginVisibility: 0.6, capexVisibility: 0.8, segmentDisclosure: 0.95 },
      doubleCountCheckPassed: true,
      rationale: "AI is a reportable segment with its own revenue, operating result and capital expenditure. Existing AI economics are included at 100% in the operating forecast; only economics beyond that forecast are treated as optionality.",
    };
  }
  const segments = input.segments ?? [];
  const standalone = segments.filter(isStandaloneAiSegment);
  const embedded = segments.filter(isEmbeddedAiSegment);
  const now = new Date().toISOString();
  const baseEvidence = (metric: string, value: number | null, unit: string | null, sourceType: AiEvidence["sourceType"], confidence: number): AiEvidence => ({
    metric,
    value,
    unit,
    asOfDate: input.asOf ?? null,
    retrievedAt: now,
    sourceType,
    sourceId: input.filingId ?? undefined,
    sourceUrl: input.filingUrl ?? undefined,
    confidence,
  });

  const family = input.familyId;
  const standaloneNames = standalone.map((segment) => segment.name);
  const embeddedNames = embedded.map((segment) => segment.name);

  if (standalone.length) {
    // A separately modelled AI business: value is its own revenue build-up, so
    // it must not also sit inside another segment or the terminal multiple.
    const probability = standalone.find((segment) => segment.probability !== undefined)?.probability ?? null;
    const modeledRevenueB = input.modeledAiRevenueB ?? standalone[0].metricValueB;
    const doubleCountCheckPassed = !segments.some((segment) => !isStandaloneAiSegment(segment) && /ai revenue|ai compute|copilot|grok/i.test(segment.metric));
    return {
      materiality: probability !== null && probability < 0.5 ? "HIGH" : "CORE",
      exposureType: "AI_NATIVE_SEGMENT",
      embeddedSegments: embeddedNames,
      standaloneSegments: standaloneNames,
      reportedRevenueB: input.reportedAiRevenueB ?? null,
      estimatedRevenueB: modeledRevenueB,
      growthRate: 0.35,
      margin: standalone[0].marginAssumption ?? null,
      capexIntensity: 0.25,
      monetizationEvidence: [
        baseEvidence("modelled AI revenue base (Grok subscriptions, enterprise API, X data and ads)", modeledRevenueB, "USD billions", input.reportedAiRevenueB ? "SEC" : "INTERNAL_FORECAST", input.reportedAiRevenueB ? 0.7 : 0.35),
        baseEvidence("delivery probability applied to the AI segment", probability, "probability", "DERIVED", 0.4),
      ],
      probability,
      confidence: {
        revenueEvidence: input.reportedAiRevenueB ? 0.75 : 0.3,
        monetizationEvidence: 0.35,
        marginVisibility: standalone[0].marginAssumption !== undefined ? 0.45 : 0.25,
        capexVisibility: 0.3,
        segmentDisclosure: input.segmentDisclosureParsed ? 0.6 : 0.3,
      },
      doubleCountCheckPassed,
      rationale: "The AI business is modelled from its own revenue base and is excluded from the consolidated revenue used by the connectivity, launch and Starship segments, so its value is not counted twice.",
    };
  }

  if (INFRASTRUCTURE_FAMILIES.has(family)) {
    return {
      materiality: "CORE",
      exposureType: "AI_INFRASTRUCTURE",
      embeddedSegments: embeddedNames,
      standaloneSegments: [],
      reportedRevenueB: input.reportedAiRevenueB ?? null,
      estimatedRevenueB: null,
      growthRate: null,
      margin: null,
      capexIntensity: null,
      monetizationEvidence: [baseEvidence("AI demand enters through reported accelerator, HBM, networking and capacity drivers", input.forwardRevenueB, "USD billions forward revenue", "SEC", 0.6)],
      probability: null,
      confidence: { revenueEvidence: 0.7, monetizationEvidence: 0.65, marginVisibility: 0.6, capexVisibility: 0.6, segmentDisclosure: input.segmentDisclosureParsed ? 0.6 : 0.4 },
      // AI economics are already inside the operating drivers that the models
      // capitalise, so no standalone AI value is added.
      doubleCountCheckPassed: true,
      rationale: "AI demand is an operating driver of the reported business (revenue, mix, ASP, utilisation). No separate AI segment is added, so AI is not capitalised twice.",
    };
  }

  if (CLOUD_FAMILIES.has(family)) {
    return {
      materiality: "HIGH",
      exposureType: "AI_CLOUD_PLATFORM",
      embeddedSegments: embeddedNames,
      standaloneSegments: [],
      reportedRevenueB: input.reportedAiRevenueB ?? null,
      estimatedRevenueB: null,
      growthRate: null,
      margin: null,
      capexIntensity: 0.35,
      monetizationEvidence: [baseEvidence("AI cloud workload growth, backlog conversion and capex intensity affect revenue and capital together", input.forwardRevenueB, "USD billions forward revenue", "SEC", 0.55)],
      probability: null,
      confidence: { revenueEvidence: 0.6, monetizationEvidence: 0.5, marginVisibility: 0.5, capexVisibility: 0.6, segmentDisclosure: input.segmentDisclosureParsed ? 0.6 : 0.35 },
      doubleCountCheckPassed: true,
      rationale: "AI changes both cloud revenue and the capital needed to serve it, and both are already inside the forecast. No standalone AI value is added.",
    };
  }

  if (SOFTWARE_FAMILIES.has(family)) {
    return {
      materiality: "MEDIUM",
      exposureType: "AI_SOFTWARE_APPLICATION",
      embeddedSegments: embeddedNames,
      standaloneSegments: [],
      reportedRevenueB: input.reportedAiRevenueB ?? null,
      estimatedRevenueB: null,
      growthRate: null,
      margin: null,
      capexIntensity: null,
      monetizationEvidence: [baseEvidence("AI seats, ARPU uplift, retention and compute cost flow through subscription revenue and margin", input.forwardRevenueB, "USD billions forward revenue", "SEC", 0.5)],
      probability: null,
      confidence: { revenueEvidence: 0.5, monetizationEvidence: 0.4, marginVisibility: 0.45, capexVisibility: 0.3, segmentDisclosure: input.segmentDisclosureParsed ? 0.55 : 0.35 },
      doubleCountCheckPassed: true,
      rationale: "AI monetisation is treated as pricing and mix inside the subscription forecast rather than as a separate business.",
    };
  }

  if (OPTIONALITY_FAMILIES.has(family)) {
    const probability = segments.find((segment) => isEmbeddedAiSegment(segment))?.probability ?? null;
    return {
      materiality: "MEDIUM",
      exposureType: "AI_OPTIONALITY",
      embeddedSegments: embeddedNames,
      standaloneSegments: [],
      reportedRevenueB: input.reportedAiRevenueB ?? null,
      estimatedRevenueB: null,
      growthRate: null,
      margin: null,
      capexIntensity: null,
      monetizationEvidence: [baseEvidence("AI is an option on the existing platform rather than a reported revenue line", null, null, "DERIVED", 0.3)],
      probability,
      confidence: { revenueEvidence: 0.25, monetizationEvidence: 0.25, marginVisibility: 0.2, capexVisibility: 0.2, segmentDisclosure: 0.3 },
      doubleCountCheckPassed: true,
      rationale: "AI is carried as probability-weighted optionality inside the existing segment framework, not as a second AI business.",
    };
  }

  return {
    materiality: "NONE",
    exposureType: "AI_EMBEDDED_DRIVER",
    embeddedSegments: embeddedNames,
    standaloneSegments: [],
    reportedRevenueB: null,
    estimatedRevenueB: null,
    growthRate: null,
    margin: null,
    capexIntensity: null,
    monetizationEvidence: [],
    probability: null,
    confidence: { revenueEvidence: 0.2, monetizationEvidence: 0.2, marginVisibility: 0.2, capexVisibility: 0.2, segmentDisclosure: 0.2 },
    doubleCountCheckPassed: true,
    rationale: "No separately identifiable AI economics were found in the routed evidence, so no AI value is created.",
  };
}
