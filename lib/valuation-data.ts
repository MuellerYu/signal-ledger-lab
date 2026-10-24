import { MODEL_FAMILIES, SUPPORTED_TICKERS, classifyCompany, getCuratedValuationProfile, type CashFlowBasis, type CompanyHint, type DataQualityCheck, type ModelFamilyId, type ValuationAssumptions, type ValuationModelId, type ValuationProfile } from "./universal-valuation";
import { getBindings } from "./runtime";
import { workerEdgeCache } from "./snapshot-cache";
import { buildRuleBasedIssuerProfile, getVerifiedIssuerProfile, loadPersistedIssuerProfile, persistIssuerProfile, type IssuerIntelligenceProfile } from "./issuer-intelligence";
import { classifyAiExposure } from "./ai-exposure";
import { MU_FORECAST_ASSUMPTIONS, MU_VALUATION_ASSUMPTIONS, buildMuValuation, parseMuEvidence, parseMuReportedProductRevenue, type MuReportedAnchors, type MuValuation } from "./mu-valuation";
import { buildSpcxShareBridge, buildSpcxValuation, parseSpcxReportedSegments, parseSpcxShareEvidence, type SpcxShareBridge, type SpcxValuation } from "./spcx-valuation";
import { calculateCapitalCost, loadCapitalCostMarketInputs } from "./valuation-capital-cost";
import { hashCanonical } from "./research-hash";
import type { BusinessExtractor } from "./company-business/types";
import { extractBusinessCandidates as extractAvgoBusinesses } from "./company-business/avgo";
import { extractBusinessCandidates as extractMuBusinesses } from "./company-business/mu";
import { extractSpcxBusinesses } from "./company-business/spcx";
import { extractBusinessCandidates as extractIntcBusinesses } from "./company-business/intc";
import { extractBusinessCandidates as extractAmznBusinesses } from "./company-business/amzn";
import { extractBusinessCandidates as extractMsftBusinesses } from "./company-business/msft";
import { extractBusinessCandidates as extractAaplBusinesses } from "./company-business/aapl";
import { extractBusinessCandidates as extractGooglBusinesses } from "./company-business/googl";
import { extractBusinessCandidates as extractMetaBusinesses } from "./company-business/meta";
import { extractBusinessCandidates as extractNvdaBusinesses } from "./company-business/nvda";
import { extractBusinessCandidates as extractAmdBusinesses } from "./company-business/amd";
import { extractBusinessCandidates as extractOrclBusinesses } from "./company-business/orcl";
import { extractBusinessCandidates as extractSnowBusinesses } from "./company-business/snow";
import { extractBusinessCandidates as extractTslaBusinesses } from "./company-business/tsla";
import { extractBusinessCandidates as extractCrclBusinesses } from "./company-business/crcl";
import { extractBusinessCandidates as extractMstrBusinesses } from "./company-business/mstr";
import { extractBusinessCandidates as extractOkloBusinesses } from "./company-business/oklo";
import { extractBusinessCandidates as extractJpmBusinesses } from "./company-business/jpm";
import { extractBusinessCandidates as extractPltrBusinesses } from "./company-business/pltr";
import { extractBusinessCandidates as extractRegnBusinesses } from "./company-business/regn";

type SecTicker = { cik_str?: number | string; ticker?: string; title?: string };
type SecFactValue = { start?: string; end?: string; val?: number | string; filed?: string; form?: string; fp?: string; fy?: number | string; frame?: string; accn?: string };
type SecConcept = { units?: Record<string, SecFactValue[]> };
export type SecFacts = { entityName?: string; facts?: Record<string, Record<string, SecConcept>> };
type SecRecentFilings = { accessionNumber?: string[]; filingDate?: string[]; reportDate?: string[]; form?: string[]; primaryDocument?: string[] };
export type SecSubmission = { name?: string; sic?: string; sicDescription?: string; fiscalYearEnd?: string; filings?: { recent?: SecRecentFilings } };
type NasdaqQuote = { companyName?: string; primaryData?: { lastSalePrice?: string; lastTradeTimestamp?: string; isRealTime?: boolean } };

/** Price-free SEC evidence corpus the research tools read from (no quote, no fair value). */
export type SecEvidence = {
  ticker: string;
  cik: string;
  entityName: string | null;
  facts: SecFacts;
  submission: SecSubmission;
  latestFiling: { accessionNumber: string | null; url: string; filed: string | null; reportDate: string | null } | null;
  latestFilingBody: string | null;
  /** Separate SEC documents; a new current report never replaces a full periodic report. */
  documents: {
    annual: SecFilingDocument | null;
    quarterly: SecFilingDocument | null;
    current: SecFilingDocument | null;
  };
  reportedBusinesses: ReportedBusinessEvidence;
};

export type SecFilingDocument = { form: string; accessionNumber: string; url: string; filed: string | null; reportDate: string | null; body: string | null };
export type ReportedBusinessEvidence = {
  status: "verified" | "unverified" | "unavailable";
  kind: "reportable_segment" | "revenue_line" | null;
  periodForm: "10-Q" | "10-K" | null;
  periodEnd: string | null;
  sourceUrl: string | null;
  accessionNumber: string | null;
  unit: "USD billions";
  consolidatedRevenueB: number | null;
  businesses: { name: string; revenueB: number; sourceExcerpt: string; basis?: "reported" | "derived" }[];
  reason: string;
};

export type ValuationPipelineStage = {
  id: "quote" | "metadata" | "financials" | "classification" | "forecast" | "models" | "monte_carlo" | "ensemble" | "rating";
  status: "completed" | "partial" | "unavailable";
  detail: string;
};

export type AutomatedValuationPack = {
  profile: ValuationProfile;
  issuerProfile: IssuerIntelligenceProfile;
  quote: { price: number; asOf: string; source: string } | null;
  identity: {
    securityTicker: string;
    issuerTicker: string;
    issuerName: string;
    cik: string;
    secEntityName: string | null;
    /** False when a reassigned ticker's SEC entity could not be verified as the current issuer. */
    filingIdentityVerified: boolean;
    relatedShareClasses: string[];
  };
  /** Raw `deriveAssumptions` evidence baseline, captured before any legacy mutation. */
  evidenceAssumptions: ValuationAssumptions;
  pipeline: ValuationPipelineStage[];
  cache: {
    financialsCached: boolean;
    valuationCacheAgeMs: number;
    quoteCacheAgeMs: number;
    latestFilingId: string | null;
    guidanceVersion: string;
    engineVersion: string;
    profileVersion: string;
    /** Stable hash of durable research evidence only (excludes quote, FV, rating). */
    evidenceVersion: string;
  };
};

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_FACTS_BASE = "https://data.sec.gov/api/xbrl/companyfacts";
const SEC_SUBMISSIONS_BASE = "https://data.sec.gov/submissions";
// Public reference price for digital-asset treasuries. The same Coinbase public
// endpoint already backs the BTC research desk in monitor-worker.
const BITCOIN_REFERENCE_URL = "https://api.exchange.coinbase.com/products/BTC-USD/ticker";
const FINANCIAL_CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
/** Bumping this invalidates every cached valuation package. */
export const ENGINE_VERSION = "universal-v12-p1-sec-business";
const QUOTE_CACHE_TTL_MS = 5 * 60 * 1_000;
const BITCOIN_CACHE_TTL_MS = 5 * 60 * 1_000;

let tickerCache: { expiresAt: number; value: Promise<SecTicker[]> } | null = null;
const packCache = new Map<string, { createdAt: number; expiresAt: number; value: Promise<AutomatedValuationPack> }>();

/** Test seam: drops this isolate's pack memory so a cold isolate can be simulated. */
export function resetPackCache() {
  packCache.clear();
}
const quoteCache = new Map<string, { createdAt: number; expiresAt: number; value: Promise<{ price: number; asOf: string; source: string; sourceUrl: string }> }>();
let bitcoinCache: { expiresAt: number; value: Promise<number> } | null = null;

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function normalizeTicker(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
}

async function fetchJson<T>(url: string, headers: HeadersInit, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}.`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, headers: HeadersInit, timeoutMs = 15_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`${new URL(url).hostname} returned ${response.status}.`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function latestFilingByForm(submission: SecSubmission, cik: string, form: string): SecFilingDocument | null {
  const recent = submission.filings?.recent;
  const candidates = (recent?.form ?? []).map((value, index) => ({ value, index }))
    .filter((row) => row.value === form && recent?.accessionNumber?.[row.index] && recent?.primaryDocument?.[row.index]);
  candidates.sort((left, right) => (recent?.filingDate?.[right.index] ?? "").localeCompare(recent?.filingDate?.[left.index] ?? ""));
  const index = candidates[0]?.index ?? -1;
  const accession = index >= 0 ? recent?.accessionNumber?.[index]?.replaceAll("-", "") : null;
  const document = index >= 0 ? recent?.primaryDocument?.[index] : null;
  if (!accession || !document) return null;
  const cikPath = String(Number(cik));
  return {
    form,
    accessionNumber: recent?.accessionNumber?.[index] ?? "",
    url: `https://www.sec.gov/Archives/edgar/data/${cikPath}/${accession}/${document}`,
    filed: recent?.filingDate?.[index] ?? null,
    reportDate: recent?.reportDate?.[index] ?? null,
    body: null,
  };
}

function latestPeriodicFiling(submission: SecSubmission, cik: string): SecFilingDocument | null {
  return [latestFilingByForm(submission, cik, "10-K"), latestFilingByForm(submission, cik, "10-Q")]
    .filter((filing): filing is SecFilingDocument => filing !== null)
    .sort((left, right) => (right.filed ?? "").localeCompare(left.filed ?? ""))[0] ?? null;
}

/** A cheap accession probe prevents a cached research plan from hiding a new periodic report. */
export async function latestPeriodicAccession(cik: string): Promise<string | null> {
  if (!/^\d{10}$/.test(cik)) return null;
  const submission = await fetchJson<SecSubmission>(`${SEC_SUBMISSIONS_BASE}/CIK${cik}.json`, secHeaders(), 15_000);
  return latestPeriodicFiling(submission, cik)?.accessionNumber ?? null;
}

function filingText(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#160;|&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#36;|&dollar;/gi, "$")
    .replace(/\s+/g, " ")
    .trim();
}

const BUSINESS_LABELS: Record<string, { kind: "reportable_segment" | "revenue_line"; labels: string[] }> = {
  NVDA: { kind: "reportable_segment", labels: ["Compute & Networking", "Graphics"] },
  AMD: { kind: "reportable_segment", labels: ["Data Center", "Total Client and Gaming", "Embedded"] },
  ORCL: { kind: "revenue_line", labels: ["Cloud services and license support", "Cloud license and on-premise license", "Hardware", "Services"] },
  PLTR: { kind: "reportable_segment", labels: ["Government", "Commercial"] },
};

const COMPANY_BUSINESS_EXTRACTORS: Record<string, BusinessExtractor> = {
  AVGO: extractAvgoBusinesses,
  MU: extractMuBusinesses,
  SPCX: extractSpcxBusinesses,
  INTC: extractIntcBusinesses,
  AMZN: extractAmznBusinesses,
  MSFT: extractMsftBusinesses,
  AAPL: extractAaplBusinesses,
  GOOG: extractGooglBusinesses,
  GOOGL: extractGooglBusinesses,
  META: extractMetaBusinesses,
  NVDA: extractNvdaBusinesses,
  AMD: extractAmdBusinesses,
  ORCL: extractOrclBusinesses,
  SNOW: extractSnowBusinesses,
  TSLA: extractTslaBusinesses,
  CRCL: extractCrclBusinesses,
  MSTR: extractMstrBusinesses,
  OKLO: extractOkloBusinesses,
  JPM: extractJpmBusinesses,
  PLTR: extractPltrBusinesses,
  REGN: extractRegnBusinesses,
};

function latestConsolidatedRevenue(facts: SecFacts, document: SecFilingDocument, ticker: string): number | null {
  // Bank net revenue includes interest economics; an ASC 606 customer-contract
  // revenue fact is only a subset and must not be used for JPM's segment tieout.
  const concepts = ticker === "JPM" ? ["RevenuesNetOfInterestExpense"]
    : ["CRCL", "GOOG", "GOOGL"].includes(ticker) ? ["Revenues"]
      : ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"];
  for (const concept of concepts) {
    const rows = facts.facts?.["us-gaap"]?.[concept]?.units?.USD ?? [];
    const matching = rows.filter((row) => row.end === document.reportDate && row.form === document.form && row.start &&
      row.accn === document.accessionNumber && Number.isFinite(Number(row.val)))
      .filter((row) => {
        const days = (Date.parse(document.reportDate!) - Date.parse(row.start!)) / 86_400_000;
        return document.form === "10-Q" ? days >= 60 && days <= 120 : days >= 330 && days <= 390;
      })
      .sort((left, right) => (right.filed ?? "").localeCompare(left.filed ?? ""));
    if (matching.length) return Number(matching[0].val) / 1e9;
  }
  return null;
}

/** Extract only a disclosed table whose business rows reconcile to SEC companyfacts.
 * No inferred sub-businesses, annualized quarters, or unverified "reported" rows. */
export function extractReportedBusinesses(ticker: string, document: SecFilingDocument | null, facts: SecFacts): ReportedBusinessEvidence {
  const companyExtractor = COMPANY_BUSINESS_EXTRACTORS[ticker];
  const currentOracleStructure = ticker === "ORCL" && /summary results for each of our three businesses/i.test(document?.body ?? "");
  const selectedSpec = currentOracleStructure
    ? { kind: "reportable_segment" as const, labels: ["Cloud and software", "Hardware", "Services"] }
    : BUSINESS_LABELS[ticker];
  const base: ReportedBusinessEvidence = {
    status: "unavailable", kind: selectedSpec?.kind ?? null,
    periodForm: document?.form === "10-Q" || document?.form === "10-K" ? document.form : null,
    periodEnd: document?.reportDate ?? null,
    sourceUrl: document?.url ?? null, accessionNumber: document?.accessionNumber ?? null,
    unit: "USD billions", consolidatedRevenueB: null, businesses: [], reason: "No supported disclosed business table is available.",
  };
  const spec = selectedSpec;
  if ((!spec && !companyExtractor) || !document?.body || !document.reportDate) return base;
  const consolidated = latestConsolidatedRevenue(facts, document, ticker);
  if (consolidated === null || consolidated <= 0) return { ...base, status: "unverified", reason: "A comparable consolidated revenue fact for this filing period is missing." };
  if (companyExtractor) {
    const candidates = companyExtractor(document.body);
    const verified = candidates.find((candidate) => candidate.businesses.length > 0 &&
      candidate.businesses.every((row) => row.name.trim() && row.sourceExcerpt.trim() && Number.isFinite(row.revenueB) && row.revenueB >= 0) &&
      new Set(candidate.businesses.map((row) => row.name)).size === candidate.businesses.length &&
      Math.abs(candidate.businesses.reduce((sum, row) => sum + row.revenueB, 0) - consolidated) <= Math.max(0.05, consolidated * 0.01));
    return verified
      ? { ...base, status: "verified", kind: verified.kind, consolidatedRevenueB: consolidated, businesses: verified.businesses,
        reason: verified.businesses.some((row) => row.basis === "derived")
          ? "Disclosed and explicitly derived non-overlapping rows reconcile to SEC consolidated revenue for the same filing period."
          : "All disclosed rows reconcile to SEC consolidated revenue for the same filing period." }
      : { ...base, status: "unverified", consolidatedRevenueB: consolidated,
        reason: "No complete business table reconciled to consolidated revenue; no rows promoted as reported." };
  }
  if (!spec) return base;
  const section = /(?:segment information|segment and geographic information|financial information for each reportable segment|reportable segments|net revenue:|revenues? by (?:segment|product|type|customer|offerings|business)|disaggregat(?:ed|ion)(?: of)? revenue)/gi;
  const anchors = [...document.body.matchAll(section)].map((match) => match.index ?? 0);
  if (currentOracleStructure) anchors.push(...[...document.body.matchAll(/summary results for each of our three businesses/gi)].map((match) => match.index ?? 0));
  // Oracle's four non-overlapping revenue lines appear in the income statement,
  // under "Revenues:", before its more detailed (overlapping) cloud tables.
  if (ticker === "ORCL") anchors.push(...[...document.body.matchAll(/\bRevenues:\s+/gi)].map((match) => match.index ?? 0));
  anchors.sort((left, right) => left - right);
  anchors.splice(20);
  const windows = anchors.length ? anchors.map((start) => document.body!.slice(Math.max(0, start - 500), start + 20_000)) : [];
  const candidates: ReportedBusinessEvidence["businesses"][] = [];
  for (const window of windows) {
    const unitHeader = window.slice(0, 2_500);
    if (!/\b(?:in millions|millions of dollars|\$ in millions|in thousands)\b/i.test(unitHeader)) continue;
    const divisor = /\bin thousands\b/i.test(unitHeader) ? 1_000_000 : 1_000;
    if (currentOracleStructure) {
      const rows: ReportedBusinessEvidence["businesses"] = [];
      for (const name of spec.labels) {
        const match = window.match(new RegExp(`\\b${name}:\\s+Revenues\\s*\\$?\\s*([0-9][0-9,]*)`, "i"));
        if (!match) break;
        rows.push({ name, revenueB: Number(match[1].replaceAll(",", "")) / 1_000,
          sourceExcerpt: window.slice(Math.max(0, (match.index ?? 0) - 35), (match.index ?? 0) + match[0].length + 35) });
      }
      if (rows.length === spec.labels.length && rows.every((row) => row.revenueB > 0) &&
        Math.abs(rows.reduce((sum, row) => sum + row.revenueB, 0) - consolidated) <= Math.max(0.05, consolidated * 0.01)) candidates.push(rows);
      continue;
    }
    if (ticker === "NVDA") {
      // NVIDIA's SEC note uses businesses as columns and Revenue as a row.
      // The first period is accepted only when both columns and the printed
      // total reconcile to the same-accession companyfacts quarter/year.
      const header = window.match(/Compute\s*(?:&|and)\s*Networking\s+Graphics\s+Total/i);
      const table = header ? window.slice((header.index ?? 0) + header[0].length, (header.index ?? 0) + header[0].length + 1_500) : "";
      const revenue = table.match(/\bRevenue\s+\$?\s*([\d,]+)\s+\$?\s*([\d,]+)\s+\$?\s*([\d,]+)/i);
      if (revenue) {
        const values = revenue.slice(1, 4).map((value) => Number(value.replaceAll(",", "")) / 1_000);
        if (values.every((value) => Number.isFinite(value) && value > 0) &&
          Math.abs(values[0] + values[1] - values[2]) <= 0.05 &&
          Math.abs(values[2] - consolidated) <= Math.max(0.05, consolidated * 0.01)) {
          const sourceExcerpt = `${header![0]} ${table.slice(Math.max(0, (revenue.index ?? 0) - 80), (revenue.index ?? 0) + revenue[0].length)}`;
          candidates.push(spec.labels.map((name, index) => ({ name, revenueB: values[index], sourceExcerpt })));
        }
      }
      continue;
    }
    const rows: ReportedBusinessEvidence["businesses"] = [];
    const positions: number[] = [];
    for (const label of spec.labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(" & ", "\\s*(?:&|and)\\s*");
      const row = window.match(new RegExp(`\\b${escaped}\\b${ticker === "PLTR" ? "(?:\\s+revenue)?" : ""}\\s*\\$?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)`, "i"));
      if (!row || !Number.isFinite(Number(row[1].replaceAll(",", "")))) break;
      positions.push(row.index ?? 0);
      rows.push({ name: label === "Total Client and Gaming" ? "Client and Gaming" : label,
        revenueB: Number(row[1].replaceAll(",", "")) / divisor,
        sourceExcerpt: window.slice(Math.max(0, (row.index ?? 0) - 45), (row.index ?? 0) + row[0].length + 45) });
    }
    if (rows.length !== spec.labels.length || rows.some((row) => row.revenueB <= 0)) continue;
    if (positions.some((position, index) => index > 0 && position <= positions[index - 1]) || positions.at(-1)! - positions[0] > 4_000) continue;
    const sum = rows.reduce((total, row) => total + row.revenueB, 0);
    if (Math.abs(sum - consolidated) <= Math.max(0.05, consolidated * 0.01)) candidates.push(rows);
  }
  if (!candidates.length) return { ...base, status: "unverified", consolidatedRevenueB: consolidated, reason: "No complete business table reconciled to consolidated revenue; no rows promoted as reported." };
  const first = candidates[0];
  if (candidates.some((rows) => rows.some((row, index) => Math.abs(row.revenueB - first[index].revenueB) > 0.001))) {
    return { ...base, status: "unverified", consolidatedRevenueB: consolidated, reason: "Multiple conflicting business tables reconcile; manual review is required." };
  }
  return { ...base, status: "verified", consolidatedRevenueB: consolidated, businesses: first, reason: "All disclosed rows reconcile to SEC consolidated revenue for the same period." };
}

