import { driverSchema, researchDraftSchema, researchPlanSchema } from "./research-plan";
import { projectSchema, toolRequestSchema } from "./research-schema";
// Information firewalls: the planner and the reviewer must never see a price.
//
// 1. sanitizeEvidenceView(pack) — the ONLY source of planner input. It exposes
//    durable operating/research evidence (identity, classification, operating
//    baseline, source provenance, filing metadata) and strips the current quote,
//    the stored fair value, any reference price, analyst consensus/targets and
//    sanity ranges.
// 2. sanitizeChecksForReviewer(checks) — strips any price-bearing field or string
//    from the research checks before they reach the reviewer.
//
// Both are exported with a shared price-token detector so the tests can assert
// that no price-bearing field or string survives.
import { projectResearchFields, type CheckProvenance } from "./research-isolation";
import type { AutomatedValuationPack } from "./valuation-data";
import type { ValuationAssumptions } from "./universal-valuation";

export const PRICE_BEARING_TOKEN =
  /\b(fair\s*value|current\s*price|market\s*price|price\s*target|target\s*price|reference\s*price|consensus|analyst\s*target|sanity\s*range|upside|downside|bear|base|bull|rating|expected\s*return)\b/i;

/** Matches a monetary figure (a price or value), so a redacted string cannot leak one. */
const MONEY_TOKEN = /\$\s?-?\d[\d,.]*(?:\s?(?:billion|B|million|M|×))?/g;

export function isPriceBearing(text: string): boolean {
  return PRICE_BEARING_TOKEN.test(text) || /\$\s?-?\d/.test(text);
}

export function redactPriceText(text: string): string {
  return text
    .replace(MONEY_TOKEN, "[value redacted]")
    .replace(PRICE_BEARING_TOKEN, "[$1 redacted]");
}

export type ResearchEvidenceView = {
  identity: AutomatedValuationPack["identity"];
  classification: {
    companyName: string;
    modelFamily: string;
    businessModel: string;
    valuationDrivers: string[];
    rationale: string;
  };
  /** Raw deriveAssumptions output — the compiler's starting point, free of any legacy mutation. */
  operatingBaseline: ValuationAssumptions;
  inputSources: Record<string, { kind: string; label: string; asOf?: string; url?: string }>;
  latestFilingId: string | null;
  guidanceVersion: string;
  evidenceMissing: string[];
  /** Legacy deterministic baseline, exposed only as a prior, never re-applied after compilation. */
  legacyPrior: { baseline: ValuationAssumptions; note: string } | null;
};

const FORBIDDEN_SOURCE_KEY = /price|quote|reference/i;
const FORBIDDEN_MISSING_NOTE = /consensus|target|price|rating|sanity|quote/i;

export function sanitizeEvidenceView(pack: AutomatedValuationPack): ResearchEvidenceView {
  const classification = pack.profile.classification;
  const inputSources: ResearchEvidenceView["inputSources"] = {};
  for (const [key, source] of Object.entries(pack.profile.inputSources ?? {})) {
    if (FORBIDDEN_SOURCE_KEY.test(key)) continue;
    if (!source || typeof source !== "object") continue;
    const label = typeof source.label === "string" ? source.label : "";
    if (isPriceBearing(label)) continue;
    inputSources[key] = {
      kind: source.kind,
      label,
      asOf: source.asOf,
      url: source.url,
    };
  }
  return {
    identity: pack.identity,
    classification: {
      companyName: classification.companyName,
      modelFamily: classification.modelFamily,
      businessModel: classification.businessModel,
      valuationDrivers: classification.valuationDrivers,
      rationale: classification.rationale,
    },
    operatingBaseline: pack.evidenceAssumptions,
    inputSources,
    latestFilingId: pack.cache.latestFilingId,
    guidanceVersion: pack.cache.guidanceVersion,
    evidenceMissing: (pack.profile.evidenceMissing ?? []).filter((note) => !FORBIDDEN_MISSING_NOTE.test(note)),
    legacyPrior: null,
  };
}

export type ResearchCheckForReview = {
  id: string;
  label: string;
  status: "passed" | "failed" | "warning";
  detail: string;
  evidenceRefs: string[];
};

export type ResearchCheck = ResearchCheckForReview & {
  /** Set by runResearchChecks when a check compares against a price or value. */
  priceBearing?: boolean;
  provenance?: CheckProvenance;
  [key: string]: unknown;
};

export function sanitizeChecksForReviewer(checks: ResearchCheck[]): ResearchCheckForReview[] {
  const result: ResearchCheckForReview[] = [];
  for (const check of checks) {
    if (check.provenance !== "operating" || check.priceBearing) continue;
    if (isPriceBearing(check.id) || isPriceBearing(check.label)) continue;
    const detail = redactPriceText(String(check.detail ?? ""));
    if (detail.trim() === "") continue;
    result.push({
      id: check.id,
      label: check.label,
      status: check.status,
      detail,
      evidenceRefs: Array.isArray(check.evidenceRefs) ? check.evidenceRefs : [],
    });
  }
  return result;
}

/** Apply the same closed schemas inside request envelopes and standalone plans.
 * Server-owned evidence/legacy envelopes retain their existing explicit views. */
function projectStructuredInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(projectStructuredInput);
  if (!value || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  if ("businesses" in node) return projectSchema(node, "toolRequests" in node ? researchDraftSchema : researchPlanSchema);
  if ("formula" in node && "params" in node) return projectSchema(node, driverSchema);
  if ("tool" in node && "args" in node) return projectSchema(node, toolRequestSchema);
  return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, projectStructuredInput(child)]));
}

/** Final boundary for actual AI request data, including tool text and model prose. */
export function sanitizeResearchInput(value: unknown): unknown {
  return projectResearchFields(projectStructuredInput(value), (text) => /fair\s*value|target\s*price|price\s*target|current\s*price|market\s*price|reference\s*price|analyst\s*target|consensus/i.test(text)
    ? "[market comparison omitted]" : text.replace(MONEY_TOKEN, "[monetary text omitted]"));
}
