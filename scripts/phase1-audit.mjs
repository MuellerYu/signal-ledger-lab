// Phase 1 — deterministic numerical audit (no AI, production-isolated).
//
// For each acceptance ticker this dumps the EXACT inputs reaching
// runValuationProfile (raw evidence assumptions, legacy baseline, capital
// cost, compiled research-plan profile) and the per-model deterministic
// output, so the published fair value can be bridged number-by-number and
// every unit (USD vs B vs shares) verified by hand.
import { readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import { installProviders, TICKERS } from "../tests/helpers/valuation-harness.mjs";

const root = new URL("../lib/", import.meta.url);
const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

async function transpile(path, replacements = []) {
  let code = await readFile(new URL(path, root), "utf8");
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

async function loadAll() {
  const runtimeUrl = dataUrl(await transpile("runtime.ts", [['import { env } from "cloudflare:workers";', "const env = {};"]]));
  const snapshotCacheUrl = dataUrl(await transpile("snapshot-cache.ts"));
  const issuerUrl = dataUrl(await transpile("issuer-intelligence.ts", [['from "./runtime"', `from "${runtimeUrl}"`]]));
  const aiExposureUrl = dataUrl(await transpile("ai-exposure.ts"));
  const spcxUrl = dataUrl(await transpile("spcx-valuation.ts"));
  const muUrl = dataUrl(await transpile("mu-valuation.ts"));
  const capitalCostUrl = dataUrl(await transpile("valuation-capital-cost.ts", [
    ['from "./runtime"', `from "${runtimeUrl}"`],
    ['from "./snapshot-cache"', `from "${snapshotCacheUrl}"`],
    ['import { configuredFeed, fetchDailyAdjustedBars } from "./alpaca-bars";', 'const configuredFeed = () => "iex"; const fetchDailyAdjustedBars = async () => new Map();'],
  ]));
  const valuationUrl = dataUrl(await transpile("universal-valuation.ts", [
    ['from "./issuer-intelligence"', `from "${issuerUrl}"`],
    ['from "./mu-valuation"', `from "${muUrl}"`],
  ]));
  const researchHashUrl = dataUrl(await transpile("research-hash.ts"));
  const researchPlanUrl = dataUrl(await transpile("research-plan.ts"));
  const researchPolicyUrl = dataUrl(await transpile("research-policy.ts"));
  const researchFirewallUrl = dataUrl(await transpile("research-firewall.ts"));
  const researchCheckUrl = dataUrl(await transpile("research-check.ts"));
  const researchValidateUrl = dataUrl(await transpile("research-validate.ts", [
    ['from "./research-plan"', `from "${researchPlanUrl}"`],
  ]));
  const packUrl = dataUrl(await transpile("valuation-data.ts", [
    ['import { calculateCapitalCost, loadCapitalCostMarketInputs } from "./valuation-capital-cost";', `import { calculateCapitalCost, loadCapitalCostMarketInputs as loadMarketInputs } from "${capitalCostUrl}";
const loadCapitalCostMarketInputs = (ticker) => globalThis.__capitalIntegrationMarket ? Promise.resolve(globalThis.__capitalIntegrationMarket) : loadMarketInputs(ticker);`],
    ['from "./valuation-capital-cost"', `from "${capitalCostUrl}"`],
    ['from "./snapshot-cache"', `from "${snapshotCacheUrl}"`],
    ['from "./universal-valuation"', `from "${valuationUrl}"`],
    ['from "./runtime"', `from "${runtimeUrl}"`],
    ['from "./ai-exposure"', `from "${aiExposureUrl}"`],
    ['from "./spcx-valuation"', `from "${spcxUrl}"`],
    ['from "./mu-valuation"', `from "${muUrl}"`],
    ['from "./issuer-intelligence"', `from "${issuerUrl}"`],
    ['from "./research-hash"', `from "${researchHashUrl}"`],
  ]));
  const researchCompilerUrl = dataUrl(await transpile("research-compiler.ts", [
    ['from "./universal-valuation"', `from "${valuationUrl}"`],
    ['from "./research-hash"', `from "${researchHashUrl}"`],
    ['from "./research-plan"', `from "${researchPlanUrl}"`],
  ]));
  const researchToolsUrl = dataUrl(await transpile("research-tools.ts", [
    ['from "./valuation-data"', `from "${packUrl}"`],
  ]));
  const valuationAiUrl = dataUrl(await transpile("valuation-ai.ts", [
    ['from "./runtime"', `from "${runtimeUrl}"`],
    ['from "./valuation-data"', `from "${packUrl}"`],
    ['from "./universal-valuation"', `from "${valuationUrl}"`],
    ['from "./issuer-intelligence"', `from "${issuerUrl}"`],
    ['from "./research-compiler"', `from "${researchCompilerUrl}"`],
    ['from "./research-check"', `from "${researchCheckUrl}"`],
    ['from "./research-firewall"', `from "${researchFirewallUrl}"`],
    ['from "./research-tools"', `from "${researchToolsUrl}"`],
    ['from "./research-policy"', `from "${researchPolicyUrl}"`],
    ['from "./research-plan"', `from "${researchPlanUrl}"`],
    ['from "./research-validate"', `from "${researchValidateUrl}"`],
  ]));

  const engine = await import(valuationUrl);
  const packMod = await import(packUrl);
  const issuer = await import(issuerUrl);
  const researchCompiler = await import(researchCompilerUrl);
  const valuationAi = await import(valuationAiUrl);
  return { engine, packMod, issuer, researchCompiler, valuationAi };
}

const num = (v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : v);

function summarizeAssumptions(a) {
  return {
    cashFlowBasis: a.cashFlowBasis ?? null,
    cashFlows: a.cashFlows ?? null,
    normalizedCashFlows: a.normalizedCashFlows ?? null,
    netCashB: a.netCashB ?? null,
    dilutedSharesB: a.dilutedSharesB ?? null,
    wacc: a.wacc ?? null,
    terminalGrowth: a.terminalGrowth ?? null,
    costOfEquity: a.costOfEquity ?? null,
    preTaxCostOfDebt: a.preTaxCostOfDebt ?? null,
    effectiveTaxRate: a.effectiveTaxRate ?? null,
    taxRateBasis: a.taxRateBasis ?? null,
    forwardEps: a.forwardEps ?? null,
    forwardPe: a.forwardPe ?? null,
    normalizedEbitdaB: a.normalizedEbitdaB ?? null,
    evEbitdaMultiple: a.evEbitdaMultiple ?? null,
    forwardFcfB: a.forwardFcfB ?? null,
    evFcfMultiple: a.evFcfMultiple ?? null,
    forwardRevenueB: a.forwardRevenueB ?? null,
    evSalesMultiple: a.evSalesMultiple ?? null,
    fcfMargin: a.fcfMargin ?? null,
    sotpSegments: a.sotpSegments?.map((s) => ({ name: s.name, metricValueB: s.metricValueB, multiple: s.multiple, probability: s.probability, ownership: s.ownership, method: s.method, layer: s.layer })) ?? null,
    projectNpvAssets: a.projectNpvAssets ?? null,
    rnpvAssets: a.rnpvAssets ?? null,
    otherAssetValueB: a.otherAssetValueB ?? null,
  };
}

function summarizeModel(m) {
  return {
    model: m.model,
    label: m.label,
    role: m.role,
    status: m.status,
    value: num(m.value),
    baseWeight: m.baseWeight,
    applicability: num(m.applicability),
    confidence: num(m.confidence),
    priorReliability: m.priorReliability,
    effectiveWeight: num(m.effectiveWeight),
    missingInputs: m.missingInputs,
    diagnostics: m.diagnostics ?? null,
    explanation: m.explanation,
  };
}

async function audit(ticker) {
  const m = await loadAll();
  const pack = await m.packMod.buildAutomatedValuationPack(ticker);
  const price = pack.quote?.price ?? null;

  // Legacy path (what the frozen baseline used).
  const legacyOut = m.engine.runValuationProfile(pack.profile, { currentPrice: price });

  // Research path (deterministic fallback — AI disabled).
  const result = await m.valuationAi.runResearchValuation(pack, { currentPrice: price }, new Request("https://example.test/research"), { force: true });
  const detail = result.orchestration.research;
  const plan = detail.plan;
  const compiled = m.researchCompiler.compileResearchPlan(pack, plan);
  const researchOut = result.output;

  return {
    ticker,
    quote: { price, asOf: pack.quote?.asOf ?? null },
    evidenceVersion: detail.evidenceVersion,
    assumptionVersion: detail.assumptionVersion,
    classification: {
      modelFamily: pack.profile.classification.modelFamily,
      growthStage: pack.profile.classification.growthStage ?? null,
      capitalIntensity: pack.profile.classification.capitalIntensity ?? null,
    },
    evidenceAssumptions: summarizeAssumptions(pack.evidenceAssumptions ?? {}),
    legacyBaseline: summarizeAssumptions(pack.profile.baseline),
    legacyThesis: pack.profile.thesis ?? null,
    capitalCost: pack.profile.capitalCost ?? null,
    plan: {
      primaryMethod: plan.primaryMethod,
      aggregationRule: plan.aggregationRule,
      missingEvidence: plan.missingEvidence ?? [],
      businesses: plan.businesses.map((b) => ({
        id: b.id, name: b.name, stage: b.stage, segmentationBasis: b.segmentationBasis,
        revenueDriver: b.revenueDriver ?? null,
        valuationMethod: b.valuationMethod,
        disclosedData: b.disclosedData ?? null,
        forecastYears: b.forecastYears ?? null,
        rationale: b.rationale,
      })),
      financing: plan.financing ?? [],
      dilution: plan.dilution ?? [],
      capitalRequirements: plan.capitalRequirements ?? [],
      scenarios: plan.scenarios ?? [],
    },
    compiledBaseline: summarizeAssumptions(compiled.profile.baseline),
    compiledClassification: compiled.profile.classification ? { modelFamily: compiled.profile.classification.modelFamily } : null,
    legacyOutput: {
      fairValue: num(legacyOut.ensemble.fairValue),
      scenarios: legacyOut.ensemble.scenarios,
      models: legacyOut.models.map(summarizeModel),
    },
    researchOutput: {
      fairValue: num(researchOut.ensemble.fairValue),
      status: researchOut.status,
      scenarios: researchOut.ensemble.scenarios,
      probabilityDistribution: researchOut.ensemble.probabilityDistribution,
      models: researchOut.models.map(summarizeModel),
      marketImplied: researchOut.marketImpliedExpectations ?? null,
      rating: researchOut.rating?.value ?? null,
      riskAdjustedUpside: num(researchOut.rating?.riskAdjustedUpside),
    },
    orchestration: {
      aiCalls: detail.aiCalls,
      toolCalls: detail.toolCalls,
      usedDeterministicFallback: detail.usedDeterministicFallback,
      compilationFailed: detail.compilationFailed,
      capabilityGap: detail.capabilityGap ?? null,
    },
  };
}

installProviders();

const out = {};
for (const [ticker] of TICKERS) {
  out[ticker] = await audit(ticker);
}

const outPath = new URL("../tests/fixtures/phase1-audit.json", import.meta.url);
await writeFile(outPath, JSON.stringify(out, null, 2));
console.log("Wrote " + outPath.pathname + "\n");

for (const [ticker, a] of Object.entries(out)) {
  console.log(`\n=============== ${ticker} ===============`);
  console.log(`quote $${a.quote.price} · family ${a.classification.modelFamily} · legacy FV $${a.legacyOutput.fairValue} · research FV $${a.researchOutput.fairValue}`);
  console.log(`primaryMethod=${a.plan.primaryMethod} · usedDeterministicFallback=${a.orchestration.usedDeterministicFallback} · compilationFailed=${a.orchestration.compilationFailed} · capabilityGap=${a.orchestration.capabilityGap ?? "(none)"}`);
  console.log(`\n-- evidenceAssumptions (raw) --`);
  console.log(JSON.stringify(a.evidenceAssumptions, null, 1));
  console.log(`-- legacy baseline --`);
  console.log(JSON.stringify(a.legacyBaseline, null, 1));
  console.log(`-- capitalCost --`);
  console.log(JSON.stringify(a.capitalCost, null, 1));
  console.log(`-- compiled research-plan baseline --`);
  console.log(JSON.stringify(a.compiledBaseline, null, 1));
  console.log(`-- research per-model output --`);
  for (const mm of a.researchOutput.models) {
    console.log(`  ${mm.model.padEnd(16)} value=${mm.value ?? "null"} effW=${mm.effectiveWeight} baseW=${mm.baseWeight} conf=${mm.confidence} status=${mm.status} missing=[${mm.missingInputs.join(",")}]`);
    if (mm.diagnostics) console.log(`      diagnostics=${JSON.stringify(mm.diagnostics)}`);
    console.log(`      ${mm.explanation}`);
  }
  console.log(`-- research scenarios --`, JSON.stringify(a.researchOutput.scenarios));
  console.log(`-- marketImplied --`, JSON.stringify(a.researchOutput.marketImplied));
  console.log(`-- plan --`, JSON.stringify({ primaryMethod: a.plan.primaryMethod, aggregationRule: a.plan.aggregationRule, forecastYears: a.plan.businesses.map((b) => b.forecastYears) }));
}
