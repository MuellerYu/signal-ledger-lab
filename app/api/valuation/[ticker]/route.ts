import { buildAutomatedValuationPack } from "@/lib/valuation-data";
import { runValuationProfile } from "@/lib/universal-valuation";
import { getCurrentEntitlement } from "@/lib/access";
import { isPublicSampleTicker } from "@/lib/public-samples";
import { valuationOutputTeaser } from "@/lib/valuation-teaser";
import { isLocalOwnerPreviewRequest } from "@/lib/local-owner-preview";

export const dynamic = "force-dynamic";

function optionalNumber(value: string | null) {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params;
  const entitlement = await getCurrentEntitlement();
  const query = new URL(request.url).searchParams;
  const currentPrice = optionalNumber(query.get("price"));
  const growthDelta = optionalNumber(query.get("growthDelta"));
  const marginDelta = optionalNumber(query.get("marginDelta"));
  const multipleDelta = optionalNumber(query.get("multipleDelta"));
  const thesis = {
    ...(growthDelta === undefined ? {} : { growthDelta }),
    ...(marginDelta === undefined ? {} : { marginDelta }),
    ...(multipleDelta === undefined ? {} : { multipleDelta }),
    note:
      growthDelta || marginDelta || multipleDelta
        ? "Signal Ledger adjustments change operating assumptions and justified multiples; they never overwrite fair value directly."
        : "No incremental Signal Ledger adjustment is applied to the AI baseline.",
  };
  let output;
  let pipeline;
  let identity;
  let issuerProfile;
  let cache;
  let liveError: string | null = null;
  try {
    const pack = await buildAutomatedValuationPack(ticker);
    pipeline = pack.pipeline;
    identity = pack.identity;
    issuerProfile = pack.issuerProfile;
    cache = pack.cache;
    output = runValuationProfile(pack.profile, {
      currentPrice: currentPrice ?? pack.quote?.price,
      priceAsOf: query.get("priceAsOf") ?? pack.quote?.asOf,
      priceSource: query.get("priceSource") ?? pack.quote?.source,
      thesis,
    });
  } catch (error) {
    // No curated-baseline fallback: a value that disagrees with every other
    // surface is worse than an explicit unavailable.
    liveError = error instanceof Error ? error.message : "Live evidence retrieval failed.";
    output = null;
  }

  if (!output) {
    return Response.json(
      {
        schema: "signal-ledger.valuation.v3",
        status: "unavailable",
        error: liveError ?? "This security does not have enough verified public evidence for valuation.",
      },
      { status: liveError?.includes("not found in the SEC ticker directory") ? 404 : 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // FREE receives only the teaser projection (ticker, price, fair value, rating,
  // upside) — identity, pipeline, issuer profile and the full engine output
  // (model weights, assumptions, evidence) stay server-side. The two public
  // sample tickers (AMD, SPCX) are the explicit exceptions: their full stored
  // output is public, but the AI-orchestrated run endpoint stays PRO-only.
  if (entitlement.tier !== "PRO" && !isPublicSampleTicker(ticker) && !isLocalOwnerPreviewRequest(request)) {
    return Response.json(
      {
        generatedAt: new Date().toISOString(),
        ...valuationOutputTeaser(output),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    {
      schema: "signal-ledger.valuation.v3",
      generatedAt: new Date().toISOString(),
      ...(identity ? { identity } : {}),
      ...(pipeline ? { pipeline } : {}),
      ...(issuerProfile ? {
        issuer_profile_source: issuerProfile.profileSource,
        issuer_profile_version: issuerProfile.profileVersion,
        classification_confidence: issuerProfile.classificationConfidence,
      } : {}),
      AI_used: false,
      AI_model: null,
      AI_call_reason: null,
      cached_valuation: cache?.financialsCached ?? false,
      valuation_cache_age_ms: cache?.valuationCacheAgeMs ?? 0,
      ...output,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