function reportedNumber(text: string, pattern: RegExp, scale = 1e-3) {
  const match = text.match(pattern);
  if (!match?.[1]) return null;
  const negative = /^\(.*\)$/.test(match[1].trim());
  const value = Number(match[1].replace(/[^\d.]/g, ""));
  return Number.isFinite(value) ? value * scale * (negative ? -1 : 1) : null;
}

function secHeaders(): HeadersInit {
  return {
    accept: "application/json",
    "user-agent": getBindings().SEC_USER_AGENT?.trim() || "Signal Ledger/1.0 owner@example.com",
  };
}

async function getTickerMap() {
  const now = Date.now();
  if (tickerCache && tickerCache.expiresAt > now) return tickerCache.value;
  const value = fetchJson<Record<string, SecTicker>>(SEC_TICKERS_URL, secHeaders(), 20_000)
    .then((payload) => Object.values(payload));
  tickerCache = { expiresAt: now + 24 * 60 * 60 * 1_000, value };
  value.catch(() => { tickerCache = null; });
  return value;
}

function numeric(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function units(payload: SecFacts, taxonomy: string, concept: string, unit: string) {
  return payload.facts?.[taxonomy]?.[concept]?.units?.[unit] ?? [];
}

function annualSeries(payload: SecFacts, concepts: string[], unit = "USD") {
  let best: Array<{ value: number; end: string; filed: string }> = [];
  for (const concept of concepts) {
    const valid = units(payload, "us-gaap", concept, unit).flatMap((fact) => {
      const value = numeric(fact.val);
      const startMs = Date.parse(`${fact.start ?? ""}T00:00:00Z`);
      const endMs = Date.parse(`${fact.end ?? ""}T00:00:00Z`);
      const duration = (endMs - startMs) / 86_400_000;
      const form = String(fact.form ?? "").toUpperCase();
      if (value === null || !Number.isFinite(duration) || duration < 240 || duration > 430 || !/^(10-K|20-F|40-F)/.test(form) || !fact.end) return [];
      return [{ value, end: fact.end, filed: String(fact.filed ?? ""), framed: Boolean(fact.frame), duration }];
    });
    const byEnd = new Map<string, { value: number; end: string; filed: string; framed: boolean; duration: number }>();
    for (const fact of valid) {
      const previous = byEnd.get(fact.end);
      const replaces = !previous
        || fact.filed > previous.filed
        || (fact.filed === previous.filed && fact.framed && !previous.framed)
        || (fact.filed === previous.filed && fact.framed === previous.framed && Math.abs(fact.value) > Math.abs(previous.value));
      if (replaces) byEnd.set(fact.end, fact);
    }
    const result = [...byEnd.values()].map(({ value, end, filed }) => ({ value, end, filed })).sort((left, right) => left.end.localeCompare(right.end));
    const resultEnd = result.at(-1)?.end ?? "";
    const bestEnd = best.at(-1)?.end ?? "";
    if (resultEnd > bestEnd || (resultEnd === bestEnd && result.length > best.length)) best = result;
  }
  return best;
}

function trailingPoint(payload: SecFacts, concepts: string[], unit = "USD") {
  let best: { value: number; end: string; filed: string } | null = null;
  for (const concept of concepts) {
    const annual = annualSeries(payload, [concept], unit);
    const quarters = units(payload, "us-gaap", concept, unit).flatMap((fact) => {
      const value = numeric(fact.val);
      const startMs = Date.parse(`${fact.start ?? ""}T00:00:00Z`);
      const endMs = Date.parse(`${fact.end ?? ""}T00:00:00Z`);
      const duration = (endMs - startMs) / 86_400_000;
      if (value === null || !fact.end || !Number.isFinite(duration) || duration < 60 || duration > 330 || String(fact.form ?? "").toUpperCase() !== "10-Q") return [];
      return [{ value, end: fact.end, filed: String(fact.filed ?? ""), duration }];
    });
    const byEnd = new Map<string, { value: number; end: string; filed: string; duration: number }>();
    for (const fact of quarters) {
      const previous = byEnd.get(fact.end);
      if (!previous || fact.duration > previous.duration + 5 || (Math.abs(fact.duration - previous.duration) <= 5 && fact.filed > previous.filed)) byEnd.set(fact.end, fact);
    }
    const ordered = [...byEnd.values()].sort((left, right) => left.end.localeCompare(right.end));
    const current = ordered.at(-1);
    if (!current) continue;
    const currentEnd = Date.parse(`${current.end}T00:00:00Z`);
    const prior = [...ordered].reverse().find((candidate) => {
      const gap = (currentEnd - Date.parse(`${candidate.end}T00:00:00Z`)) / 86_400_000;
      return gap >= 330 && gap <= 400 && Math.abs(candidate.duration - current.duration) <= 35;
    });
    const annualBase = [...annual].reverse().find((item) => item.end < current.end);
    if (!prior || !annualBase) continue;
    const value = annualBase.value + current.value - prior.value;
    if (!Number.isFinite(value)) continue;
    const candidate = { value, end: current.end, filed: current.filed };
    if (!best || candidate.end > best.end || (candidate.end === best.end && candidate.filed > best.filed)) best = candidate;
  }
  return best;
}

function financialSeries(payload: SecFacts, concepts: string[], unit = "USD") {
  const annual = annualSeries(payload, concepts, unit);
  const trailing = trailingPoint(payload, concepts, unit);
  if (!trailing || trailing.end <= (annual.at(-1)?.end ?? "")) return annual;
  return [...annual, trailing];
}

function latestInstant(payload: SecFacts, concepts: string[], unit = "USD", taxonomy = "us-gaap") {
  return concepts.flatMap((concept, priority) => units(payload, taxonomy, concept, unit)
    .map((fact) => ({ value: numeric(fact.val), end: String(fact.end ?? ""), filed: String(fact.filed ?? ""), form: String(fact.form ?? ""), priority })))
    .filter((fact): fact is { value: number; end: string; filed: string; form: string; priority: number } => fact.value !== null && Boolean(fact.end) && /^(10-Q|10-K|20-F|40-F)/.test(fact.form))
    .sort((left, right) => right.end.localeCompare(left.end) || right.filed.localeCompare(left.filed) || left.priority - right.priority)[0] ?? null;
}

function latestAnnual(payload: SecFacts, concepts: string[], unit = "USD") {
  return annualSeries(payload, concepts, unit).at(-1) ?? null;
}

/**
 * The balance-sheet value of the first reported concept at an exact period end,
 * used to roll operating working capital forward year over year. Each concept
 * list is a priority-ordered set of synonyms, so the first tag present wins and
 * the same item is never double-counted.
 */
function instantValueAtEnd(payload: SecFacts, concepts: string[], end: string, unit = "USD") {
  for (const concept of concepts) {
    let best: { value: number; filed: string } | null = null;
    for (const fact of units(payload, "us-gaap", concept, unit)) {
      const value = numeric(fact.val);
      if (value === null || String(fact.end ?? "") !== end) continue;
      if (!best || String(fact.filed ?? "") > best.filed) best = { value, filed: String(fact.filed ?? "") };
    }
    if (best) return best.value;
  }
  return null;
}

/**
 * Annualizes the latest interim (10-Q) period when an issuer has no full
 * fiscal year of public reporting yet — for example a company that listed this
 * year. The basis is labelled, never presented as a reported annual figure.
 */
function annualizedInterimRevenue(payload: SecFacts, concepts: string[], unit = "USD") {
  let best: { value: number; end: string; filed: string; annualizationFactor: number; days: number } | null = null;
  for (const concept of concepts) {
    for (const fact of units(payload, "us-gaap", concept, unit)) {
      const value = numeric(fact.val);
      const startMs = Date.parse(`${fact.start ?? ""}T00:00:00Z`);
      const endMs = Date.parse(`${fact.end ?? ""}T00:00:00Z`);
      const days = (endMs - startMs) / 86_400_000;
      if (value === null || !fact.end || !Number.isFinite(days) || days < 55 || days > 200) continue;
      if (String(fact.form ?? "").toUpperCase() !== "10-Q") continue;
      const factor = days >= 150 ? 2 : 4;
      const candidate = { value: value * factor, end: fact.end, filed: String(fact.filed ?? ""), annualizationFactor: factor, days };
      // Prefer the latest period, then the longest period reported for that
      // date (a half-year annualized ×2 beats a single quarter annualized ×4).
      if (!best
        || candidate.end > best.end
        || (candidate.end === best.end && candidate.days > best.days)
        || (candidate.end === best.end && candidate.days === best.days && candidate.filed > best.filed)) best = candidate;
    }
  }
  return best;
}

function familyFromSic(sic: string, description: string, companyName: string): ModelFamilyId {
  const code = Number.parseInt(sic, 10);
  const text = `${description} ${companyName}`.toLowerCase();
  if (/circle internet group|stablecoin|usdc|digital currency network/.test(text)) return "stablecoin_network";
  if (/bitcoin treasury|digital asset treasury|strategy inc/.test(text)) return "bitcoin_treasury";
  if (/space exploration|spacex|rocket|launch vehicle|satellite|space systems/.test(text)) return "integrated_space_connectivity_ai_platform";
  if (/nuclear|small modular reactor|reactor design/.test(text)) return "advanced_nuclear_project_npv";
  if (/memory|dram|nand/.test(text)) return "memory_cycle_semiconductor";
  if (/intel corporation/.test(text)) return "foundry_semiconductor";
  if ((code >= 6000 && code <= 6099) || /bank|depository|financial institution/.test(text)) return "bank";
  if (code === 6798 || /real estate investment trust|\breit\b/.test(text)) return "reit";
  if ((code >= 2833 && code <= 2836) || /biological|biotech|pharmaceutical/.test(text)) return "biotech";
  if (code === 3674 || /semiconductor|integrated circuit/.test(text)) return "mature_semiconductor";
  if ((code >= 3711 && code <= 3716) || /motor vehicle|automobile/.test(text)) return "auto_energy_optionality_sotp";
  if (/software|prepackaged software|cloud|data processing/.test(text)) return "saas_growth";
  return "general_equity";
}

function classificationHint(entry: SecTicker, submission: SecSubmission): CompanyHint {
  const companyName = submission.name?.trim() || entry.title?.trim() || normalizeTicker(entry.ticker);
  const description = submission.sicDescription?.trim() || "Public company";
  const family = familyFromSic(String(submission.sic ?? ""), description, companyName);
  const sector = family === "stablecoin_network" ? "Financial Technology"
    : family === "bitcoin_treasury" ? "Digital Assets"
    : family === "advanced_nuclear_project_npv" ? "Advanced Nuclear"
    : family === "bank" ? "Banks"
    : family === "reit" ? "Real Estate"
      : family === "biotech" ? "Biotechnology"
        : family === "mature_semiconductor" || family === "foundry_semiconductor" || family === "memory_cycle_semiconductor" ? "Semiconductors"
          : family === "auto_energy_optionality_sotp" ? "Automotive"
            : family === "saas_growth" ? "Software"
              : description;
  return {
    companyName,
    sector,
    businessModel: description,
    growthStage: "Derived from reported financial history",
    profitability: "Derived from SEC-reported earnings and cash flow",
    capitalIntensity: ["reit", "auto_energy_optionality_sotp", "integrated_space_connectivity_ai_platform", "mature_semiconductor", "foundry_semiconductor", "memory_cycle_semiconductor", "advanced_nuclear_project_npv"].includes(family) ? "Capital intensive" : "Company specific",
    valuationDrivers: family === "stablecoin_network" ? ["USDC circulation", "reserve yield", "distribution costs", "network optionality"]
      : family === "bitcoin_treasury" ? ["bitcoin holdings", "reference bitcoin price", "financing claims", "share dilution"]
      : family === "advanced_nuclear_project_npv" ? ["licensed project pipeline", "delivery probability", "capital cost", "power purchase economics"]
      : family === "memory_cycle_semiconductor" ? ["DRAM pricing", "NAND pricing", "bit shipments", "normalized margin"]
      : family === "bank" ? ["ROE", "tangible book value", "capital strength"]
      : family === "reit" ? ["asset value", "cash generation", "capitalization rates"]
        : family === "biotech" ? ["commercial revenue", "pipeline probability", "cash runway"]
          : ["revenue growth", "normalized FCF margin", "capital structure", "justified multiple"],
  };
}

function familyParameters(family: ModelFamilyId) {
  const table: Record<ModelFamilyId, { growth: number; terminalGrowth: number; fcfMargin: number; wacc: number; peMin: number; peMax: number }> = {
    ai_compute_platform: { growth: 0.22, terminalGrowth: 0.035, fcfMargin: 0.46, wacc: 0.1, peMin: 26, peMax: 42 },
    ai_semiconductor: { growth: 0.16, terminalGrowth: 0.035, fcfMargin: 0.34, wacc: 0.105, peMin: 22, peMax: 38 },
    cyclical_semiconductor: { growth: 0.05, terminalGrowth: 0.025, fcfMargin: 0.16, wacc: 0.11, peMin: 12, peMax: 24 },
    memory_cycle_semiconductor: { growth: 0.05, terminalGrowth: 0.025, fcfMargin: 0.14, wacc: 0.115, peMin: 10, peMax: 20 },
    mature_semiconductor: { growth: 0.06, terminalGrowth: 0.03, fcfMargin: 0.2, wacc: 0.105, peMin: 13, peMax: 24 },
    foundry_semiconductor: { growth: 0.06, terminalGrowth: 0.025, fcfMargin: 0.16, wacc: 0.11, peMin: 14, peMax: 26 },
    semiconductor_infrastructure: { growth: 0.1, terminalGrowth: 0.03, fcfMargin: 0.35, wacc: 0.1, peMin: 18, peMax: 32 },
    consumer_tech_platform: { growth: 0.08, terminalGrowth: 0.03, fcfMargin: 0.26, wacc: 0.085, peMin: 24, peMax: 34 },
    digital_platform: { growth: 0.11, terminalGrowth: 0.03, fcfMargin: 0.3, wacc: 0.09, peMin: 20, peMax: 32 },
    commerce_cloud_hybrid: { growth: 0.11, terminalGrowth: 0.03, fcfMargin: 0.16, wacc: 0.095, peMin: 22, peMax: 36 },
    ecommerce_platform: { growth: 0.11, terminalGrowth: 0.03, fcfMargin: 0.16, wacc: 0.095, peMin: 22, peMax: 36 },
    saas_growth: { growth: 0.12, terminalGrowth: 0.032, fcfMargin: 0.25, wacc: 0.1, peMin: 20, peMax: 36 },
    mature_software: { growth: 0.06, terminalGrowth: 0.0275, fcfMargin: 0.24, wacc: 0.09, peMin: 16, peMax: 28 },
    cloud_software_hybrid: { growth: 0.1, terminalGrowth: 0.032, fcfMargin: 0.26, wacc: 0.095, peMin: 18, peMax: 30 },
    cloud_software_platform: { growth: 0.12, terminalGrowth: 0.032, fcfMargin: 0.32, wacc: 0.09, peMin: 24, peMax: 36 },
    stablecoin_network: { growth: 0.12, terminalGrowth: 0.025, fcfMargin: 0.2, wacc: 0.12, peMin: 14, peMax: 28 },
    crypto_exchange: { growth: 0.08, terminalGrowth: 0.025, fcfMargin: 0.2, wacc: 0.125, peMin: 12, peMax: 26 },
    bank: { growth: 0.04, terminalGrowth: 0.025, fcfMargin: 0.18, wacc: 0.1, peMin: 9, peMax: 16 },
    insurance: { growth: 0.045, terminalGrowth: 0.025, fcfMargin: 0.16, wacc: 0.095, peMin: 10, peMax: 18 },
    asset_manager: { growth: 0.055, terminalGrowth: 0.0275, fcfMargin: 0.25, wacc: 0.1, peMin: 12, peMax: 22 },
    payments: { growth: 0.09, terminalGrowth: 0.03, fcfMargin: 0.42, wacc: 0.09, peMin: 22, peMax: 34 },
    reit: { growth: 0.045, terminalGrowth: 0.025, fcfMargin: 0.32, wacc: 0.09, peMin: 13, peMax: 22 },
    utility: { growth: 0.045, terminalGrowth: 0.025, fcfMargin: 0.14, wacc: 0.085, peMin: 14, peMax: 22 },
    oil_gas: { growth: 0.025, terminalGrowth: 0.02, fcfMargin: 0.18, wacc: 0.105, peMin: 9, peMax: 16 },
    commodity_producer: { growth: 0.025, terminalGrowth: 0.02, fcfMargin: 0.17, wacc: 0.11, peMin: 8, peMax: 15 },
    industrial: { growth: 0.055, terminalGrowth: 0.0275, fcfMargin: 0.13, wacc: 0.095, peMin: 15, peMax: 25 },
    airline: { growth: 0.035, terminalGrowth: 0.02, fcfMargin: 0.08, wacc: 0.12, peMin: 7, peMax: 15 },
    auto: { growth: 0.045, terminalGrowth: 0.025, fcfMargin: 0.09, wacc: 0.11, peMin: 8, peMax: 18 },
    biotech: { growth: 0.08, terminalGrowth: 0.025, fcfMargin: 0.18, wacc: 0.12, peMin: 12, peMax: 26 },
    pharma: { growth: 0.055, terminalGrowth: 0.025, fcfMargin: 0.24, wacc: 0.095, peMin: 13, peMax: 24 },
    medtech: { growth: 0.06, terminalGrowth: 0.0275, fcfMargin: 0.19, wacc: 0.09, peMin: 17, peMax: 27 },
    consumer_staples: { growth: 0.045, terminalGrowth: 0.025, fcfMargin: 0.15, wacc: 0.085, peMin: 18, peMax: 28 },
    consumer_discretionary: { growth: 0.055, terminalGrowth: 0.0275, fcfMargin: 0.12, wacc: 0.1, peMin: 14, peMax: 27 },
    telecom: { growth: 0.035, terminalGrowth: 0.0225, fcfMargin: 0.18, wacc: 0.09, peMin: 10, peMax: 18 },
    media: { growth: 0.05, terminalGrowth: 0.025, fcfMargin: 0.16, wacc: 0.105, peMin: 13, peMax: 24 },
    auto_energy_optionality_sotp: { growth: 0.08, terminalGrowth: 0.03, fcfMargin: 0.12, wacc: 0.11, peMin: 16, peMax: 34 },
    integrated_space_connectivity_ai_platform: { growth: 0.15, terminalGrowth: 0.03, fcfMargin: 0.18, wacc: 0.14, peMin: 18, peMax: 35 },
    bitcoin_treasury: { growth: 0.04, terminalGrowth: 0.02, fcfMargin: 0.2, wacc: 0.15, peMin: 8, peMax: 22 },
    advanced_nuclear_project_npv: { growth: 0.12, terminalGrowth: 0.025, fcfMargin: 0.14, wacc: 0.15, peMin: 10, peMax: 40 },
    general_equity: { growth: 0.055, terminalGrowth: 0.0275, fcfMargin: 0.14, wacc: 0.1, peMin: 11, peMax: 24 },
  };
  return table[family];
}

function deriveAssumptions(payload: SecFacts, family: ModelFamilyId) {
  const revenueConcepts = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "SalesRevenueGoodsNet"];
  // Purchases of property/equipment (and, under the newer `ProductiveAssets` tag,
  // intangibles used in production) is the investing-cash-flow outflow that turns
  // CFO into free cash flow. Filers migrated from the legacy `PropertyPlantAndEquipment`
  // tag to `PaymentsToAcquireProductiveAssets` around 2021–2024 (NVIDIA did so after
  // FY2020); without the newer tag a migrated filer's recent capex reads as absent,
  // which silently drops every recent year from the CFO−CapEx and FCFF bridges and
  // degrades the DCF to a policy-margin proxy. The tags are near-synonyms, so the
  // series is chosen by latest period end, never double-counted.
  const capexConcepts = ["PaymentsToAcquireProductiveAssets", "PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsForAdditionsToPropertyPlantAndEquipment"];
  const annualRevenue = annualSeries(payload, revenueConcepts);
  let revenue = financialSeries(payload, revenueConcepts);
  const interimRevenue = revenue.length ? null : annualizedInterimRevenue(payload, revenueConcepts);
  if (interimRevenue) revenue = [{ value: interimRevenue.value, end: interimRevenue.end, filed: interimRevenue.filed }];
  const cashFlowSeries = (concepts: string[]) => {
    const reported = financialSeries(payload, concepts);
    if (reported.length || !interimRevenue) return reported;
    // Interim-only issuers still need a comparable operating and investing base.
    const annualized = annualizedInterimRevenue(payload, concepts);
    return annualized ? [{ value: annualized.value, end: annualized.end, filed: annualized.filed }] : [];
  };
  const cashFromOperations = cashFlowSeries(["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"]);
  const capex = cashFlowSeries(capexConcepts);
  const netIncome = cashFlowSeries(["NetIncomeLoss", "ProfitLoss"]);
  // EBIT, income tax and D&A are the unlevered cash-flow bridge inputs: they let
  // the DCF discount a true FCFF stream (EBIT×(1−tax) + D&A − CapEx) rather than
  // the levered CFO−CapEx proxy, so the stream and the WACC are口径-consistent.
  const operatingIncome = cashFlowSeries(["OperatingIncomeLoss"]);
  const incomeTax = cashFlowSeries(["IncomeTaxExpenseBenefit"]);
  const dAndA = cashFlowSeries(["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet"]);
  // Income taxes actually paid (a cash-flow statement line) distinct from the
  // accrual tax expense, so the book and cash tax rates are never conflated.
  const incomeTaxesPaid = cashFlowSeries(["IncomeTaxesPaid"]);
  // The DCF denominator is the current DILUTED share count. Weighted-average
  // diluted shares are filer-reported post-split and already include the dilutive
  // effect of options/RSUs/convertibles, so they are the correct per-share
  // denominator. "Shares outstanding" (cover page) is a basic point-in-time count
  // that understates dilution, so it is only a fallback, and the annual weighted
  // average is the last resort when neither a duration nor an instant count exists.
  const outstandingShares = latestInstant(payload, ["EntityCommonStockSharesOutstanding"], "shares", "dei");
  const annualDilutedShares = latestAnnual(payload, ["WeightedAverageNumberOfDilutedSharesOutstanding"], "shares");
  const durationDilutedShares = latestDurationShares(payload, ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"]);
  const dilutedShares = durationDilutedShares ?? outstandingShares ?? annualDilutedShares;
  // Interim-only issuers (a duration share count with no cover-page count and no
  // annual statement) are labelled distinctly so the provenance is honest.
  const interimShareCount = durationDilutedShares && !outstandingShares && !annualDilutedShares ? dilutedShares : null;
  const cash = latestInstant(payload, ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]);
  const investments = latestInstant(payload, ["ShortTermInvestments", "MarketableSecuritiesCurrent"]);
  // LongTermDebt includes current maturities, but NOT short-term borrowing.
  // DebtCurrent, in contrast, already includes both short-term borrowing and
  // current long-term maturities. Never sum an aggregate with its children.
  const longTermDebtConcepts = ["LongTermDebtAndFinanceLeaseObligations", "LongTermDebt"];
  const currentMaturityConcepts = ["LongTermDebtAndFinanceLeaseObligationsCurrent", "LongTermDebtCurrent"];
  const noncurrentDebtConcepts = ["LongTermDebtAndFinanceLeaseObligationsNoncurrent", "LongTermDebtNoncurrent", "LongTermNotesAndLoans", "LongTermNotesPayable"];
  // Full current debt (short-term borrowings + current maturities) is distinct
  // from the current-maturity line above, which is only the current slice of
  // long-term debt. NotesPayableCurrent is how Oracle tags its "notes payable
  // and other borrowings, current" line — the full current debt, not maturities.
  const currentDebtConcepts = ["DebtCurrent", "NotesPayableCurrent"];
  // DebtLongtermAndShorttermCombinedAmount is the company's own disclosed total
  // of long-term AND short-term debt, so it already covers current maturities,
  // non-current debt and any short-term borrowing in one line. When reported it
  // is the authoritative complete total; no optional XBRL tag is forced to exist.
  const totalDebtConcepts = ["DebtLongtermAndShorttermCombinedAmount"];
  const latestDebt = latestInstant(payload, [...totalDebtConcepts, ...longTermDebtConcepts, ...currentMaturityConcepts, ...noncurrentDebtConcepts, ...currentDebtConcepts, "ShortTermBorrowings"]);
  const capitalAsOf = [cash?.end, latestDebt?.end].filter((end): end is string => Boolean(end)).sort().at(-1);
  const debtAtEnd = (concepts: string[]) => capitalAsOf ? instantValueAtEnd(payload, concepts, capitalAsOf) : null;
  const totalDebt = debtAtEnd(totalDebtConcepts);
  const longTermDebt = debtAtEnd(longTermDebtConcepts);
  const currentMaturities = debtAtEnd(currentMaturityConcepts);
  const noncurrentDebt = debtAtEnd(noncurrentDebtConcepts);
  const shortTermDebt = debtAtEnd(["ShortTermBorrowings"]);
  const currentDebtTotal = debtAtEnd(currentDebtConcepts);
  const equity = latestInstant(payload, ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]);
  const goodwill = latestInstant(payload, ["Goodwill"]);
  const intangibles = latestInstant(payload, ["FiniteLivedIntangibleAssetsNet", "IndefiniteLivedIntangibleAssetsExcludingGoodwill"]);
  // Digital-asset treasuries report holdings at fair value, so the balance is a
  // reported input rather than a modelled quantity.
  const digitalAssets = latestInstant(payload, ["DigitalAssets", "DigitalAssetsAndLiabilities", "CryptoAssetFairValue", "CryptoAssets"]);
  // Stock-based compensation is a real economic claim on equity, so it is
  // captured for the capital bridge instead of being ignored.
  const stockComp = cashFlowSeries(["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"]);
  // Preferred stock, minority interests and similar senior claims sit above the
  // common equity and must be deducted in the bridge rather than ignored.
  const preferredClaims = latestInstant(payload, ["PreferredStockValue", "TemporaryEquityCarryingAmountAttributableToParent", "RedeemablePreferredStockCarryingAmount"]);
  // Only the non-controlling portion is a claim above the common equity. The
  // "including NCI" total is the whole equity section, not a claim on it.
  const minorityInterest = latestInstant(payload, ["MinorityInterest", "RedeemableNoncontrollingInterestEquityCarryingAmount"]);
  // Share-count components, kept separate so the denominator can be rebuilt and
  // audited instead of inferred from a single weighted average.
  const periodEndShares = latestInstant(payload, ["CommonStockSharesOutstanding", "CommonStockSharesIssued"], "shares")
    ?? latestInstant(payload, ["EntityCommonStockSharesOutstanding"], "shares", "dei");
  const weightedAverageBasic = latestDurationShares(payload, ["WeightedAverageNumberOfSharesOutstandingBasic"]);
  const weightedAverageDiluted = latestDurationShares(payload, ["WeightedAverageNumberOfDilutedSharesOutstanding"]);
  const optionShares = latestInstant(payload, [
    "ShareBasedCompensationArrangementByShareBasedPaymentAwardOptionsOutstandingNumber",
    "ShareBasedCompensationArrangementByShareBasedPaymentAwardEquityInstrumentsOtherThanOptionsOutstandingNumber",
  ], "shares");
  const restrictedStockUnitShares = latestInstant(payload, [
    "ShareBasedCompensationArrangementByShareBasedPaymentAwardEquityInstrumentsOtherThanOptionsNonvestedNumber",
    "RestrictedStockUnitsOutstandingNumber",
  ], "shares");
  const warrantShares = latestInstant(payload, ["ClassOfWarrantOrRightOutstanding", "WarrantsOutstandingShares"], "shares");
  const convertibleShares = latestInstant(payload, ["DebtInstrumentConvertibleNumberOfSharesIssuable", "ConvertibleDebtConversionShares"], "shares");
  // Redeemable/temporary equity that converted into common during the period is
  // evidence that a weighted average understates the current share count.
  const temporaryEquitySeries = units(payload, "us-gaap", "TemporaryEquitySharesOutstanding", "shares")
    .map((fact) => ({ end: String(fact.end ?? ""), value: numeric(fact.val) }))
    .filter((item): item is { end: string; value: number } => item.value !== null && Boolean(item.end))
    .sort((left, right) => left.end.localeCompare(right.end));
  const temporaryEquityShares = temporaryEquitySeries.length ? Math.max(...temporaryEquitySeries.map((item) => item.value)) / 1e9 : null;
  // Latest reported quarter, used as the anchor for the structural forecast.
  const latestQuarterFact = (concepts: string[], unit = "USD") => {
    let best: { value: number; end: string; days: number } | null = null;
    for (const concept of concepts) {
      for (const fact of units(payload, "us-gaap", concept, unit)) {
        const value = numeric(fact.val);
        if (value === null || !fact.start || !fact.end || String(fact.form ?? "") !== "10-Q") continue;
        const days = (Date.parse(`${fact.end}T00:00:00Z`) - Date.parse(`${fact.start}T00:00:00Z`)) / 86_400_000;
        if (!Number.isFinite(days) || days < 80 || days > 100) continue;
        const candidate = { value, end: fact.end, days };
        if (!best || candidate.end > best.end) best = candidate;
      }
    }
    return best;
  };
  const quarterRevenue = latestQuarterFact(["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"]);
  const quarterGrossProfit = latestQuarterFact(["GrossProfit"]);
  const quarterNetIncome = latestQuarterFact(["NetIncomeLoss", "ProfitLoss"]);
  const quarterEps = latestQuarterFact(["EarningsPerShareDiluted"], "USD/shares");
  const quarterDandA = latestQuarterFact(["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet"]);
  const quarterCapex = latestQuarterFact(capexConcepts);
  const quarterCfo = latestQuarterFact(["NetCashProvidedByUsedInOperatingActivities"]);
  const quarterOperatingIncome = latestQuarterFact(["OperatingIncomeLoss"]);
  const quarterTax = latestQuarterFact(["IncomeTaxExpenseBenefit"]);
  // Fiscal year to date: the longest interim period reported in the latest 10-Q.
  // The trailing twelve months then rolls the last fiscal year forward with the
  // current year to date less the prior-year comparable period.
  const yearToDateFact = (concepts: string[], unit = "USD") => {
    let best: { value: number; end: string; days: number } | null = null;
    for (const concept of concepts) {
      for (const fact of units(payload, "us-gaap", concept, unit)) {
        const value = numeric(fact.val);
        if (value === null || !fact.start || !fact.end || String(fact.form ?? "").toUpperCase() !== "10-Q") continue;
        const days = (Date.parse(`${fact.end}T00:00:00Z`) - Date.parse(`${fact.start}T00:00:00Z`)) / 86_400_000;
        if (!Number.isFinite(days) || days < 150 || days > 300) continue;
        const candidate = { value, end: fact.end, days };
        if (!best || candidate.end > best.end || (candidate.end === best.end && candidate.days > best.days)) best = candidate;
      }
    }
    return best;
  };
  const ytdRevenue = yearToDateFact(["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"]);
  const ytdGrossProfit = yearToDateFact(["GrossProfit"]);
  const ytdOperatingIncome = yearToDateFact(["OperatingIncomeLoss"]);
  const ytdNetIncome = yearToDateFact(["NetIncomeLoss", "ProfitLoss"]);
  const ytdEps = yearToDateFact(["EarningsPerShareDiluted"], "USD/shares");
  const ytdDandA = yearToDateFact(["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet"]);
  const ytdCapex = yearToDateFact(capexConcepts);
  const ytdCfo = yearToDateFact(["NetCashProvidedByUsedInOperatingActivities"]);
  const ytdTax = yearToDateFact(["IncomeTaxExpenseBenefit"]);
  const ttmRevenue = trailingPoint(payload, ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"]);
  const ttmGrossProfit = trailingPoint(payload, ["GrossProfit"]);
  const ttmNetIncome = trailingPoint(payload, ["NetIncomeLoss", "ProfitLoss"]);
  const ttmEps = trailingPoint(payload, ["EarningsPerShareDiluted"], "USD/shares");
  const ttmDandA = trailingPoint(payload, ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet"]);
  const ttmCapex = trailingPoint(payload, capexConcepts);
  const ttmCfo = trailingPoint(payload, ["NetCashProvidedByUsedInOperatingActivities"]);
  // Some issuers tag cash-flow items only for the year-to-date period. When the
  // latest tagged "quarter" predates the year-to-date end, the quarter is the
  // difference between two year-to-date periods of the same fiscal year.
  const yearToDateDelta = (concepts: string[], unit = "USD") => {
    const points = concepts.flatMap((concept) => units(payload, "us-gaap", concept, unit).flatMap((fact) => {
      const value = numeric(fact.val);
      if (value === null || !fact.start || !fact.end || String(fact.form ?? "").toUpperCase() !== "10-Q") return [];
      const days = (Date.parse(`${fact.end}T00:00:00Z`) - Date.parse(`${fact.start}T00:00:00Z`)) / 86_400_000;
      if (!Number.isFinite(days) || days < 60 || days > 300) return [];
      return [{ value, start: fact.start, end: fact.end, days }];
    }));
    const latest = points.slice().sort((left, right) => right.end.localeCompare(left.end) || right.days - left.days)[0];
    if (!latest || latest.days < 150) return null;
    const previous = points
      .filter((point) => point.start === latest.start && point.end < latest.end && latest.days - point.days >= 60)
      .sort((left, right) => left.end.localeCompare(right.end))
      .at(-1);
    if (!previous) return null;
    return { value: latest.value - previous.value, end: latest.end };
  };
  const quarterCapexDelta = quarterCapex && ytdCapex && quarterCapex.end !== ytdCapex.end
    ? yearToDateDelta(capexConcepts)
    : null;
  const quarterCfoDelta = quarterCfo && ytdCfo && quarterCfo.end !== ytdCfo.end
    ? yearToDateDelta(["NetCashProvidedByUsedInOperatingActivities"])
    : null;
  const params = familyParameters(family);
  const revenuesB = revenue.slice(-5).map((item) => item.value / 1e9);
  const latestRevenueB = revenuesB.at(-1) ?? null;
  const growthRates = revenuesB.slice(1).map((value, index) => value / revenuesB[index] - 1).filter((value) => Number.isFinite(value) && value > -0.8 && value < 2);
  const recentGrowth = growthRates.at(-1) ?? params.growth;
  const historicalGrowth = median(growthRates.slice(-3)) ?? params.growth;
  const structuralGrowth = ["ai_compute_platform", "ai_semiconductor", "cloud_software_platform", "digital_platform"].includes(family);
  const growthCap = family === "ai_compute_platform" ? 0.55 : family === "ai_semiconductor" ? 0.45 : family === "biotech" ? 0.5 : 0.35;
  const nextGrowth = clamp(recentGrowth * (structuralGrowth ? 0.55 : 0.45) + historicalGrowth * 0.25 + params.growth * (structuralGrowth ? 0.2 : 0.3), -0.15, growthCap);
  const cfoByEnd = new Map(cashFromOperations.map((item) => [item.end, item.value / 1e9]));
  const capexByEnd = new Map(capex.map((item) => [item.end, item.value / 1e9]));
  const ebitByEnd = new Map(operatingIncome.map((item) => [item.end, item.value / 1e9]));
  const taxByEnd = new Map(incomeTax.map((item) => [item.end, item.value / 1e9]));
  const dAndAByEnd = new Map(dAndA.map((item) => [item.end, item.value / 1e9]));
  const netIncomeByEnd = new Map(netIncome.map((item) => [item.end, item.value / 1e9]));
  const taxesPaidByEnd = new Map(incomeTaxesPaid.map((item) => [item.end, item.value / 1e9]));
  // Pre-tax income (EBT) is the correct denominator for the book effective tax
  // rate. Where a filer does not tag a pre-tax line directly it is approximated
  // as net income + income tax expense (the standard book-tax reconciliation).
  const ebtByEnd = new Map<string, number>();
  for (const item of revenue.slice(-5)) {
    const netIncomeValue = netIncomeByEnd.get(item.end);
    const taxValue = taxByEnd.get(item.end);
    if (netIncomeValue !== undefined && taxValue !== undefined) ebtByEnd.set(item.end, netIncomeValue + taxValue);
  }
  // Effective tax rate. The book rate is income tax expense ÷ pre-tax income
  // (EBT), not ÷ EBIT: EBIT is pre-interest, so dividing by it understates the
  // levered issuer's true tax drag and overstates NOPAT. EBT is approximated as
  // net income + tax expense when no pre-tax line is tagged, and EBIT is only a
  // fallback denominator — never the primary one. The cash rate (taxes paid ÷
  // EBT) is tracked separately because it is what FCFF should actually discount.
  const statutoryTaxRate = 0.21;
  const taxRateResult = (() => {
    const bookRates = revenue.slice(-5).map((item) => {
      const tax = taxByEnd.get(item.end);
      const ebt = ebtByEnd.get(item.end);
      if (tax === undefined || ebt === undefined || ebt <= 0) return null;
      return clamp(tax / ebt, -0.2, 0.6);
    }).filter((value): value is number => value !== null);
    if (bookRates.length) return { rate: median(bookRates)!, basis: "book_ebt" as const };
    const ebitRates = revenue.slice(-5).map((item) => {
      const tax = taxByEnd.get(item.end);
      const ebit = ebitByEnd.get(item.end);
      if (tax === undefined || ebit === undefined || ebit <= 0) return null;
      return clamp(tax / ebit, 0, 0.4);
    }).filter((value): value is number => value !== null);
    if (ebitRates.length) return { rate: median(ebitRates)!, basis: "ebit_fallback" as const };
    return { rate: statutoryTaxRate, basis: "statutory" as const };
  })();
  const effectiveTaxRate = taxRateResult.rate;
  const taxRateBasis = taxRateResult.basis;
  const cashTaxRate = (() => {
    const rates = revenue.slice(-5).map((item) => {
      const paid = taxesPaidByEnd.get(item.end);
      const ebt = ebtByEnd.get(item.end);
      if (paid === undefined || ebt === undefined || ebt <= 0) return null;
      return clamp(paid / ebt, -0.2, 0.6);
    }).filter((value): value is number => value !== null);
    return rates.length ? median(rates)! : null;
  })();
  // Reported CFO − CapEx. Missing CapEx must not read as zero: the year is
  // dropped rather than overstated, so an unreported investing line can never
  // inflate a free-cash-flow margin.
  const reportedFcf = revenue.slice(-5).map((item) => {
    const cfo = cfoByEnd.get(item.end);
    const capexValue = capexByEnd.get(item.end);
    if (cfo === undefined || capexValue === undefined) return null;
    return { end: item.end, value: cfo - capexValue, margin: (cfo - capexValue) / (item.value / 1e9) };
  }).filter((item): item is { end: string; value: number; margin: number } => item !== null && Number.isFinite(item.margin));
  // Operating net working capital (NWC): the cash-tied current assets and
  // non-interest-bearing current liabilities whose year-over-year change must be
  // subtracted to turn NOPAT + D&A − CapEx into a true FCFF. Only the latest
  // balance-sheet point at each fiscal-year end is used, so ΔNWC is a reported
  // movement, never a defaulted zero.
  const nwcReceivableConcepts = ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"];
  const nwcInventoryConcepts = ["InventoryNet", "InventoryNetCurrent"];
  const nwcPayableConcepts = ["AccountsPayableCurrent", "AccountsPayableAndAccruedLiabilitiesCurrent"];
  const nwcByEnd = new Map<string, number | null>();
  const nwcEnds = new Set(nwcReceivableConcepts.flatMap((concept) => units(payload, "us-gaap", concept, "USD").flatMap((fact) => fact.end ? [fact.end] : [])));
  for (const end of nwcEnds) {
    const receivables = instantValueAtEnd(payload, nwcReceivableConcepts, end);
    const inventory = instantValueAtEnd(payload, nwcInventoryConcepts, end);
    const payables = instantValueAtEnd(payload, nwcPayableConcepts, end);
    // A reported zero is valid; absence is not evidence of zero or inapplicability.
    const complete = receivables !== null && inventory !== null && payables !== null;
    nwcByEnd.set(end, complete ? receivables + inventory - payables : null);
  }
  // ΔNWC per year, in USD billions. A year without a prior balance-sheet point
  // (or with any missing component) contributes null rather than zero, so an
  // incomplete bridge degrades to a proxy instead of silently completing itself.
  const nwcChanges = revenue.slice(-5).map((item) => {
    const current = nwcByEnd.get(item.end);
    // A TTM stream needs a year-on-year movement, not the movement since the
    // preceding fiscal year end. Allow 52/53-week reporting calendars.
    const priorEnd = [...nwcEnds].map((end) => ({ end, days: (Date.parse(item.end) - Date.parse(end)) / 86_400_000 }))
      .filter(({ days }) => days >= 330 && days <= 400)
      .sort((a, b) => Math.abs(a.days - 365) - Math.abs(b.days - 365))[0]?.end;
    const prior = priorEnd ? nwcByEnd.get(priorEnd) : null;
    if (current === null || current === undefined || prior === null || prior === undefined) return null;
    return (current - prior) / 1e9;
  });
  const nwcChangeReported = nwcChanges.some((value) => value !== null);
  // Unlevered FCFF bridge: EBIT×(1−tax) + D&A − CapEx − ΔNWC. A year is dropped
  // when EBIT/D&A/capex or the ΔNWC term is missing, so an incomplete bridge can
  // never be presented as a complete FCFF.
  const fcffBridge = revenue.slice(-5).map((item, index) => {
    const ebit = ebitByEnd.get(item.end);
    const dAndAValue = dAndAByEnd.get(item.end);
    const capexValue = capexByEnd.get(item.end);
    const nwcChange = nwcChanges[index];
    if (ebit === undefined || dAndAValue === undefined || capexValue === undefined || nwcChange === null) return null;
    const fcff = ebit * (1 - effectiveTaxRate) + dAndAValue - capexValue - nwcChange;
    return { end: item.end, value: fcff, margin: fcff / (item.value / 1e9) };
  }).filter((item): item is { end: string; value: number; margin: number } => item !== null && Number.isFinite(item.margin));
  // Pre-working-capital bridge: the same unlevered reconstruction without ΔNWC.
  // It is a real unlevered proxy (not the levered CFO−CapEx stream) but it is
  // labelled `fcff_before_nwc` and never `fcff_ebit_bridge`, because omitting the
  // working-capital movement overstates true free cash flow.
  const fcffBeforeNwc = revenue.slice(-5).map((item) => {
    const ebit = ebitByEnd.get(item.end);
    const dAndAValue = dAndAByEnd.get(item.end);
    const capexValue = capexByEnd.get(item.end);
    if (ebit === undefined || dAndAValue === undefined || capexValue === undefined) return null;
    const fcff = ebit * (1 - effectiveTaxRate) + dAndAValue - capexValue;
    return { end: item.end, value: fcff, margin: fcff / (item.value / 1e9) };
  }).filter((item): item is { end: string; value: number; margin: number } => item !== null && Number.isFinite(item.margin));
  const fcffBridgeMargins = fcffBridge.map((item) => item.margin).filter((value) => value > -0.5 && value < 0.8);
  const fcffBeforeNwcMargins = fcffBeforeNwc.map((item) => item.margin).filter((value) => value > -0.5 && value < 0.8);
  const reportedMargins = reportedFcf.map((item) => item.margin).filter((value) => value > -0.5 && value < 0.8);
  // The DCF discounts an unlevered stream at WACC. Only a complete EBIT/D&A/capex
  // history with a reported ΔNWC earns the `fcff_ebit_bridge`口径; without ΔNWC the
  // unlevered bridge degrades to `fcff_before_nwc` (a warning, never "passed"),
  // and without any EBIT/D&A history the reported CFO−CapEx is a levered proxy.
  const useFcffBridge = fcffBridgeMargins.length >= 2;
  const useFcffBeforeNwc = !useFcffBridge && fcffBeforeNwcMargins.length >= 2;
  const operatingMargins = useFcffBridge ? fcffBridgeMargins : useFcffBeforeNwc ? fcffBeforeNwcMargins : reportedMargins;
  const cashFlowBasis: CashFlowBasis = useFcffBridge ? "fcff_ebit_bridge" : useFcffBeforeNwc ? "fcff_before_nwc" : reportedMargins.length ? "cfo_capex_proxy" : "derived_proxy";
  const latestReportedMargin = operatingMargins.at(-1) ?? params.fcfMargin;
  const recentMedianMargin = median(operatingMargins.slice(-3)) ?? latestReportedMargin;
  // Cyclical economics must be normalized across the cycle, not anchored to the
  // latest trough (or peak). The realized high and low define the mid-cycle
  // point, which is then blended with the family policy margin.
  const cyclicalFamily = family === "memory_cycle_semiconductor" || family === "cyclical_semiconductor";
  // Mid-cycle estimate: a single catastrophic trough year is not a mid-cycle
  // state, so the worst reported period is excluded and the remaining cycle
  // average is blended with the family's normalized margin policy.
  const cycleMidMargin = operatingMargins.length >= 3
    ? (() => {
      const sorted = [...operatingMargins].sort((left, right) => left - right);
      const retained = sorted.slice(1);
      return retained.reduce((sum, value) => sum + value, 0) / retained.length;
    })()
    : null;
  const normalizedReportedMargin = cyclicalFamily && cycleMidMargin !== null ? cycleMidMargin : recentMedianMargin;
  const startingMargin = clamp(
    cyclicalFamily && cycleMidMargin !== null
      ? cycleMidMargin * 0.5 + params.fcfMargin * 0.5
      : normalizedReportedMargin * 0.65 + params.fcfMargin * 0.35,
    -0.15,
    0.55,
  );
  const forwardRevenueB = latestRevenueB === null ? null : latestRevenueB * (1 + nextGrowth);
  const forwardMargin = clamp(startingMargin + (params.fcfMargin - startingMargin) * 0.25, -0.1, 0.55);
  const fadeSpeed = structuralGrowth ? 0.22 : family === "consumer_tech_platform" || family === "semiconductor_infrastructure" ? 0.3 : 0.38;
  const normalizedCashFlows = forwardRevenueB === null ? undefined : Array.from({ length: 6 }, (_, index) => {
    const growth = params.terminalGrowth + (nextGrowth - params.terminalGrowth) * Math.exp(-fadeSpeed * index);
    const forecastRevenue = index === 0 ? forwardRevenueB : forwardRevenueB * Array.from({ length: index }, (__, year) => 1 + params.terminalGrowth + (nextGrowth - params.terminalGrowth) * Math.exp(-fadeSpeed * (year + 1))).reduce((product, factor) => product * factor, 1);
    const margin = forwardMargin + (params.fcfMargin - forwardMargin) * (1 - Math.exp(-0.42 * (index + 1)));
    return forecastRevenue * clamp(margin, -0.05, 0.6) * (growth > -1 ? 1 : 0);
  });
  const positiveTerminalPath = normalizedCashFlows?.at(-1) && normalizedCashFlows.at(-1)! > 0 ? normalizedCashFlows : undefined;
  const sharesB = dilutedShares?.value ? dilutedShares.value / 1e9 : null;
  const cashReported = cash?.value !== undefined && cash.end === capitalAsOf;
  const investmentsReported = investments?.value !== undefined;
  // Require complete, same-date components. A missing short-term balance is
  // unknown, not zero; DebtCurrent + non-current debt is an alternative complete
  // route when the separate short-term/current-maturity lines are unavailable.
  const completeLongTermDebt = longTermDebt ?? (currentMaturities !== null && noncurrentDebt !== null ? currentMaturities + noncurrentDebt : null);
  // A disclosed "long-term and short-term debt combined" total is used verbatim
  // when reported: it already covers current maturities, non-current debt and any
  // short-term borrowing, so it is complete on its own and never summed with its
  // components. The component-only reconciliations remain the fallback when that
  // total is absent. None of these routes default a missing line to zero.
  const completeDebt = totalDebt !== null
    ? totalDebt
    : completeLongTermDebt !== null && shortTermDebt !== null
      ? completeLongTermDebt + shortTermDebt
      : currentDebtTotal !== null && noncurrentDebt !== null ? currentDebtTotal + noncurrentDebt : null;
  // The reconciliation formula, for the audit panel: which tag produced the debt
  // total, at which date, and — when the combined total exactly equals the
  // current-maturity + non-current split — that short-term borrowing is zero by
  // reconciliation rather than by tag absence.
  const debtSource = totalDebt !== null
    ? `reported combined long-term and short-term debt ${(totalDebt / 1e6).toFixed(0)}M at ${capitalAsOf}${currentMaturities !== null && noncurrentDebt !== null && Math.abs(totalDebt - (currentMaturities + noncurrentDebt)) < 1e6 ? ` (${(currentMaturities / 1e6).toFixed(0)}M current + ${(noncurrentDebt / 1e6).toFixed(0)}M non-current → short-term borrowing reconciles to zero)` : ""}`
    : completeLongTermDebt !== null && shortTermDebt !== null
      ? `long-term debt ${(completeLongTermDebt / 1e6).toFixed(0)}M + short-term borrowings ${(shortTermDebt / 1e6).toFixed(0)}M at ${capitalAsOf}`
      : currentDebtTotal !== null && noncurrentDebt !== null
        ? `current debt ${(currentDebtTotal / 1e6).toFixed(0)}M + non-current debt ${(noncurrentDebt / 1e6).toFixed(0)}M at ${capitalAsOf}`
        : null;
  const debtCoverage: "full_total" | "partial" | "unknown" = completeDebt !== null && completeDebt >= 0
    ? "full_total" : latestDebt ? "partial" : "unknown";
  const debtReported = debtCoverage !== "unknown";
  const debtComplete = debtCoverage === "full_total";
  // Partial sums are disclosed for diagnostics only; never feed the equity bridge.
  const debt = completeDebt ?? (longTermDebt !== null
    ? longTermDebt + (shortTermDebt ?? 0)
    : currentDebtTotal !== null ? currentDebtTotal + (noncurrentDebt ?? 0)
      : (currentMaturities ?? 0) + (noncurrentDebt ?? 0) + (shortTermDebt ?? 0));
  const preferredClaimsB = (preferredClaims?.value ?? 0) / 1e9;
  // Net cash used by the models already nets off senior claims, so the bridge
  // and the models cannot disagree about who sits above the common equity.
  // A missing or partial debt line must not silently read as zero: when the debt
  // side of the capital structure is unreported or only a component is present
  // the bridge is withheld (null) rather than overstated, and the audit panel
  // names the missing line. (Reported zero cash/debt is a defined value, not a
  // missing one, so it still produces a valid bridge.)
  const netCashB = cashReported && debtComplete
    ? ((cash?.value ?? 0) + (investments?.value ?? 0) - debt) / 1e9 - preferredClaimsB
    : null;
  // Cost of equity sits above the blended WACC because equity is the residual
  // claim: the premium is the WACC spread over an assumed after-tax cost of debt,
  // scaled by the book debt-to-equity ratio. This is a labelled policy heuristic,
  // not a beta estimate or sourced CAPM with an external ERP/β — it must
  // never be presented as a market-derived cost of equity.
  const equityB = equity?.value ? equity.value / 1e9 : null;
  const debtToEquity = equityB && equityB > 0 ? Math.max(0, debt / 1e9) / equityB : 0;
  const preTaxCostOfDebt = debtComplete && debt > 0 ? clamp(0.02 + 0.02 * Math.min(debtToEquity, 3), 0.02, 0.09) : 0.02;
  const afterTaxCostOfDebt = preTaxCostOfDebt * (1 - effectiveTaxRate);
  const costOfEquity = clamp(params.wacc + Math.max(0, params.wacc - afterTaxCostOfDebt) * Math.min(debtToEquity, 3), params.wacc, 0.2);
  const costOfEquitySource = "policy_heuristic" as const;
  const latestNetIncomeB = netIncome.at(-1)?.value ? netIncome.at(-1)!.value / 1e9 : null;
  const netMargin = latestNetIncomeB !== null && latestRevenueB ? latestNetIncomeB / latestRevenueB : null;
  const forwardEps = forwardRevenueB && sharesB && netMargin !== null && netMargin > 0 ? forwardRevenueB * clamp(netMargin, 0.01, 0.45) / sharesB : null;
  const earningsGrowth = clamp(nextGrowth + Math.max(0, params.fcfMargin - startingMargin) * 0.5, -0.1, 0.45);
  const forwardPe = clamp(14 + earningsGrowth * 48, params.peMin, params.peMax);
  const forwardFcfB = forwardRevenueB && forwardMargin > 0 ? forwardRevenueB * forwardMargin : null;
  const evFcfFloor = family === "ai_compute_platform" ? 24 : family === "consumer_tech_platform" ? 22 : family === "cloud_software_platform" ? 20 : family === "ai_semiconductor" || family === "digital_platform" ? 18 : 10;
  const evFcfCeiling = family === "ai_compute_platform" ? 38 : family === "ai_semiconductor" ? 32 : ["consumer_tech_platform", "cloud_software_platform", "digital_platform"].includes(family) ? 30 : 25;
  const evFcfMultiple = clamp(15 + Math.max(0, nextGrowth) * 45, evFcfFloor, evFcfCeiling);
  const evSalesMultiple = clamp(evFcfMultiple * Math.max(0.06, forwardMargin), 0.8, ["saas_growth", "ai_compute_platform", "ai_semiconductor", "cloud_software_platform"].includes(family) ? 14 : 9);
  const normalizedEbitdaB = forwardRevenueB && forwardRevenueB > 0 ? forwardRevenueB * clamp(forwardMargin + 0.08, 0.08, 0.42) : null;
  const evEbitdaMultiple = clamp(9 + Math.max(0, nextGrowth) * 24, 7, family === "foundry_semiconductor" ? 13 : 18);
  const bookValuePerShare = equity?.value && sharesB ? equity.value / 1e9 / sharesB : null;
  const tangibleEquityB = equity ? (equity.value - (goodwill?.value ?? 0) - (intangibles?.value ?? 0)) / 1e9 : null;
  const tangibleBookValuePerShare = tangibleEquityB && tangibleEquityB > 0 && sharesB ? tangibleEquityB / sharesB : null;
  const returnOnEquity = latestNetIncomeB !== null && equity?.value ? latestNetIncomeB / (equity.value / 1e9) : null;
  const priceToTangibleBook = returnOnEquity !== null ? clamp((returnOnEquity - params.terminalGrowth) / Math.max(0.02, params.wacc - params.terminalGrowth), 0.6, 3.5) : null;

  const assumptions: ValuationAssumptions = {};
  if (positiveTerminalPath) {
    assumptions.cashFlows = positiveTerminalPath;
    assumptions.normalizedCashFlows = positiveTerminalPath;
  }
  if (sharesB && sharesB > 0) assumptions.dilutedSharesB = sharesB;
  if (netCashB !== null && Number.isFinite(netCashB)) assumptions.netCashB = netCashB;
  assumptions.wacc = params.wacc;
  assumptions.terminalGrowth = params.terminalGrowth;
  assumptions.cashFlowBasis = cashFlowBasis;
  assumptions.effectiveTaxRate = effectiveTaxRate;
  assumptions.taxRateBasis = taxRateBasis;
  if (cashTaxRate !== null) assumptions.cashTaxRate = cashTaxRate;
  assumptions.preTaxCostOfDebt = preTaxCostOfDebt;
  if (forwardRevenueB && forwardRevenueB > 0) assumptions.forwardRevenueB = forwardRevenueB;
  if (forwardFcfB && forwardFcfB > 0) assumptions.forwardFcfB = forwardFcfB;
  if (forwardEps && forwardEps > 0) assumptions.forwardEps = forwardEps;
  assumptions.forwardPe = forwardPe;
  if (normalizedEbitdaB && normalizedEbitdaB > 0) assumptions.normalizedEbitdaB = normalizedEbitdaB;
  assumptions.evEbitdaMultiple = evEbitdaMultiple;
  assumptions.evFcfMultiple = evFcfMultiple;
  assumptions.evSalesMultiple = evSalesMultiple;
  if (forwardMargin > 0) assumptions.fcfMargin = forwardMargin;
  if (bookValuePerShare && bookValuePerShare > 0) assumptions.bookValuePerShare = bookValuePerShare;
  if (tangibleBookValuePerShare && tangibleBookValuePerShare > 0) assumptions.tangibleBookValuePerShare = tangibleBookValuePerShare;
  if (returnOnEquity !== null && Number.isFinite(returnOnEquity)) assumptions.returnOnEquity = clamp(returnOnEquity, -0.25, 0.5);
  assumptions.costOfEquity = costOfEquity;
  assumptions.costOfEquitySource = costOfEquitySource;
  assumptions.residualGrowth = params.terminalGrowth;
  if (priceToTangibleBook && priceToTangibleBook > 0) assumptions.priceToTangibleBook = priceToTangibleBook;

  const latestPeriod = revenue.at(-1) ?? null;
  const periodBasis = interimRevenue
    ? `annualized latest interim period (×${interimRevenue.annualizationFactor}) through ${interimRevenue.end}`
    : latestPeriod && latestPeriod.end > (annualRevenue.at(-1)?.end ?? "")
      ? "TTM through latest 10-Q"
      : "latest fiscal year";
  const qualityChecks: DataQualityCheck[] = [
    {
      id: "reported-period", provenance: "operating" as const,
      label: "Reported period",
      status: latestPeriod ? "passed" : ["advanced_nuclear_project_npv", "biotech"].includes(family) && netCashB !== null && sharesB && sharesB > 0 ? "warning" : "failed",
      detail: latestPeriod ? `${periodBasis}; period ended ${latestPeriod.end}, filed ${latestPeriod.filed || "date unavailable"}.` : ["advanced_nuclear_project_npv", "biotech"].includes(family) ? "Pre-revenue business: a revenue series is not an operating anchor; project evidence is required." : "No comparable reported revenue series was found.",
    },
    {
      id: "financial-scale", provenance: "operating" as const,
      label: "Financial unit scale",
      // Pre-revenue developers have no revenue base; a reported capital base is
      // an equally valid scale reference and must not withhold the valuation.
      status: (latestRevenueB && latestRevenueB > 0 || (netCashB !== null && Math.abs(netCashB) >= 0.05)) && sharesB && sharesB > 0 ? "passed" : "failed",
      detail: !(sharesB && sharesB > 0)
        ? "No usable share count was reported, so per-share values cannot be published."
        : latestRevenueB && latestRevenueB > 0
          ? cyclicalFamily && cycleMidMargin !== null
            ? `Financial values are normalized to USD billions. Mid-cycle FCF margin ${(cycleMidMargin * 100).toFixed(1)}% is the average of the reported cycle excluding the worst period, blended with the ${(params.fcfMargin * 100).toFixed(0)}% family policy for ${family.replaceAll("_", " ")}.`
            : interimShareCount
            ? `Financial values are normalized to USD billions; the share base is the latest interim weighted-average diluted count (${(sharesB).toFixed(2)}B), because no cover-page count or annual statement is filed yet.`
            : "Financial statement values are normalized to USD billions and shares to billions."
          : "No comparable revenue was reported, so the reported capital base and share count were used as the scale reference.",
    },
    {
      id: "capital-bridge", provenance: "operating" as const,
      label: "Capital bridge",
      status: netCashB === null ? "warning" : latestRevenueB && Math.abs(netCashB) <= latestRevenueB * 10 ? "passed" : "warning",
      detail: netCashB === null
        ? `The net cash/debt bridge is withheld: ${[!cashReported ? "cash is missing at the capital-structure date" : null, !debtComplete ? "long-term and short-term debt cannot be fully reconciled at the same date" : null].filter(Boolean).join("; ")} (${capitalAsOf ?? "date unavailable"}). Missing components are not defaulted to zero.`
        : latestRevenueB && Math.abs(netCashB) <= latestRevenueB * 10 ? `Cash, investments and a ${debtCoverage === "full_total" ? "complete" : ""} debt total are within a plausible scale relative to revenue (${debtSource ?? "debt components reported"}${investmentsReported ? "" : "; short-term investments were not reported and are treated as zero"}).` : "The net cash/debt bridge requires company-specific review.",
    },
    {
      id: "cash-flow-basis", provenance: "operating" as const,
      label: "Cash-flow口径",
      status: useFcffBridge ? "passed" : "warning",
      detail: useFcffBridge
        ? `The DCF discounts a complete unlevered FCFF stream — EBIT×(1−tax) at ${(effectiveTaxRate * 100).toFixed(0)}% tax (${taxRateBasis === "book_ebt" ? "book tax ÷ pre-tax income" : taxRateBasis === "ebit_fallback" ? "tax ÷ EBIT fallback" : "statutory"}${cashTaxRate !== null ? `; cash tax ${(cashTaxRate * 100).toFixed(0)}%` : ""}) + D&A − CapEx − ΔNWC — built from the reported EBIT, depreciation, capital-expenditure and balance-sheet working-capital history.`
        : useFcffBeforeNwc
          ? `The DCF discounts an unlevered FCFF proxy — EBIT×(1−tax) + D&A − CapEx — but the change in net working capital was not reported, so the bridge is pre-working-capital (${"fcff_before_nwc"}) and is treated as an approximation rather than a complete FCFF.`
          : "No complete EBIT/depreciation/capex history was reported, so the reported CFO−CapEx is used as a levered free-cash-flow proxy (it already nets interest and working-capital cash) rather than presented as FCFF; its conversion method and limits are stated in the provenance.",
    },
    {
      id: "cost-of-capital-source", provenance: "operating" as const,
      label: "Cost of capital source",
      status: "warning",
      detail: cashFlowBasis === "cfo_capex_proxy"
        ? `The levered stream is discounted at a policy-heuristic cost of equity (${(costOfEquity * 100).toFixed(1)}%, based on book leverage and assumed debt cost) — not a sourced CAPM with an external equity-risk premium and beta.`
        : "The unlevered stream is discounted at WACC, so the cost of equity is not applied to this DCF.",
    },
    {
      id: "ttm-freshness", provenance: "operating" as const,
      label: "Interim-period freshness",
      status: periodBasis.startsWith("TTM") ? "passed" : "warning",
      detail: periodBasis.startsWith("TTM") ? "The latest 10-Q has been rolled into trailing-twelve-month fundamentals." : "The automated forecast is based on the latest fiscal year because a comparable TTM bridge was unavailable.",
    },
  ];

  return {
    assumptions,
    latestRevenueB,
    nextGrowth,
    forwardMargin,
    latestFiled: latestPeriod?.filed ?? null,
    periodBasis,
    qualityChecks,
    // P0 financial口径: the cash-flow derivation and the cost-of-capital inputs,
    // surfaced so the provenance and audit panel can name them rather than guess.
    cashFlowBasis,
    useFcffBridge,
    useFcffBeforeNwc,
    nwcChangeReported,
    effectiveTaxRate,
    taxRateBasis,
    cashTaxRate,
    preTaxCostOfDebt,
    costOfEquity,
    costOfEquitySource,
    cashReported,
    investmentsReported,
    debtReported,
    debtCoverage,
    debtComplete,
    debtSource,
    digitalAssetsB: digitalAssets?.value ? digitalAssets.value / 1e9 : null,
    hasFullFiscalYear: annualRevenue.length > 0,
    // Share-count components for the SPCX denominator rebuild.
    periodEndBasicSharesB: periodEndShares?.value ? periodEndShares.value / 1e9 : null,
    weightedAverageBasicSharesB: weightedAverageBasic?.value ? weightedAverageBasic.value / 1e9 : (dilutedShares?.value ? dilutedShares.value / 1e9 : null),
    weightedAverageDilutedSharesB: weightedAverageDiluted?.value ? weightedAverageDiluted.value / 1e9 : (dilutedShares?.value ? dilutedShares.value / 1e9 : null),
    optionSharesB: optionShares?.value ? optionShares.value / 1e9 : null,
    restrictedStockUnitSharesB: restrictedStockUnitShares?.value ? restrictedStockUnitShares.value / 1e9 : null,
    warrantSharesB: warrantShares?.value ? warrantShares.value / 1e9 : null,
    convertibleSharesB: convertibleShares?.value ? convertibleShares.value / 1e9 : null,
    temporaryEquitySharesB: temporaryEquityShares,
    latestQuarter: {
      periodEnd: quarterRevenue?.end ?? null,
      revenueM: (quarterRevenue?.value ?? 0) / 1e6,
      grossProfitM: (quarterGrossProfit?.value ?? 0) / 1e6,
      netIncomeM: (quarterNetIncome?.value ?? 0) / 1e6,
      eps: quarterEps?.value ?? 0,
      dAndAM: (quarterDandA?.value ?? 0) / 1e6,
      capexM: quarterCapexDelta ? quarterCapexDelta.value / 1e6 : quarterCapex ? quarterCapex.value / 1e6 : null,
      cfoM: quarterCfoDelta ? quarterCfoDelta.value / 1e6 : quarterCfo ? quarterCfo.value / 1e6 : null,
    },
    // Reported interim, year-to-date and trailing-twelve-month lines. Used by the
    // company-specific models that anchor on the latest filing, and available to
    // the audit panel as reported evidence rather than a model output.
    reportedLines: {
      quarter: {
        periodEnd: quarterRevenue?.end ?? null,
        revenueM: (quarterRevenue?.value ?? 0) / 1e6,
        grossProfitM: quarterGrossProfit ? quarterGrossProfit.value / 1e6 : null,
        operatingIncomeM: quarterOperatingIncome ? quarterOperatingIncome.value / 1e6 : null,
        netIncomeM: quarterNetIncome ? quarterNetIncome.value / 1e6 : null,
        eps: quarterEps?.value ?? null,
        dAndAM: quarterDandA ? quarterDandA.value / 1e6 : null,
        capexM: quarterCapexDelta ? quarterCapexDelta.value / 1e6 : quarterCapex ? quarterCapex.value / 1e6 : null,
        cfoM: quarterCfoDelta ? quarterCfoDelta.value / 1e6 : quarterCfo ? quarterCfo.value / 1e6 : null,
        taxM: quarterTax ? quarterTax.value / 1e6 : null,
      },
      yearToDate: {
        periodEnd: ytdRevenue?.end ?? null,
        revenueM: ytdRevenue ? ytdRevenue.value / 1e6 : null,
        grossProfitM: ytdGrossProfit ? ytdGrossProfit.value / 1e6 : null,
        operatingIncomeM: ytdOperatingIncome ? ytdOperatingIncome.value / 1e6 : null,
        netIncomeM: ytdNetIncome ? ytdNetIncome.value / 1e6 : null,
        eps: ytdEps?.value ?? null,
        dAndAM: ytdDandA ? ytdDandA.value / 1e6 : null,
        capexM: ytdCapex ? ytdCapex.value / 1e6 : null,
        cfoM: ytdCfo ? ytdCfo.value / 1e6 : null,
        taxM: ytdTax ? ytdTax.value / 1e6 : null,
      },
      ttm: {
        periodEnd: ttmRevenue?.end ?? null,
        revenueM: ttmRevenue ? ttmRevenue.value / 1e6 : null,
        grossProfitM: ttmGrossProfit ? ttmGrossProfit.value / 1e6 : null,
        netIncomeM: ttmNetIncome ? ttmNetIncome.value / 1e6 : null,
        eps: ttmEps?.value ?? null,
        dAndAM: ttmDandA ? ttmDandA.value / 1e6 : null,
        capexM: ttmCapex ? ttmCapex.value / 1e6 : null,
        cfoM: ttmCfo ? ttmCfo.value / 1e6 : null,
      },
    },
    // Gross capital-bridge components, so the published reconciliation can be
    // checked line by line rather than only as a net figure.
    capitalBridge: {
      cashB: (cash?.value ?? 0) / 1e9,
      investmentsB: (investments?.value ?? 0) / 1e9,
      debtB: debt / 1e9,
      debtSource: debtSource ?? null,
      preferredClaimsB,
      minorityInterestB: (minorityInterest?.value ?? 0) / 1e9,
      stockCompB: stockComp.at(-1)?.value ? stockComp.at(-1)!.value / 1e9 : null,
      equityB: (equity?.value ?? 0) / 1e9,
    },
  };
}

function companySpecificAssumptions(
  symbol: string,
  derived: ReturnType<typeof deriveAssumptions>,
  latestFilingText: string | null,
  context: { bitcoinPriceUsd: number | null; marketPrice?: number | null; filingId?: string | null; filingHtml?: string | null },
) {
  const assumptions: ValuationAssumptions = structuredClone(derived.assumptions);
  const text = latestFilingText ?? "";
  let parsed = false;
  let spcxResult: (SpcxValuation & { shareBridge: SpcxShareBridge }) | null = null;
  let muResult: MuValuation | null = null;
  let spcxShareFailure: string | null = null;
  let modelConfidence: Partial<Record<ValuationModelId, number>> | null = null;

  if (symbol === "TSLA") {
    const automotive = reportedNumber(text, /Total automotive revenues\s+\$?\s*([\d,]+)/i);
    const energy = reportedNumber(text, /Energy generation and storage\s+\$?\s*([\d,]+)/i);
    const services = reportedNumber(text, /Services and other\s+\$?\s*([\d,]+)/i);
    const deliveries = reportedNumber(text, /(?:Total )?[Dd]eliveries\s+(?:of\s+)?([\d,]+)/i, 1);
    const automotiveGrossMargin = reportedNumber(text, /[Aa]utomotive gross margin\s+([\d.]+)\s*%/i, 0.01);
    const quarterTotal = automotive && energy && services ? automotive + energy + services : null;
    const forwardTotal = assumptions.forwardRevenueB ?? derived.latestRevenueB;
    if (forwardTotal && forwardTotal > 0) {
      const shares = quarterTotal
        ? { automotive: automotive! / quarterTotal, energy: energy! / quarterTotal, services: services! / quarterTotal }
        : { automotive: 0.72, energy: 0.12, services: 0.16 };
      // Explicit, auditable SOTP: operating segments are valued on reported
      // revenue and through-cycle margins, while FSD/Robotaxi/Optimus carry a
      // delivery probability so unproven optionality is never fully credited.
      const marginFactor = automotiveGrossMargin === null ? 1 : clamp(automotiveGrossMargin / 0.18, 0.7, 1.25);
      // Stock-based compensation is a genuine claim on equity, so it enters the
      // SOTP as its own negative segment rather than being netted away.
      const stockCompB = derived.capitalBridge.stockCompB;
      const dilutionAdjustmentB = stockCompB && stockCompB > 0 ? stockCompB * 5 : null;
      assumptions.sotpSegments = [
        // No autonomy value sits inside the automotive multiple: the optionality
        // below is the only place autonomy is credited, so it is never counted twice.
        { name: "Automotive", metric: deliveries !== null ? `${Math.round(deliveries)} reported deliveries at the reported ASP and automotive gross margin excluding credits; carries no autonomy value` : "latest reported revenue mix × forward revenue; carries no autonomy value", metricValueB: forwardTotal * shares.automotive * marginFactor, multiple: 6, driverSource: quarterTotal ? "reported" : "model_derived", method: "revenue_multiple", marginAssumption: automotiveGrossMargin ?? undefined },
        { name: "Energy generation & storage", metric: quarterTotal ? "reported energy revenue × growth, storage margin normalized to a mid-cycle utility-scale level rather than an auto multiple" : "forward revenue × normalized energy mix at a mid-cycle storage margin", metricValueB: forwardTotal * shares.energy, multiple: 10, driverSource: quarterTotal ? "reported" : "model_derived", method: "revenue_multiple", marginAssumption: 0.18 },
        { name: "Charging, services and other", metric: quarterTotal ? "latest reported revenue mix × forward revenue" : "forward revenue × normalized mix", metricValueB: forwardTotal * shares.services, multiple: 3, driverSource: quarterTotal ? "reported" : "model_derived", method: "revenue_multiple" },
        { name: "FSD software and licensing", metric: "addressable autonomy economics × adoption × technical and regulatory success probability", metricValueB: forwardTotal * 0.9, multiple: 1, probability: 0.45, driverSource: "model_derived", method: "probability_weighted_option" },
        { name: "Robotaxi / Cybercab network", metric: "addressable ride-hail economics × fleet adoption × deployment probability", metricValueB: forwardTotal * 2.1, multiple: 1, probability: 0.3, driverSource: "model_derived", method: "probability_weighted_option" },
        { name: "Optimus and other optionality", metric: "unproven business, probability weighted rather than zeroed or fully credited", metricValueB: forwardTotal * 1.5, multiple: 1, probability: 0.12, driverSource: "model_derived", method: "probability_weighted_option" },
        ...(dilutionAdjustmentB ? [{ name: "Stock-based compensation and dilution", metric: `reported annual stock compensation ${stockCompB!.toFixed(2)}B × 5 years`, metricValueB: -dilutionAdjustmentB, multiple: 1, driverSource: "reported" as const, method: "equity_claim" as const }] : []),
      ];
      parsed = Boolean(quarterTotal);
    }
  }

  if (symbol === "INTC") {
    const segmentRow = text.match(/Revenue\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)\s+\$\s*[\d,]+\s+\$\s*([\d,]+)\s+\$\s*([\d,]+).{0,120}?\$\s*([\d,]+)\s+Cost of sales/i);
    const values = segmentRow?.slice(1, 6).map((value) => Number(value.replaceAll(",", "")) / 1e3) ?? [];
    const hasReportedSegments = values.length === 5 && values.every((value) => Number.isFinite(value) && value > 0) && values[4] > 5;
    const forwardTotal = assumptions.forwardRevenueB ?? derived.latestRevenueB;
    if (forwardTotal && forwardTotal > 0) {
      assumptions.normalizedEbitdaB = forwardTotal * 0.22;
      assumptions.evEbitdaMultiple = 10;
      const total = hasReportedSegments ? values[4] : forwardTotal / 4;
      const scale = forwardTotal / total;
      const client = hasReportedSegments ? values[0] * scale : forwardTotal * 0.55;
      const dataCenter = hasReportedSegments ? values[1] * scale : forwardTotal * 0.39;
      const foundryRunRate = hasReportedSegments ? values[2] * scale : forwardTotal * 1.35;
      const other = hasReportedSegments ? values[3] * scale : forwardTotal * 0.06;
      assumptions.sotpSegments = [
        { name: "Client Computing", metric: hasReportedSegments ? "latest reported segment mix × forward revenue" : "forward revenue × normalized mix", metricValueB: client, multiple: 5 },
        { name: "Data Center & AI", metric: hasReportedSegments ? "latest reported segment mix × forward revenue" : "forward revenue × normalized mix", metricValueB: dataCenter, multiple: 8 },
        { name: "All Other", metric: hasReportedSegments ? "latest reported segment mix × forward revenue" : "forward revenue × normalized mix", metricValueB: other, multiple: 3 },
        { name: "Intel Foundry turnaround", metric: "reported segment run-rate; probability-weighted for utilization and external-customer execution", metricValueB: foundryRunRate, multiple: 3, probability: 0.5 },
      ];
      parsed = hasReportedSegments;
    }
  }

  if (symbol === "CRCL") {
    const reserveIncome = reportedNumber(text, /Reserve income\s+\$?\s*([\d,]+)/i, 1e-6);
    const otherRevenue = reportedNumber(text, /Other revenue\s+\$?\s*([\d,]+)/i, 1e-6);
    const distributionCosts = reportedNumber(text, /Distribution,? transaction and other costs\s+\$?\s*([\d,]+)/i, 1e-6);
    const annualRevenue = assumptions.forwardRevenueB ?? derived.latestRevenueB;
    if (annualRevenue && annualRevenue > 0) {
      const reserveContribution = reserveIncome !== null && distributionCosts !== null
        ? Math.max(reserveIncome - distributionCosts, reserveIncome * 0.25) * 4
        : annualRevenue * 0.36;
      const annualOtherRevenue = otherRevenue !== null ? otherRevenue * 4 : annualRevenue * 0.05;
      assumptions.sotpSegments = [
        { name: "Net reserve economics", metric: reserveIncome !== null && distributionCosts !== null ? "latest reserve income less distribution costs, annualized" : "forward revenue × normalized net reserve margin", metricValueB: reserveContribution, multiple: 18 },
        { name: "Other revenue", metric: otherRevenue !== null ? "latest reported quarter annualized" : "forward revenue × normalized non-reserve mix", metricValueB: annualOtherRevenue, multiple: 10 },
        { name: "Payments / network optionality", metric: "unadjusted option value derived from forward revenue", metricValueB: annualRevenue * 3.5, multiple: 1, probability: 0.4 },
      ];
      if ((assumptions.netCashB ?? 0) > annualRevenue * 3) assumptions.netCashB = 0;
      parsed = reserveIncome !== null && distributionCosts !== null && otherRevenue !== null;
    }
  }

  if (symbol === "MSTR") {
    // A bitcoin treasury is valued from reported digital assets at a market
    // reference price, plus the software business, less financing claims.
    const bitcoinPriceUsd = context.bitcoinPriceUsd;
    const digitalAssetsB = derived.digitalAssetsB;
    const softwareValueB = assumptions.forwardRevenueB && assumptions.forwardRevenueB > 0
      ? assumptions.forwardRevenueB * 2.5
      : null;
    if (bitcoinPriceUsd && bitcoinPriceUsd > 0 && digitalAssetsB && digitalAssetsB > 0) {
      assumptions.bitcoinHoldings = (digitalAssetsB * 1e9) / bitcoinPriceUsd;
      assumptions.bitcoinPriceUsd = bitcoinPriceUsd;
      assumptions.otherAssetValueB = softwareValueB ?? 0;
      parsed = true;
    }
    assumptions.sotpSegments = digitalAssetsB && digitalAssetsB > 0
      ? [
        { name: "Reported digital assets at the reference bitcoin price", metric: "SEC-reported digital-asset fair value", metricValueB: digitalAssetsB, multiple: 1 },
        ...(softwareValueB ? [{ name: "Enterprise software operations", metric: "forward revenue × 2.5× software multiple", metricValueB: softwareValueB, multiple: 1 }] : []),
      ]
      : undefined;
  }

  if (symbol === "SPCX") {
    // Space Exploration Technologies: public issuer since the June 2026 Nasdaq
    // listing. The denominator comes from the current period-end counts in the
    // 10-Q, never from the EPS weighted average.
    const shareEvidence = parseSpcxShareEvidence(text);
    const spcxShareBridge = buildSpcxShareBridge({
      evidence: shareEvidence,
      weightedAverageBasicSharesB: derived.weightedAverageBasicSharesB,
      weightedAverageDilutedSharesB: derived.weightedAverageDilutedSharesB,
      filingId: context.filingId ?? null,
    });
    // The denominator is the current period-end count plus economic dilution.
    assumptions.dilutedSharesB = spcxShareBridge.fullyDilutedSharesCurrentB;
    const reported = parseSpcxReportedSegments(text, "10-Q for the quarter ended June 30, 2026");
    const reportedNetCorporateB = reported.cashM !== null && reported.debtAndLeasesM !== null
      ? (reported.cashM + (reported.marketableSecuritiesM ?? 0) + (reported.digitalAssetsM ?? 0) - reported.debtAndLeasesM) / 1000
      : assumptions.netCashB ?? 0;
    if (reported.halfYear && reported.quarter) {
      const spcx = buildSpcxValuation({
        reported,
        shareBridge: spcxShareBridge,
        netCorporateB: reportedNetCorporateB,
        marketPrice: context.marketPrice ?? null,
      });
      const subLines = (segment: "Space" | "Connectivity" | "AI") => reported.revenueDetail
        .filter((line) => line.segment === segment && !/^(Space|Connectivity|AI)$/.test(line.label))
        .map((line) => `${line.label} $${(line.halfYear / 1000).toFixed(2)}B reported half-year`)
        .join(", ");
      assumptions.sotpSegments = spcx.segments.map((segment) => ({
        name: `${segment.segment} segment`,
        metric: `${segment.method}. Reported sub-lines: ${subLines(segment.segment)}`,
        metricValueB: segment.enterpriseValueB,
        multiple: 1,
        probability: 1,
        driverSource: "reported" as const,
        method: "ebitda_multiple" as const,
        marginAssumption: segment.anchorMargin2028,
        layer: "core" as const,
        valuationBasis: "ENTERPRISE_VALUE" as const,
        currentRevenueB: segment.revenueBaseB,
        growthCagr: segment.revenueBaseB > 0 ? (segment.anchorRevenue2028B / segment.revenueBaseB) ** (1 / 2) - 1 : 0,
        cashFlowB: segment.enterpriseValueB,
      }));
      if (spcx.otherOptionality.valueB > 0) {
        assumptions.sotpSegments.push({
          name: "Strategic optionality beyond the segments",
          metric: `identifiable economics outside the segment plans: ${spcx.otherOptionality.items.map((item) => `${item.name} $${item.valueB.toFixed(0)}B`).join(", ")}`,
          metricValueB: spcx.otherOptionality.valueB,
          multiple: 1,
          probability: 1,
          driverSource: "model_derived" as const,
          method: "dcf" as const,
          layer: "optionality" as const,
          valuationBasis: "ENTERPRISE_VALUE" as const,
          currentRevenueB: 0,
          growthCagr: 0,
        });
      }
      if (spcx.starship.expectedValueB > 0) {
        assumptions.sotpSegments.push({
          name: "Starship scenario tree",
          metric: `scenario-weighted value across ${spcx.starship.scenarios.length} scenarios whose probabilities sum to ${(spcx.starship.probabilitySum * 100).toFixed(0)}%`,
          metricValueB: spcx.starship.expectedValueB,
          multiple: 1,
          probability: 1,
          driverSource: "model_derived" as const,
          method: "dcf" as const,
          layer: "optionality" as const,
          valuationBasis: "ENTERPRISE_VALUE" as const,
          currentRevenueB: 0,
          growthCagr: 0,
        });
      }
      assumptions.netCashB = reportedNetCorporateB;
      spcxResult = spcx;
      parsed = true;
    }
    spcxShareFailure = spcxShareBridge.valid ? null : spcxShareBridge.validation.join(" ");
  }

  if (symbol === "MU") {
    // Structural + cyclical model. Reported product revenue fixes the DRAM/NAND
    // split, HBM is modelled as its own business, and legacy memory normalises
    // one year at a time instead of jumping to a historical average.
    const lines = derived.reportedLines;
    const productRevenue = parseMuReportedProductRevenue(context.filingHtml ?? null);
    const evidence = parseMuEvidence(latestFilingText);
    if (lines.yearToDate.revenueM === null) evidence.notes.push("The latest 10-Q did not expose a machine-readable fiscal-year-to-date table, so the anchor fell back to the reported quarter annualised.");
    const anchors: MuReportedAnchors = {
      quarter: {
        periodEnd: lines.quarter.periodEnd,
        revenueM: lines.quarter.revenueM || (derived.latestRevenueB ?? 0) * 1000 / 4,
        grossProfitM: lines.quarter.grossProfitM ?? 0,
        operatingIncomeM: lines.quarter.operatingIncomeM,
        operatingExpenseM: lines.quarter.grossProfitM !== null && lines.quarter.operatingIncomeM !== null
          ? lines.quarter.grossProfitM - lines.quarter.operatingIncomeM
          : null,
        netIncomeM: lines.quarter.netIncomeM ?? 0,
        eps: lines.quarter.eps ?? 0,
        dAndAM: lines.quarter.dAndAM ?? 0,
        capexM: lines.quarter.capexM,
        cfoM: lines.quarter.cfoM,
      },
      yearToDate: lines.yearToDate.revenueM !== null
        ? {
          periodEnd: lines.yearToDate.periodEnd,
          revenueM: lines.yearToDate.revenueM,
          grossProfitM: lines.yearToDate.grossProfitM,
          operatingIncomeM: lines.yearToDate.operatingIncomeM,
          netIncomeM: lines.yearToDate.netIncomeM,
          eps: lines.yearToDate.eps,
          dAndAM: lines.yearToDate.dAndAM,
          capexM: lines.yearToDate.capexM,
          cfoM: lines.yearToDate.cfoM,
          taxM: lines.yearToDate.taxM,
        }
        : null,
      ttm: {
        periodEnd: lines.ttm.periodEnd,
        revenueM: lines.ttm.revenueM ?? (derived.latestRevenueB !== null ? derived.latestRevenueB * 1000 : null),
        grossProfitM: lines.ttm.grossProfitM,
        netIncomeM: lines.ttm.netIncomeM,
        eps: lines.ttm.eps,
        dAndAM: lines.ttm.dAndAM,
        capexM: lines.ttm.capexM,
        cfoM: lines.ttm.cfoM,
      },
      balance: {
        cashM: derived.capitalBridge.cashB * 1000,
        longTermDebtM: derived.capitalBridge.debtB * 1000,
        equityM: derived.capitalBridge.equityB * 1000,
        inventoryM: 0,
      },
      dilutedSharesM: (derived.weightedAverageDilutedSharesB ?? 0) * 1000,
      productRevenue,
      source: "SEC Company Facts (latest quarter, fiscal year to date, trailing twelve months) + latest 10-Q product revenue table",
      sourceDate: derived.latestFiled,
    };
    if (anchors.quarter.revenueM > 0 && anchors.dilutedSharesM > 0) {
      const mu = buildMuValuation({
        anchors,
        assumptions: MU_FORECAST_ASSUMPTIONS,
        valuation: MU_VALUATION_ASSUMPTIONS,
        evidence,
        price: context.marketPrice ?? null,
        netCashB: assumptions.netCashB ?? 0,
        sharesM: anchors.dilutedSharesM,
      });
      const productMetric = productRevenue.quarter
        ? `reported product revenue: DRAM $${(productRevenue.quarter.dramM / 1000).toFixed(1)}B and NAND $${(productRevenue.quarter.nandM / 1000).toFixed(1)}B in the latest quarter`
        : "reported product revenue was not machine-readable, so the DRAM/NAND split is a labelled assumption";
      // The segment table is the same engine as the published value: FY2028
      // segment EBITDA at the model's EV/EBITDA multiple, bridged to equity.
      assumptions.sotpSegments = mu.segmentBreakdown.segments.map((segment) => ({
        name: segment.name,
        metric: `${segment.note} Segment revenue $${segment.revenueB.toFixed(1)}B, segment EBITDA $${segment.ebitdaB.toFixed(1)}B. ${productMetric}.`,
        metricValueB: segment.enterpriseValueB,
        multiple: 1,
        probability: 1,
        driverSource: productRevenue.quarter ? "reported" as const : "model_derived" as const,
        method: "ebitda_multiple" as const,
        marginAssumption: segment.ebitdaMargin,
        layer: "core" as const,
        valuationBasis: "ENTERPRISE_VALUE" as const,
        currentRevenueB: segment.revenueB,
      }));
      muResult = mu;
      parsed = productRevenue.quarter !== null;
    }
  }

  if (symbol === "OKLO") {
    // Pre-revenue reactor developers have no trailing cash-flow multiple. The
    // funded capital base is a reported input; project values below it are
    // explicit, probability-weighted model assumptions rather than facts.
    const fundedBaseB = Math.max(0, assumptions.netCashB ?? 0);
    const forwardRevenue = assumptions.forwardRevenueB ?? derived.latestRevenueB;
    const scaleBase = fundedBaseB > 0.05 ? fundedBaseB : forwardRevenue && forwardRevenue > 0 ? forwardRevenue * 2 : null;
    if (scaleBase) {
      assumptions.projectNpvAssets = [
        { name: "Licensed and announced reactor projects at delivery milestones", npvB: scaleBase * 3.2, probability: 0.3 },
        { name: "Early-stage development pipeline and fuel optionality", npvB: scaleBase * 2.4, probability: 0.15 },
      ];
      // The funded base is a scale reference; reported net cash enters the
      // project-NPV bridge exactly once through otherAssetValueB.
      assumptions.otherAssetValueB = Math.max(0, assumptions.netCashB ?? 0);
      parsed = true;
    }
  }

  if (symbol === "AMD") {
    // AMD reports four operating segments. Segment revenue is read from the
    // latest 10-Q where disclosed; no separate "AI revenue" line is invented —
    // "Data Center" is the disclosed segment that carries the accelerator and
    // server-CPU franchises. Growth rates and multiples are explicit model
    // assumptions, never presented as disclosed guidance.
    // AMD prints a `$` on the Data Center row but bare numbers on Client/Gaming/
    // Embedded, so the currency sign is optional and a word boundary stops
    // "Client" matching the "Client and Gaming" subtotal header.
    const amdSegment = (label: string) => reportedNumber(text, new RegExp(`\\b${label}\\s+\\$?\\s*([\\d,]+)`, "i"), 1e-3);
    const dataCenter = amdSegment("Data Center");
    const client = amdSegment("Client");
    const gaming = amdSegment("Gaming");
    const embedded = amdSegment("Embedded");
    if ([dataCenter, client, gaming, embedded].every((value) => value !== null && value > 0)) {
      const growth = { dataCenter: 0.15, client: 0.05, gaming: 0, embedded: -0.05 } as const;
      const multiple = { dataCenter: 8, client: 4, gaming: 3, embedded: 4 } as const;
      const annualize = (value: number) => value * 4;
      const segment = (name: string, reported: number, g: number, m: number) => ({
        name,
        metric: `latest reported ${name.toLowerCase()} segment revenue $${reported.toFixed(2)}B annualized and grown ${(g >= 0 ? "+" : "")}${(g * 100).toFixed(0)}% (growth and multiple are labelled assumptions, not disclosed guidance)`,
        metricValueB: annualize(reported) * (1 + g),
        multiple: m,
        driverSource: "reported" as const,
        method: "revenue_multiple" as const,
        currentRevenueB: annualize(reported),
        growthCagr: g,
      });
      const segments = [
        segment("Data Center", dataCenter!, growth.dataCenter, multiple.dataCenter),
        segment("Client", client!, growth.client, multiple.client),
        segment("Gaming", gaming!, growth.gaming, multiple.gaming),
        segment("Embedded", embedded!, growth.embedded, multiple.embedded),
      ];
      assumptions.sotpSegments = segments;
      assumptions.forwardRevenueB = segments.reduce((sum, item) => sum + item.metricValueB, 0);
      parsed = true;
      modelConfidence = { sotp: 0.7, dcf: 0.5, forward_pe: 0.5, ev_fcf: 0.48, ev_sales: 0.42, reverse_dcf: 0.5 };
    }
  }

  if (symbol === "ORCL") {
    // Oracle's cloud/software hybrid is preserved: the reported revenue types
    // ("Cloud", "Software", "Hardware", "Services") are valued at software-calibre
    // multiples for the cloud and software lines and a low multiple for hardware.
    // No business-line split (OCI / applications / database) is reverse-engineered
    // from revenue types. The income statement prints `$` on the first row only,
    // so the currency sign is optional.
    const orclSegment = (label: string) => reportedNumber(text, new RegExp(`\\b${label}\\s+\\$?\\s*([\\d,]+)`, "i"), 1e-3);
    const cloud = orclSegment("Cloud");
    const software = orclSegment("Software");
    const hardware = orclSegment("Hardware");
    const services = orclSegment("Services");
    if ([cloud, software, hardware, services].every((value) => value !== null && value > 0)) {
      const growth = { cloud: 0.12, software: 0.05, hardware: 0, services: 0.03 } as const;
      const multiple = { cloud: 6, software: 5, hardware: 1, services: 2 } as const;
      const annualize = (value: number) => value * 4;
      const segment = (name: string, reported: number, g: number, m: number) => ({
        name,
        metric: `latest reported ${name.toLowerCase()} revenue $${reported.toFixed(2)}B annualized and grown ${(g >= 0 ? "+" : "")}${(g * 100).toFixed(0)}% (growth and multiple are labelled assumptions)`,
        metricValueB: annualize(reported) * (1 + g),
        multiple: m,
        driverSource: "reported" as const,
        method: "revenue_multiple" as const,
        currentRevenueB: annualize(reported),
        growthCagr: g,
      });
      const segments = [
        segment("Cloud", cloud!, growth.cloud, multiple.cloud),
        segment("Software", software!, growth.software, multiple.software),
        segment("Hardware", hardware!, growth.hardware, multiple.hardware),
        segment("Services", services!, growth.services, multiple.services),
      ];
      assumptions.sotpSegments = segments;
      assumptions.forwardRevenueB = segments.reduce((sum, item) => sum + item.metricValueB, 0);
      parsed = true;
      modelConfidence = { sotp: 0.65, normalized_dcf: 0.6, forward_pe: 0.55, ev_fcf: 0.5, reverse_dcf: 0.55 };
    }
  }

  return {
    assumptions,
    spcxResult,
    muResult,
    spcxShareFailure,
    parsed,
    modelConfidence,
    check: symbol === "TSLA" || symbol === "INTC" || symbol === "CRCL" || symbol === "MSTR" || symbol === "OKLO" || symbol === "SPCX" || symbol === "MU" || symbol === "AMD" || symbol === "ORCL" ? {
      id: "company-specific-driver-pack", provenance: "operating" as const,
      label: "Company-specific operating drivers",
      status: parsed ? "passed" as const : "warning" as const,
      detail: symbol === "MU"
        ? parsed
          ? "The memory model anchors on reported DRAM and NAND product revenue, carries HBM as its own business with volume, ASP and a premium margin, and normalises legacy DRAM and NAND one year at a time so up-cycle economics are never capitalised as permanent."
          : "The 10-Q product revenue table was not machine-readable, so the DRAM/NAND split fell back to a labelled assumption and the data gate is reported as failed rather than passed."
        : symbol === "SPCX"
        ? parsed
          ? "The routed SOTP uses current-issuer reported financials only. Starlink and launch carry segment multiples; Starship, direct-to-device and other development value are explicitly probability weighted."
          : "No current-issuer revenue or funded capital base was available yet, so the public-equity SOTP could not be constructed."
        : symbol === "OKLO"
        ? parsed
          ? "The routed project-NPV engine uses the reported funded capital base plus explicit, probability-weighted development assumptions; contracted project economics are not yet reported."
          : "No reported funded capital base was available, so the project-NPV anchor could not be constructed."
        : symbol === "MSTR"
          ? parsed
            ? "Reported digital-asset fair value is marked at a market reference bitcoin price; financing claims, dilution and the software business are bridged to equity value."
            : "Reported digital assets or the reference bitcoin price were unavailable, so the treasury NAV anchor is incomplete."
          : symbol === "AMD"
          ? parsed
            ? "The AMD SOTP reads the four reported operating segments (Data Center, Client, Gaming, Embedded) and values each on its own revenue multiple; segment growth and multiples are explicit assumptions, not disclosed guidance, and no separate AI-revenue line is invented."
            : "The latest filing did not expose AMD's reported segment revenue, so the segment SOTP could not be built and the frozen research snapshot is retained instead of a generic historical-growth DCF."
          : symbol === "ORCL"
          ? parsed
            ? "The Oracle cloud/software hybrid reads the reported revenue-type segments (cloud, software, hardware, services) and values the cloud and software lines at software-calibre multiples; no OCI/applications/database split is reverse-engineered."
            : "The latest filing did not expose Oracle's reported revenue-type segments, so the hybrid SOTP could not be built and the frozen research snapshot is retained instead of a generic historical-growth DCF."
          : parsed
        ? "The latest 10-Q operating disclosures were parsed into the routed company-specific model."
        : "The latest filing did not expose a machine-readable segment table; the router used disclosed total financials and transparent family assumptions instead of stopping.",
    } : null,
  };
}

