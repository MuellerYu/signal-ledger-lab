import { schemaErrors } from "./research-schema";
import { marketFieldPaths } from "./research-isolation";
// Runtime schema validation for every AI-produced research payload.
//
// The research schemas are sent to OpenAI with `strict: false` (their free-form
// maps and optional fields cannot be expressed in OpenAI strict mode), so the
// server-side JSON schema is guidance only. That makes an explicit runtime gate
// mandatory: every `research_draft`, `research_finalize` (ResearchPlan) and
// `research_reviewer` (ResearchRevision) payload is validated here AFTER
// `JSON.parse` and BEFORE it reaches the compiler or the reviewer.
//
// A payload that fails this validation is rejected with RESEARCH_SCHEMA_INVALID.
// Before structural validation, only existing optional missing-value encodings
// and unused method-level DCF multiple:null are normalized. A sparse draft's
// missing business fields remain missing; no numeric values are inferred and
// the original payload remains untouched.
import {
  researchPlanSchema, researchDraftSchema, researchRevisionSchema, canonicalizeResearchPlan,
  DRIVER_FORMULAS,
  VALUATION_MODEL_IDS,
  REVISION_REASONS,
  FINAL_RESEARCH_EXECUTION_CONTRACT,
  type ResearchPlan,
} from "./research-plan";

export class ResearchSchemaInvalidError extends Error {
  constructor(readonly errors: string[]) {
    super(`RESEARCH_SCHEMA_INVALID: ${errors.join("; ")}`);
    this.name = "ResearchSchemaInvalidError";
  }
}

export type ResearchPayloadKind = "draft" | "plan" | "revision";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === "string";

