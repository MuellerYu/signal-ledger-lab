// ResearchPlan: the authoritative, machine-readable research artifact.
//
// The ResearchPlan is the ONLY thing the planner may produce. It carries operating
// and research evidence — business segmentation, forecast drivers, capital,
// financing, dilution, scenarios, model selection — and is deliberately *incapable*
// of carrying a price. There is no `fairValue`, `targetPrice` or `referencePrice`
// field here or in any schema derived from it. Prices are computed downstream by
// deterministic code and never feed back into the plan.
import { DRIVER_PARAMETER_KEYS, driverParamsSchema, toolRequestSchema, type DriverParameter, type ResearchSchema } from "./research-schema";
import type { ValuationModelId } from "./universal-valuation";

// ---------------------------------------------------------------------------
// Driver formula whitelist. No executable JS, no arbitrary expressions.
// ---------------------------------------------------------------------------
export const DRIVER_FORMULAS = [
  "reported_segment",
  "volume_x_price",
  "users_x_arpu",
  "capacity_x_utilization_x_price",
  "revenue_x_margin",
  "asset_yield_minus_share_plus_fees",
  "growth",
  "constant",
  "sum_of_children",
  "scenario_weighted",
] as const;

export type DriverFormula = (typeof DRIVER_FORMULAS)[number];

export const VALUATION_MODEL_IDS: ValuationModelId[] = [
  "dcf", "normalized_dcf", "forward_pe", "ev_ebitda", "ev_fcf", "ev_sales", "sotp",
  "residual_income", "p_tbv", "nav", "affo", "rnpv", "project_npv", "bitcoin_nav",
  "commodity_scenario", "reverse_dcf",
];

export type BusinessStage = "emerging" | "commercializing" | "scaling" | "mature" | "declining" | "optionality";

export type DriverParams = Partial<Record<DriverParameter, number | string>>;

export type RevenueDriver = {
  formula: DriverFormula;
  params: DriverParams;
  evidenceId: string | null;
  note?: string;
};

export type ForecastAssumption = {
  id: string;
  field: string;
  value: number;
  unit: string;
  evidenceId: string | null;
  rationale: string;
};

export type ForecastYear = {
  year: number;
  growth?: number;
  margin?: number;
  revenueB?: number;
  capexB?: number;
  fcfB?: number;
};

export type GrowthConstraint = {
  id: string;
  field: string;
  min?: number;
  max?: number;
  rationale: string;
  evidenceId?: string | null;
};

export type DisclosedData = {
  label: string;
  value: number | null;
  unit: string;
  evidenceId: string | null;
};

export type BusinessNode = {
  id: string;
  name: string;
  stage: BusinessStage;
  economicMeaning: string;
  /** Must equal `"reported_segment"` when the split is disclosed; anything else is an analytical split. */
  segmentationBasis: "reported_segment" | string;
  revenueDriver: RevenueDriver;
  costDrivers: RevenueDriver[];
  disclosedData: DisclosedData[];
  forecastAssumptions: ForecastAssumption[];
  growthConstraints: GrowthConstraint[];
  forecastYears: ForecastYear[];
  valuationMethod: ValuationModelId;
  /** Revenue/operating multiple applied when the business is valued on a driver multiple. */
  multiple: number | null;
  rationale: string;
  applicabilityConditions: string[];
  overlaps: string[];
};

export type CapitalRequirement = {
  /** Must be true: this cash outflow is NOT already included in forecast FCF. */
  incremental?: boolean;
  id: string;
  businessId: string | null;
  kind: "capex" | "working_capital" | "acquisition" | "other";
  amountB: number;
  timingYear: number;
  evidenceId: string | null;
  rationale: string;
};

export type Financing = {
  id: string;
  kind: "debt" | "equity" | "hybrid";
  amountB: number;
  timingYear: number;
  costPct?: number;
  evidenceId: string | null;
  rationale: string;
};

