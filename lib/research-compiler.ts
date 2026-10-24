// The research compiler: ResearchPlan → ValuationProfile.
//
// The compiler is the single authority that turns a machine-readable ResearchPlan
// into the deterministic valuation profile. It never writes a price, and it starts
// from the pack's raw `evidenceAssumptions` — never the legacy-mutated baseline —
// so a legacy delta can never be applied twice. Unknown models or driver formulas
// raise MODEL_CAPABILITY_GAP instead of silently falling back to a generic DCF.
import { MODEL_FAMILIES, VALUATION_MODELS } from "./universal-valuation";
import type {
  ModelFamilyId,
  ScenarioWeightedProfile,
  SotPSegment,
  ValuationAssumptions,
  ValuationModelId,
  ValuationProfile,
} from "./universal-valuation";
import { hashCanonical } from "./research-hash";
import { canonicalizeResearchPlan, FINAL_RESEARCH_EXECUTION_CONTRACT, isDriverFormula, VALUATION_MODEL_IDS } from "./research-plan";
import { validateFinalResearchExecution } from "./research-validate";
import type {
  BusinessNode,
  CapitalRequirement,
  Dilution,
  Financing,
  ProbabilityOwner,
  ResearchPlan,
  Scenario,
  ScenarioEconomics,
  ValuationMethodSpec,
} from "./research-plan";

export class ModelCapabilityGapError extends Error {
  constructor(message: string) {
    super(`MODEL_CAPABILITY_GAP: ${message}`);
    this.name = "ModelCapabilityGapError";
  }
}