function hasNonFinite(value: unknown, path: string, errors: string[]): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    errors.push(`${path}: NaN/Infinity is not a valid number`);
    return;
  }
  if (typeof value === "string" && /^(nan|infinity|-infinity)$/i.test(value.trim())) {
    errors.push(`${path}: "${value}" is not a valid number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => hasNonFinite(item, `${path}[${index}]`, errors));
    return;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      hasNonFinite(child, `${path}.${key}`, errors);
    }
  }
}

function inEnum(path: string, value: unknown, allowed: readonly string[], errors: string[]): void {
  if (!isString(value) || !(allowed as readonly string[]).includes(value)) {
    errors.push(`${path}: "${String(value)}" is not one of ${allowed.join("|")}`);
  }
}

function optionalFinite(path: string, value: unknown, errors: string[], bounds?: { min?: number; max?: number }): void {
  if (value === undefined || value === null) return;
  if (!isFiniteNumber(value)) {
    errors.push(`${path}: expected a finite number, got ${JSON.stringify(value)}`);
    return;
  }
  if (bounds?.min !== undefined && value < bounds.min) errors.push(`${path}: ${value} is below the minimum ${bounds.min}`);
  if (bounds?.max !== undefined && value > bounds.max) errors.push(`${path}: ${value} exceeds the maximum ${bounds.max}`);
}

function requiredNumber(path: string, value: unknown, errors: string[], bounds?: { min?: number; max?: number }): void {
  if (!isFiniteNumber(value)) {
    errors.push(`${path}: expected a finite number, got ${JSON.stringify(value)}`);
    return;
  }
  if (bounds?.min !== undefined && value < bounds.min) errors.push(`${path}: ${value} is below the minimum ${bounds.min}`);
  if (bounds?.max !== undefined && value > bounds.max) errors.push(`${path}: ${value} exceeds the maximum ${bounds.max}`);
}

function requiredString(path: string, value: unknown, errors: string[]): void {
  if (!isString(value) || value.length === 0) errors.push(`${path}: expected a non-empty string`);
}

function optionalString(path: string, value: unknown, errors: string[]): void {
  if (value === undefined || value === null) return;
  if (!isString(value)) errors.push(`${path}: expected a string, got ${JSON.stringify(value)}`);
}

function validateDriver(path: string, driver: unknown, errors: string[]): void {
  if (!isObject(driver)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  inEnum(`${path}.formula`, driver.formula, DRIVER_FORMULAS, errors);
  if (!isObject(driver.params)) errors.push(`${path}.params: expected an object`);
  if (driver.evidenceId !== null && driver.evidenceId !== undefined && !isString(driver.evidenceId)) errors.push(`${path}.evidenceId: expected a string or null`);
  optionalString(`${path}.note`, driver.note, errors);
}

function validateBusiness(path: string, business: unknown, errors: string[], draft = false): void {
  if (!isObject(business)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  requiredString(`${path}.id`, business.id, errors);
  requiredString(`${path}.name`, business.name, errors);
  inEnum(`${path}.stage`, business.stage, ["emerging", "commercializing", "scaling", "mature", "declining", "optionality"], errors);
  requiredString(`${path}.economicMeaning`, business.economicMeaning, errors);
  requiredString(`${path}.segmentationBasis`, business.segmentationBasis, errors);
  validateDriver(`${path}.revenueDriver`, business.revenueDriver, errors);
  if (!Array.isArray(business.costDrivers)) errors.push(`${path}.costDrivers: expected an array`);
  else business.costDrivers.forEach((item, index) => validateDriver(`${path}.costDrivers[${index}]`, item, errors));
  if (!Array.isArray(business.disclosedData) && (!draft || business.disclosedData !== undefined))
    errors.push(`${path}.disclosedData: expected an array`);
  if (!Array.isArray(business.forecastAssumptions) && (!draft || business.forecastAssumptions !== undefined))
    errors.push(`${path}.forecastAssumptions: expected an array`);
  if (!Array.isArray(business.growthConstraints)) errors.push(`${path}.growthConstraints: expected an array`);
  if (!Array.isArray(business.forecastYears)) {
    if (!draft || business.forecastYears !== undefined) errors.push(`${path}.forecastYears: expected an array`);
  } else {
    business.forecastYears.forEach((item, index) => {
      const yearPath = `${path}.forecastYears[${index}]`;
      if (!isObject(item)) {
        errors.push(`${yearPath}: expected an object`);
        return;
      }
      requiredNumber(`${yearPath}.year`, item.year, errors, { min: 1 });
      optionalFinite(`${yearPath}.growth`, item.growth, errors);
      optionalFinite(`${yearPath}.margin`, item.margin, errors);
      optionalFinite(`${yearPath}.revenueB`, item.revenueB, errors, { min: 0 });
      optionalFinite(`${yearPath}.capexB`, item.capexB, errors, { min: 0 });
      optionalFinite(`${yearPath}.fcfB`, item.fcfB, errors);
    });
  }
  inEnum(`${path}.valuationMethod`, business.valuationMethod, VALUATION_MODEL_IDS, errors);
  if (business.multiple !== null && business.multiple !== undefined) requiredNumber(`${path}.multiple`, business.multiple, errors, { min: 0 });
  requiredString(`${path}.rationale`, business.rationale, errors);
  if (!Array.isArray(business.applicabilityConditions)) errors.push(`${path}.applicabilityConditions: expected an array`);
  if (!Array.isArray(business.overlaps)) errors.push(`${path}.overlaps: expected an array`);
}

function validatePlanShape(plan: Record<string, unknown>, errors: string[], draft = false): void {
  const requiredTop = [
    "policyVersion", "businesses", "capitalRequirements", "financing", "dilution",
    "valuationMethods", "scenarios", "probabilitiesCheck", "sources", "missingEvidence",
    "primaryMethod", "aggregationRule", "crossChecks", "thesisChanges", "revisionRecords",
  ];
  for (const key of requiredTop) {
    if (!(key in plan)) errors.push(`top: missing required field "${key}"`);
  }
  const allowedTop = new Set([...requiredTop, "toolRequests"]);
  for (const key of Object.keys(plan)) {
    if (!allowedTop.has(key)) errors.push(`top: unknown field "${key}"`);
  }

  if (!Array.isArray(plan.businesses)) errors.push("businesses: expected an array");
  else plan.businesses.forEach((item, index) => validateBusiness(`businesses[${index}]`, item, errors, draft));

  if (!Array.isArray(plan.capitalRequirements)) errors.push("capitalRequirements: expected an array");
  else plan.capitalRequirements.forEach((item, index) => {
    const path = `capitalRequirements[${index}]`;
    if (!isObject(item)) { errors.push(`${path}: expected an object`); return; }
    requiredString(`${path}.id`, item.id, errors);
    if (item.businessId !== null && item.businessId !== undefined && !isString(item.businessId)) errors.push(`${path}.businessId: expected a string or null`);
    inEnum(`${path}.kind`, item.kind, ["capex", "working_capital", "acquisition", "other"], errors);
    requiredNumber(`${path}.amountB`, item.amountB, errors);
    requiredNumber(`${path}.timingYear`, item.timingYear, errors);
    if (item.evidenceId !== null && item.evidenceId !== undefined && !isString(item.evidenceId)) errors.push(`${path}.evidenceId: expected a string or null`);
    requiredString(`${path}.rationale`, item.rationale, errors);
  });

  if (!Array.isArray(plan.financing)) errors.push("financing: expected an array");
  else plan.financing.forEach((item, index) => {
    const path = `financing[${index}]`;
    if (!isObject(item)) { errors.push(`${path}: expected an object`); return; }
    requiredString(`${path}.id`, item.id, errors);
    inEnum(`${path}.kind`, item.kind, ["debt", "equity", "hybrid"], errors);
    requiredNumber(`${path}.amountB`, item.amountB, errors);
    requiredNumber(`${path}.timingYear`, item.timingYear, errors);
    optionalFinite(`${path}.costPct`, item.costPct, errors, { min: 0, max: 1 });
    if (item.evidenceId !== null && item.evidenceId !== undefined && !isString(item.evidenceId)) errors.push(`${path}.evidenceId: expected a string or null`);
    requiredString(`${path}.rationale`, item.rationale, errors);
  });

  if (!Array.isArray(plan.dilution)) errors.push("dilution: expected an array");
  else plan.dilution.forEach((item, index) => {
    const path = `dilution[${index}]`;
    if (!isObject(item)) { errors.push(`${path}: expected an object`); return; }
    requiredString(`${path}.id`, item.id, errors);
    inEnum(`${path}.kind`, item.kind, ["stock_comp", "new_shares", "warrants", "convertible"], errors);
    requiredNumber(`${path}.sharesB`, item.sharesB, errors, { min: 0 });
    if (item.evidenceId !== null && item.evidenceId !== undefined && !isString(item.evidenceId)) errors.push(`${path}.evidenceId: expected a string or null`);
    requiredString(`${path}.rationale`, item.rationale, errors);
  });

  if (!Array.isArray(plan.valuationMethods)) errors.push("valuationMethods: expected an array");
  else plan.valuationMethods.forEach((item, index) => {
    const path = `valuationMethods[${index}]`;
    if (!isObject(item)) { errors.push(`${path}: expected an object`); return; }
    inEnum(`${path}.model`, item.model, VALUATION_MODEL_IDS, errors);
    inEnum(`${path}.purpose`, item.purpose, ["valuation", "cross_check"], errors);
    if (!Array.isArray(item.appliesToBusinessIds)) errors.push(`${path}.appliesToBusinessIds: expected an array`);
    if (item.multiple !== undefined) optionalFinite(`${path}.multiple`, item.multiple, errors, { min: 0 });
    requiredString(`${path}.rationale`, item.rationale, errors);
  });

  if (!Array.isArray(plan.scenarios)) errors.push("scenarios: expected an array");
  else plan.scenarios.forEach((item, index) => {
    const path = `scenarios[${index}]`;
    if (!isObject(item)) { errors.push(`${path}: expected an object`); return; }
    requiredString(`${path}.id`, item.id, errors);
    requiredString(`${path}.name`, item.name, errors);
    requiredString(`${path}.description`, item.description, errors);
    requiredNumber(`${path}.probability`, item.probability, errors, { min: 0, max: 1 });
    inEnum(`${path}.appliesTo`, item.appliesTo, ["segment", "company"], errors);
    if (!Array.isArray(item.businessIds)) errors.push(`${path}.businessIds: expected an array`);
    if (item.economics !== undefined && item.economics !== null) {
      if (!isObject(item.economics)) errors.push(`${path}.economics: expected an object`);
      else {
        for (const field of ["growthMultiplier", "revenueMultiplier", "fcfMultiplier", "multipleMultiplier"]) {
          optionalFinite(`${path}.economics.${field}`, item.economics[field], errors, { min: 0 });
        }
        optionalFinite(`${path}.economics.marginDelta`, item.economics.marginDelta, errors, { min: -1, max: 1 });
      }
    }
  });

  if (!Array.isArray(plan.sources)) errors.push("sources: expected an array");
  else plan.sources.forEach((item, index) => {
    const path = `sources[${index}]`;
    if (!isObject(item)) { errors.push(`${path}: expected an object`); return; }
    requiredString(`${path}.id`, item.id, errors);
    inEnum(`${path}.kind`, item.kind, ["filing", "tool_result", "guidance", "peer", "prior"], errors);
    requiredString(`${path}.label`, item.label, errors);
  });

  if (!Array.isArray(plan.missingEvidence)) errors.push("missingEvidence: expected an array");
  if (!Array.isArray(plan.crossChecks)) errors.push("crossChecks: expected an array");
  if (!Array.isArray(plan.thesisChanges)) errors.push("thesisChanges: expected an array");

  inEnum("primaryMethod", plan.primaryMethod, VALUATION_MODEL_IDS, errors);
  inEnum("aggregationRule", plan.aggregationRule, ["sotp", "ensemble", "single_model", "scenario_weighted"], errors);

  if (!Array.isArray(plan.revisionRecords)) errors.push("revisionRecords: expected an array");
  else plan.revisionRecords.forEach((item, index) => validateRevision(`revisionRecords[${index}]`, item, errors));
}

function validateToolRequests(plan: Record<string, unknown>, errors: string[]): void {
  if (plan.toolRequests === undefined) {
    errors.push("toolRequests: missing required field for a research draft");
    return;
  }
  if (!Array.isArray(plan.toolRequests)) {
    errors.push("toolRequests: expected an array");
    return;
  }
  plan.toolRequests.forEach((item, index) => {
    const path = `toolRequests[${index}]`;
    if (!isObject(item)) { errors.push(`${path}: expected an object`); return; }
    requiredString(`${path}.tool`, item.tool, errors);
    if (!isObject(item.args)) errors.push(`${path}.args: expected an object`);
  });
}

function validateRevision(path: string, revision: unknown, errors: string[]): void {
  if (!isObject(revision)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  inEnum(`${path}.revisionReason`, revision.revisionReason, REVISION_REASONS, errors);
  requiredString(`${path}.path`, revision.path, errors);
  if (!(revision.oldValue === null || typeof revision.oldValue === "number" || typeof revision.oldValue === "string")) {
    errors.push(`${path}.oldValue: expected number, string or null`);
  }
  if (!(revision.proposedValue === null || typeof revision.proposedValue === "number" || typeof revision.proposedValue === "string")) {
    errors.push(`${path}.proposedValue: expected number, string or null`);
  }
  if (!Array.isArray(revision.evidenceRefs)) errors.push(`${path}.evidenceRefs: expected an array`);
  requiredString(`${path}.explanation`, revision.explanation, errors);
}

export type FinalExecutionIssue = { code: string; path: string; detail: string };

/** Collect every plan-only capability mismatch before compilation. This never
 * repairs a draft or infers economic values; evidence-dependent model gates stay
 * in the compiler and deterministic valuation engine. */
export function validateFinalResearchExecution(plan: ResearchPlan): FinalExecutionIssue[] {
  const c = FINAL_RESEARCH_EXECUTION_CONTRACT;
  const issues: FinalExecutionIssue[] = [];
  const add = (code: string, path: string, detail: string) => issues.push({ code, path, detail });
  if (!Array.isArray(plan.businesses) || !Array.isArray(plan.capitalRequirements) ||
    !Array.isArray(plan.financing) || !Array.isArray(plan.dilution) ||
    !Array.isArray(plan.valuationMethods) || !Array.isArray(plan.scenarios)) return issues;
  const businesses = plan.businesses.filter((business): business is ResearchPlan["businesses"][number] => isObject(business));
  const ids = businesses.map((business) => business.id);
  if (!ids.length || new Set(ids).size !== ids.length) add("BUSINESS_IDS", "businesses", "business ids must be nonempty and unique");
  for (const [bi, business] of businesses.entries()) {
    const path = `businesses[${bi}]`;
    if (!(c.businessMethods as readonly string[]).includes(business.valuationMethod))
      add("BUSINESS_METHOD", `${path}.valuationMethod`, `business method ${String(business.valuationMethod)} has no audited P0 valuation equation`);
    if (Array.isArray(business.costDrivers) && business.costDrivers.length)
      add("COST_DRIVERS", `${path}.costDrivers`, "costDrivers not implemented; final plan requires []");
    if (Array.isArray(business.forecastAssumptions) && business.forecastAssumptions.length)
      add("FORECAST_ASSUMPTIONS", `${path}.forecastAssumptions`, "forecastAssumptions not implemented; final plan requires [] and explicit annual FCF");
    if (Array.isArray(business.forecastYears)) {
      const dcf = (c.dcfMethods as readonly string[]).includes(business.valuationMethod);
      if (dcf && !business.forecastYears.length)
        add("DCF_FORECAST_EMPTY", `${path}.forecastYears`, "DCF requires a complete explicit annual forecastYears.fcfB path");
      business.forecastYears.forEach((row, yi) => {
        if (!isObject(row)) return;
        const rowPath = `${path}.forecastYears[${yi}]`;
        if (Object.hasOwn(row, "capexB")) add("FORECAST_CAPEX", `${rowPath}.capexB`, "capexB lacks an included-in-FCF contract; final plan must omit it");
        if (dcf && !isFiniteNumber(row.fcfB)) add("DCF_FCF", `${rowPath}.fcfB`, "every DCF year requires explicit finite fcfB; unknown is not zero");
        if (dcf && (!Number.isInteger(row.year) || (yi > 0 && (!isObject(business.forecastYears[yi - 1]) ||
          row.year !== business.forecastYears[yi - 1].year + 1))))
          add("DCF_YEARS", `${rowPath}.year`, "DCF requires consecutive annual forecast years");
      });
    }
    if (Array.isArray(business.disclosedData)) business.disclosedData.forEach((row, di) => {
      if (isObject(row) && row.unit !== c.disclosedUnit)
        add("DISCLOSED_UNIT", `${path}.disclosedData[${di}].unit`, `executable disclosedData requires ${c.disclosedUnit}; use audit text for other units`);
    });
    if (Array.isArray(business.growthConstraints)) business.growthConstraints.forEach((constraint, ci) => {
      if (!isObject(constraint)) return;
      const constraintPath = `${path}.growthConstraints[${ci}]`;
      if (!(c.growthConstraintFields as readonly string[]).includes(String(constraint.field))) {
        add("CONSTRAINT_FIELD", `${constraintPath}.field`, "unsupported growth constraint field; use an actual forecast row field");
        return;
      }
      if (!Array.isArray(business.forecastYears) || !business.forecastYears.length)
        add("CONSTRAINT_ROWS", constraintPath, "growth constraint has no forecast rows");
      else business.forecastYears.forEach((row, yi) => {
        const value = isObject(row) ? (row as Record<string, unknown>)[String(constraint.field)] : undefined;
        if (!isFiniteNumber(value) || (isFiniteNumber(constraint.min) && value < constraint.min) ||
          (isFiniteNumber(constraint.max) && value > constraint.max))
          add("CONSTRAINT_VIOLATION", `${path}.forecastYears[${yi}].${String(constraint.field)}`, "forecast violates declared growth constraint");
      });
    });
    if ((c.dcfMethods as readonly string[]).includes(business.valuationMethod) && business.multiple != null)
      add("DCF_MULTIPLE", `${path}.multiple`, "DCF does not consume a business multiple");
  }
  plan.capitalRequirements.forEach((item, index) => {
    if (!isObject(item)) return;
    const path = `capitalRequirements[${index}]`;
    if (!(c.capitalKinds as readonly string[]).includes(String(item.kind)) || item.incremental !== true)
      add("CAPITAL_INCREMENTAL", path, "capital must explicitly be incremental capex/working_capital, not an unknown or already-deducted placeholder");
    if (!isFiniteNumber(item.amountB) || item.amountB < 0 || !Number.isInteger(item.timingYear) || item.timingYear < 1)
      add("CAPITAL_AMOUNT_YEAR", path, "capital requires a valid amount and positive forecast timing year");
    const business = businesses.find((entry) => entry.id === item.businessId);
    if (!business || !(c.dcfMethods as readonly string[]).includes(business.valuationMethod) ||
      !Array.isArray(business.forecastYears) || item.timingYear > business.forecastYears.length)
      add("CAPITAL_CONSUMER", `${path}.businessId`, "capital requires an identified DCF business and an explicit forecast year");
    if (business && isFiniteNumber(item.amountB) && item.amountB > 0 && plan.scenarios.some((scenario) =>
      isObject(scenario) && scenario.appliesTo === "segment" && Array.isArray(scenario.businessIds) &&
      scenario.businessIds.includes(business.id) && scenario.probability !== 1))
      add("CAPITAL_PROBABILITY", path, "incremental capital with segment probability needs an unsupported contingent contract");
  });
  plan.dilution.forEach((item, index) => {
    if (!isObject(item)) return;
    if (item.kind !== c.dilutionKind || !isFiniteNumber(item.sharesB) || item.sharesB < 0)
      add("DILUTION_KIND", `dilution[${index}]`, "only explicit incremental new_shares are supported; SBC/options need an economic contract");
  });
  if (plan.financing.length > 1) add("FINANCING_COUNT", "financing", "at most one current-date equity financing is supported");
  plan.financing.forEach((item, index) => {
    if (!isObject(item)) return;
    const path = `financing[${index}]`;
    if (item.kind !== c.financingKind || item.timingYear !== c.financingTimingYear ||
      (item.costPct ?? 0) !== 0 || !isFiniteNumber(item.amountB) || item.amountB < 0)
      add("FINANCING_KIND", path, "financing requires timingYear=0 equity; debt/hybrid/future schedules are unsupported");
    if (typeof item.evidenceId !== "string" || !item.evidenceId || !plan.dilution.some((shares) =>
      isObject(shares) && shares.kind === c.dilutionKind && shares.evidenceId === item.evidenceId &&
      isFiniteNumber(shares.sharesB) && shares.sharesB > 0))
      add("FINANCING_SHARES", path, "equity financing requires matching evidenced incremental new_shares");
  });
  const companies = plan.scenarios.filter((scenario) => isObject(scenario) && scenario.appliesTo === "company");
  const segments = plan.scenarios.filter((scenario) => isObject(scenario) && scenario.appliesTo === "segment");
  if (!(c.aggregationRules as readonly string[]).includes(plan.aggregationRule))
    add("AGGREGATION", "aggregationRule", "research ensemble and other unsupported aggregation are not executable");
  if (plan.aggregationRule === "sotp" && plan.primaryMethod !== "sotp")
    add("PRIMARY_METHOD", "primaryMethod", "SOTP aggregation requires primaryMethod=sotp");
  if (plan.aggregationRule !== "sotp" && !(c.dcfMethods as readonly string[]).includes(plan.primaryMethod))
    add("PRIMARY_METHOD", "primaryMethod", `company research primary method ${String(plan.primaryMethod)} must be DCF or normalized_dcf`);
  if (plan.aggregationRule !== "sotp" && businesses.length !== 1)
    add("BUSINESS_AGGREGATION", "businesses", "multiple businesses require explicit SOTP aggregation");
  if (plan.aggregationRule !== "sotp" && businesses.some((business) => !(c.dcfMethods as readonly string[]).includes(business.valuationMethod)))
    add("BUSINESS_AGGREGATION", "businesses", "company research business must use an executable DCF method");
  if (companies.length && plan.aggregationRule !== "scenario_weighted")
    add("COMPANY_SCENARIOS", "aggregationRule", "company scenarios require scenario_weighted aggregation");
  if (plan.aggregationRule === "scenario_weighted" && (!companies.length ||
    Math.abs(companies.reduce((sum, scenario) => sum + Number(scenario.probability), 0) - 1) > 1e-8))
    add("SCENARIO_SUM", "scenarios", "exhaustive company scenarios must sum to 1");
  if (plan.aggregationRule !== "sotp" && segments.length)
    add("SEGMENT_SCENARIOS", "scenarios", "segment probabilities require SOTP aggregation");
  const segmentOwners = segments.flatMap((scenario) => Array.isArray(scenario.businessIds) ? scenario.businessIds : []);
  if (new Set(segmentOwners).size !== segmentOwners.length)
    add("PROBABILITY_OWNER", "scenarios", "each segment uncertainty must have one probability owner");
  plan.scenarios.forEach((scenario, index) => {
    if (!isObject(scenario)) return;
    const path = `scenarios[${index}]`;
    if (!isFiniteNumber(scenario.probability) || scenario.probability < 0 || scenario.probability > 1)
      add("SCENARIO_PROBABILITY", `${path}.probability`, "scenario probability must be within 0..1");
    if (Array.isArray(scenario.businessIds) && scenario.businessIds.some((id) => !ids.includes(id)))
      add("SCENARIO_BUSINESS", `${path}.businessIds`, "scenario references an unknown business");
    if (scenario.appliesTo === "segment" && isObject(scenario.economics))
      add("SEGMENT_ECONOMICS", `${path}.economics`, "segment scenario economics are not implemented");
    if (isObject(scenario.economics)) for (const [field, value] of Object.entries(scenario.economics)) {
      if (!(c.scenarioEconomicsFields as readonly string[]).includes(field))
        add("SCENARIO_ECONOMICS", `${path}.economics.${field}`, "scenario economics currently support explicit fcfMultiplier only");
      else if (!isFiniteNumber(value) || value < 0)
        add("SCENARIO_FCF", `${path}.economics.${field}`, "fcfMultiplier must be finite and nonnegative");
    }
  });
  return issues;
}

/** Validates a parsed research payload. Throws ResearchSchemaInvalidError on the first failure set. */
export function validateResearchPayload<T>(kind: ResearchPayloadKind, value: unknown): T {
  const errors: string[] = [];
  if (!isObject(value)) {
    throw new ResearchSchemaInvalidError(["top: expected a JSON object"]);
  }

  // Deep-scan for NaN/Infinity and forbidden price-targeting keys before any
  // field-level validation, so a smuggled key or a non-finite number is caught
  // even inside a free-form map.
  errors.push(...marketFieldPaths(value).map((field) => `${field}: a price-targeting field is forbidden in a research payload`));
  hasNonFinite(value, "top", errors);
  const candidate = kind === "revision" ? value : canonicalizeResearchPlan(value as unknown as ResearchPlan);
  errors.push(...schemaErrors(candidate, kind === "draft" ? researchDraftSchema : kind === "plan" ? researchPlanSchema : researchRevisionSchema));

  if (kind === "revision") {
    if (value.revisions === undefined) errors.push("revisions: missing required field");
    else if (!Array.isArray(value.revisions)) errors.push("revisions: expected an array");
    else value.revisions.forEach((item, index) => validateRevision(`revisions[${index}]`, item, errors));
    for (const key of Object.keys(value)) {
      if (key !== "revisions") errors.push(`top: unknown field "${key}"`);
    }
  } else {
    validatePlanShape(candidate, errors, kind === "draft");
    if (kind === "draft") validateToolRequests(candidate, errors);
    else {
      if ("toolRequests" in candidate) errors.push("top: a finalized plan must not carry toolRequests");
      errors.push(...validateFinalResearchExecution(candidate as unknown as ResearchPlan)
        .map((issue) => `${issue.path}: ${issue.code}: ${issue.detail}`));
    }
  }

  if (errors.length) throw new ResearchSchemaInvalidError(errors);
  return candidate as T;
}
