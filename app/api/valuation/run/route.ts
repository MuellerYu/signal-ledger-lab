import { buildAutomatedValuationPack } from "@/lib/valuation-data";
import { runAiOrchestratedValuation } from "@/lib/valuation-ai";
import { isAuthorizedMutation } from "@/lib/auth";
import { requirePro, upgradeRequired } from "@/lib/access";

export const dynamic = "force-dynamic";

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sourceDates(pack: Awaited<ReturnType<typeof buildAutomatedValuationPack>>) {
  return [...new Set(Object.values(pack.profile.inputSources ?? {}).map((source) => source?.asOf).filter((value): value is string => Boolean(value)))].sort().reverse();
}

export async function POST(request: Request) {
  // Gate before any compute: the AI-orchestrated valuation is PRO-only.
  if (!(await requirePro())) return upgradeRequired();

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return Response.json({ status: "invalid_request", error: "A JSON request body is required." }, { status: 400 });
  }

  const ticker = String(body.ticker ?? "").trim().toUpperCase();
  try {
    const pack = await buildAutomatedValuationPack(ticker);
    const manualPrice = optionalNumber(body.price);
    const valuationOptions = {
      currentPrice: manualPrice ?? pack.quote?.price,
      priceAsOf: manualPrice === undefined ? pack.quote?.asOf : String(body.priceAsOf ?? "Manual scenario"),
      priceSource: manualPrice === undefined ? pack.quote?.source : "Manual scenario price",
      thesis: {
        growthDelta: optionalNumber(body.growthDelta) ?? 0,
        marginDelta: optionalNumber(body.marginDelta) ?? 0,
        multipleDelta: optionalNumber(body.multipleDelta) ?? 0,
        note: optionalNumber(body.growthDelta) || optionalNumber(body.marginDelta) || optionalNumber(body.multipleDelta)
          ? "Signal Ledger adjustments change operating assumptions and justified multiples; they never overwrite fair value directly."
          : pack.profile.thesis.note,
      },
    };
    const { output, orchestration } = await runAiOrchestratedValuation(pack, valuationOptions, request, { force: body.forceAi === true && isAuthorizedMutation(request) });
    const selectedModels = orchestration.selectedModels.length
      ? orchestration.selectedModels
      : output.models.filter((model) => model.role === "valuation" && model.effectiveWeight > 0).map((model) => model.model);
    const rejectedModels = orchestration.rejectedModels;
    const warnings = [...new Set([
      ...orchestration.warnings,
      ...output.investorRead.evidenceMissing,
      ...output.dataQuality.checks.filter((check) => check.status !== "passed").map((check) => check.detail),
    ])];
    return Response.json(
      {
        schema: "signal-ledger.valuation.v3",
        generatedAt: new Date().toISOString(),
        identity: pack.identity,
        security: {
          ticker: pack.identity.securityTicker,
          currentPrice: output.currentPrice.value,
          priceAsOf: output.currentPrice.asOf,
          priceSource: output.currentPrice.source,
        },
        issuer: {
          ticker: pack.identity.issuerTicker,
          name: pack.identity.issuerName,
          cik: pack.identity.cik,
          relatedShareClasses: pack.identity.relatedShareClasses,
        },
        dataFreshness: {
          generatedAt: new Date().toISOString(),
          priceAsOf: output.currentPrice.asOf,
          evidenceAsOf: sourceDates(pack),
        },
        valuationFamily: output.classification.modelFamily,
        businessModel: output.classification.businessModel,
        drivers: output.classification.valuationDrivers,
        aiMode: orchestration.aiMode,
        AI_used: orchestration.aiUsed,
        AI_model: orchestration.aiUsed ? orchestration.model : null,
        AI_call_reason: orchestration.aiCallReason,
        issuer_profile_source: orchestration.issuerProfileSource,
        issuer_profile_age_ms: orchestration.issuerProfileAgeMs,
        cached_valuation: orchestration.cachedValuation,
        valuation_cache_age_ms: orchestration.valuationCacheAgeMs,
        selectedModels,
        rejectedModels,
        modelResults: output.models,
        review: orchestration.review ?? null,
        fairValue: output.ensemble.fairValue,
        distribution: output.ensemble.probabilityDistribution,
        confidence: output.ensemble.confidence,
        warnings,
        aiOrchestration: orchestration,
        pipeline: pack.pipeline.map((stage) => stage.id === "models"
          ? { ...stage, detail: `${output.engine.modelsCalculated} calculated independently · ${output.engine.modelsIncluded} comparable models included in the ensemble` }
          : stage.id === "classification" && orchestration.status === "active"
            ? { ...stage, detail: `${output.classification.modelFamily.replaceAll("_", " ")} · ${orchestration.planOrigin === "ai" ? "AI-planned" : "Deterministic plan"} · ${orchestration.reviewStatus === "passed" ? "independently reviewed" : "provisional; independent review not completed"}` }
          : stage),
        ...output,
      },
      { headers: { "Cache-Control": "private, max-age=0, no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The valuation run failed.";
    const notFound = /not found in the SEC ticker directory|identifier is unavailable/i.test(message);
    return Response.json(
      {
        schema: "signal-ledger.valuation.v3",
        status: "unavailable",
        error: notFound ? "The requested U.S. security could not be identified." : "The valuation data service is temporarily unavailable.",
      },
      { status: notFound ? 404 : 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } },
    );
  }
}