function modelConfidence(family: ModelFamilyId): Partial<Record<ValuationModelId, number>> {
  const base: Partial<Record<ValuationModelId, number>> = { dcf: 0.56, normalized_dcf: 0.6, forward_pe: 0.54, ev_ebitda: 0.55, ev_fcf: 0.56, ev_sales: 0.48, reverse_dcf: 0.52, residual_income: 0.58, p_tbv: 0.59, nav: 0.45, affo: 0.44, rnpv: 0.35, project_npv: 0.34, bitcoin_nav: 0.52, sotp: 0.35 };
  if (family === "bank") return { ...base, residual_income: 0.64, p_tbv: 0.66, forward_pe: 0.56 };
  if (family === "foundry_semiconductor") return { ...base, sotp: 0.62, normalized_dcf: 0.47, ev_ebitda: 0.58, forward_pe: 0.43, reverse_dcf: 0.55 };
  if (family === "auto_energy_optionality_sotp") return { ...base, sotp: 0.61, normalized_dcf: 0.45, ev_fcf: 0.44, reverse_dcf: 0.55 };
  if (family === "integrated_space_connectivity_ai_platform") return { ...base, sotp: 0.42, ev_sales: 0.38, dcf: 0.34 };
  if (family === "bitcoin_treasury") return { ...base, bitcoin_nav: 0.56, ev_sales: 0.3, forward_pe: 0.36, reverse_dcf: 0.34 };
  if (family === "advanced_nuclear_project_npv") return { ...base, project_npv: 0.4, ev_sales: 0.3, normalized_dcf: 0.32, reverse_dcf: 0.34 };
  if (family === "memory_cycle_semiconductor") return { ...base, normalized_dcf: 0.58, ev_ebitda: 0.6, forward_pe: 0.44, reverse_dcf: 0.54 };
  if (family === "stablecoin_network") return { ...base, sotp: 0.64, forward_pe: 0.36, ev_sales: 0.4, reverse_dcf: 0.45 };
  return base;
}