export type Dilution = {
  id: string;
  kind: "stock_comp" | "new_shares" | "warrants" | "convertible";
  sharesB: number;
  evidenceId: string | null;
  rationale: string;
};

export type ValuationMethodSpec = {
  appliesToBusinessIds: string[];
  purpose: "valuation" | "cross_check";
  rationale: string;
  evidenceId?: string | null;
} & (
  | { model: "dcf" | "normalized_dcf"; multiple?: number | null }
  | { model: Exclude<ValuationModelId, "dcf" | "normalized_dcf">; multiple?: number }
);

/** The executable subset of a ResearchPlan. Drafts may investigate a wider set
 * of economics, but only this contract can reach the P0 compiler. */
export const FINAL_RESEARCH_EXECUTION_CONTRACT = {
  businessMethods: ["dcf", "normalized_dcf", "ev_sales", "ev_ebitda", "ev_fcf"],
  dcfMethods: ["dcf", "normalized_dcf"],
  multipleBusinessMethods: ["ev_sales", "ev_ebitda", "ev_fcf"],
  growthConstraintFields: ["growth", "margin", "revenueB", "fcfB"],
  disclosedUnit: "USD billions",
  capitalKinds: ["capex", "working_capital"],
  financingKind: "equity",
  financingTimingYear: 0,
  dilutionKind: "new_shares",
  scenarioEconomicsFields: ["fcfMultiplier"],
  aggregationRules: ["sotp", "single_model", "scenario_weighted"],
} as const;

/** Generated from the same limits used by schema, validator and compiler. */
export function finalResearchExecutionInstructions(): string {
  const c = FINAL_RESEARCH_EXECUTION_CONTRACT;
  return [
    "Final ResearchPlan is executable, not an exploratory notebook. Unsupported economics must be omitted rather than silently discarded.",
    `Business valuationMethod may only be ${c.businessMethods.join("|")}; method-level multiples can value only ${c.multipleBusinessMethods.join("|")}.`,
    "Set costDrivers and forecastAssumptions to []; they are not executed. Unknown economics belong in missingEvidence or audit text, never in a zero-valued placeholder object.",
    "For each DCF business, provide a complete explicit annual forecastYears.fcfB path. Unknown FCF is not 0; a genuine economic 0 may remain 0 but must pass the DCF terminal-value gate. Omit forecastYears.capexB; only separately evidenced incremental capital is supported.",
    `Valued disclosedData must use ${c.disclosedUnit}; keep percent, shares and other audit facts out of executable disclosedData. growthConstraints.field may only be ${c.growthConstraintFields.join("|")}.`,
    `CapitalRequirements may only be ${c.capitalKinds.join("|")} with incremental=true, identified DCF business and explicit forecast timing. Unknown or non-incremental capital belongs in missingEvidence.`,
    `Financing may only be timingYear=${c.financingTimingYear} ${c.financingKind} with matching evidenced incremental ${c.dilutionKind}; debt/hybrid and stock_comp placeholders are unsupported.`,
    `Scenario economics may only contain ${c.scenarioEconomicsFields.join("|")}; unsupported growth/revenue/margin/multiple multipliers must not appear, even as identity values.`,
    `Aggregation may only be ${c.aggregationRules.join("|")} when its probability and primary-method contract is satisfied. cross_check methods are advisory and never affect FV.`,
  ].join("\n");
}

/** Normalize only missing encodings for fields that the formal schema already
 * permits to be absent. Keep the original AI evidence immutable. */
