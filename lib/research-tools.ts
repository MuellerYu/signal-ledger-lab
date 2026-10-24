import { schemaErrors, TOOL_ARGUMENT_SCHEMAS } from "./research-schema";
// Bounded, read-only research tools. These are the ONLY way the planner can pull
// external evidence, and they are deliberately narrow: a fixed registry of three
// SEC-only tools, a per-run call budget, a per-result byte cap, and a total
// timeout. External document text is returned as data only — the planner is told
// never to execute instructions found inside a filing.
import { loadSecEvidence } from "./valuation-data";
import type { SecEvidence, SecFacts } from "./valuation-data";

export type ToolResult = {
  id: string;
  tool: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  byteLength: number;
};

export type ToolDefinition = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  run: (evidence: SecEvidence, args: Record<string, unknown>) => Promise<unknown>;
};

export const MAX_TOOL_CALLS_PER_RUN = 6;
export const MAX_TOOL_RESULT_BYTES = 120_000;
export const MAX_TOOL_TOTAL_MS = 30_000;

const PEER_FIELDS = [
  "Revenues",
  "NetIncomeLoss",
  "NetCashProvidedByUsedInOperatingActivities",
  "PaymentsToAcquirePropertyPlantAndEquipment",
  "CashAndCashEquivalentsAtCarryingValue",
  "LongTermDebt",
  "ShortTermBorrowings",
  "GrossProfit",
  "OperatingIncomeLoss",
  "ResearchAndDevelopmentExpense",
  "SellingGeneralAndAdministrativeExpense",
  "ShareBasedCompensation",
] as const;

const PEER_MAX = 5;
const PEER_FIELD_MAX = PEER_FIELDS.length;

function latestFact(payload: SecFacts, concept: string): { value: number | null; end: string | null; form: string | null } {
  let best: { value: number; end: string; form: string } | null = null;
  for (const unit of ["USD", "shares"]) {
    const facts = payload.facts?.["us-gaap"]?.[concept]?.units?.[unit]
      ?? payload.facts?.["dei"]?.[concept]?.units?.[unit]
      ?? [];
    for (const fact of facts) {
      const value = typeof fact.val === "number" ? fact.val : Number(String(fact.val ?? "").replace(/[^\d.\-]/g, ""));
      if (!Number.isFinite(value) || !fact.end) continue;
      const form = String(fact.form ?? "");
      if (!/^(10-K|10-Q)/i.test(form)) continue;
      if (!best || fact.end > best.end) best = { value, end: fact.end, form };
    }
  }
  return best ? { value: best.value, end: best.end, form: best.form } : { value: null, end: null, form: null };
}

function extractPeerFinancials(evidence: SecEvidence): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of PEER_FIELDS) {
    const fact = latestFact(evidence.facts, field);
    fields[field] = { valueB: fact.value === null ? null : fact.value / 1e9, end: fact.end, form: fact.form };
  }
  const shares = latestFact(evidence.facts, "EntityCommonStockSharesOutstanding");
  fields.sharesOutstandingB = shares.value === null ? null : shares.value / 1e9;
  return fields;
}

function boundedSlice(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const slice = text.slice(0, maxBytes);
  return { text: slice.slice(0, slice.lastIndexOf(" ")), truncated: true };
}

const listFilingDocuments: ToolDefinition = {
  name: "list_filing_documents",
  description: "List the issuer's recent SEC filings (form, filing date, report date, accession).",
  schema: TOOL_ARGUMENT_SCHEMAS.list_filing_documents,
  async run(evidence, args) {
    const recent = evidence.submission.filings?.recent;
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const rows: unknown[] = [];
    for (let index = 0; index < Math.min(limit, recent?.form?.length ?? 0); index += 1) {
      rows.push({
        form: recent?.form?.[index] ?? null,
        filingDate: recent?.filingDate?.[index] ?? null,
        reportDate: recent?.reportDate?.[index] ?? null,
        accessionNumber: recent?.accessionNumber?.[index] ?? null,
        primaryDocument: recent?.primaryDocument?.[index] ?? null,
      });
    }
    const document = (item: typeof evidence.documents.annual) => item && ({ form: item.form, accessionNumber: item.accessionNumber, url: item.url, filed: item.filed, reportDate: item.reportDate, bodyAvailable: item.body !== null });
    return { ticker: evidence.ticker, cik: evidence.cik, filings: rows,
      latestAnnualReport: document(evidence.documents.annual), latestQuarterlyReport: document(evidence.documents.quarterly),
      latestCurrentReport: document(evidence.documents.current) };
  },
};