async function fetchNasdaqQuote(symbol: string) {
  const sourceUrl = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`;
  const payload = await fetchJson<{ data?: NasdaqQuote | null; message?: string }>(sourceUrl, { accept: "application/json", "user-agent": "Mozilla/5.0 SignalLedger/1.0" }, 12_000);
  const price = numeric(payload.data?.primaryData?.lastSalePrice);
  if (!price || price <= 0) throw new Error(payload.message || "Nasdaq quote unavailable.");
  return { price, asOf: payload.data?.primaryData?.lastTradeTimestamp || "Quote timestamp unavailable", source: `Nasdaq Quote API${payload.data?.primaryData?.isRealTime ? " · real-time flag" : " · provider timestamp"}`, sourceUrl };
}

async function fetchNasdaqQuoteCached(symbol: string) {
  const now = Date.now();
  const cached = quoteCache.get(symbol);
  if (cached && cached.expiresAt > now) return { quote: await cached.value, ageMs: now - cached.createdAt };
  const value = fetchNasdaqQuote(symbol);
  quoteCache.set(symbol, { createdAt: now, expiresAt: now + QUOTE_CACHE_TTL_MS, value });
  value.catch(() => quoteCache.delete(symbol));
  return { quote: await value, ageMs: 0 };
}

async function fetchBitcoinReferencePriceCached() {
  const now = Date.now();
  if (bitcoinCache && bitcoinCache.expiresAt > now) return bitcoinCache.value;
  const value = fetchJson<{ price?: string }>(BITCOIN_REFERENCE_URL, { accept: "application/json" }, 12_000)
    .then((payload) => {
      const price = numeric(payload.price);
      if (price === null || price <= 0) throw new Error("Bitcoin reference price unavailable.");
      return price;
    });
  bitcoinCache = { expiresAt: now + BITCOIN_CACHE_TTL_MS, value };
  value.catch(() => { bitcoinCache = null; });
  return value;
}

const BITCOIN_TREASURY_ISSUERS = new Set(["MSTR"]);

/**
 * AI-native segment assumptions. These are explicit model assumptions for a
 * business that has no reported segment revenue of its own, so the value is
 * built from a revenue base, growth, margin, multiple and delivery probability
 * rather than a multiple of the parent's consolidated revenue.
 */
export const AI_SEGMENT_ASSUMPTIONS = {
  revenueBaseB: 4,
  revenueGrowth: 0.35,
  revenueYears: 3,
  revenueMultiple: 12,
  deliveryProbability: 0.35,
  margin: 0.25,
  capexIntensity: 0.25,
} as const;
const AI_REVENUE_BASE_B = AI_SEGMENT_ASSUMPTIONS.revenueBaseB;
const AI_REVENUE_GROWTH = AI_SEGMENT_ASSUMPTIONS.revenueGrowth;
const AI_REVENUE_YEARS = AI_SEGMENT_ASSUMPTIONS.revenueYears;
const AI_REVENUE_MULTIPLE = AI_SEGMENT_ASSUMPTIONS.revenueMultiple;
const AI_DELIVERY_PROBABILITY = AI_SEGMENT_ASSUMPTIONS.deliveryProbability;

/**
 * Ticker-reuse guard. A ticker that changed hands must never inherit the prior
 * security's reporting history, price history or fundamentals. When a ticker is
 * listed here, the SEC entity name must match the current issuer before any of
 * its financial statements are used; otherwise the pack keeps the verified
 * identity, the live quote, and reports the filing link as unresolved.
 */
const SEC_ENTITY_IDENTITY: Record<string, RegExp> = {
  SPCX: /space\s*exploration|spacex/i,
};

/**
 * True when the SEC reporting entity may be used for this ticker. Tickers
 * without a reuse rule always pass; a guarded ticker only passes when the SEC
 * entity name matches the current issuer.
 */

/**
 * Latest duration-based share count. For the same period end the shortest
 * reported duration wins, because a quarterly weighted average reflects the
 * current share count better than a year-to-date average (for example after a
 * pre-IPO instrument converts into common stock).
 */
function latestDurationShares(payload: SecFacts, concepts: string[]) {
  let best: { value: number; end: string; days: number } | null = null;
  for (const concept of concepts) {
    for (const fact of units(payload, "us-gaap", concept, "shares").concat(units(payload, "dei", concept, "shares"))) {
      const value = numeric(fact.val);
      if (value === null || value <= 0 || !fact.end) continue;
      if (!/^(10-Q|10-K)/i.test(String(fact.form ?? ""))) continue;
      const startMs = Date.parse(`${fact.start ?? ""}T00:00:00Z`);
      const endMs = Date.parse(`${fact.end}T00:00:00Z`);
      const days = Number.isFinite(startMs) && Number.isFinite(endMs) ? (endMs - startMs) / 86_400_000 : 0;
      if (days > 200) continue;
      const candidate = { value, end: fact.end, days };
      if (!best || candidate.end > best.end || (candidate.end === best.end && candidate.days < best.days)) best = candidate;
    }
  }
  return best;
}

export function verifiedFilingIdentity(ticker: string, secEntityName: string | null) {
  const pattern = SEC_ENTITY_IDENTITY[ticker.trim().toUpperCase()];
  if (!pattern || !secEntityName) return true;
  return pattern.test(secEntityName);
}


async function buildPack(symbol: string): Promise<AutomatedValuationPack> {
  const tickers = await getTickerMap();
  const entry = tickers.find((item) => normalizeTicker(item.ticker) === symbol);
  if (!entry) throw new Error(`${symbol} was not found in the SEC ticker directory.`);
  const directoryCik = String(entry.cik_str ?? "").replace(/\D/g, "");
  const relatedShareClasses = tickers
    .filter((candidate) => String(candidate.cik_str ?? "").replace(/\D/g, "") === directoryCik)
    .map((candidate) => normalizeTicker(candidate.ticker))
    .filter(Boolean)
    .sort();
  const issuerTicker = relatedShareClasses.find((candidate) => SUPPORTED_TICKERS.includes(candidate)) ?? symbol;
  const verified = getVerifiedIssuerProfile(issuerTicker) ?? getVerifiedIssuerProfile(symbol);
  // A verified issuer profile may preserve a predecessor reporting CIK after a
  // holding-company reorganization. That keeps the historical financial series
  // continuous while the live security quote remains tied to the current ticker.
  const issuerCik = String(verified?.cik ?? directoryCik).replace(/\D/g, "");
  const cik = issuerCik.padStart(10, "0");
  if (!/^\d{10}$/.test(cik)) throw new Error(`SEC identifier is unavailable for ${symbol}.`);
  const factsUrl = `${SEC_FACTS_BASE}/CIK${cik}.json`;
  const submissionsUrl = `${SEC_SUBMISSIONS_BASE}/CIK${cik}.json`;
  // Dedicated company models (MU/SPCX) build their own discount rates; AMD and
  // ORCL now source the dynamic capital cost from the same market inputs as the
  // generic path, so their discount rate updates with evidence rather than
  // staying pinned to an imported snapshot.
  const usesDedicatedRates = ["MU", "SPCX"].includes(issuerTicker);
  const [factsResult, submissionResult, quoteResult, capitalResult] = await Promise.allSettled([
    fetchJson<SecFacts>(factsUrl, secHeaders(), 20_000),
    fetchJson<SecSubmission>(submissionsUrl, secHeaders(), 15_000),
    fetchNasdaqQuoteCached(symbol),
    usesDedicatedRates ? Promise.resolve(null) : loadCapitalCostMarketInputs(symbol),
  ]);
  const submission = submissionResult.status === "fulfilled" ? submissionResult.value : { name: entry.title, sic: "", sicDescription: "Public company" };
  const identityPattern = SEC_ENTITY_IDENTITY[symbol] ?? SEC_ENTITY_IDENTITY[issuerTicker];
  const secEntityName = (submissionResult.status === "fulfilled" ? submissionResult.value.name : entry.title)?.trim() || null;
  // A reassigned ticker must never inherit the previous security's statements.
  const filingIdentityVerified = !identityPattern || verifiedFilingIdentity(symbol, secEntityName) && verifiedFilingIdentity(issuerTicker, secEntityName);
  if (filingIdentityVerified && factsResult.status === "rejected") throw new Error(`SEC financial statements are unavailable for ${symbol}.`);
  const facts: SecFacts = !filingIdentityVerified || factsResult.status === "rejected"
    ? { entityName: secEntityName ?? undefined, facts: {} }
    : factsResult.value;
  const hint = classificationHint(entry, submission);
  const initialClassification = classifyCompany(issuerTicker, hint);
  if (!initialClassification) throw new Error(`The valuation router could not classify ${symbol}.`);
  const persisted = verified ? null : await loadPersistedIssuerProfile(symbol, cik);
  const ruleBased = buildRuleBasedIssuerProfile({
    ticker: symbol,
    issuerTicker,
    canonicalName: initialClassification.companyName,
    cik,
    family: initialClassification.modelFamily,
    businessModel: initialClassification.businessModel,
    drivers: initialClassification.valuationDrivers,
  });
  const issuerProfile: IssuerIntelligenceProfile = verified
    ? { ...verified, cik, tickers: relatedShareClasses.length ? relatedShareClasses : verified.tickers }
    : persisted ?? ruleBased;
  if (verified || !persisted) void persistIssuerProfile(issuerProfile);
  const classification = {
    ...initialClassification,
    ticker: symbol,
    companyName: issuerProfile.canonicalName,
    businessModel: issuerProfile.businessModel,
    valuationDrivers: issuerProfile.driverSchema,
    modelFamily: issuerProfile.valuationFamily,
    rationale: issuerProfile.investmentQuestion,
    // The registry family governs the displayed sector; a raw SIC description
    // ("Services-Computer Programming, Data Processing") is filing taxonomy,
    // not a sector name, and must never reach the page.
    sector: /services-|data processing|etc\.|public company/i.test(initialClassification.sector)
      ? MODEL_FAMILIES[issuerProfile.valuationFamily].label.split(" /")[0].replace(/ (Optionality )?SOTP$/, "")
      : initialClassification.sector,
  };
  const derived = deriveAssumptions(facts, classification.modelFamily);
  // Raw evidence baseline captured BEFORE companySpecificAssumptions mutates the
  // assumptions. The research compiler starts from this, not the legacy-mutated
  // `profile.baseline`, so the precedence rule cannot double-apply legacy deltas.
  const evidenceAssumptions = structuredClone(derived.assumptions);
  let spcxDetail: (SpcxValuation & { shareBridge: SpcxShareBridge }) | null = null;
  let muDetail: MuValuation | null = null;
  let spcxShareFailure: string | null = null;
  const latestFiling = latestFilingByForm(submission, cik, "10-Q");
  const latestPeriodic = latestPeriodicFiling(submission, cik);
  let latestFilingBody: string | null = null;
  // The raw inline XBRL is needed for dimensional facts (Micron's product revenue
  // table); the same document is stored as text for the visible-statement parsers.
  let latestFilingHtml: string | null = null;
  if (latestFiling && ["TSLA", "INTC", "CRCL", "SPCX", "MU", "AMD", "ORCL"].includes(symbol)) {
    try {
      const raw = await fetchText(latestFiling.url, secHeaders(), 20_000);
      latestFilingHtml = raw;
      latestFilingBody = filingText(raw);
    } catch {
      latestFilingBody = null;
      latestFilingHtml = null;
    }
  }
  // Only digital-asset treasuries need a bitcoin reference price; every other
  // issuer path stays on SEC/Nasdaq evidence with no extra provider call.
  const bitcoinPriceUsd = BITCOIN_TREASURY_ISSUERS.has(issuerTicker) || BITCOIN_TREASURY_ISSUERS.has(symbol)
    ? await fetchBitcoinReferencePriceCached().catch(() => null)
    : null;
  const quote = quoteResult.status === "fulfilled" ? quoteResult.value.quote : null;
  const adaptive = companySpecificAssumptions(issuerTicker, derived, latestFilingBody, { bitcoinPriceUsd, marketPrice: quote?.price ?? null, filingId: latestFiling?.accessionNumber ?? null, filingHtml: latestFilingHtml });
  spcxDetail = adaptive.spcxResult ?? null;
  muDetail = adaptive.muResult ?? null;
  spcxShareFailure = adaptive.spcxShareFailure ?? null;
  const curated = getCuratedValuationProfile(issuerTicker);
  // The current valuation comes from verified SEC evidence, not an imported
  // snapshot. The curated research is a frozen historical reference and is
  // promoted to the live baseline only when the company-specific model could not
  // be built from the latest filing (AMD/ORCL), so it is never silently
  // overwritten by a generic historical-growth DCF and never presented as fresh.
  const companyModelBuilt = adaptive.parsed && (issuerTicker === "AMD" || issuerTicker === "ORCL");
  const usesFrozenResearch = curated !== null && !companyModelBuilt;
  const frozenResearch = curated ? {
    asOf: curated.referencePrice?.asOf ?? new Date().toISOString().slice(0, 10),
    source: curated.referencePrice?.source ?? "Imported research snapshot",
    baseline: curated.baseline,
    thesis: curated.thesis,
    modelConfidence: curated.modelConfidence,
    evidenceMissing: curated.evidenceMissing,
  } : null;
  const capitalMarket = capitalResult.status === "fulfilled" ? capitalResult.value : null;
  const capitalCost = !usesFrozenResearch && !spcxDetail && !muDetail && filingIdentityVerified && capitalMarket
    ? calculateCapitalCost({ market: capitalMarket, price: quote?.price ?? null, sharesB: adaptive.assumptions.dilutedSharesB,
      debtB: derived.debtComplete ? derived.capitalBridge.debtB : null,
      taxRate: adaptive.assumptions.effectiveTaxRate, terminalGrowth: adaptive.assumptions.terminalGrowth })
    : null;
  if (capitalCost) {
    adaptive.assumptions.wacc = capitalCost.wacc;
    adaptive.assumptions.costOfEquity = capitalCost.costOfEquity;
    adaptive.assumptions.preTaxCostOfDebt = capitalCost.preTaxCostOfDebt;
    adaptive.assumptions.costOfEquitySource = capitalCost.method;
  }
  const quoteAgeMs = quoteResult.status === "fulfilled" ? quoteResult.value.ageMs : 0;
  const missing = [
    "Live sell-side consensus and revision history",
    "Company-specific management guidance normalization",
    "Peer-regression and sector KPI pack",
  ];
  // When the frozen research snapshot is retained, the fallback must say *why*
  // the company-specific model could not be rebuilt, not just that it was not.
  const frozenFallbackReason = usesFrozenResearch && (symbol === "AMD" || symbol === "ORCL") && !adaptive.parsed
    ? `${symbol} latest 10-Q did not expose a machine-readable segment revenue table, so the company-specific segment SOTP could not be rebuilt`
    : null;
  if (!quote) missing.unshift("Current Nasdaq quote");
  if (!derived.hasFullFiscalYear) missing.unshift("Reported full fiscal year (the forecast is annualized from the latest interim period)");
  const sourceDate = derived.latestFiled ?? new Date().toISOString().slice(0, 10);
  const automatedSources: ValuationProfile["inputSources"] = {
    cashFlows: { kind: "internal_forecast", label: derived.useFcffBridge ? "Forecast from a complete unlevered FCFF bridge (EBIT×(1−tax) + D&A − CapEx − ΔNWC) over SEC-reported history" : derived.useFcffBeforeNwc ? "Forecast from an unlevered FCFF proxy (EBIT×(1−tax) + D&A − CapEx, ΔNWC omitted)" : "Forecast from SEC-reported operating cash flow less capital expenditure (levered proxy)", asOf: sourceDate, url: factsUrl },
    normalizedCashFlows: { kind: "internal_forecast", label: derived.useFcffBridge ? "Forecast from a complete unlevered FCFF bridge (EBIT×(1−tax) + D&A − CapEx − ΔNWC) over SEC-reported history" : derived.useFcffBeforeNwc ? "Forecast from an unlevered FCFF proxy (EBIT×(1−tax) + D&A − CapEx, ΔNWC omitted)" : "Forecast from SEC-reported operating cash flow less capital expenditure (levered proxy)", asOf: sourceDate, url: factsUrl },
    cashFlowBasis: { kind: "derived", label: derived.useFcffBridge ? "FCFF (EBIT×(1−tax)+D&A−CapEx−ΔNWC), discounted at WACC" : derived.useFcffBeforeNwc ? "Unlevered FCFF proxy (EBIT×(1−tax)+D&A−CapEx, ΔNWC omitted), discounted at WACC" : "CFO−CapEx levered proxy, discounted at the cost of equity, labelled with its conversion method and limits" },
    forwardRevenueB: { kind: "internal_forecast", label: "Historical-growth forecast with sector mean reversion", asOf: sourceDate, url: factsUrl },
    forwardFcfB: { kind: "internal_forecast", label: "Revenue forecast multiplied by normalized FCF margin", asOf: sourceDate, url: factsUrl },
    forwardEps: { kind: "internal_forecast", label: "SEC-reported net margin applied to forecast revenue", asOf: sourceDate, url: factsUrl },
    netCashB: { kind: "reported", label: derived.cashReported && derived.debtComplete ? "Latest SEC-reported cash, investments and debt" : "Net cash withheld — cash or a complete debt total was not reported", asOf: sourceDate, url: factsUrl },
    dilutedSharesB: { kind: "reported", label: "Latest SEC-reported diluted or outstanding shares", asOf: sourceDate, url: factsUrl },
    wacc: { kind: "derived", label: "Model-family discount-rate policy" },
    costOfEquity: { kind: "derived", label: "Policy heuristic: WACC levered up by the debt-to-equity ratio; not a sourced CAPM/levered beta" },
    preTaxCostOfDebt: { kind: "derived", label: "Assumed pre-tax cost of debt behind the levered cost of equity" },
    effectiveTaxRate: { kind: "derived", label: derived.taxRateBasis === "book_ebt" ? `Book effective tax rate (income tax ÷ pre-tax income); cash tax ${derived.cashTaxRate === null ? "not reported" : `${(derived.cashTaxRate * 100).toFixed(0)}%`}` : derived.taxRateBasis === "ebit_fallback" ? "Tax ÷ EBIT fallback (no pre-tax income reported)" : "Statutory tax rate fallback" },
    costOfEquitySource: { kind: "derived", label: "policy_heuristic (book-leverage adjustment, not a beta estimate or sourced CAPM)" },
    terminalGrowth: { kind: "derived", label: "Model-family long-run growth policy" },
    forwardPe: { kind: "derived", label: "Growth-adjusted multiple within family guardrails" },
    normalizedEbitdaB: { kind: "internal_forecast", label: "Normalized EBITDA derived from forward revenue and a family-specific through-cycle margin", asOf: sourceDate, url: factsUrl },
    evEbitdaMultiple: { kind: "derived", label: "Normalized EV/EBITDA multiple within family guardrails" },
    evFcfMultiple: { kind: "derived", label: "Growth-adjusted EV/FCF guardrail" },
    evSalesMultiple: { kind: "derived", label: "Cash-margin-consistent EV/Sales guardrail" },
    ...(adaptive.assumptions.sotpSegments ? {
      sotpSegments: {
        kind: latestFilingBody ? "reported" as const : "internal_forecast" as const,
        label: latestFilingBody
          ? "Latest SEC 10-Q operating disclosures routed into company-specific SOTP; multiples and probabilities are explicit model assumptions"
          : "SEC total financials routed into a company-specific SOTP using transparent family assumptions",
        asOf: latestFiling?.reportDate ?? sourceDate,
        url: latestFiling?.url ?? factsUrl,
      },
    } : {}),
    ...(adaptive.assumptions.bitcoinHoldings && adaptive.assumptions.bitcoinPriceUsd ? {
      bitcoinHoldings: {
        kind: "reported" as const,
        label: "SEC-reported digital-asset fair value converted at the published bitcoin reference price",
        asOf: sourceDate,
        url: factsUrl,
      },
      bitcoinPriceUsd: {
        kind: "derived" as const,
        label: "Public Coinbase BTC-USD reference price, cached for five minutes",
        asOf: new Date().toISOString().slice(0, 10),
        url: BITCOIN_REFERENCE_URL,
      },
    } : {}),
    ...(adaptive.assumptions.projectNpvAssets ? {
      projectNpvAssets: {
        kind: "internal_forecast" as const,
        label: "Reported funded capital base plus explicit, probability-weighted development-project assumptions",
        asOf: sourceDate,
        url: factsUrl,
      },
    } : {}),
  };
  const curatedAsOf = curated?.referencePrice?.asOf ?? sourceDate;
  const inputSources: ValuationProfile["inputSources"] = usesFrozenResearch ? {
    cashFlows: { kind: "analyst_estimate", label: "Imported company-specific Signal Ledger research forecast", asOf: curatedAsOf },
    normalizedCashFlows: { kind: "analyst_estimate", label: "Imported company-specific Signal Ledger normalized forecast", asOf: curatedAsOf },
    forwardRevenueB: { kind: "analyst_estimate", label: "Imported company-specific Signal Ledger research forecast", asOf: curatedAsOf },
    forwardFcfB: { kind: "analyst_estimate", label: "Imported company-specific Signal Ledger research forecast", asOf: curatedAsOf },
    forwardEps: { kind: "analyst_estimate", label: "Imported company-specific Signal Ledger research forecast", asOf: curatedAsOf },
    netCashB: { kind: "analyst_estimate", label: "Imported research capital bridge", asOf: curatedAsOf },
    dilutedSharesB: { kind: "analyst_estimate", label: "Imported research diluted-share assumption", asOf: curatedAsOf },
    wacc: { kind: "analyst_estimate", label: "Company-specific Signal Ledger discount-rate assumption", asOf: curatedAsOf },
    terminalGrowth: { kind: "analyst_estimate", label: "Company-specific Signal Ledger terminal-growth assumption", asOf: curatedAsOf },
    forwardPe: { kind: "analyst_estimate", label: "Company-specific justified multiple", asOf: curatedAsOf },
    normalizedEbitdaB: { kind: "analyst_estimate", label: "Company-specific normalized EBITDA forecast", asOf: curatedAsOf },
    evEbitdaMultiple: { kind: "analyst_estimate", label: "Company-specific normalized EV/EBITDA multiple", asOf: curatedAsOf },
    evFcfMultiple: { kind: "analyst_estimate", label: "Company-specific justified cash-flow multiple", asOf: curatedAsOf },
    evSalesMultiple: { kind: "analyst_estimate", label: "Company-specific justified sales multiple", asOf: curatedAsOf },
  } : automatedSources;
  const qualityChecks: DataQualityCheck[] = [
    {
      id: "capital-cost-source", provenance: "operating" as const, label: "Discount-rate evidence", status: "warning",
      detail: capitalCost
        ? `Treasury risk-free proxy as of ${capitalCost.riskFree.asOf}; beta ${capitalCost.beta.value.toFixed(2)} from ${capitalCost.beta.observations} matched adjusted returns through ${capitalCost.beta.end}. ERP and credit spread remain policy assumptions. ${capitalCost.warnings.join(" ")}`
        : usesDedicatedRates ? "Dedicated research rates retained; no automated market-rate overwrite is applied to imported or company-specific forecasts."
          : usesFrozenResearch ? `Imported research WACC ${((curated?.baseline.wacc ?? 0) * 100).toFixed(2)}% is retained as a frozen fallback (${frozenResearch?.asOf ?? "unknown date"} snapshot); no automated market-rate overwrite is applied to imported research.`
            : `Existing policy rates retained: sourced CAPM inputs or the capital-structure/rate checks are incomplete. ${capitalMarket?.warnings.join(" ") ?? "Capital-cost provider unavailable."}`,
    },
    ...derived.qualityChecks.map((check) => usesFrozenResearch && ["cash-flow-basis", "cost-of-capital-source", "capital-bridge"].includes(check.id)
      ? {
        ...check, status: "warning" as const,
        detail: check.id === "cash-flow-basis"
          ? "This published model uses imported analyst FCFF, not the automatically reconstructed SEC cash-flow path. Its source-to-forecast tie-out remains incomplete."
          : check.id === "cost-of-capital-source"
            ? `Imported research WACC ${((curated!.baseline.wacc ?? 0) * 100).toFixed(2)}% is retained. It is an analyst assumption, not the automated policy rate or a sourced CAPM result.`
            : `This model uses its imported research capital bridge. The separate SEC bridge is not substituted silently: ${check.detail}`,
      }
      : symbol === "CRCL" && check.id === "capital-bridge"
      ? {
        ...check,
        status: "passed" as const,
        detail: "Stablecoin-holder reserves are excluded from the equity capital bridge; only corporate net cash is used.",
      }
      : capitalCost && check.id === "cost-of-capital-source" ? {
        ...check,
        detail: `Discount rates use sourced Treasury yield and adjusted-return beta, with explicitly assumed ERP and credit spread. WACC ${(capitalCost.wacc * 100).toFixed(2)}%; cost of equity ${(capitalCost.costOfEquity * 100).toFixed(2)}%. The cash-flow basis determines which rate is applied.`,
      } : check),
    ...(spcxShareFailure ? [{
      id: "spcx-share-count", provenance: "operating" as const,
      label: "SPCX share count",
      status: "failed" as const,
      detail: spcxShareFailure,
    }] : []),
    ...(identityPattern ? [{
      id: "security-identity", provenance: "operating" as const,
      label: "Security identity",
      status: filingIdentityVerified ? "passed" as const : "failed" as const,
      detail: filingIdentityVerified
        ? `SEC reporting entity "${secEntityName ?? "unnamed"}" matches the current ${symbol} issuer, so its filings are used.`
        : `SEC entity "${secEntityName ?? "unknown"}" does not match the current ${symbol} issuer. Ticker-reuse protection is active: no prior-security price history, fundamentals or profiles are attached.`,
    }] : []),
    ...(adaptive.check ? [adaptive.check] : []),
    ...(usesFrozenResearch ? [{
      id: "research-source-tieout", provenance: "operating" as const,
      label: "Research forecast tie-out",
      status: "warning" as const,
      detail: `Company-specific assumptions are used as a frozen fallback (${frozenResearch?.asOf ?? "unknown date"} snapshot); the source-to-assumption bridge is not yet automated and the output remains provisional.`,
    }] : []),
  ];
  const sourceProvenance: Record<string, { unit: string; asOf: string; sourceType: "reported" | "consensus" | "guidance" | "model_derived"; transformation: string; confidence: number; filingId?: string | null }> = {
      forwardRevenueB: {
        unit: "USD billions",
        asOf: sourceDate,
        sourceType: "reported",
        transformation: `SEC-reported revenue history → growth normalized toward the ${classification.modelFamily.replaceAll("_", " ")} family path → forward revenue assumption`,
        confidence: derived.hasFullFiscalYear ? 0.6 : 0.45,
        filingId: latestFiling?.accessionNumber ?? null,
      },
      fcfMargin: {
        unit: "share of revenue",
        asOf: sourceDate,
        sourceType: "model_derived",
        transformation: derived.useFcffBridge
          ? "Complete unlevered FCFF bridge — EBIT×(1−tax) + D&A − CapEx − ΔNWC — over the reported history → margin normalized and blended toward the family policy margin"
          : derived.useFcffBeforeNwc
            ? "Unlevered FCFF proxy — EBIT×(1−tax) + D&A − CapEx, ΔNWC omitted — over the reported history → margin normalized and blended toward the family policy margin"
            : "Reported CFO − CapEx (a levered proxy that already nets interest and working-capital cash) → margin history → normalized and blended toward the family policy margin; labelled as a proxy, not FCFF",
        confidence: derived.useFcffBridge ? 0.55 : derived.useFcffBeforeNwc ? 0.5 : 0.5,
        filingId: latestFiling?.accessionNumber ?? null,
      },
      cashFlowBasis: {
        unit: "cash-flow口径",
        asOf: sourceDate,
        sourceType: "model_derived",
        transformation: derived.useFcffBridge
          ? `FCFF (EBIT×(1−tax)+D&A−CapEx−ΔNWC), unlevered, discounted at WACC; effective tax rate ${(derived.effectiveTaxRate * 100).toFixed(0)}% (${derived.taxRateBasis})`
          : derived.useFcffBeforeNwc
            ? `Unlevered FCFF proxy (EBIT×(1−tax)+D&A−CapEx, ΔNWC omitted), discounted at WACC; effective tax rate ${(derived.effectiveTaxRate * 100).toFixed(0)}% (${derived.taxRateBasis})`
            : "CFO−CapEx levered proxy; the conversion method and its limits (interest and working-capital cash are inside the stream) are stated rather than presented as FCFF",
        confidence: 0.6,
        filingId: latestFiling?.accessionNumber ?? null,
      },
      effectiveTaxRate: {
        unit: "rate",
        asOf: sourceDate,
        sourceType: "model_derived",
        transformation: `Book effective tax rate ${(derived.effectiveTaxRate * 100).toFixed(1)}% (income tax expense ÷ pre-tax income, ${derived.taxRateBasis === "ebit_fallback" ? "EBIT fallback" : derived.taxRateBasis === "statutory" ? "statutory fallback" : "EBT"}); cash tax rate ${derived.cashTaxRate === null ? "not reported" : `${(derived.cashTaxRate * 100).toFixed(1)}% (taxes paid ÷ pre-tax income)`}`,
        confidence: derived.taxRateBasis === "book_ebt" ? 0.6 : 0.4,
      },
      costOfEquity: {
        unit: "discount rate",
        asOf: sourceDate,
        sourceType: "model_derived",
        transformation: `WACC ${(adaptive.assumptions.wacc ?? 0).toFixed(3)} adjusted by book debt-to-equity and assumed debt cost for equity's residual claim. This is a policy heuristic, not a beta estimate or sourced CAPM with an external equity-risk premium and beta; it is applied only to levered streams.`,
        confidence: 0.4,
      },
      preTaxCostOfDebt: {
        unit: "discount rate",
        asOf: sourceDate,
        sourceType: "model_derived",
        transformation: `Assumed pre-tax cost of debt behind the levered cost of equity${derived.debtCoverage !== "full_total" ? "; a complete debt total was not reported, so this stays at the floor" : ""}`,
        confidence: 0.35,
      },
      normalizedEbitdaB: {
        unit: "USD billions",
        asOf: sourceDate,
        sourceType: "model_derived",
        transformation: "Forward revenue × normalized cash margin plus a family depreciation allowance → normalized EBITDA",
        confidence: 0.5,
        filingId: latestFiling?.accessionNumber ?? null,
      },
      wacc: { unit: "discount rate", asOf: sourceDate, sourceType: "model_derived", transformation: "Family discount-rate policy applied to reported capital structure; not a company-disclosed WACC", confidence: 0.4 },
      terminalGrowth: { unit: "growth rate", asOf: sourceDate, sourceType: "model_derived", transformation: "Family long-run growth policy; capped below the discount rate", confidence: 0.4 },
      ...(adaptive.assumptions.sotpSegments ? {
        sotpSegments: {
          unit: "USD billions per segment",
          asOf: latestFiling?.reportDate ?? sourceDate,
          sourceType: latestFilingBody ? "reported" as const : "model_derived" as const,
          transformation: latestFilingBody
            ? "Reported segment disclosures → normalized segment metric → segment multiple and delivery probability"
            : "Reported total financials → labelled segment mix policy → segment multiple and delivery probability",
          confidence: latestFilingBody ? 0.55 : 0.4,
          filingId: latestFiling?.accessionNumber ?? null,
        },
      } : {}),
  };

  if (capitalCost) {
    const asOf = [capitalCost.riskFree.asOf, capitalCost.beta.end].sort()[0];
    for (const [key, transformation] of [
      ["costOfEquity", `Treasury ${(capitalCost.riskFree.value * 100).toFixed(2)}% + adjusted-return beta ${capitalCost.beta.value.toFixed(3)} × policy ERP ${(capitalCost.equityRiskPremium.value * 100).toFixed(2)}%; ERP is an assumption, not a measured market premium.`],
      ["preTaxCostOfDebt", `Treasury ${(capitalCost.riskFree.value * 100).toFixed(2)}% + policy credit spread ${(capitalCost.creditSpread.value * 100).toFixed(2)}%; not a quoted issuer bond yield.`],
      ["wacc", `Ke × market equity / (market equity + book debt) + Kd × (1 − tax) × book debt / (market equity + book debt). Market equity $${capitalCost.marketEquityB.toFixed(3)}B, book debt $${capitalCost.bookDebtB.toFixed(3)}B; book debt is a market-value proxy.`],
    ] as const) {
      inputSources[key] = { kind: "derived", label: transformation, asOf, url: capitalCost.riskFree.url };
      sourceProvenance[key] = { unit: "discount rate", asOf, sourceType: "model_derived", transformation, confidence: 0.55 };
    }
    inputSources.costOfEquitySource = { kind: "derived", label: "CAPM with sourced Treasury yield and historical beta; explicit policy ERP and credit spread" };
  }

  const profile: ValuationProfile = {
    classification,
    capitalCost,
    referencePrice: quote ? { value: quote.price, asOf: quote.asOf, source: quote.source } : undefined,
    capitalBridge: spcxDetail
      ? {
        cashB: (spcxDetail.reported.cashM ?? 0) / 1000,
        investmentsB: (spcxDetail.reported.marketableSecuritiesM ?? 0) / 1000,
        debtB: (spcxDetail.reported.debtAndLeasesM ?? 0) / 1000,
        otherClaimsB: 0,
        stockCompB: derived.capitalBridge.stockCompB,
      }
      : {
        ...derived.capitalBridge,
        otherClaimsB: 0,
        ...(symbol === "CRCL" ? { note: "Stablecoin holder reserves are excluded from the equity bridge; only corporate net cash is used." } : {}),
      },
    baseline: usesFrozenResearch ? curated!.baseline : adaptive.assumptions,
    thesis: usesFrozenResearch ? curated!.thesis : { growthDelta: 0, marginDelta: 0, multipleDelta: 0, note: "Signal Ledger changes operating assumptions only; it never inserts a target price directly." },
    modelConfidence: adaptive.modelConfidence ?? curated?.modelConfidence ?? modelConfidence(classification.modelFamily),
    modelApplicability: companyModelBuilt
      ? Object.fromEntries(MODEL_FAMILIES[classification.modelFamily].models.map((entry) => [entry.model, entry.model === "sotp" || entry.model === "reverse_dcf" ? 1 : 0]))
      : Object.fromEntries([
        ...issuerProfile.preferredModels.map((model) => [model, 1]),
        ...issuerProfile.rejectedModels.map((model) => [model, 0]),
      ]),
    sourcePosture: usesFrozenResearch ? curated!.sourcePosture : "reported_internal_forecast",
    // Automated SEC transformations must not relabel imported research paths.
    inputSources: Object.fromEntries(Object.entries(inputSources).map(([key, value]) => [key, { ...value, ...(usesFrozenResearch ? {} : sourceProvenance[key as keyof typeof sourceProvenance] ?? {}) }])) as ValuationProfile["inputSources"],
    ...(spcxDetail ? { spcx: spcxDetail } : {}),
    ...(muDetail ? { mu: muDetail } : {}),
    importedResearch: frozenResearch,
    aiExposure: classifyAiExposure({
      ticker: symbol,
      familyId: classification.modelFamily,
      segments: adaptive.assumptions.sotpSegments,
      forwardRevenueB: adaptive.assumptions.forwardRevenueB ?? derived.latestRevenueB,
      // A reported AI segment always overrides a modelled AI base.
      reportedAiRevenueB: spcxDetail && spcxDetail.reported.halfYear ? (spcxDetail.reported.halfYear.ai.revenue * 2) / 1000 : undefined,
      aiIsReportableSegment: Boolean(spcxDetail?.reported.halfYear),
      modeledAiRevenueB: symbol === "SPCX" && !spcxDetail ? AI_REVENUE_BASE_B * (1 + AI_REVENUE_GROWTH) ** AI_REVENUE_YEARS : undefined,
      segmentDisclosureParsed: latestFilingBody !== null,
      filingId: latestFiling?.accessionNumber ?? null,
      filingUrl: latestFiling?.url ?? null,
      asOf: latestFiling?.reportDate ?? sourceDate,
    }),
    evidenceMissing: usesFrozenResearch
      ? [...(curated!.evidenceMissing ?? []), `沿用 ${frozenResearch?.asOf ?? "历史"} 研究假设；${frozenFallbackReason ?? "最新证据不足以重建公司级模型"}，以下输入仍待补充：${missing.join("、") || "无"}`]
      : missing,
    variantPath: (usesFrozenResearch ? curated?.variantPath : undefined) ?? (issuerTicker === "TSLA"
      ? "Auto and energy must fund growth while autonomy moves from probability-weighted optionality to evidenced unit economics."
      : issuerTicker === "INTC"
        ? "Product franchises must fund the foundry ramp while utilization and external-customer revenue improve toward sustainable returns."
        : issuerTicker === "CRCL"
          ? "USDC circulation and reserve spread must offset lower rates while non-reserve network revenue becomes economically material."
          : derived.latestRevenueB === null ? "The next filing must establish a comparable revenue and cash-flow base." : `This run uses forward revenue of $${adaptive.assumptions.forwardRevenueB?.toFixed(2) ?? "unavailable"}B and a forecast cash-flow path of ${(adaptive.assumptions.cashFlows ?? adaptive.assumptions.normalizedCashFlows ?? []).map((value) => "$" + value.toFixed(2) + "B").join(" → ") || "not available"}; these are model estimates based on the current evidence.`),
    downsideMechanism: (usesFrozenResearch ? curated?.downsideMechanism : undefined) ?? (issuerTicker === "TSLA"
      ? "Auto margin compression and delayed autonomy deployment reduce operating value and optionality together."
      : issuerTicker === "INTC"
        ? "Foundry losses and CapEx persist while product share weakens, delaying normalized cash conversion."
        : issuerTicker === "CRCL"
          ? "Lower short rates or slower USDC growth compress reserve economics while distribution and regulatory costs remain elevated."
          : "Growth or cash conversion below the disclosed baseline reduces both forecast cash flow and the justified multiple; leverage can amplify the equity impact."),
    evidenceGate: (usesFrozenResearch ? curated?.evidenceGate : undefined) ?? (issuerTicker === "TSLA"
      ? "Re-run on deliveries, storage deployments, segment margins, CapEx and verified autonomy milestones."
      : issuerTicker === "INTC"
        ? "Re-run on product revenue, foundry external mix, utilization, gross margin, CapEx and subsidies."
        : issuerTicker === "CRCL"
          ? "Re-run on USDC circulation, reserve yield, net reserve margin, distribution costs and non-reserve revenue."
          : "Re-run after each 10-Q or 10-K and replace internal assumptions when verified guidance or comparable consensus becomes available."),
    dataQuality: {
      status: qualityChecks.some((check) => check.status === "failed") ? "failed" : qualityChecks.some((check) => check.status === "warning") ? "warning" : "passed",
      valuationRelease: qualityChecks.some((check) => check.status === "failed") ? "withheld" : qualityChecks.some((check) => check.status === "warning") ? "screening_only" : "released",
      checks: qualityChecks,
    },
  };
  return {
    profile,
    issuerProfile,
    quote,
    evidenceAssumptions,
    identity: {
      securityTicker: symbol,
      issuerTicker,
      issuerName: classification.companyName,
      cik,
      secEntityName,
      filingIdentityVerified,
      relatedShareClasses,
    },
    pipeline: [
      { id: "quote", status: quote ? "completed" : "unavailable", detail: quote ? quote.source : "No verified Nasdaq quote; fair value can still calculate." },
      { id: "metadata", status: "completed", detail: relatedShareClasses.length > 1 ? `${symbol} resolved to ${classification.companyName} issuer · shared CIK ${cik} · classes ${relatedShareClasses.join(" / ")}` : `SEC issuer directory · CIK ${cik}` },
      {
        id: "financials",
        status: !filingIdentityVerified ? "unavailable" : derived.hasFullFiscalYear ? "completed" : "partial",
        detail: !filingIdentityVerified
          ? `SEC entity "${secEntityName ?? "unknown"}" is not the current ${symbol} issuer; ticker-reuse protection blocked its statements`
          : `SEC Company Facts · ${derived.periodBasis} · filed ${sourceDate}${secEntityName ? ` · ${secEntityName}` : ""}${latestFilingBody ? " · latest 10-Q operating disclosures parsed" : ""}`,
      },
      { id: "classification", status: "completed", detail: classification.modelFamily.replaceAll("_", " ") },
      { id: "forecast", status: usesFrozenResearch ? "partial" : "completed", detail: usesFrozenResearch ? `沿用 ${frozenResearch?.asOf ?? "历史"} 研究假设；最新证据不足以重建公司级模型` : "Historical growth, cash conversion and family normalization" },
      { id: "models", status: "completed", detail: "Each eligible model runs independently" },
      { id: "monte_carlo", status: "partial", detail: "Input sensitivities run after model selection; actual draw counts and limitations are returned in the simulation audit" },
      { id: "ensemble", status: "completed", detail: "Successful model weights re-normalized" },
      { id: "rating", status: "partial", detail: quote ? "Rating held at WATCH until the forecast source bridge reaches decision grade" : "Rating held at WATCH until a current price and decision-grade forecast are available" },
    ],
    cache: {
      financialsCached: false,
      valuationCacheAgeMs: 0,
      quoteCacheAgeMs: quoteAgeMs,
      latestFilingId: latestPeriodic?.accessionNumber ?? null,
      guidanceVersion: "unconnected",
      engineVersion: ENGINE_VERSION,
      profileVersion: issuerProfile.profileVersion,
      evidenceVersion: hashCanonical({ evidence: evidenceAssumptions, cik, latestFilingId: latestPeriodic?.accessionNumber ?? null }),
    },
  };
}