export function canonicalizeResearchPlan<T extends ResearchPlan>(plan: T): T {
  let changed = false;
  const valuationMethods = Array.isArray(plan.valuationMethods) ? plan.valuationMethods.map((method) => {
    if (method && (method.model === "dcf" || method.model === "normalized_dcf") && method.multiple === null) {
      const canonical = { ...method };
      delete canonical.multiple;
      changed = true;
      return canonical;
    }
    return method;
  }) : plan.valuationMethods;
  const canonicalizeDriver = (driver: RevenueDriver): RevenueDriver => {
    if (!driver || typeof driver !== "object" || Array.isArray(driver) ||
      !Object.hasOwn(DRIVER_PARAMETER_KEYS, driver.formula) ||
      !driver.params || typeof driver.params !== "object" || Array.isArray(driver.params)) return driver;
    const parameterContract = driverParamsSchema(driver.formula);
    const paramSchema = parameterContract.properties ?? {};
    let params: DriverParams | undefined;
    for (const [key, field] of Object.entries(paramSchema)) {
      if (parameterContract.required?.includes(key) ||
        !field.anyOf?.some((variant) => variant.type === "number")) continue;
      const value = driver.params[key as DriverParameter];
      if (typeof value === "string" && value.trim() === "not supplied") {
        params ??= { ...driver.params };
        delete params[key as DriverParameter];
      }
    }
    if (!params) return driver;
    changed = true;
    return { ...driver, params };
  };
  const businesses = Array.isArray(plan.businesses) ? plan.businesses.map((business) => {
    if (!business || typeof business !== "object" || Array.isArray(business)) return business;
    const revenueDriver = canonicalizeDriver(business.revenueDriver);
    const costDrivers = Array.isArray(business.costDrivers)
      ? business.costDrivers.map(canonicalizeDriver) : business.costDrivers;
    const forecastYears = Array.isArray(business.forecastYears) ? business.forecastYears.map((forecast) => {
      if (!forecast || typeof forecast !== "object" || Array.isArray(forecast)) return forecast;
      let canonical: ForecastYear | undefined;
      for (const [key, field] of Object.entries(forecastYearSchema.properties)) {
        if (field.type !== "number" || forecastYearSchema.required.includes(key)) continue;
        if (Object.hasOwn(forecast, key) && forecast[key as keyof ForecastYear] === null) {
          canonical ??= { ...forecast };
          delete canonical[key as keyof ForecastYear];
        }
      }
      if (canonical) changed = true;
      return canonical ?? forecast;
    }) : business.forecastYears;
    if (revenueDriver === business.revenueDriver &&
      (!Array.isArray(costDrivers) || costDrivers.every((driver, index) => driver === business.costDrivers[index])) &&
      (!Array.isArray(forecastYears) || forecastYears.every((year, index) => year === business.forecastYears[index]))) return business;
    return { ...business, revenueDriver, costDrivers, forecastYears };
  }) : plan.businesses;
  return changed ? { ...plan, valuationMethods, businesses } : plan;
}

/**
 * Economic content of a scenario. Each field is a bounded, auditable adjustment
 * to the compiled operating baseline; together they let a scenario produce its
 * own deterministic valuation instead of merely relabelling a Monte Carlo
 * percentile. Every field is optional and defaults to the identity adjustment.
 */
export type ScenarioEconomics = {
  /** Scales forecast growth through the cash-flow path (1 = unchanged). */
  growthMultiplier?: number;
  /** Scales forward revenue (1 = unchanged). */
  revenueMultiplier?: number;
  /** Adds to the FCF/operating margin (0 = unchanged). */
  marginDelta?: number;
  /** Scales the FCF path (1 = unchanged). */
  fcfMultiplier?: number;
  /** Scales the valuation multiples (1 = unchanged). */
  multipleMultiplier?: number;
};

export type Scenario = {
  id: string;
  name: string;
  description: string;
  probability: number;
  /** H: each uncertainty's probability lives in a segment OR a scenario, never both. */
  appliesTo: "segment" | "company";
  businessIds: string[];
  /** Economic content that makes a company-level scenario produce its own value. */
  economics?: ScenarioEconomics;
};

export type Source = {
  id: string;
  kind: "filing" | "tool_result" | "guidance" | "peer" | "prior";
  label: string;
  asOf?: string;
  url?: string;
};

