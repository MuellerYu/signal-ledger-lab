import { getBindings } from "./runtime";
import { workerEdgeCache } from "./snapshot-cache";
import { SUPPORTED_TICKERS, runValuationProfile, type UniversalValuationOutput } from "./universal-valuation";
import { buildAutomatedValuationPack, ENGINE_VERSION, type ValuationPipelineStage } from "./valuation-data";

/**
 * One cached investment object shared by the homepage, research cards, the
 * valuation workbench, earnings cards, options recommendations and any AI
 * review. Every surface reads the same valuation result instead of maintaining
 * its own fair-value logic.
 */
export type SnapshotRating = "STRONG_BUY" | "UNDERVALUED" | "FAIRLY_VALUED" | "OVERVALUED" | "WATCH" | "MODEL_CHECK_REQUIRED" | "UNAVAILABLE";
export type SnapshotStatus = "DECISION_GRADE" | "PROVISIONAL" | "HIGH_UNCERTAINTY" | "SCREENING" | "MODEL_CHECK_REQUIRED" | "UNAVAILABLE";

export type EquityBridgeView = {
  enterpriseValue: number | null;
  cash: number;
  investments: number;
  debt: number;
  preferredClaims: number;
  minorityInterest: number;
  otherClaims: number;
  dilutionAdjustment: number;
  equityValue: number | null;
  basicShares: number | null;
  dilutedShares: number | null;
  perShareValue: number | null;
};

export type InvestmentSnapshot = {
  /* Canonical spec interface (Part A) */
  marketPrice: number | null;
  marketPriceTimestamp: string | null;
  bearValue: number | null;
  baseValue: number | null;
  bullValue: number | null;
  upsideDownside: number | null;
  ratingLabel: SnapshotRating;
  statusLabel: SnapshotStatus;
  equityBridgeView: EquityBridgeView;
  reconciliationView: UniversalValuationOutput["reconciliation"];
  marketImpliedExpectations: UniversalValuationOutput["marketImpliedExpectations"];
  keyDrivers: Array<{ driver: string; assumption: string; source: string }>;
  evidence: Array<{ metric: string; value: number | string | null; unit: string | null; asOfDate: string | null; retrievedAt: string; sourceType: string; sourceId?: string; sourceUrl?: string; confidence: number }>;
  selectedModels: Array<{ model: string; label: string; value: number | null; effectiveWeight: number; applicability: number; confidence: number; priorReliability: number; status: string; reason: string }>;
  rejectedModels: Array<{ model: string; label: string; value: number | null; reason: string }>;
  engineVersion: string;
  issuerProfileVersion: string | null;
  aiExposure: UniversalValuationOutput["aiExposure"];
  ratingEnum: SnapshotRating;
  statusEnum: SnapshotStatus;

  ticker: string;
  issuerId: string;
  securityId: string;
  snapshotId: string;
  company: string;
  sector: string;
  quote: {
    price: number | null;
    asOf: string | null;
    source: string;
  };
  fairValue: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  buyZone: number | null;
  strongBuyZone: number | null;
  upsidePct: number | null;
  rating: UniversalValuationOutput["rating"]["value"];
  confidence: number;
  confidenceLabel: UniversalValuationOutput["confidenceLabel"];
  confidenceBreakdown: UniversalValuationOutput["confidenceBreakdown"];
  releaseGate: UniversalValuationOutput["releaseGate"];
  releaseGateDetail: string;
  /** Primary fair value is always the base estimate; the range is separate uncertainty information. */
  modelRange: { bear: number | null; base: number | null; bull: number | null };
  valuationFamily: string;
  valuationFamilyLabel: string;
  valuationStatus: UniversalValuationOutput["status"];
  valuationRelease: UniversalValuationOutput["dataQuality"]["valuationRelease"];
  valuationUpdatedAt: string;
  modelsIncluded: number;
  modelsRouted: number;
  modelsUsed: Array<{ model: string; label: string; role: string; value: number | null; effectiveWeight: number; priorReliability: number }>;
  modelWeights: Record<string, number>;
  keyAssumptions: string[];
  evidenceMissing: string[];
  equityBridge: UniversalValuationOutput["reconciliation"];
  evidenceFreshness: { priceAsOf: string | null; latestEvidenceAsOf: string | null; reportingBasis: string | null };
  pipeline: ValuationPipelineStage[];
  /** Deterministic snapshots never call OpenAI; AI review is a separate, explicit action. */
  aiUsed: false;
  aiModel: null;
  cache: {
    hit: boolean;
    ageMs: number;
    financialsCached: boolean;
    engineVersion: string;
  };
  /** The complete deterministic engine output behind this snapshot. */
  output: UniversalValuationOutput;
  /** True when this is the last released valuation served while a refresh runs. */
  stale?: boolean;
};