const getReportedSegments: ToolDefinition = {
  name: "get_reported_segments",
  description: "Return SEC filing business rows only when they reconcile to same-accession consolidated revenue; include source and status.",
  schema: TOOL_ARGUMENT_SCHEMAS.get_reported_segments,
  async run(evidence) {
    const business = evidence.reportedBusinesses;
    const available = business.status === "verified";
    // A failed tie-out never exposes free text as if it were verified segment data.
    const excerpt = available ? business.businesses.map((row) => row.sourceExcerpt).join(" … ") : "";
    const { text, truncated } = boundedSlice(excerpt, MAX_TOOL_RESULT_BYTES - 8_192);
    return {
      ticker: evidence.ticker,
      filing: evidence.latestFiling,
      available,
      reportedBusinesses: business,
      truncated,
      text,
    };
  },
};

const getPeerFinancials: ToolDefinition = {
  name: "get_peer_financials",
  description: "Return a bounded set of latest reported fundamentals for up to 5 named peer tickers.",
  schema: TOOL_ARGUMENT_SCHEMAS.get_peer_financials,
  async run(_evidence, args) {
    // The planner's schema names the field `peers`, but earlier drafts sent
    // `peerTickers`/`tickers`; accept all three so a well-formed request is never
    // silently dropped to an empty result.
    const requested = args.peers ?? args.peerTickers ?? args.tickers;
    const raw = Array.isArray(requested) ? requested.map(String).slice(0, PEER_MAX) : [];
    const peers: Record<string, unknown> = {};
    for (const peer of raw) {
      try {
        const peerEvidence = await loadSecEvidence(peer);
        peers[peer] = extractPeerFinancials(peerEvidence);
      } catch (error) {
        peers[peer] = { unavailable: true, reason: error instanceof Error ? error.message : "unavailable" };
      }
    }
    return { peers, fields: [...PEER_FIELDS].slice(0, PEER_FIELD_MAX) };
  },
};

export const RESEARCH_TOOLS: Record<string, ToolDefinition> = {
  list_filing_documents: listFilingDocuments,
  get_reported_segments: getReportedSegments,
  get_peer_financials: getPeerFinancials,
};

export type ToolResultId = string;

/**
 * Per-run budget: caps the number of tool calls, the size of each result, and the
 * total wall-clock time. A run that exceeds any bound is rejected rather than
 * silently allowed to fan out.
 */
export class ResearchToolRunner {
  private calls = 0;
  private startedAt = Date.now();

  constructor(
    private readonly maxCalls = MAX_TOOL_CALLS_PER_RUN,
    private readonly maxBytesPerResult = MAX_TOOL_RESULT_BYTES,
    private readonly maxTotalMs = MAX_TOOL_TOTAL_MS,
  ) {}

  get remainingCalls(): number {
    return this.maxCalls - this.calls;
  }

  async run(toolName: string, args: Record<string, unknown>, evidence: SecEvidence): Promise<ToolResult> {
    if (this.calls >= this.maxCalls) {
      return { id: `tool:${toolName}:${this.calls}`, tool: toolName, ok: false, error: `Tool call budget exceeded (${this.maxCalls}).`, byteLength: 0 };
    }
    const definition = RESEARCH_TOOLS[toolName];
    if (!Object.hasOwn(RESEARCH_TOOLS, toolName) || !definition) {
      return { id: `tool:${toolName}:${this.calls}`, tool: toolName, ok: false, error: `Unknown tool "${toolName}".`, byteLength: 0 };
    }
    const errors = schemaErrors(args, TOOL_ARGUMENT_SCHEMAS[toolName], "tool.args");
    if (errors.length) return { id: `tool:${toolName}:${this.calls}`, tool: toolName, ok: false, error: `RESEARCH_SCHEMA_INVALID: ${errors.join("; ")}`, byteLength: 0 };
    this.calls += 1;
    const id = `tool:${toolName}:${this.calls}`;
    try {
      const data = await Promise.race([
        definition.run(evidence, args ?? {}),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Tool timeout.")), this.maxTotalMs - (Date.now() - this.startedAt))),
      ]);
      const serialized = JSON.stringify(data);
      const byteLength = Buffer.byteLength(serialized, "utf8");
      if (byteLength > this.maxBytesPerResult) {
        return { id, tool: toolName, ok: false, error: `Tool result exceeded the byte cap (${byteLength} > ${this.maxBytesPerResult}).`, byteLength };
      }
      return { id, tool: toolName, ok: true, data, byteLength };
    } catch (error) {
      return { id, tool: toolName, ok: false, error: error instanceof Error ? error.message : "Tool failed.", byteLength: 0 };
    }
  }
}