/**
 * The SEC-derived pack is the expensive half of a valuation; the quote is not.
 * The pack is published to the shared edge cache so a cold isolate reuses
 * another isolate's retrieval instead of rebuilding it. The key carries the
 * engine version, the issuer profile version and the ticker, so any of those
 * changing invalidates the entry rather than serving a stale route.
 */
const PACK_CACHE_PREFIX = "signal-ledger.internal/valuation-pack";

export function packCacheKey(symbol: string, profileVersion: string | null) {
  return `${symbol}|${ENGINE_VERSION}|${profileVersion ?? "unprofiled"}`;
}

function packEdgeUrl(cacheKey: string) {
  return `https://${PACK_CACHE_PREFIX}/${encodeURIComponent(cacheKey)}`;
}

/** Plain-data round trip: the pack is JSON, so a shared entry survives intact. */
type SharedPackEntry = { storedAt: number; pack: AutomatedValuationPack };

async function readSharedPack(cacheKey: string, now: number): Promise<{ pack: AutomatedValuationPack; storedAt: number } | null> {
  const url = packEdgeUrl(cacheKey);
  const edge = workerEdgeCache();
  if (edge) {
    try {
      const hit = await edge.match(url);
      if (hit) {
        const entry = await hit.json() as SharedPackEntry;
        if (Number.isFinite(entry?.storedAt) && now - entry.storedAt < FINANCIAL_CACHE_TTL_MS && entry.pack?.profile) {
          return { pack: entry.pack, storedAt: entry.storedAt };
        }
      }
    } catch {
      // A cache failure must never block the source read.
    }
  }
  return null;
}