// Shared views must invalidate alongside the calculation engine, not keep
// serving a pre-fix fair value after the underlying package has been re-keyed.
export const SNAPSHOT_ENGINE_VERSION = `signal-ledger.investment-snapshot.v2.${ENGINE_VERSION}`;
export const SNAPSHOT_TTL_MS = 15 * 60 * 1_000;
// Cache retention is longer than freshness; durable publication history is P3.
const LAST_GOOD_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const VIEW_RETENTION_DAYS = 30;

/** Coverage seeds for the homepage shelves; any listed ticker can be requested. */
export const DEFAULT_COVERAGE_SEED = ["AMD", "NVDA", "MU", "MSTR", "OKLO", "TSLA", "GOOG", "JPM", "O", "CRCL", "SPCX", "ORCL"];

type SnapshotRecord = { ticker: string; expiresAt: number; value: Promise<InvestmentSnapshot | null> };
const snapshotCache = new Map<string, SnapshotRecord>();

/** Test seam: drops this isolate's snapshot memory, leaving the shared cache intact. */
export function resetSnapshotMemory() {
  snapshotCache.clear();
}
const memoryViews = new Map<string, number>();


function snapshotRating(output: UniversalValuationOutput, gate: UniversalValuationOutput["releaseGate"]): SnapshotRating {
  if (gate !== "passed") return gate === "model_check_required" ? "MODEL_CHECK_REQUIRED" : "UNAVAILABLE";
  switch (output.rating.value) {
    case "STRONG BUY": return "STRONG_BUY";
    case "BUY": return "UNDERVALUED";
    case "REDUCE":
    case "SELL": return "OVERVALUED";
    default: return output.ensemble.expectedReturn === null ? "WATCH" : Math.abs(output.ensemble.expectedReturn) < 0.1 ? "FAIRLY_VALUED" : "WATCH";
  }
}

function snapshotStatus(output: UniversalValuationOutput, gate: UniversalValuationOutput["releaseGate"]): SnapshotStatus {
  if (gate === "model_check_required") return "MODEL_CHECK_REQUIRED";
  switch (output.status) {
    case "decision-grade": return "DECISION_GRADE";
    case "provisional": return "PROVISIONAL";
    case "high-uncertainty": return "HIGH_UNCERTAINTY";
    case "screening": return "SCREENING";
    default: return "UNAVAILABLE";
  }
}

export function normalizeSnapshotTicker(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
}

export function isValidSnapshotTicker(ticker: string) {
  return /^[A-Z][A-Z0-9.\-]{0,7}$/.test(ticker);
}