// ---------------------------------------------------------------------------
// Reviewer patch. The reviewer may ONLY return patches, never a whole plan.
// ---------------------------------------------------------------------------
export const REVISION_REASONS = [
  "evidence_contradiction",
  "unit_error",
  "basis_mismatch",
  "duplication",
  "omitted_financing",
  "omitted_dilution",
  "probability_invalid",
  "applicability_unsupported",
  "guidance_contradiction",
  "historical_contradiction",
] as const;

export type RevisionReason = (typeof REVISION_REASONS)[number];

export type ResearchRevision = {
  revisionReason: RevisionReason;
  /** JSON-pointer-like path to a mutable field, e.g. `businesses[0].forecastYears[1].growth`. */
  path: string;
  oldValue: number | string | null;
  proposedValue: number | string | null;
  evidenceRefs: string[];
  explanation: string;
};

export type ProbabilityOwner = { uncertaintyId: string; owner: "segment" | "scenario" };

export type ResearchPlan = {
  policyVersion: string;
  businesses: BusinessNode[];
  capitalRequirements: CapitalRequirement[];
  financing: Financing[];
  dilution: Dilution[];
  valuationMethods: ValuationMethodSpec[];
  scenarios: Scenario[];
  probabilitiesCheck: { owners: ProbabilityOwner[]; note: string };
  sources: Source[];
  missingEvidence: string[];
  primaryMethod: ValuationModelId;
  aggregationRule: "sotp" | "ensemble" | "single_model" | "scenario_weighted";
  crossChecks: string[];
  thesisChanges: string[];
  revisionRecords: ResearchRevision[];
};

export type ResearchDraftBusiness = Omit<BusinessNode, "forecastYears" | "multiple" | "disclosedData" | "forecastAssumptions"> & {
  forecastYears?: ForecastYear[];
  multiple?: number | null;
  disclosedData?: DisclosedData[];
  forecastAssumptions?: ForecastAssumption[];
};

export type ResearchDraft = Omit<ResearchPlan, "businesses"> & {
  businesses: ResearchDraftBusiness[];
  toolRequests: ToolRequest[];
};

export type ToolRequest = {
  tool: "list_filing_documents" | "get_reported_segments" | "get_peer_financials";
  args: { limit?: number; peers?: string[]; peerTickers?: string[]; tickers?: string[] };
};

// ---------------------------------------------------------------------------
// Reviewer mutable-path whitelist. Only these paths may be patched; everything
// else is rejected so the reviewer cannot replace the plan wholesale.
// ---------------------------------------------------------------------------
const MUTABLE_PATH_PATTERNS: RegExp[] = [
  /^businesses\[\d+\]\.forecastYears\[\d+\]\.(growth|margin|revenueB|capexB|fcfB)$/,
  /^businesses\[\d+\]\.revenueDriver\.params\.[A-Za-z_][A-Za-z0-9_]*$/,
  /^businesses\[\d+\]\.costDrivers\[\d+\]\.params\.[A-Za-z_][A-Za-z0-9_]*$/,
  /^businesses\[\d+\]\.forecastAssumptions\[\d+\]\.value$/,
  /^businesses\[\d+\]\.multiple$/,
  /^scenarios\[\d+\]\.probability$/,
  /^dilution\[\d+\]\.sharesB$/,
  /^financing\[\d+\]\.amountB$/,
  /^financing\[\d+\]\.costPct$/,
  /^capitalRequirements\[\d+\]\.amountB$/,
  /^capitalRequirements\[\d+\]\.timingYear$/,
  /^valuationMethods\[\d+\]\.multiple$/,
];

export function isMutablePath(path: string): boolean {
  return MUTABLE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** Returns the value at a mutable path, or `undefined` when the path is absent. */
export function getValueAtPath(target: unknown, path: string): number | string | null | undefined {
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let current = target as Record<string, unknown> | null | undefined;
  for (const segment of segments) {
    if (current == null) return undefined;
    current = current[segment] as Record<string, unknown> | null | undefined;
  }
  return current as number | string | null | undefined;
}

/** Sets a value at a mutable path. Throws when the path is not present. */
export function setValueAtPath(target: unknown, path: string, value: number | string | null): void {
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let current = target as Record<string, unknown> | null | undefined;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (current == null) throw new Error(`Path ${path} does not exist.`);
    current = current[segment] as Record<string, unknown> | null | undefined;
  }
  if (current == null) throw new Error(`Path ${path} does not exist.`);
  current[segments.at(-1)!] = value;
}

