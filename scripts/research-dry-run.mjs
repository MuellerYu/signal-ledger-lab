// Production-isolated dry-run for the adaptive research engine (Task B).
//
// Runs the research loop for OKLO / AMD / NVDA / SPCX with every Cloudflare
// binding replaced by an inert stand-in (getBindings() === {} → no D1, no
// claimAiCall quota) and every provider served from deterministic fixtures.
// AI is disabled in this context, so the loop exercises the deterministic
// research fallback: compile the evidence-only ResearchPlan → deterministic
// valuation → research checks → (no reviewer, 0 AI calls).
//
// Writes the A–L acceptance audit to tests/fixtures/research-dry-run-report.json
// and prints a summary. Nothing here touches a production D1 table or the
// production claimAiCall quota.
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
  const researchCheck = await import(researchCheckUrl);
  const researchCompiler = await import(researchCompilerUrl);
  const valuationAi = await import(valuationAiUrl);
  return { engine, packMod, issuer, researchCheck, researchCompiler, valuationAi };
}

const round = (value) => (Number.isFinite(value) ? Number(value.toFixed(2)) : null);

function businessNode(b) {
  return {
    id: b.id,
    name: b.name,
    stage: b.stage,
    economicMeaning: b.economicMeaning,
    segmentationBasis: b.segmentationBasis,
    revenueDriver: b.revenueDriver?.formula ?? null,
    valuationMethod: b.valuationMethod,
    multiple: b.multiple ?? null,
    currentRevenueB: b.disclosedData?.find((d) => d.label === "Revenue")?.value ?? null,
    forecastYears: (b.forecastYears ?? []).map((y) => ({
      year: y.year,
      revenueB: y.revenueB ?? null,
      margin: y.margin ?? null,
      fcfB: y.fcfB ?? null,
      growth: y.growth ?? null,
    })),
    rationale: b.rationale,
  };
}

async function auditTicker(m, frozen, ticker) {
  const old = frozen.tickers[ticker];
  const pack = await m.packMod.buildAutomatedValuationPack(ticker);
  const price = pack.quote?.price ?? null;
  const result = await m.valuationAi.runResearchValuation(pack, { currentPrice: price }, new Request("https://example.test/research"), { force: true });

  const detail = result.orchestration.research;
  const plan = detail.plan;
  const output = result.output;

  // Re-run the full (unsanitized) checks for the J pass/fail list.
  const compiled = m.researchCompiler.compileResearchPlan(pack, plan);
  const checks = m.researchCheck.runResearchChecks(pack, plan, compiled, output);

  // Old→new bridge: the deterministic fallback applies no capital/financing/
  // dilution/probability, so those components are zero; the full delta is the
  // method/segmentation/aggregation normalization from the legacy ensemble to
  // the deterministic single-business DCF (or SOTP).
  const newFv = round(output.ensemble.fairValue);
  const oldFv = round(old.oldPublishedFairValue);
  const delta = Number.isFinite(newFv) && Number.isFinite(oldFv) ? round(newFv - oldFv) : null;

  return {
    ticker,
    currentPrice: price,
    modelFamily: pack.profile.classification.modelFamily,
    A: { oldFairValue: oldFv, oldBear: round(old.bear), oldBase: round(old.base), oldBull: round(old.bull), oldPublishedModel: old.publishedModel },
    B: {
      bear: round(output.ensemble.scenarios.bear),
      base: round(output.ensemble.scenarios.base),
      bull: round(output.ensemble.scenarios.bull),
      publishedFairValue: newFv,
      publishedModel: output.engine?.publishedModel ?? null,
      rating: output.rating?.value ?? null,
    },
    C_businessGraph: plan.businesses.map(businessNode),
    D_perBusiness: plan.businesses.map(businessNode),
    E_primaryMethod: plan.primaryMethod,
    F_crossChecks: plan.crossChecks ?? [],
    G_aggregationRule: plan.aggregationRule,
    H_evidenceSources: plan.sources ?? [],
    I_missingEvidence: plan.missingEvidence ?? [],
    J_checks: checks.map((c) => ({ id: c.id, label: c.label, status: c.status, detail: c.detail })),
    K_reviewerRevisions: result.orchestration.revisions ?? [],
    L_bridge: {
      oldFairValue: oldFv,
      newFairValue: newFv,
      delta,
      segmentationChange: null,
      growthChange: null,
      marginNormalization: null,
      optionality: null,
      minusCapex: 0,
      minusFinancing: 0,
      minusDilution: 0,
      minusFailureProbability: 0,
      minusMultipleNormalization: null,
      note: detail.compilationFailed
        ? "Deterministic fallback could not value this issuer from raw evidence (asset- or segment-curated family), so runResearchValuation fell back to the legacy deterministic path (rule B); old == new by construction."
        : "Deterministic fallback (AI disabled in the isolated dry-run): a single company-level business with no capital/financing/dilution/scenario probability, so all additive bridge components are zero; the full delta is the legacy-ensemble → deterministic-single-business method/aggregation normalization.",
    },
    orchestration: {
      policyVersion: detail.policyVersion,
      evidenceVersion: detail.evidenceVersion,
      assumptionVersion: detail.assumptionVersion,
      cached: detail.cached,
      aiCalls: detail.aiCalls,
      toolCalls: detail.toolCalls,
      usedDeterministicFallback: detail.usedDeterministicFallback,
      compilationFailed: detail.compilationFailed,
      productionD1Mutations: detail.productionD1Mutations,
    },
  };
}