export function toInvestmentSnapshot(
  output: UniversalValuationOutput,
  meta: {
    issuerId?: string;
    securityId?: string;
    updatedAt?: string;
    pipeline?: ValuationPipelineStage[];
    cache?: { hit: boolean; ageMs: number; financialsCached: boolean };
    issuerProfileVersion?: string | null;
    releaseGate?: UniversalValuationOutput["releaseGate"];
  } = {},
): InvestmentSnapshot {
  const { ensemble, currentPrice, rating, dataQuality, engine, ticker, classification } = output;
  const upsidePct = currentPrice.value && ensemble.fairValue ? (ensemble.fairValue / currentPrice.value - 1) * 100 : null;
  const updatedAt = meta.updatedAt ?? new Date().toISOString();
  const sourceDates = Object.values(output.aiBaseline.inputSources ?? {})
    .map((source) => source?.asOf)
    .filter((value): value is string => Boolean(value))
    .sort();
  const selectedModels = output.models
    .filter((model) => model.role === "valuation" && model.value !== null)
    .map((model) => ({
      model: model.model,
      label: model.label,
      value: model.value,
      effectiveWeight: model.effectiveWeight,
      applicability: model.applicability,
      confidence: model.confidence,
      priorReliability: model.priorReliability,
      status: model.status,
      reason: model.explanation,
    }));
  const rejectedModels = output.models
    .filter((model) => model.role === "valuation" && model.value !== null && model.effectiveWeight === 0)
    .map((model) => ({ model: model.model, label: model.label, value: model.value, reason: model.explanation }));
  const ratingEnum = snapshotRating(output, meta.releaseGate ?? output.releaseGate);
  const statusEnum = snapshotStatus(output, meta.releaseGate ?? output.releaseGate);
  const bridge = output.reconciliation;
  return {
    /* Canonical spec interface (Part A) */
    marketPrice: currentPrice.value,
    marketPriceTimestamp: currentPrice.asOf,
    bearValue: ensemble.scenarios.bear,
    baseValue: ensemble.scenarios.base,
    bullValue: ensemble.scenarios.bull,
    upsideDownside: upsidePct,
    ratingLabel: ratingEnum,
    ratingEnum,
    statusLabel: statusEnum,
    statusEnum,
    equityBridgeView: {
      enterpriseValue: bridge.enterpriseValueB,
      cash: bridge.cashB ?? 0,
      investments: bridge.investmentsB ?? 0,
      debt: bridge.debtB ?? 0,
      preferredClaims: bridge.preferredClaimsB ?? 0,
      minorityInterest: bridge.minorityInterestB ?? 0,
      otherClaims: bridge.otherClaimsB ?? 0,
      dilutionAdjustment: bridge.dilutionB ?? 0,
      equityValue: bridge.equityValueB,
      basicShares: bridge.basicSharesB,
      dilutedShares: bridge.dilutedSharesB,
      perShareValue: bridge.perShare,
    },
    reconciliationView: bridge,
    marketImpliedExpectations: output.marketImpliedExpectations,
    keyDrivers: [
      ...(output.aiBaseline.assumptions.sotpSegments ?? []).map((segment) => ({
        driver: segment.name,
        assumption: `${segment.metricValueB.toFixed(1)}B × ${segment.multiple}×${(segment.probability ?? 1) < 1 ? ` × ${Math.round((segment.probability ?? 1) * 100)}% probability` : ""}`,
        source: segment.driverSource ?? "model_derived",
      })),
      ...output.classification.valuationDrivers.slice(0, 6).map((driver) => ({ driver, assumption: "Routed valuation driver", source: "issuer_profile" })),
    ],
    evidence: Object.entries(output.aiBaseline.inputSources ?? {}).flatMap(([metric, source]) => source ? [{
      metric,
      value: source.label,
      unit: source.unit ?? null,
      asOfDate: source.asOf ?? null,
      retrievedAt: updatedAt,
      sourceType: source.sourceType ?? source.kind,
      sourceId: source.filingId ?? undefined,
      sourceUrl: source.url,
      confidence: source.confidence ?? 0.4,
    }] : []),
    selectedModels,
    rejectedModels,
    engineVersion: SNAPSHOT_ENGINE_VERSION,
    issuerProfileVersion: meta.issuerProfileVersion ?? null,
    aiExposure: output.aiExposure,

    ticker,
    issuerId: meta.issuerId ?? ticker,
    securityId: meta.securityId ?? meta.issuerId ?? ticker,
    // Stable identifier for this exact reconciled snapshot; options, the
    // homepage and research all quote it back.
    snapshotId: `${ticker}:${output.engine.family.id}:${updatedAt}:${ensemble.fairValue?.toFixed(4) ?? "none"}`,
    company: classification.companyName,
    sector: classification.sector,
    quote: { price: currentPrice.value, asOf: currentPrice.asOf, source: currentPrice.source },
    fairValue: ensemble.fairValue,
    p10: ensemble.probabilityDistribution.p10,
    p50: ensemble.probabilityDistribution.p50,
    p90: ensemble.probabilityDistribution.p90,
    buyZone: rating.buyZone,
    strongBuyZone: rating.strongBuyZone,
    upsidePct,
    rating: rating.value,
    confidence: ensemble.confidence,
    confidenceLabel: output.confidenceLabel,
    confidenceBreakdown: output.confidenceBreakdown,
    releaseGate: output.releaseGate,
    releaseGateDetail: output.releaseGateDetail,
    modelRange: { bear: ensemble.scenarios.bear, base: ensemble.scenarios.base, bull: ensemble.scenarios.bull },
    valuationFamily: output.valuationFamilyAlias,
    valuationFamilyLabel: engine.family.label,
    valuationStatus: output.status,
    valuationRelease: dataQuality.valuationRelease,
    valuationUpdatedAt: updatedAt,
    modelsIncluded: engine.modelsIncluded,
    modelsRouted: engine.valuationModelsRouted,
    modelsUsed: output.models
      .filter((model) => model.role === "valuation" && model.value !== null)
      .map((model) => ({ model: model.model, label: model.label, role: model.role, value: model.value, effectiveWeight: model.effectiveWeight, priorReliability: model.priorReliability })),
    modelWeights: Object.fromEntries(output.models.filter((model) => model.effectiveWeight > 0).map((model) => [model.model, model.effectiveWeight])),
    keyAssumptions: [
      output.engine.formula,
      ...(output.aiBaseline.assumptions.sotpSegments ?? []).map((segment) => `${segment.name}: ${segment.metricValueB.toFixed(1)}B × ${segment.multiple}×${(segment.probability ?? 1) < 1 ? ` × ${Math.round((segment.probability ?? 1) * 100)}% probability` : ""}`),
    ],
    evidenceMissing: output.investorRead.evidenceMissing,
    equityBridge: output.reconciliation,
    evidenceFreshness: {
      priceAsOf: currentPrice.asOf,
      latestEvidenceAsOf: sourceDates.at(-1) ?? null,
      reportingBasis: meta.pipeline?.find((stage) => stage.id === "financials")?.detail ?? null,
    },
    pipeline: meta.pipeline ?? [],
    aiUsed: false,
    aiModel: null,
    cache: {
      hit: meta.cache?.hit ?? false,
      ageMs: meta.cache?.ageMs ?? 0,
      financialsCached: meta.cache?.financialsCached ?? false,
      engineVersion: SNAPSHOT_ENGINE_VERSION,
    },
    output,
  };
}

