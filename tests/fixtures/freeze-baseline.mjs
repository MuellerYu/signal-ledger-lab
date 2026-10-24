// STEP 0 — freeze the pre-upgrade baseline (read-only, no production D1 writes).
//
// Run BEFORE any engine change:  node tests/fixtures/freeze-baseline.mjs
//
// Uses the deterministic production-isolated harness (mocked SEC/Nasdaq providers,
// no Cloudflare bindings) so the frozen numbers are reproducible and comparable to
// the post-upgrade dry-run. The old→new bridge reads THIS file, never a recomputed
// value from a modified engine.
import { writeFile, mkdir } from "node:fs/promises";
import { installProviders, loadEngine, runValuation, QUOTES, factsFor } from "../helpers/valuation-harness.mjs";

installProviders();
const { ENGINE_VERSION } = await loadEngine();

const TICKERS = ["OKLO", "AMD", "NVDA", "SPCX"];

const frozen = {
  meta: {
    purpose: "Pre-upgrade frozen baseline for the adaptive research engine (Task B). Produced by the UNMODIFIED deterministic engine. Never regenerate with a modified engine.",
    frozenAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    tickers: TICKERS,
  },
  tickers: {},
};

for (const ticker of TICKERS) {
  const { pack, output } = await runValuation(ticker);
  const classification = pack.profile.classification;
  const sourceDate = pack.profile.inputSources?.forwardRevenueB?.asOf ?? pack.cache?.latestFilingId ?? null;
  const valuationModels = output.models.filter((m) => m.role === "valuation" && m.value !== null);
  const included = valuationModels.filter((m) => m.effectiveWeight > 0);
  const top = included.slice().sort((a, b) => b.effectiveWeight - a.effectiveWeight)[0];

  frozen.tickers[ticker] = {
    ticker,
    evidenceDate: sourceDate,
    quoteAsOf: pack.quote?.asOf ?? null,
    currentPrice: pack.quote?.price ?? null,
    modelFamily: classification.modelFamily,
    primaryBasis: output.engine.publishedBasis,
    publishedModel: output.engine.publishedModel ?? top?.model ?? null,
    topWeightedModel: top?.model ?? null,
    profileVersion: pack.cache.profileVersion ?? pack.issuerProfile.profileVersion ?? null,
    engineVersion: ENGINE_VERSION,
    oldPublishedFairValue: output.ensemble.fairValue,
    oldExpectedReturn: output.ensemble.expectedReturn,
    bear: output.ensemble.scenarios.bear,
    base: output.ensemble.scenarios.base,
    bull: output.ensemble.scenarios.bull,
    probabilityDistribution: output.ensemble.probabilityDistribution,
    rating: output.rating.value,
    status: output.status,
    confidence: output.ensemble.confidence,
    valuationScenarios: {
      method: output.valuationScenarios.method,
      bear: output.valuationScenarios.bear.value,
      base: output.valuationScenarios.base.value,
      bull: output.valuationScenarios.bull.value,
    },
    models: valuationModels.map((m) => ({ model: m.model, value: m.value, effectiveWeight: m.effectiveWeight })),
    baseline: {
      cashFlowBasis: pack.profile.baseline.cashFlowBasis ?? null,
      cashFlows: pack.profile.baseline.cashFlows ?? null,
      normalizedCashFlows: pack.profile.baseline.normalizedCashFlows ?? null,
      netCashB: pack.profile.baseline.netCashB ?? null,
      dilutedSharesB: pack.profile.baseline.dilutedSharesB ?? null,
      wacc: pack.profile.baseline.wacc ?? null,
      terminalGrowth: pack.profile.baseline.terminalGrowth ?? null,
      forwardRevenueB: pack.profile.baseline.forwardRevenueB ?? null,
      forwardEps: pack.profile.baseline.forwardEps ?? null,
      forwardFcfB: pack.profile.baseline.forwardFcfB ?? null,
      normalizedEbitdaB: pack.profile.baseline.normalizedEbitdaB ?? null,
      sotpSegments: (pack.profile.baseline.sotpSegments ?? []).map((s) => ({ name: s.name, metricValueB: s.metricValueB, multiple: s.multiple, probability: s.probability ?? null })),
      projectNpvAssets: (pack.profile.baseline.projectNpvAssets ?? []).map((a) => ({ name: a.name, npvB: a.npvB, probability: a.probability })),
      otherAssetValueB: pack.profile.baseline.otherAssetValueB ?? null,
    },
    sourcePosture: pack.profile.sourcePosture,
    dataQuality: { status: output.dataQuality.status, valuationRelease: output.dataQuality.valuationRelease },
  };
}

await mkdir(new URL(".", import.meta.url), { recursive: true });
const outPath = new URL("./pre-upgrade-baseline.json", import.meta.url);
await writeFile(outPath, JSON.stringify(frozen, null, 2) + "\n");
console.log(`Frozen ${TICKERS.length} tickers → ${outPath.pathname}`);
for (const ticker of TICKERS) {
  const t = frozen.tickers[ticker];
  console.log(`  ${ticker}: FV=${t.oldPublishedFairValue?.toFixed?.(2) ?? t.oldPublishedFairValue}  [${t.bear?.toFixed?.(2) ?? t.bear} / ${t.base?.toFixed?.(2) ?? t.base} / ${t.bull?.toFixed?.(2) ?? t.bull}]  family=${t.modelFamily}  model=${t.publishedModel}`);
}