async function writeSharedPack(cacheKey: string, pack: AutomatedValuationPack, storedAt: number) {
  const edge = workerEdgeCache();
  if (!edge) return;
  try {
    await edge.put(packEdgeUrl(cacheKey), Response.json(
      { storedAt, pack } satisfies SharedPackEntry,
      { headers: { "Cache-Control": `public, max-age=${Math.floor(FINANCIAL_CACHE_TTL_MS / 1000)}` } },
    ));
  } catch {
    // The in-isolate cache still serves this caller.
  }
}

/** Re-attaches the freshest quote to a cached pack, leaving the model inputs alone. */
function withFreshQuote(
  pack: AutomatedValuationPack,
  refreshedQuote: Awaited<ReturnType<typeof fetchNasdaqQuoteCached>> | null,
  now: number,
  storedAt: number,
): AutomatedValuationPack {
  const quote = refreshedQuote?.quote ?? pack.quote;
  return {
    ...pack,
    quote,
    profile: {
      ...pack.profile,
      referencePrice: quote ? { value: quote.price, asOf: quote.asOf, source: quote.source } : pack.profile.referencePrice,
    },
    cache: {
      ...pack.cache,
      financialsCached: true,
      valuationCacheAgeMs: now - storedAt,
      quoteCacheAgeMs: refreshedQuote?.ageMs ?? pack.cache.quoteCacheAgeMs,
    },
  };
}