export type CompiledResearchProfile = {
  profile: ValuationProfile;
  segments: SotPSegment[];
  primaryMethod: ValuationModelId;
  aggregationRule: "sotp" | "ensemble" | "single_model" | "scenario_weighted";
  appliedCapital: CapitalRequirement[];
  appliedFinancing: Financing[];
  appliedDilution: Dilution[];
  probabilityOwners: ProbabilityOwner[];
  /** Research-only methods are retained for review; valuation math never reads them. */
  advisoryMethods: ValuationMethodSpec[];
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function firstFinite(values: Array<unknown>): number | null {
  for (const value of values) if (finite(value)) return value;
  return null;
}
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

/**
 * Explicit, audited model-alias map. A plan's primary method may resolve to a
 * family-routable model ONLY when the two are economically equivalent — same
 * inputs, same valuation basis. The compiler writes the same cash-flow stream to
 * both `cashFlows` and `normalizedCashFlows`, so a plain `dcf` and a
 * `normalized_dcf` are interchangeable here. Every other mapping must be declared
 * explicitly; an undeclared mismatch is a hard MODEL_CAPABILITY_GAP, never a
 * silent substitution of an unrelated model.
 */
const MODEL_ALIASES: Partial<Record<ValuationModelId, ValuationModelId[]>> = {
  dcf: ["normalized_dcf"],
  normalized_dcf: ["dcf"],
};

function resolvePrimaryModel(
  familyModels: Array<{ model: ValuationModelId }>,
  primaryMethod: ValuationModelId,
): ValuationModelId | undefined {
  if (familyModels.some((entry) => entry.model === primaryMethod)) return primaryMethod;
  for (const alias of MODEL_ALIASES[primaryMethod] ?? []) {
    if (familyModels.some((entry) => entry.model === alias)) return alias;
  }
  return undefined;
}

/** Applies a scenario's bounded economics to an operating baseline, producing a
 * distinct, deterministic baseline for that scenario. */
function applyScenarioEconomics(baseline: ValuationAssumptions, economics: ScenarioEconomics | undefined, capital: CapitalRequirement[]): ValuationAssumptions {
  if (!economics) return baseline;
  const growth = clamp(finite(economics.growthMultiplier) ? economics.growthMultiplier : 1, 0, 3);
  const revenue = clamp(finite(economics.revenueMultiplier) ? economics.revenueMultiplier : 1, 0, 10);
  const fcf = economics.fcfMultiplier ?? 1;
  const marginDelta = clamp(finite(economics.marginDelta) ? economics.marginDelta : 0, -1, 1);
  const multiple = clamp(finite(economics.multipleMultiplier) ? economics.multipleMultiplier : 1, 0, 10);
  const scale = (path: number[] | undefined) => path?.map((value, index) => {
    const investment = capital.filter((item) => item.timingYear === index + 1).reduce((sum, item) => sum + item.amountB, 0);
    return (value + investment) * fcf * growth ** index - investment;
  });
  const cashFlows = scale(baseline.cashFlows);
  const normalizedCashFlows = scale(baseline.normalizedCashFlows);
  return {
    ...baseline,
    cashFlows,
    normalizedCashFlows,
    terminalCashFlowB: baseline.terminalCashFlowB == null ? undefined : baseline.terminalCashFlowB * fcf * growth ** Math.max(0, (baseline.cashFlows?.length ?? 1) - 1),
    forwardRevenueB: baseline.forwardRevenueB != null ? baseline.forwardRevenueB * revenue : baseline.forwardRevenueB,
    forwardFcfB: baseline.forwardFcfB != null ? baseline.forwardFcfB * fcf : baseline.forwardFcfB,
    fcfMargin: baseline.fcfMargin != null ? clamp(baseline.fcfMargin + marginDelta, 0, 1) : baseline.fcfMargin,
    forwardPe: baseline.forwardPe != null ? baseline.forwardPe * multiple : baseline.forwardPe,
    evFcfMultiple: baseline.evFcfMultiple != null ? baseline.evFcfMultiple * multiple : baseline.evFcfMultiple,
    evSalesMultiple: baseline.evSalesMultiple != null ? baseline.evSalesMultiple * multiple : baseline.evSalesMultiple,
  };
}

/** The canonical ResearchPlan hash — the valuation-result cache's `assumptionVersion`. */
export function hashPlan(plan: ResearchPlan): string {
  return hashCanonical(canonicalizeResearchPlan(plan));
}

function methodForModel(model: ValuationModelId): NonNullable<SotPSegment["method"]> {
  switch (model) {
    case "dcf":
    case "normalized_dcf":
    case "reverse_dcf":
      return "dcf";
    case "ev_ebitda":
      return "ebitda_multiple";
    case "ev_sales":
    case "forward_pe":
      return "revenue_multiple";
    case "ev_fcf":
      return "fcf_multiple";
    case "project_npv":
    case "rnpv":
    case "commodity_scenario":
      return "probability_weighted_option";
    case "nav":
    case "residual_income":
    case "p_tbv":
    case "bitcoin_nav":
    case "affo":
      return "capital_based";
    default:
      return "revenue_multiple";
  }
}

function isEquityBasis(model: ValuationModelId): boolean {
  return ["nav", "bitcoin_nav", "project_npv", "rnpv", "residual_income", "p_tbv", "affo"].includes(model);
}

function evaluateRevenueDriver(business: BusinessNode): number | null {
  const params = business.revenueDriver.params ?? {};
  const num = (value: unknown) => (typeof value === "number" ? value : Number(value));
  switch (business.revenueDriver.formula) {
    case "volume_x_price":
      return finite(num(params.volume)) && finite(num(params.price)) ? num(params.volume) * num(params.price) / 1e9 : null;
    case "users_x_arpu":
      return finite(num(params.users)) && finite(num(params.arpu)) ? num(params.users) * num(params.arpu) / 1e9 : null;
    case "capacity_x_utilization_x_price":
      return finite(num(params.capacity)) && finite(num(params.utilization)) && finite(num(params.price))
        ? num(params.capacity) * num(params.utilization) * num(params.price) / 1e9
        : null;
    case "constant":
      return finite(num(params.value)) ? num(params.value) / 1e9 : null;
    case "growth":
    case "reported_segment":
    case "revenue_x_margin":
      return finite(num(params.revenueB)) ? num(params.revenueB) : null;
    default:
      return null;
  }
}

function evaluateBusiness(business: BusinessNode): {
  metric: "revenue" | "ebitda" | "fcf";
  metricValueB: number;
  revenueB: number | null;
  growthCagr: number;
  cashFlowB: number | null;
} {
  const disclosedRevenue = business.disclosedData.find((item) => /^revenue$/i.test(item.label))?.value ?? null;
  const revenueB = firstFinite([business.forecastYears[0]?.revenueB, disclosedRevenue, evaluateRevenueDriver(business)]);
  const growthCagr = business.forecastYears[0]?.growth ?? 0;
  // A driver formula does not establish an EBITDA or FCFF metric. Only an
  // explicit forecast FCF can feed EV/FCF; generic margin and revenue cannot.
  const cashFlowB = firstFinite([business.forecastYears[0]?.fcfB]);
  const metric = business.valuationMethod === "ev_ebitda" ? "ebitda"
    : ["dcf", "normalized_dcf", "ev_fcf"].includes(business.valuationMethod) ? "fcf" : "revenue";
  const metricValueB = (metric === "revenue" ? revenueB : metric === "fcf" ? cashFlowB
    : business.disclosedData.find((item) => /^ebitda$/i.test(item.label) && item.unit === "USD billions")?.value) ?? 0;
  return { metric, metricValueB, revenueB, growthCagr, cashFlowB };
}

function resolveSegmentProbability(business: BusinessNode, scenarios: Scenario[]): { probability: number; owner: "segment" | "scenario" | null } {
  const segmentScenario = scenarios.find((scenario) => scenario.appliesTo === "segment" && scenario.businessIds.includes(business.id));
  const companyScenario = scenarios.find((scenario) => scenario.appliesTo === "company" && scenario.businessIds.includes(business.id));
  if (segmentScenario && companyScenario) {
    // Both claim the same uncertainty: first owner wins and the double-count is
    // flagged by runResearchChecks, so value is never multiplied twice.
    return { probability: segmentScenario.probability, owner: "segment" };
  }
  if (segmentScenario) return { probability: segmentScenario.probability, owner: "segment" };
  if (companyScenario) return { probability: 1, owner: "scenario" };
  return { probability: 1, owner: null };
}

function buildSegments(plan: ResearchPlan, evidence: ValuationAssumptions, profile: ValuationProfile, methodMultiples: Map<string, number>): { segments: SotPSegment[]; probabilityOwners: ProbabilityOwner[] } {
  const probabilityOwners: ProbabilityOwner[] = [];
  const segments: SotPSegment[] = plan.businesses.map((business) => {
    const evaluated = evaluateBusiness(business);
    let multiple = business.multiple ?? methodMultiples.get(business.id);
    if (["dcf", "normalized_dcf"].includes(business.valuationMethod)) {
      const flows = companyForecast({ ...plan, businesses: [business] }) ?? [];
      const segmentDcf = plan.aggregationRule === "sotp";
      if (segmentDcf && !["analyst_fcff", "fcff_ebit_bridge"].includes(evidence.cashFlowBasis ?? "")) throw new ModelCapabilityGapError("segment DCF requires explicit unlevered FCFF before the corporate bridge");
      const result = VALUATION_MODELS.dcf.run({ ...evidence, cashFlows: flows, dilutedSharesB: 1, netCashB: 0,
        wacc: profile.capitalCost?.wacc ?? evidence.wacc, costOfEquity: profile.capitalCost?.costOfEquity ?? evidence.costOfEquity }, null);
      if (!finite(result.value)) throw new ModelCapabilityGapError(`${business.id}: complete DCF path, discount rate and positive terminal cash flow required`);
      const discountRate = segmentDcf || ["analyst_fcff", "fcff_ebit_bridge"].includes(evidence.cashFlowBasis ?? "") ? (profile.capitalCost?.wacc ?? evidence.wacc) : (profile.capitalCost?.costOfEquity ?? evidence.costOfEquity);
      if (!finite(discountRate)) throw new ModelCapabilityGapError("DCF discount rate missing");
      evaluated.metricValueB = result.value - plan.capitalRequirements.filter((item) => item.businessId === business.id || plan.businesses.length === 1).reduce((sum, item) => sum + item.amountB / (1 + discountRate) ** item.timingYear, 0);
      // Identity multiplier on a computed present value, never a missing-multiple fallback.
      multiple = 1;
    } else if (plan.aggregationRule === "sotp") {
      if (!["ev_sales", "ev_ebitda", "ev_fcf"].includes(business.valuationMethod)) throw new ModelCapabilityGapError(`segment method ${business.valuationMethod} is not implemented`);
      if (!finite(multiple) || multiple <= 0) throw new ModelCapabilityGapError(`${business.id}: an explicit positive multiple is required`);
      if (business.valuationMethod === "ev_ebitda") {
        const ebitda = business.disclosedData.find((item) => /^ebitda$/i.test(item.label) && item.unit === "USD billions")?.value;
        if (!finite(ebitda)) throw new ModelCapabilityGapError(`${business.id}: explicit EBITDA is required; revenue/margin is not EBITDA`);
        evaluated.metricValueB = ebitda;
      }
      if (business.valuationMethod === "ev_sales" && !finite(evaluated.revenueB)) throw new ModelCapabilityGapError(`${business.id}: EV/sales requires explicit revenue`);
      if (business.valuationMethod === "ev_fcf" && (!finite(evaluated.cashFlowB) || !["analyst_fcff", "fcff_ebit_bridge"].includes(evidence.cashFlowBasis ?? ""))) throw new ModelCapabilityGapError("EV/FCF requires explicit forecast unlevered cash flow; revenue is not a substitute");
    } else {
      throw new ModelCapabilityGapError(`company research method ${business.valuationMethod} has no audited plan-to-equation mapping`);
    }
    const probability = resolveSegmentProbability(business, plan.scenarios);
    if (probability.owner) {
      probabilityOwners.push({ uncertaintyId: business.id, owner: probability.owner });
    }
    return {
      name: business.name,
      metric: ["dcf", "normalized_dcf"].includes(business.valuationMethod) ? "present value of forecast cash flows" : evaluated.metric,
      metricValueB: evaluated.metricValueB,
      multiple: multiple!,
      probability: probability.probability,
      driverSource: business.segmentationBasis === "reported_segment" ? "reported" : "model_derived",
      method: methodForModel(business.valuationMethod),
      marginAssumption: business.forecastYears[0]?.margin,
      layer: business.stage === "optionality" ? "optionality" : business.stage === "mature" ? "core" : "growth",
      valuationBasis: isEquityBasis(business.valuationMethod) ? "EQUITY_VALUE" : "ENTERPRISE_VALUE",
      currentRevenueB: evaluated.revenueB ?? undefined,
      growthCagr: evaluated.growthCagr,
      cashFlowB: evaluated.cashFlowB ?? undefined,
    };
  });
  return { segments, probabilityOwners };
}

/** P0 consumption contract: explicit FCF is already net of operating capex;
 * separately declared capital is consumed only when explicitly incremental.
 * Unimplemented economics fail closed instead of being copied to an audit array.
 */
export const RESEARCH_CONSUMPTION = {
  forecastYears: "consecutive annual FCF -> DCF including terminal value",
  capitalRequirements: "incremental capex/working capital -> specified year cash flow; never terminal run rate",
  financing: "one current-date equity raise + matched incremental shares -> cash and denominator",
  dilution: "explicit incremental new shares -> denominator; options/SBC need a separate economic contract",
  costDrivers: "unsupported: capability gap",
  forecastAssumptions: "unsupported: supply explicit annual FCF; no implicit growth/margin propagation",
  forecastMetadata: "revenue/margin/growth annotate the explicit FCF path; they do not independently rebuild it",
  growthConstraints: "validate each corresponding forecast row; no silent clipping",
} as const;

function validateEconomicConsumption(plan: ResearchPlan, evidence: ValuationAssumptions) {
  const fail = (message: string): never => { throw new ModelCapabilityGapError(message); };
  const contract = FINAL_RESEARCH_EXECUTION_CONTRACT;
  if (!plan.businesses.length || new Set(plan.businesses.map((b) => b.id)).size !== plan.businesses.length) fail("business ids must be nonempty and unique");
  if (plan.aggregationRule === "sotp" && plan.primaryMethod !== "sotp") fail("SOTP requires an explicit matching primary method");
  if (plan.aggregationRule !== "sotp" && !(contract.dcfMethods as readonly string[]).includes(plan.primaryMethod)) fail("company research primary method has no audited economic mapping");
  const methodMultiples = new Map<string, number>();
  const valuationConsumers = new Set<string>();
  const bind = (key: string) => {
    if (valuationConsumers.has(key)) fail("valuation methods have multiple declarations for one consumer");
    valuationConsumers.add(key);
  };
  if (!plan.valuationMethods.some((method) => method.purpose === "valuation")) fail("no executable valuation method declared");
  for (const method of plan.valuationMethods) {
    if (method.purpose !== "valuation" && method.purpose !== "cross_check") fail("valuation method purpose must be explicit");
    if (!VALUATION_MODEL_IDS.includes(method.model)) fail("valuation method model is unsupported");
    if (!method.appliesToBusinessIds.length || new Set(method.appliesToBusinessIds).size !== method.appliesToBusinessIds.length) fail("valuation method requires unique business targets");
    if (method.appliesToBusinessIds.some((id) => !plan.businesses.some((b) => b.id === id))) fail("valuation method references an unknown business");
    const multiple = method.multiple;
    if (multiple === undefined) {
      if (method.purpose === "cross_check") continue;
      if (method.model === "sotp" && plan.aggregationRule === "sotp" && plan.primaryMethod === "sotp" &&
        method.appliesToBusinessIds.length === plan.businesses.length) {
        bind("aggregation:sotp");
        continue;
      }
      if (method.appliesToBusinessIds.length === 1 &&
        plan.businesses.find((b) => b.id === method.appliesToBusinessIds[0])?.valuationMethod === method.model) {
        bind(`business:${method.appliesToBusinessIds[0]}`);
        continue;
      }
      fail("valuation method has no matching executable consumer");
    }
    if (!finite(multiple) || multiple <= 0) throw new ModelCapabilityGapError("an explicit positive multiple is required");
    if (method.model === "dcf" || method.model === "normalized_dcf") fail("DCF method does not consume a multiple");
    if (method.purpose === "cross_check") continue;
    if (plan.aggregationRule !== "sotp" || method.appliesToBusinessIds.length !== 1) {
      fail("method-level multiple has no unique SOTP business consumer");
    }
    const business = plan.businesses.find((b) => b.id === method.appliesToBusinessIds[0])!;
    if (!(contract.multipleBusinessMethods as readonly string[]).includes(method.model) ||
      business.valuationMethod !== method.model || business.multiple != null) {
      fail("method-level multiple is unused; specify it once on a matching multiple-valued business");
    }
    if (methodMultiples.has(business.id)) fail("method-level multiple has multiple consumers for one business");
    bind(`business:${business.id}`);
    methodMultiples.set(business.id, multiple);
  }
  for (const business of plan.businesses) {
    if ((contract.dcfMethods as readonly string[]).includes(business.valuationMethod) && business.multiple != null) fail(`${business.id}: DCF does not consume a multiple`);
    if (business.costDrivers.length) fail(`${business.id}: costDrivers not implemented; supply reconciled net cash flows`);
    if (business.forecastAssumptions.length) fail(`${business.id}: unsupported forecastAssumption field`);
    if (business.forecastYears.some((row) => row.capexB !== undefined)) fail(`${business.id}: capexB lacks an included-in-FCF contract; use explicit incremental capitalRequirements`);
    for (const row of business.disclosedData) if (row.value !== null && row.unit !== contract.disclosedUnit) fail(`${business.id}: disclosedData requires normalized USD billions`);
    for (const constraint of business.growthConstraints) {
      if (!(contract.growthConstraintFields as readonly string[]).includes(constraint.field)) fail(`${business.id}: unsupported constraint ${constraint.field}`);
      if (!business.forecastYears.length) fail(`${business.id}: constraint has no forecast rows`);
      for (const row of business.forecastYears) {
        const value = row[constraint.field as keyof typeof row];
        if (!finite(value) || (constraint.min !== undefined && value < constraint.min) || (constraint.max !== undefined && value > constraint.max)) fail(`${business.id}: forecast violates ${constraint.field} constraint`);
      }
    }
  }
  for (const item of plan.capitalRequirements) {
    if (!(contract.capitalKinds as readonly string[]).includes(item.kind) || item.incremental !== true) fail(`${item.id}: capital must explicitly be incremental capex/working capital, not already deducted in FCF`);
    if (!finite(item.amountB) || item.amountB < 0 || !Number.isInteger(item.timingYear) || item.timingYear < 1) fail(`${item.id}: invalid capital amount/year`);
    const business = plan.businesses.find((b) => b.id === item.businessId) ?? (item.businessId === null && plan.businesses.length === 1 ? plan.businesses[0] : undefined);
    if (!business || !(contract.dcfMethods as readonly string[]).includes(business.valuationMethod) || item.timingYear > business.forecastYears.length) fail(`${item.id}: capital requires an identified DCF business and an explicit forecast year`);
    if (business && item.amountB > 0 && plan.scenarios.some((scenario) => scenario.appliesTo === "segment" && scenario.businessIds.includes(business.id) && scenario.probability !== 1)) fail(`${item.id}: independent capital with segment probability requires an explicit unconditional/contingent contract; unsupported in P0`);
  }
  for (const item of plan.dilution) {
    if (item.kind !== contract.dilutionKind || !finite(item.sharesB) || item.sharesB < 0) fail(`${item.id}: only explicit incremental new_shares are supported; SBC/options need their economic cost contract`);
  }
  if (plan.financing.length) {
    const item = plan.financing[0];
    if (plan.financing.length !== 1 || item.kind !== contract.financingKind || item.timingYear !== contract.financingTimingYear || (item.costPct ?? 0) !== 0 || !finite(item.amountB) || item.amountB < 0) fail("financing requires timingYear=0 equity; future/debt/hybrid financing needs maturity, interest and repayment schedules");
    if (!item.evidenceId || !plan.dilution.some((d) => d.evidenceId === item.evidenceId && d.sharesB > 0)) fail("equity financing requires matching incremental shares and evidence");
    if (plan.aggregationRule !== "sotp" && !["analyst_fcff", "fcff_ebit_bridge"].includes(evidence.cashFlowBasis ?? "")) fail("financing an equity-stream proxy is unsupported; net cash cannot be silently ignored");
  }
  const companies = plan.scenarios.filter((s) => s.appliesTo === "company");
  if (companies.length && plan.aggregationRule !== "scenario_weighted") fail("company scenarios require explicit scenario_weighted aggregation");
  if (plan.aggregationRule === "scenario_weighted" && (!companies.length || Math.abs(companies.reduce((sum, s) => sum + s.probability, 0) - 1) > 1e-8)) fail("exhaustive company scenarios must sum to 1");
  if (plan.scenarios.some((s) => !finite(s.probability) || s.probability < 0 || s.probability > 1)) fail("invalid scenario probability");
  if (plan.aggregationRule !== "sotp" && plan.scenarios.some((s) => s.appliesTo === "segment")) fail("segment probability requires explicit SOTP aggregation");
  const segmentOwners = plan.scenarios.filter((s) => s.appliesTo === "segment").flatMap((s) => s.businessIds);
  if (new Set(segmentOwners).size !== segmentOwners.length) fail("each segment uncertainty must have a single probability owner");
  for (const scenario of plan.scenarios) {
    if (scenario.economics?.fcfMultiplier !== undefined && (!finite(scenario.economics.fcfMultiplier) || scenario.economics.fcfMultiplier < 0)) fail("invalid scenario FCF multiplier");
    if (scenario.businessIds.some((id) => !plan.businesses.some((b) => b.id === id))) fail("scenario references unknown business");
    if (scenario.appliesTo === "segment" && scenario.economics) fail("segment scenario economics are not implemented");
    if (scenario.economics && Object.entries(scenario.economics).some(([key, value]) => !(contract.scenarioEconomicsFields as readonly string[]).includes(key) && value !== undefined)) fail("scenario economics currently support explicit fcfMultiplier only; other drivers need a reconciled forecast");
  }
  if (plan.aggregationRule === "ensemble") fail("research ensemble requires explicit comparable model contracts");
  return methodMultiples;
}

function applyCapitalToCashFlows(cashFlows: number[], capital: CapitalRequirement[]): number[] {
  const result = [...cashFlows];
  for (const item of capital) result[item.timingYear - 1] -= item.amountB;
  return result;
}

function companyForecast(plan: ResearchPlan): number[] | null {
  const business = plan.businesses[0];
  if (!business?.forecastYears.length) return null;
  const values = business.forecastYears.map((row, index) => {
    if (!Number.isInteger(row.year) || (index > 0 && row.year !== business.forecastYears[index - 1].year + 1)) throw new ModelCapabilityGapError("DCF requires consecutive annual forecast years");
    // A generic margin cannot be silently interpreted as a cash-flow margin.
    if (!finite(row.fcfB)) throw new ModelCapabilityGapError(`${business.id}: every DCF year requires explicit net fcfB`);
    return row.fcfB;
  });
  return values;
}

/**
 * Compiles a ResearchPlan into a deterministic valuation profile. The plan is the
 * authoritative source for segmentation, drivers, growth/margin, capital, financing,
 * dilution, scenarios and model selection. The compiled profile never carries a
 * `fairValue`, `referencePrice` or `targetPrice`.
 */
export function compileResearchPlan(
  pack: { profile: ValuationProfile; evidenceAssumptions: ValuationAssumptions },
  plan: ResearchPlan,
): CompiledResearchProfile {
  plan = canonicalizeResearchPlan(plan);
  const capabilityIssues = validateFinalResearchExecution(plan);
  if (capabilityIssues.length) throw new ModelCapabilityGapError(capabilityIssues
    .map((issue) => `${issue.path}: ${issue.code}: ${issue.detail}`).join("; "));
  // 1. Capability validation: unknown formula or model is a hard gap, never a
  //    silent substitution with a generic DCF.
  for (const business of plan.businesses) {
    if (!isDriverFormula(business.revenueDriver.formula)) {
      throw new ModelCapabilityGapError(`driver formula "${business.revenueDriver.formula}" is not whitelisted`);
    }
    for (const driver of business.costDrivers) {
      if (!isDriverFormula(driver.formula)) throw new ModelCapabilityGapError(`cost driver formula "${driver.formula}" is not whitelisted`);
    }
    if (!VALUATION_MODEL_IDS.includes(business.valuationMethod)) {
      throw new ModelCapabilityGapError(`valuation method "${business.valuationMethod}" is not supported`);
    }
  }
  if (!VALUATION_MODEL_IDS.includes(plan.primaryMethod)) {
    throw new ModelCapabilityGapError(`primary method "${plan.primaryMethod}" is not supported`);
  }

  const evidence = pack.evidenceAssumptions;
  const legacyClassification = pack.profile.classification;

  // 2. Probability ownership and SOTP segments.
  const methodMultiples = validateEconomicConsumption(plan, evidence);
  const { segments, probabilityOwners } = buildSegments(plan, evidence, pack.profile, methodMultiples);

  // 3. Capital → cash flow / committed-capital reduction (affects value).


  // 4. Financing → EV/equity bridge.
  const equityFinancingB = plan.financing.reduce((sum, item) => sum + (item.kind === "equity" ? item.amountB : 0), 0);


  // 5. Dilution → per-share denominator.
  const dilutionSharesB = plan.dilution.reduce((sum, item) => sum + item.sharesB, 0);

  const baseSharesB = evidence.dilutedSharesB ?? 0;
  const baseNetCashB = evidence.netCashB ?? 0;

  const useSotp = plan.aggregationRule === "sotp";
  if (!useSotp && plan.businesses.length !== 1) throw new ModelCapabilityGapError("multiple businesses require an explicit supported aggregation; not automatically SOTP");

  let baseline: ValuationAssumptions;
  if (useSotp) {
    // Incremental capital is already deducted in segment PV; only current equity proceeds enter net cash.
    baseline = {
      ...evidence,
      sotpSegments: segments,
      netCashB: baseNetCashB + equityFinancingB,
      dilutedSharesB: baseSharesB + dilutionSharesB,
    };
  } else {
    // Single-business company-level valuation: build a DCF-style baseline.
    const rawCashFlows = companyForecast(plan) ?? (evidence.cashFlows ?? evidence.normalizedCashFlows);
    const cashFlows = applyCapitalToCashFlows(rawCashFlows ?? [], plan.capitalRequirements);
    const business = plan.businesses[0];
    const margin = firstFinite([
      business?.forecastYears[0]?.margin,
      business?.forecastAssumptions.find((item) => item.field === "margin")?.value,
      evidence.fcfMargin,
    ]);
    baseline = {
      ...evidence,
      cashFlows,
      normalizedCashFlows: cashFlows,
      terminalCashFlowB: plan.capitalRequirements.length ? rawCashFlows?.at(-1) : undefined,
      forwardRevenueB: business?.forecastYears[0]?.revenueB ?? evidence.forwardRevenueB,
      forwardFcfB: business?.forecastYears[0]?.fcfB ?? evidence.forwardFcfB,
      fcfMargin: margin ?? evidence.fcfMargin,
      sotpSegments: undefined,
      netCashB: baseNetCashB + equityFinancingB,
      dilutedSharesB: baseSharesB + dilutionSharesB,
    };
  }

  // Sourced CAPM / policy rates from the evidence pack, applied exactly as the
  // deterministic engine applies them, so research-engine rates stay consistent.
  if (pack.profile.capitalCost) {
    baseline.wacc = pack.profile.capitalCost.wacc;
    baseline.costOfEquity = pack.profile.capitalCost.costOfEquity;
    baseline.preTaxCostOfDebt = pack.profile.capitalCost.preTaxCostOfDebt;
    baseline.costOfEquitySource = pack.profile.capitalCost.method;
  }

  // 6. Model selection is fixed before any valuation output is seen.
  const familyModels = MODEL_FAMILIES[legacyClassification.modelFamily as ModelFamilyId]?.models ?? [];
  const modelApplicability: Partial<Record<ValuationModelId, number>> = {};
  for (const entry of familyModels) modelApplicability[entry.model] = 0;
  const familyModelNames = familyModels.map((entry) => entry.model);
  if (useSotp) {
    // A segment-level aggregation is only expressible when the family actually routes
    // the `sotp` model; otherwise every valuation model stays disabled and the value
    // silently nulls out, so it is a hard capability gap.
    if (!familyModelNames.includes("sotp")) {
      throw new ModelCapabilityGapError(`plan aggregation "${plan.aggregationRule}" requires the "sotp" model, which family "${legacyClassification.modelFamily}" does not route`);
    }
    modelApplicability.sotp = 1;
    modelApplicability.reverse_dcf = 1;
  } else {
    // Resolve the plan's primary method to a model the family actually routes. A plan
    // may legitimately name a DCF variant the family does not carry (`normalized_dcf`
    // in `ai_compute_platform`, which routes plain `dcf`); the two are interchangeable
    // here because the compiler writes the same stream to both `cashFlows` and
    // `normalizedCashFlows`, and that interchange is declared explicitly in
    // MODEL_ALIASES. Any other mismatch is a hard gap, never a silent swap.
    const resolvedPrimary = resolvePrimaryModel(familyModels, plan.primaryMethod);
    if (!resolvedPrimary) {
      throw new ModelCapabilityGapError(`primary method "${plan.primaryMethod}" is not routable by model family "${legacyClassification.modelFamily}"`);
    }
    modelApplicability[resolvedPrimary] = 1;
    modelApplicability.reverse_dcf = 1;
  }

  // 7. Scenario-weighted aggregation (single-business path). Each company-level
  //    scenario applies its own bounded economics to the compiled baseline, so each
  //    scenario produces its own deterministic valuation. `runValuationProfile`
  //    prices each baseline through the same ensemble and publishes the
  //    probability-weighted expectation; the base case gets the residual
  //    probability 1 − Σ p. Probabilities are never applied twice: company-level
  //    scenarios only price this way, while segment-level probabilities already
  //    live in `segments` and are excluded from this block.
  let scenarioWeighted: ScenarioWeightedProfile | undefined;
  if (!useSotp && plan.aggregationRule === "scenario_weighted") {
    const companyScenarios = plan.scenarios.filter((scenario) => scenario.appliesTo === "company");
    if (companyScenarios.length > 0) {
      const probabilitySum = companyScenarios.reduce((sum, scenario) => sum + scenario.probability, 0);
      scenarioWeighted = {
        scenarios: companyScenarios.map((scenario) => ({
          id: scenario.id,
          name: scenario.name,
          probability: scenario.probability,
          baseline: applyScenarioEconomics(baseline, scenario.economics, plan.capitalRequirements),
        })),
        residualProbability: clamp(1 - probabilitySum, 0, 1),
      };
    }
  }

  const profile: ValuationProfile = {
    classification: legacyClassification,
    capitalCost: pack.profile.capitalCost ?? null,
    baseline,
    scenarioWeighted,
    dataQuality: pack.profile.dataQuality,
    thesis: { growthDelta: 0, marginDelta: 0, multipleDelta: 0, note: "ResearchPlan is authoritative; no legacy delta is applied after compilation." },
    modelConfidence: Object.fromEntries(familyModels.map((entry) => [entry.model, entry.priorReliability])) as ValuationProfile["modelConfidence"],
    modelApplicability,
    sourcePosture: "reported_internal_forecast",
    inputSources: {
      sotpSegments: {
        kind: "internal_forecast",
        label: "ResearchPlan businesses compiled into segments; probabilities owned by segment or scenario exactly once.",
      },
      cashFlows: {
        kind: "internal_forecast",
        label: "ResearchPlan forecast drivers compiled into a deterministic cash-flow stream.",
      },
      netCashB: {
        kind: "derived",
        label: "Evidence capital bridge adjusted for current equity financing; incremental capital is deducted in cash-flow PV.",
      },
      dilutedSharesB: {
        kind: "derived",
        label: "Evidence share count adjusted for ResearchPlan dilution.",
      },
    },
    evidenceMissing: plan.missingEvidence,
    variantPath: plan.thesisChanges.join("; ") || "ResearchPlan compiled from operating evidence.",
    downsideMechanism: plan.crossChecks.join("; ") || "Forecast miss reduces cash flow and the justified multiple.",
    evidenceGate: "Re-run on the next 10-Q/10-K and replace ResearchPlan assumptions when verified guidance or filings change.",
  };

  return {
    profile,
    segments,
    primaryMethod: plan.primaryMethod,
    aggregationRule: plan.aggregationRule,
    appliedCapital: plan.capitalRequirements,
    appliedFinancing: plan.financing,
    appliedDilution: plan.dilution,
    probabilityOwners,
    advisoryMethods: plan.valuationMethods.filter((method) => method.purpose === "cross_check")
      .map((method) => ({ ...method, appliesToBusinessIds: [...method.appliesToBusinessIds] })),
  };
}