// ---------------------------------------------------------------------------
// JSON Schemas for strict AI output. `additionalProperties: false` everywhere so
// a price field is structurally impossible in a planner/reviewer payload.
// ---------------------------------------------------------------------------
export const driverSchema = { anyOf: DRIVER_FORMULAS.map((formula) => ({
  type: "object", additionalProperties: false, required: ["formula", "params", "evidenceId"],
  properties: {
    formula: { type: "string", const: formula }, params: driverParamsSchema(formula),
    evidenceId: { type: ["string", "null"] }, note: { type: "string" },
  },
})) };

const forecastYearSchema = {
  type: "object",
  additionalProperties: false,
  required: ["year"],
  properties: {
    year: { type: "number", minimum: 1 },
    growth: { type: "number" },
    margin: { type: "number" },
    revenueB: { type: "number" },
    capexB: { type: "number" },
    fcfB: { type: "number" },
  },
};

const businessSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "stage", "economicMeaning", "segmentationBasis", "revenueDriver", "costDrivers", "disclosedData", "forecastAssumptions", "growthConstraints", "forecastYears", "valuationMethod", "multiple", "rationale", "applicabilityConditions", "overlaps"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    stage: { type: "string", enum: ["emerging", "commercializing", "scaling", "mature", "declining", "optionality"] },
    economicMeaning: { type: "string" },
    segmentationBasis: { type: "string" },
    revenueDriver: driverSchema,
    costDrivers: { type: "array", items: driverSchema },
    disclosedData: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "value", "unit", "evidenceId"], properties: { label: { type: "string" }, value: { type: ["number", "null"] }, unit: { type: "string" }, evidenceId: { type: ["string", "null"] } } } },
    forecastAssumptions: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "field", "value", "unit", "evidenceId", "rationale"], properties: { id: { type: "string" }, field: { type: "string" }, value: { type: "number" }, unit: { type: "string" }, evidenceId: { type: ["string", "null"] }, rationale: { type: "string" } } } },
    growthConstraints: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "field", "rationale"], properties: { id: { type: "string" }, field: { type: "string" }, min: { type: "number" }, max: { type: "number" }, rationale: { type: "string" }, evidenceId: { type: ["string", "null"] } } } },
    forecastYears: { type: "array", items: forecastYearSchema },
    valuationMethod: { type: "string", enum: VALUATION_MODEL_IDS },
    multiple: { type: ["number", "null"] },
    rationale: { type: "string" },
    applicabilityConditions: { type: "array", items: { type: "string" } },
    overlaps: { type: "array", items: { type: "string" } },
  },
};

const draftBusinessSchema = {
  ...businessSchema,
  required: businessSchema.required.filter((field) =>
    !["forecastYears", "multiple", "disclosedData", "forecastAssumptions"].includes(field)),
};

const sourceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "label"],
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["filing", "tool_result", "guidance", "peer", "prior"] },
    label: { type: "string" },
    asOf: { type: "string" },
    url: { type: "string" },
  },
};

const revisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["revisionReason", "path", "oldValue", "proposedValue", "evidenceRefs", "explanation"],
  properties: {
    revisionReason: { type: "string", enum: [...REVISION_REASONS] },
    path: { type: "string" },
    oldValue: { type: ["number", "string", "null"] },
    proposedValue: { type: ["number", "string", "null"] },
    evidenceRefs: { type: "array", items: { type: "string" } },
    explanation: { type: "string" },
  },
};