installProviders();

const frozen = JSON.parse(await readFile(new URL("../tests/fixtures/pre-upgrade-baseline.json", import.meta.url), "utf8"));
const m = await loadAll();

const report = {
  meta: {
    purpose: "Production-isolated dry-run acceptance audit for the adaptive research engine (Task B). AI disabled → deterministic fallback; no production D1 writes or claimAiCall quota.",
    generatedAt: new Date().toISOString(),
    engineVersion: m.packMod.ENGINE_VERSION,
    tickers: TICKERS.map(([t]) => t),
  },
  tickers: {},
};

for (const [ticker] of TICKERS) {
  report.tickers[ticker] = await auditTicker(m, frozen, ticker);
}

// Isolation proof: the whole run must be mutation-free.
const totalMutations = Object.values(report.tickers).reduce((sum, t) => sum + (t.orchestration.productionD1Mutations ?? 0), 0);
const totalAiCalls = Object.values(report.tickers).reduce((sum, t) => sum + (t.orchestration.aiCalls ?? 0), 0);
report.proof = {
  productionD1Mutations: totalMutations,
  totalAiCalls: totalAiCalls,
  allDeterministicFallback: Object.values(report.tickers).every((t) => t.orchestration.usedDeterministicFallback === true),
  conclusion: totalMutations === 0 ? "Production D1 mutations = 0 — PASS" : `FAIL: ${totalMutations} production D1 mutations`,
};

const outPath = new URL("../tests/fixtures/research-dry-run-report.json", import.meta.url);
await writeFile(outPath, JSON.stringify(report, null, 2));

// Human summary
console.log("=== Research engine dry-run (production-isolated) ===\n");
for (const [ticker, t] of Object.entries(report.tickers)) {
  console.log(`${ticker}  (quote $${t.currentPrice})`);
  console.log(`  old FV $${t.A.oldFairValue}  →  new FV $${t.B.publishedFairValue}  (Δ ${t.L_bridge.delta})`);
  console.log(`  bear/base/bull: $${t.B.bear} / $${t.B.base} / $${t.B.bull}`);
  console.log(`  primary method ${t.E_primaryMethod} · aggregation ${t.G_aggregationRule} · businesses ${t.C_businessGraph.map((b) => b.name).join(", ")}`);
  console.log(`  aiCalls ${t.orchestration.aiCalls} · toolCalls ${t.orchestration.toolCalls} · D1 mutations ${t.orchestration.productionD1Mutations} · checks ${t.J_checks.filter((c) => c.status === "failed").length} failed\n`);
}
console.log(`PROOF: ${report.proof.conclusion} · total AI calls ${report.proof.totalAiCalls}`);
console.log(`Report written to ${outPath.pathname}`);