export function supportedSnapshotUniverse() {
  return SUPPORTED_TICKERS;
}

/**
 * The published snapshot is shared across isolates on the same short TTL as the
 * in-memory cache. A returning visitor reads another isolate's result instead
 * of waiting for the SEC retrieval and model run to be redone.
 *
 * The entry holds the last valid research or explicitly labelled screening result. A refresh replaces it
 * after the release gate passes; a failed refresh leaves it untouched.
 */
function snapshotEdgeUrl(symbol: string) {
  return `https://signal-ledger.internal/investment-snapshot/${SNAPSHOT_ENGINE_VERSION}/${encodeURIComponent(symbol)}`;
}

type SharedSnapshotEntry = { storedAt: number; snapshot: InvestmentSnapshot };

async function readSharedSnapshot(symbol: string): Promise<SharedSnapshotEntry | null> {
  const edge = workerEdgeCache();
  if (!edge) return null;
  try {
    const hit = await edge.match(snapshotEdgeUrl(symbol));
    if (!hit) return null;
    const entry = await hit.json() as SharedSnapshotEntry;
    if (Number.isFinite(entry?.storedAt) && entry.snapshot?.ticker && Date.now() - entry.storedAt < LAST_GOOD_RETENTION_MS && canRetainSnapshot(entry.snapshot)) return entry;
  } catch {
    // A cache failure must never block the snapshot read.
  }
  return null;
}