const planProperties = {
  policyVersion: { type: "string" },
  businesses: { type: "array", items: businessSchema },
  capitalRequirements: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "businessId", "kind", "amountB", "timingYear", "evidenceId", "rationale"], properties: { id: { type: "string" }, businessId: { type: ["string", "null"] }, incremental: { type: "boolean" }, kind: { type: "string", enum: ["capex", "working_capital", "acquisition", "other"] }, amountB: { type: "number" }, timingYear: { type: "number" }, evidenceId: { type: ["string", "null"] }, rationale: { type: "string" } } } },
  financing: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "kind", "amountB", "timingYear", "evidenceId", "rationale"], properties: { id: { type: "string" }, kind: { type: "string", enum: ["debt", "equity", "hybrid"] }, amountB: { type: "number" }, timingYear: { type: "number" }, costPct: { type: "number" }, evidenceId: { type: ["string", "null"] }, rationale: { type: "string" } } } },
  dilution: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "kind", "sharesB", "evidenceId", "rationale"], properties: { id: { type: "string" }, kind: { type: "string", enum: ["stock_comp", "new_shares", "warrants", "convertible"] }, sharesB: { type: "number" }, evidenceId: { type: ["string", "null"] }, rationale: { type: "string" } } } },
  valuationMethods: { type: "array", items: {
    anyOf: VALUATION_MODEL_IDS.map((model): ResearchSchema => ({
      type: "object", additionalProperties: false, required: ["model", "appliesToBusinessIds", "purpose", "rationale"],
      properties: {
        model: { type: "string", const: model },
        appliesToBusinessIds: { type: "array", items: { type: "string" } },
        purpose: { type: "string", enum: ["valuation", "cross_check"] },
        multiple: { type: model === "dcf" || model === "normalized_dcf" ? ["number", "null"] : "number", minimum: 0 },
        rationale: { type: "string" }, evidenceId: { type: ["string", "null"] },
      },
    })),
  } },
  scenarios: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name", "description", "probability", "appliesTo", "businessIds"], properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, probability: { type: "number", minimum: 0, maximum: 1 }, appliesTo: { type: "string", enum: ["segment", "company"] }, businessIds: { type: "array", items: { type: "string" } }, economics: { type: "object", additionalProperties: false, properties: { growthMultiplier: { type: "number", minimum: 0 }, revenueMultiplier: { type: "number", minimum: 0 }, marginDelta: { type: "number" }, fcfMultiplier: { type: "number", minimum: 0 }, multipleMultiplier: { type: "number", minimum: 0 } } } } } },
  probabilitiesCheck: { type: "object", additionalProperties: false, required: ["owners", "note"], properties: { owners: { type: "array", items: { type: "object", additionalProperties: false, required: ["uncertaintyId", "owner"], properties: { uncertaintyId: { type: "string" }, owner: { type: "string", enum: ["segment", "scenario"] } } } }, note: { type: "string" } } },
  sources: { type: "array", items: sourceSchema },
  missingEvidence: { type: "array", items: { type: "string" } },
  primaryMethod: { type: "string", enum: VALUATION_MODEL_IDS },
  aggregationRule: { type: "string", enum: ["sotp", "ensemble", "single_model", "scenario_weighted"] },
  crossChecks: { type: "array", items: { type: "string" } },
  thesisChanges: { type: "array", items: { type: "string" } },
  revisionRecords: { type: "array", items: revisionSchema },
};

const draftPlanProperties = {
  ...planProperties,
  businesses: { ...planProperties.businesses, items: draftBusinessSchema },
};

