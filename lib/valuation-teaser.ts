import type { InvestmentSnapshot } from "./investment-snapshot";
import type { UniversalValuationOutput } from "./universal-valuation";

/**
 * The FREE-visible projection of a valuation.
 *
 * The paywall rule is structural, not visual: a FREE client receives this
 * teaser shape and never the full snapshot or engine output. Nothing here is
 * then hidden with blur or `display:none` — the locked numbers simply do not
 * exist in the FREE payload.
 */

export const VALUATION_TEASER_SCHEMA = "signal-ledger.valuation-teaser.v1";

export const VALUATION_LOCKED_SECTIONS = [
  "Bear / Base / Bull scenario range",
  "Model weights and valuation methods",
  "DCF and relative valuation detail",
  "Market-implied expectations",
  "Key assumptions and drivers",
  "Supporting evidence",
  "Valuation history",
] as const;

export type TeaserSnapshot = {
  schema: string;
  access: "FREE";
  lockedSections: readonly string[];
  ticker: string;
  company: string;
  sector: string;
  marketPrice: number | null;
  marketPriceTimestamp: string | null;
  quote: { price: number | null; asOf: string | null; source: string };
  fairValue: number | null;
  rating: string;
  ratingLabel: string;
  upsidePct: number | null;
  confidence: number;
  confidenceLabel: string;
  valuationFamilyLabel: string;
  valuationStatus: string;
  valuationUpdatedAt: string;
  snapshotId: string;
  releaseGate: string;
  releaseGateDetail: string;
  // Deliberately nulled so a shared card component can render without branching.
  // The real numbers never reach a FREE client.
  modelRange: { bear: null; base: null; bull: null };
  bearValue: null;
  baseValue: null;
  bullValue: null;
  buyZone: null;
  strongBuyZone: null;
  p10: null;
  p50: null;
  p90: null;
};

export function teaserSnapshot(snapshot: InvestmentSnapshot): TeaserSnapshot {
  return {
    schema: VALUATION_TEASER_SCHEMA,
    access: "FREE",
    lockedSections: VALUATION_LOCKED_SECTIONS,
    ticker: snapshot.ticker,
    company: snapshot.company,
    sector: snapshot.sector,
    marketPrice: snapshot.marketPrice,
    marketPriceTimestamp: snapshot.marketPriceTimestamp,
    quote: snapshot.quote,
    fairValue: snapshot.fairValue,
    rating: snapshot.rating,
    ratingLabel: snapshot.ratingLabel,
    upsidePct: snapshot.upsidePct,
    confidence: snapshot.confidence,
    confidenceLabel: snapshot.confidenceLabel,
    valuationFamilyLabel: snapshot.valuationFamilyLabel,
    valuationStatus: snapshot.valuationStatus,
    valuationUpdatedAt: snapshot.valuationUpdatedAt,
    snapshotId: snapshot.snapshotId,
    releaseGate: snapshot.releaseGate,
    releaseGateDetail: snapshot.releaseGateDetail,
    modelRange: { bear: null, base: null, bull: null },
    bearValue: null,
    baseValue: null,
    bullValue: null,
    buyZone: null,
    strongBuyZone: null,
    p10: null,
    p50: null,
    p90: null,
  };
}

/** The FREE-visible projection of the full valuation engine output (`/api/valuation/[ticker]`). */
export type ValuationOutputTeaser = {
  schema: string;
  access: "FREE";
  lockedSections: readonly string[];
  ticker: string;
  currentPrice: { value: number | null; asOf: string | null; source: string };
  fairValue: number | null;
  rating: string;
  upsidePct: number | null;
  company: string;
  sector: string;
};

export function valuationOutputTeaser(output: UniversalValuationOutput): ValuationOutputTeaser {
  const price = output.currentPrice.value;
  const fairValue = output.ensemble.fairValue;
  return {
    schema: VALUATION_TEASER_SCHEMA,
    access: "FREE",
    lockedSections: VALUATION_LOCKED_SECTIONS,
    ticker: output.ticker,
    currentPrice: {
      value: price,
      asOf: output.currentPrice.asOf,
      source: output.currentPrice.source,
    },
    fairValue,
    rating: output.rating.value,
    upsidePct: price !== null && fairValue !== null && price > 0 ? (fairValue / price - 1) * 100 : null,
    company: output.classification.companyName,
    sector: output.classification.sector,
  };
}