export function canRetainSnapshot(snapshot: InvestmentSnapshot): boolean {
  return snapshot.valuationRelease !== "withheld" && snapshot.releaseGate === "passed"
    && snapshot.fairValue !== null && Number.isFinite(snapshot.fairValue)
    && !snapshot.output.dataQuality.checks.some((check) => check.status === "failed");
}

async function writeSharedSnapshot(snapshot: InvestmentSnapshot, storedAt: number) {
  if (!canRetainSnapshot(snapshot)) return;
  const edge = workerEdgeCache();
  if (!edge) return;
  try {
    await edge.put(snapshotEdgeUrl(snapshot.ticker), Response.json(
      { storedAt, snapshot } satisfies SharedSnapshotEntry,
      { headers: { "Cache-Control": `public, max-age=${Math.floor(LAST_GOOD_RETENTION_MS / 1000)}` } },
    ));
  } catch {
    // The in-isolate cache still serves this caller.
  }
}

function startRefresh(symbol: string, now: number, previous: InvestmentSnapshot | null) {
  const asset = (async (): Promise<InvestmentSnapshot | null> => {
    try {
      // Deterministic path only: no AI orchestration, no model review call.
      const pack = await buildAutomatedValuationPack(symbol);
      const output = runValuationProfile(pack.profile, {
        currentPrice: pack.quote?.price,
        priceAsOf: pack.quote?.asOf,
        priceSource: pack.quote?.source,
      });
      const snapshot = toInvestmentSnapshot(output, {
        issuerId: pack.issuerProfile.issuerId,
        securityId: pack.identity.securityTicker,
        updatedAt: new Date().toISOString(),
        pipeline: pack.pipeline,
        cache: { hit: false, ageMs: 0, financialsCached: pack.cache.financialsCached },
      });
      if (!canRetainSnapshot(snapshot) || (previous?.valuationRelease === "released" && snapshot.valuationRelease !== "released")) {
        return previous ? { ...previous, stale: true } : null;
      }
      await writeSharedSnapshot(snapshot, Date.now());
      return snapshot;
    } catch {
      // A failed recalculation must never replace a released snapshot.
      return previous ? { ...previous, stale: true } : null;
    }
  })();
  snapshotCache.set(symbol, { ticker: symbol, expiresAt: now + SNAPSHOT_TTL_MS, value: asset });
  asset.then((value) => { if (!value) snapshotCache.delete(symbol); }).catch(() => snapshotCache.delete(symbol));
  return asset;
}

export async function getInvestmentSnapshot(ticker: string): Promise<InvestmentSnapshot | null> {
  const symbol = normalizeSnapshotTicker(ticker);
  if (!isValidSnapshotTicker(symbol)) return null;
  const now = Date.now();

  const cached = snapshotCache.get(symbol);
  if (cached && cached.expiresAt > now) {
    const value = await cached.value;
    return value ? { ...value, cache: { ...value.cache, hit: true, ageMs: now - (cached.expiresAt - SNAPSHOT_TTL_MS) } } : null;
  }

  const shared = await readSharedSnapshot(symbol);
  if (shared) {
    const age = now - shared.storedAt;
    const snapshot = { ...shared.snapshot, cache: { ...shared.snapshot.cache, hit: true, ageMs: age } };
    if (age < SNAPSHOT_TTL_MS) {
      snapshotCache.set(symbol, { ticker: symbol, expiresAt: shared.storedAt + SNAPSHOT_TTL_MS, value: Promise.resolve(shared.snapshot) });
      return snapshot;
    }
    // Stale: publish the released snapshot now and refresh behind the response.
    startRefresh(symbol, now, shared.snapshot);
    return { ...snapshot, stale: true };
  }

  const previous = cached ? await cached.value : null;
  return startRefresh(symbol, now, previous && canRetainSnapshot(previous) && now - Date.parse(previous.valuationUpdatedAt) < LAST_GOOD_RETENTION_MS ? previous : null);
}