const finalForecastYearProperties = Object.fromEntries(
  Object.entries(forecastYearSchema.properties).filter(([key]) => key !== "capexB"),
);
const finalBusinessSchema: ResearchSchema = { anyOf: FINAL_RESEARCH_EXECUTION_CONTRACT.businessMethods.map((model) => ({
  ...businessSchema,
  properties: {
    ...businessSchema.properties,
    valuationMethod: { type: "string", const: model },
    costDrivers: { type: "array", maxItems: 0, items: driverSchema },
    forecastAssumptions: { type: "array", maxItems: 0, items: businessSchema.properties.forecastAssumptions.items },
    disclosedData: { type: "array", items: {
      ...businessSchema.properties.disclosedData.items,
      properties: {
        ...businessSchema.properties.disclosedData.items.properties,
        unit: { type: "string", const: FINAL_RESEARCH_EXECUTION_CONTRACT.disclosedUnit },
      },
    } },
    growthConstraints: { type: "array", items: {
      ...businessSchema.properties.growthConstraints.items,
      properties: {
        ...businessSchema.properties.growthConstraints.items.properties,
        field: { type: "string", enum: FINAL_RESEARCH_EXECUTION_CONTRACT.growthConstraintFields },
      },
    } },
    forecastYears: { type: "array", minItems: FINAL_RESEARCH_EXECUTION_CONTRACT.dcfMethods.includes(model as "dcf" | "normalized_dcf") ? 1 : undefined,
      items: { ...forecastYearSchema, required: FINAL_RESEARCH_EXECUTION_CONTRACT.dcfMethods.includes(model as "dcf" | "normalized_dcf")
        ? ["year", "fcfB"] : ["year"], properties: finalForecastYearProperties } },
  },
})) };

const finalPlanProperties: Record<string, ResearchSchema> = {
  ...planProperties,
  businesses: { type: "array", items: finalBusinessSchema },
  capitalRequirements: { type: "array", items: {
    ...planProperties.capitalRequirements.items,
    required: [...planProperties.capitalRequirements.items.required, "incremental"],
    properties: {
      ...planProperties.capitalRequirements.items.properties,
      businessId: { type: "string" },
      incremental: { type: "boolean", const: true },
      kind: { type: "string", enum: FINAL_RESEARCH_EXECUTION_CONTRACT.capitalKinds },
      timingYear: { type: "integer", minimum: 1 },
      amountB: { type: "number", minimum: 0 },
    },
  } },
  financing: { type: "array", maxItems: 1, items: {
    ...planProperties.financing.items,
    properties: {
      ...planProperties.financing.items.properties,
      kind: { type: "string", const: FINAL_RESEARCH_EXECUTION_CONTRACT.financingKind },
      timingYear: { type: "integer", const: FINAL_RESEARCH_EXECUTION_CONTRACT.financingTimingYear },
      costPct: { type: "number", const: 0 },
      evidenceId: { type: "string", minLength: 1 },
      amountB: { type: "number", minimum: 0 },
    },
  } },
  dilution: { type: "array", items: {
    ...planProperties.dilution.items,
    properties: {
      ...planProperties.dilution.items.properties,
      kind: { type: "string", const: FINAL_RESEARCH_EXECUTION_CONTRACT.dilutionKind },
      sharesB: { type: "number", minimum: 0 },
    },
  } },
  scenarios: { type: "array", items: {
    ...planProperties.scenarios.items,
    properties: {
      ...planProperties.scenarios.items.properties,
      economics: { type: "object", additionalProperties: false,
        properties: { fcfMultiplier: { type: "number", minimum: 0 } } },
    },
  } },
  aggregationRule: { type: "string", enum: FINAL_RESEARCH_EXECUTION_CONTRACT.aggregationRules },
};

export const researchPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: Object.keys(finalPlanProperties),
  properties: finalPlanProperties,
};

export const researchDraftSchema = {
  type: "object",
  additionalProperties: false,
  required: [...Object.keys(draftPlanProperties), "toolRequests"],
  properties: {
    ...draftPlanProperties,
    toolRequests: { type: "array", items: toolRequestSchema },
  },
};

export const researchRevisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["revisions"],
  properties: { revisions: { type: "array", items: revisionSchema } },
};

export function isDriverFormula(value: unknown): value is DriverFormula {
  return typeof value === "string" && (DRIVER_FORMULAS as readonly string[]).includes(value);
}

export function isRevisionReason(value: unknown): value is RevisionReason {
  return typeof value === "string" && (REVISION_REASONS as readonly string[]).includes(value);
}