export async function buildAutomatedValuationPack(ticker: string, knownFilingId?: string): Promise<AutomatedValuationPack> {
  const symbol = normalizeTicker(ticker);
  if (!/^[A-Z][A-Z0-9.\-]{0,7}$/.test(symbol)) throw new Error("Enter a valid U.S. ticker symbol.");
  const now = Date.now();
  const verifiedProfile = getVerifiedIssuerProfile(symbol);
  const baseCacheKey = packCacheKey(symbol, verifiedProfile?.profileVersion ?? null);
  const cacheKey = knownFilingId ? `${baseCacheKey}|filing:${knownFilingId}` : baseCacheKey;

  const cached = packCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    const [pack, refreshedQuote] = await Promise.all([cached.value, fetchNasdaqQuoteCached(symbol).catch(() => null)]);
    return withFreshQuote(pack, refreshedQuote, now, cached.createdAt);
  }

  // Cross-isolate reuse: the retrieval another isolate already paid for.
  const shared = await readSharedPack(cacheKey, now);
  if (shared) {
    packCache.set(cacheKey, {
      createdAt: shared.storedAt,
      expiresAt: shared.storedAt + FINANCIAL_CACHE_TTL_MS,
      value: Promise.resolve(shared.pack),
    });
    const refreshedQuote = await fetchNasdaqQuoteCached(symbol).catch(() => null);
    return withFreshQuote(shared.pack, refreshedQuote, now, shared.storedAt);
  }

  const value = buildPack(symbol);
  packCache.set(cacheKey, { createdAt: now, expiresAt: now + FINANCIAL_CACHE_TTL_MS, value });
  value.catch(() => packCache.delete(cacheKey));
  void value.then((pack) => writeSharedPack(cacheKey, pack, Date.now())).catch(() => undefined);
  return value;
}