/** Read a previously released snapshot without starting an SEC or quote fetch.
 * Coverage pages can show the latest valuation state at bounded cost. */
export async function peekInvestmentSnapshot(ticker: string): Promise<InvestmentSnapshot | null> {
  const symbol = normalizeSnapshotTicker(ticker);
  if (!isValidSnapshotTicker(symbol)) return null;
  const cached = snapshotCache.get(symbol);
  if (cached) {
    const value = await cached.value;
    if (value && canRetainSnapshot(value)) return value;
  }
  return (await readSharedSnapshot(symbol))?.snapshot ?? null;
}

export async function getInvestmentSnapshots(tickers: string[], limit = 24) {
  const unique = [...new Set(tickers.map(normalizeSnapshotTicker).filter(isValidSnapshotTicker))].slice(0, limit);
  // Public SEC/quote endpoints are rate-limited, so resolve in small batches
  // instead of firing the whole coverage list at once.
  const snapshots: InvestmentSnapshot[] = [];
  for (let index = 0; index < unique.length; index += 4) {
    const batch = await Promise.all(unique.slice(index, index + 4).map((ticker) => getInvestmentSnapshot(ticker)));
    snapshots.push(...batch.flatMap((snapshot) => snapshot ? [snapshot] : []));
  }
  return snapshots;
}

/** Ranked purely from cached snapshots: no valuation, AI or provider call. */
export function rankSnapshotsByValuationGap(snapshots: InvestmentSnapshot[], limit = 6) {
  return [...snapshots]
    .filter((snapshot) => snapshot.fairValue !== null && snapshot.upsidePct !== null)
    .sort((left, right) => Math.abs(right.upsidePct!) - Math.abs(left.upsidePct!))
    .slice(0, limit);
}

export function rankSnapshotsByRecency(snapshots: InvestmentSnapshot[], limit = 6) {
  return [...snapshots]
    .sort((left, right) => Date.parse(right.valuationUpdatedAt) - Date.parse(left.valuationUpdatedAt))
    .slice(0, limit);
}

function dayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function viewTables(db: D1Database) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS valuation_view_counts (
      ticker TEXT NOT NULL,
      view_date TEXT NOT NULL,
      view_count INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (ticker, view_date)
    )`,
  ).run();
}

/**
 * "Most viewed" only needs a cheap counter. It is best-effort: when D1 is not
 * bound (local preview, offline tests) the in-memory counter still ranks the
 * page without blocking a render.
 */
export async function recordValuationView(ticker: string) {
  const symbol = normalizeSnapshotTicker(ticker);
  if (!isValidSnapshotTicker(symbol)) return;
  memoryViews.set(symbol, (memoryViews.get(symbol) ?? 0) + 1);
  const db = getBindings().DB;
  if (!db) return;
  try {
    await viewTables(db);
    await db.prepare(
      `INSERT INTO valuation_view_counts (ticker, view_date, view_count, updated_at_ms)
       VALUES (?1, ?2, 1, ?3)
       ON CONFLICT (ticker, view_date) DO UPDATE SET view_count = view_count + 1, updated_at_ms = ?3`,
    ).bind(symbol, dayStamp(), Date.now()).run();
  } catch {
    // A view counter never blocks or breaks the research page.
  }
}

export async function readValuationViews(limit = 12): Promise<string[]> {
  const db = getBindings().DB;
  if (!db) return [...memoryViews.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([ticker]) => ticker);
  try {
    await viewTables(db);
    const since = new Date(Date.now() - VIEW_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
    const result = await db.prepare(
      `SELECT ticker, SUM(view_count) AS total FROM valuation_view_counts WHERE view_date >= ?1 GROUP BY ticker ORDER BY total DESC LIMIT ?2`,
    ).bind(since, limit).all<{ ticker: string }>();
    const ranked = (result.results ?? []).map((row) => normalizeSnapshotTicker(row.ticker)).filter(isValidSnapshotTicker);
    return ranked.length ? ranked : [...memoryViews.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([ticker]) => ticker);
  } catch {
    return [...memoryViews.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([ticker]) => ticker);
  }
}