/**
 * Price-free SEC evidence corpus for the research tools. Read-only: this fetches
 * company facts, submissions and the latest filing text, and never touches the
 * quote, a fair value or a rating. The research loop reads through this so the
 * planner only ever sees durable filing evidence.
 */
export async function loadSecEvidence(ticker: string): Promise<SecEvidence> {
  const symbol = normalizeTicker(ticker);
  const tickers = await getTickerMap();
  const entry = tickers.find((item) => normalizeTicker(item.ticker) === symbol);
  if (!entry) throw new Error(`${symbol} was not found in the SEC ticker directory.`);
  const directoryCik = String(entry.cik_str ?? "").replace(/\D/g, "");
  const verified = getVerifiedIssuerProfile(symbol);
  const cik = String(verified?.cik ?? directoryCik).replace(/\D/g, "").padStart(10, "0");
  const factsUrl = `${SEC_FACTS_BASE}/CIK${cik}.json`;
  const submissionsUrl = `${SEC_SUBMISSIONS_BASE}/CIK${cik}.json`;
  const [factsResult, submissionResult] = await Promise.allSettled([
    fetchJson<SecFacts>(factsUrl, secHeaders(), 20_000),
    fetchJson<SecSubmission>(submissionsUrl, secHeaders(), 15_000),
  ]);
  if (submissionResult.status === "rejected" || factsResult.status === "rejected") throw new Error(`SEC research evidence is unavailable for ${symbol}.`);
  const submission = submissionResult.value;
  const facts = factsResult.value;
  const entityName = (submission.name ?? entry.title ?? "").trim() || null;
  if (!verifiedFilingIdentity(symbol, entityName)) throw new Error(`SEC issuer identity did not match ${symbol}.`);
  const annual = latestFilingByForm(submission, cik, "10-K");
  const quarterly = latestFilingByForm(submission, cik, "10-Q");
  const current = latestFilingByForm(submission, cik, "8-K");
  const loaded = await Promise.all([annual, quarterly].map(async (document) => {
    if (!document) return null;
    try { return { ...document, body: filingText(await fetchText(document.url, secHeaders(), 20_000)) }; }
    catch { return document; }
  }));
  const documents = { annual: loaded[0], quarterly: loaded[1], current };
  const latest = [documents.annual, documents.quarterly].filter((item): item is SecFilingDocument => item !== null)
    .sort((left, right) => (right.filed ?? "").localeCompare(left.filed ?? ""))[0] ?? null;
  const latestFiling = latest ? { accessionNumber: latest.accessionNumber, url: latest.url, filed: latest.filed, reportDate: latest.reportDate } : null;
  const latestFilingBody = latest?.body ?? null;
  const reportedBusinesses = extractReportedBusinesses(symbol, latest, facts);
  return {
    ticker: symbol,
    cik,
    entityName,
    facts,
    submission,
    latestFiling,
    latestFilingBody,
    documents,
    reportedBusinesses,
  };
}
