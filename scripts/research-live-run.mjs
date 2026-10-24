// LIVE research-loop run for Task B Phases 2–7 (acceptance).
//
// This is the production-isolated LIVE counterpart to research-dry-run.mjs:
//   * OpenAI bindings are injected from a user-populated .dev.vars (never printed),
//     so `runtimeConfig().enabled` is true and the loop makes REAL AI calls
//     (research_draft → read-only tools → research_finalize → compile → value →
//     checks → research_reviewer).
//   * The network shim is surgical: api.openai.com and the real SEC EDGAR endpoints
//     for the three public filers (AMD/NVDA/OKLO) go to the REAL network; only SPCX
//     (SpaceX — private, no public companyfacts), the ticker directory, and the
//     firewall-excluded quote are served from deterministic fixtures.
//   * No production D1 table is ever touched: getBindings().DB is undefined, so
//     claimAiCall uses the in-memory map and productionD1Mutations stays 0.
//
// Writes tests/fixtures/research-live-run-report.json and prints a summary plus an
// explicit READY FOR REVIEW / NOT READY / BLOCKED verdict.
import { readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import { installProviders, TICKERS, QUOTES, SPCX_FILING_TEXT } from "../tests/helpers/valuation-harness.mjs";

const root = new URL("../lib/", import.meta.url);
const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const SEC_HEADERS = { accept: "application/json", "user-agent": "Signal Ledger/1.0 owner@example.com" };

async function transpile(path, replacements = []) {
  let code = await readFile(new URL(path, root), "utf8");
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

// ---------------------------------------------------------------------------
// Isolated OpenAI bindings (user-populated .dev.vars; the key is never printed)
// ---------------------------------------------------------------------------
async function readDevVars() {
  const url = new URL("../.dev.vars", import.meta.url);
  let text;
  try {
    text = await readFile(url, "utf8");
  } catch {
    throw new Error("No .dev.vars at project root. Create it first (see the instructions printed when this script runs).");
  }
  const bindings = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) bindings[key] = value;
  }
  return bindings;
}

// Redact anything secret; the report records presence only, never values.
function bindingSummary(bindings) {
  const out = {};
  for (const [k, v] of Object.entries(bindings)) {
    out[k] = /KEY|SECRET|TOKEN|PASSWORD/i.test(k) ? (v ? "present" : "absent") : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Surgical network shim (real network for OpenAI + public SEC; fixture for SPCX)
// ---------------------------------------------------------------------------
let realFetch;
let cachedDir = null;
let openAiCalls = []; // { role, status, requestId } — per-role HTTP outcome, for the AI-call proof

async function getTickerDirectory() {
  if (cachedDir) return cachedDir;
  let real = {};
  try {
    const res = await realFetch("https://www.sec.gov/files/company_tickers.json", { headers: SEC_HEADERS });
    real = await res.json();
  } catch {
    real = {}; // fall back to the known 4-ticker map only
  }
  const dir = { ...real };
  const known = { AMD: 2488, NVDA: 1045810, OKLO: 1849056, SPCX: 1900001 };
  let next = Math.max(-1, ...Object.keys(dir).map(Number)) + 1;
  for (const [ticker, cik] of Object.entries(known)) {
    const hit = Object.entries(dir).find(([, v]) => v && v.ticker === ticker);
    if (hit) dir[hit[0]] = { cik_str: cik, ticker, title: hit[1].title };
    else dir[String(next++)] = { cik_str: cik, ticker, title: ticker };
  }
  cachedDir = dir;
  return dir;
}

function installSurgicalShim() {
  realFetch = globalThis.fetch.bind(globalThis);
  installProviders(); // registers SPCX interim-only + installs the full fixture fetch
  const fixtureFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://api.openai.com/")) {
      let role = "unknown";
      try {
        const body = JSON.parse(init?.body ?? "{}");
        const m = (body.prompt_cache_key ?? "").match(/signal-ledger:([^:]+):/);
        if (m) role = m[1];
      } catch { /* non-JSON body (health probe) */ }
      const res = await realFetch(input, init);
      openAiCalls.push({ role, status: res.status, requestId: res.headers.get("x-request-id") });
      return res;
    }
    if (url.startsWith("https://www.sec.gov/files/company_tickers.json")) {
      return Response.json(await getTickerDirectory());
    }
    const isSpcx = url.includes("1900001");
    const isSec = url.startsWith("https://data.sec.gov/") || url.startsWith("https://www.sec.gov/Archives/");
    if (isSec && !isSpcx) return realFetch(input, init);
    return fixtureFetch(input, init);
  };
}

// ---------------------------------------------------------------------------
// Engine loader (bindings injected into the transpiled runtime `env`)
// ---------------------------------------------------------------------------
async function loadAll(bindings) {
  const runtimeUrl = dataUrl(await transpile("runtime.ts", [['import { env } from "cloudflare:workers";', `const env = ${JSON.stringify(bindings)};`]]));
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
  const researchCheck = await import(researchCheckUrl);
  const researchCompiler = await import(researchCompilerUrl);
  const researchTools = await import(researchToolsUrl);
  const valuationAi = await import(valuationAiUrl);
  return { engine, packMod, researchCheck, researchCompiler, researchTools, valuationAi };
}

// ---------------------------------------------------------------------------
// Deterministic baseline (the raw evidence DCF, pre-AI — ties to $288.44 / $182.06)
// ---------------------------------------------------------------------------
function deterministicDcf(a) {
  const cashFlows = a.cashFlows ?? [];
  if (!cashFlows.length) return null;
  const equityBasis = a.cashFlowBasis === "cfo_capex_proxy" || a.cashFlowBasis === "fcfe_equity";
  const rate = equityBasis ? a.costOfEquity : a.wacc;
  const g = a.terminalGrowth;
  const sharesB = a.dilutedSharesB;
  if (!Number.isFinite(rate) || !Number.isFinite(g) || !Number.isFinite(sharesB) || rate <= g) return null;
  const netCashB = equityBasis ? 0 : (a.netCashB ?? 0);
  let pv = 0;
  for (let i = 0; i < cashFlows.length; i += 1) pv += cashFlows[i] / (1 + rate) ** (i + 1);
  const terminalValue = (cashFlows.at(-1) * (1 + g)) / (rate - g);
  const pvTerminal = terminalValue / (1 + rate) ** cashFlows.length;
  return (pv + pvTerminal + netCashB) / sharesB;
}

const round = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : null);

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

function toolPeriod(data) {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.filings) && data.filings.length) return data.filings[0].reportDate ?? data.filings[0].filingDate ?? null;
  if (data.filing && typeof data.filing === "object") return data.filing.reportDate ?? data.filing.filed ?? null;
  return null;
}

function lastFinite(arr) {
  for (let i = arr.length - 1; i >= 0; i -= 1) if (Number.isFinite(arr[i])) return arr[i];
  return null;
}

// Recursively locate plan fields whose string value references a tool (by result id
// or by tool name). This is the audited "was the tool evidence actually consumed"
// trace: each match is a JSON-pointer path into the ResearchPlan.
function findRefs(value, needles, path, out) {
  if (typeof value === "string") {
    for (const needle of needles) {
      if (value === needle || value.includes(needle)) out.push({ path, matched: needle, value });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => findRefs(item, needles, `${path}[${index}]`, out));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) findRefs(child, needles, path ? `${path}.${key}` : key, out);
  }
}

function resolveSource(plan, evidenceId, toolResults) {
  if (!evidenceId) return null;
  const source = (plan.sources ?? []).find((item) => item.id === evidenceId);
  const tool = toolResults.find((item) => item.id === evidenceId);
  return {
    id: evidenceId,
    kind: source?.kind ?? (tool ? "tool_result" : "unknown"),
    label: source?.label ?? (tool ? tool.tool : null),
    asOf: source?.asOf ?? (tool ? tool.period : null),
    url: source?.url ?? null,
  };
}

// Material-driver provenance: assumption → evidence id → source/tool → period/date.
function assumptionProvenance(plan, toolResults) {
  const rows = [];
  (plan.businesses ?? []).forEach((business, bi) => {
    (business.forecastAssumptions ?? []).forEach((fa, fi) => {
      rows.push({
        path: `businesses[${bi}].forecastAssumptions[${fi}]`,
        field: fa.field,
        value: fa.value,
        unit: fa.unit,
        evidenceId: fa.evidenceId,
        source: resolveSource(plan, fa.evidenceId, toolResults),
        rationale: fa.rationale,
      });
    });
    if (business.revenueDriver?.evidenceId) {
      rows.push({
        path: `businesses[${bi}].revenueDriver`,
        field: business.revenueDriver.formula,
        evidenceId: business.revenueDriver.evidenceId,
        source: resolveSource(plan, business.revenueDriver.evidenceId, toolResults),
      });
    }
    (business.costDrivers ?? []).forEach((cd, ci) => {
      if (cd.evidenceId) {
        rows.push({
          path: `businesses[${bi}].costDrivers[${ci}]`,
          field: cd.formula,
          evidenceId: cd.evidenceId,
          source: resolveSource(plan, cd.evidenceId, toolResults),
        });
      }
    });
  });
  return rows;
}

// 6-year operating table from the authoritative ResearchPlan + compiled cash-flow
// stream (Year / Revenue / Revenue growth / FCF / FCF margin / Capex / Major drivers).
function operatingTable(plan, compiled) {
  const business = plan.businesses[0];
  const forecastYears = (business?.forecastYears ?? []).slice(0, 6);
  const cashFlows = compiled.profile.baseline.cashFlows ?? compiled.profile.baseline.normalizedCashFlows ?? [];
  const fcfMargin = compiled.profile.baseline.fcfMargin;
  const capexByYear = {};
  for (const item of plan.capitalRequirements ?? []) {
    if (item.kind === "capex") capexByYear[item.timingYear] = (capexByYear[item.timingYear] ?? 0) + item.amountB;
  }
  const revenueAt = (i) => (plan.businesses ?? []).reduce((sum, b) => sum + ((b.forecastYears?.[i]?.revenueB) ?? 0), 0);
  const count = Math.max(forecastYears.length, cashFlows.length, 6);
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const fy = forecastYears[i] ?? {};
    const revenueB = revenueAt(i);
    const prevRevenue = revenueAt(i - 1);
    const growth = revenueB && prevRevenue ? revenueB / prevRevenue - 1 : (fy.growth ?? null);
    rows.push({
      year: fy.year ?? i + 1,
      revenueB: round(revenueB || null),
      revenueGrowth: round(growth),
      fcfB: round(Number.isFinite(cashFlows[i]) ? cashFlows[i] : null),
      fcfMargin: round(fy.margin ?? fcfMargin ?? null),
      capexB: round(capexByYear[i + 1] ?? (fy.capexB ?? null)),
      majorDrivers: (plan.businesses ?? []).map((b) => `${b.name} → ${b.revenueDriver?.formula ?? "none"}`),
    });
  }
  return rows;
}

async function auditTicker(m, frozen, ticker, toolTrace) {
  const old = frozen.tickers[ticker];
  const pack = await m.packMod.buildAutomatedValuationPack(ticker);
  const price = pack.quote?.price ?? null;

  const toolsBefore = toolTrace.length;
  const aiBefore = openAiCalls.length;
  const result = await m.valuationAi.runResearchValuation(pack, { currentPrice: price }, new Request("https://example.test/research"), { force: true });
  const tickerTools = toolTrace.slice(toolsBefore);
  const tickerAi = openAiCalls.slice(aiBefore);

  const detail = result.orchestration.research;
  const plan = detail.plan;
  const output = result.output;

  const deterministic = deterministicDcf(pack.evidenceAssumptions);
  const newFv = round(output.ensemble.fairValue);
  const oldFv = round(old.oldPublishedFairValue);

  const compiled = m.researchCompiler.compileResearchPlan(pack, plan);
  const checks = m.researchCheck.runResearchChecks(pack, plan, compiled, output);

  // Year-6 operating bridge: the deterministic evidence cash-flow stream vs the
  // compiled ResearchPlan stream. This is the operating-level answer to "why did the
  // value move" — never the stock price.
  const detCashFlows = pack.evidenceAssumptions.cashFlows ?? pack.evidenceAssumptions.normalizedCashFlows ?? [];
  const resCashFlows = compiled.profile.baseline.cashFlows ?? compiled.profile.baseline.normalizedCashFlows ?? [];
  const detYear6Fcf = lastFinite(detCashFlows);
  const resYear6Fcf = lastFinite(resCashFlows);

  const toolResultsForProvenance = tickerTools.map((t) => ({ id: t.id, tool: t.tool, period: toolPeriod(t.data) }));

  const tools = tickerTools.map((t) => {
    const refs = [];
    findRefs(plan, [t.id, t.tool], "", refs);
    const consumed = refs.length > 0;
    return {
      id: t.id,
      tool: t.tool,
      ok: t.ok,
      error: t.error ?? null,
      args: t.args ?? {},
      source: t.data?.ticker ?? ticker,
      period: toolPeriod(t.data),
      consumed,
      consumedBy: refs.map((r) => r.path),
      status: !t.ok ? "FAILED" : consumed ? "CONSUMED" : "CALLED_BUT_NOT_CONSUMED",
    };
  });

  const companyScenarios = (plan.scenarios ?? []).filter((s) => s.appliesTo === "company");
  const companyProbabilitySum = companyScenarios.reduce((sum, s) => sum + (Number.isFinite(s.probability) ? s.probability : 0), 0);

  return {
    ticker,
    currentPrice: price,
    modelFamily: pack.profile.classification.modelFamily,
    // §12 FINAL NUMERICAL OUTPUT
    deterministicBaselineDcf: round(deterministic),
    // Monte Carlo percentiles — reported SEPARATELY from the research scenarios, never
    // relabelled as research Bear/Base/Bull.
    monteCarlo: {
      distribution: {
        p10: round(output.ensemble.probabilityDistribution.p10),
        p25: round(output.ensemble.probabilityDistribution.p25),
        p50: round(output.ensemble.probabilityDistribution.p50),
        p75: round(output.ensemble.probabilityDistribution.p75),
        p90: round(output.ensemble.probabilityDistribution.p90),
      },
      bearBaseBull: {
        bear: round(output.ensemble.scenarios.bear),
        base: round(output.ensemble.scenarios.base),
        bull: round(output.ensemble.scenarios.bull),
      },
    },
    // Research scenarios: each company-level scenario priced through the SAME
    // ensemble, probability-weighted into the published value. Distinct from Monte Carlo.
    researchScenarios: output.researchScenarios
      ? {
          baseValue: round(output.researchScenarios.baseValue),
          expectedValue: round(output.researchScenarios.expectedValue),
          residualProbability: output.researchScenarios.residualProbability,
          scenarios: output.researchScenarios.scenarios.map((s) => ({ id: s.id, name: s.name, probability: s.probability, value: round(s.value) })),
        }
      : null,
    publishedFairValue: newFv,
    publishedModel: output.engine?.publishedModel ?? null,
    primaryMethod: plan.primaryMethod,
    aggregationRule: plan.aggregationRule,
    selectedModels: result.orchestration.selectedModels,
    crossChecks: plan.crossChecks ?? [],
    // §16 acceptance gates
    researchLoopSuccess: !detail.usedDeterministicFallback,
    aiCalls: detail.aiCalls,
    aiCallDetail: tickerAi.map((c) => ({ role: c.role, status: c.status, requestId: c.requestId })),
    toolCalls: detail.toolCalls,
    tools,
    reviewerRevisions: result.orchestration.revisions ?? [],
    fallbackUsed: detail.usedDeterministicFallback,
    compilationFailed: detail.compilationFailed,
    capabilityGap: detail.capabilityGap,
    schemaError: detail.schemaError,
    cached: detail.cached,
    policyVersion: detail.policyVersion,
    evidenceVersion: detail.evidenceVersion,
    assumptionVersion: detail.assumptionVersion,
    productionD1Mutations: detail.productionD1Mutations,
    // A–L detail
    A_oldFairValue: oldFv,
    A_oldBear: round(old.bear),
    A_oldBase: round(old.base),
    A_oldBull: round(old.bull),
    A_oldPublishedModel: old.publishedModel,
    C_businessGraph: plan.businesses.map(businessNode),
    H_evidenceSources: plan.sources ?? [],
    I_missingEvidence: plan.missingEvidence ?? [],
    J_checks: checks.map((c) => ({ id: c.id, label: c.label, status: c.status, detail: c.detail })),
    // §13 valuation bridge — OPERATING-LEVEL decomposition, never a price justification.
    bridge: {
      deterministicBaselineDcf: round(deterministic),
      researchPublishedFv: newFv,
      delta: Number.isFinite(deterministic) && Number.isFinite(newFv) ? round(newFv - deterministic) : null,
      segmentation: plan.businesses.map((b) => ({ id: b.id, name: b.name, method: b.valuationMethod, segmentationBasis: b.segmentationBasis })),
      operatingTable: operatingTable(plan, compiled),
      year6Fcf: {
        deterministicB: round(detYear6Fcf),
        researchB: round(resYear6Fcf),
        deltaB: Number.isFinite(detYear6Fcf) && Number.isFinite(resYear6Fcf) ? round(resYear6Fcf - detYear6Fcf) : null,
      },
      fcfMargin: {
        deterministic: round(pack.evidenceAssumptions.fcfMargin),
        research: round(compiled.profile.baseline.fcfMargin),
      },
      revenue: {
        deterministicForwardB: round(pack.evidenceAssumptions.forwardRevenueB),
        researchForwardB: round(compiled.profile.baseline.forwardRevenueB),
      },
      capitalRequirements: plan.capitalRequirements ?? [],
      financing: plan.financing ?? [],
      dilution: plan.dilution ?? [],
      scenarios: (plan.scenarios ?? []).map((s) => ({
        id: s.id ?? null,
        name: s.name ?? null,
        appliesTo: s.appliesTo ?? null,
        probability: s.probability ?? null,
        businessIds: s.businessIds ?? [],
        economics: s.economics ?? null,
        description: s.description ?? null,
      })),
      assumptionProvenance: assumptionProvenance(plan, toolResultsForProvenance),
      note: "Operating-level decomposition from the authoritative ResearchPlan. Year-6 FCF, FCF margin, revenue, capex, financing and dilution are the operating drivers behind the revaluation; the stock price is never an input to any of these values. Each material assumption carries its evidence id and source/period via assumptionProvenance.",
    },
    plan,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const bindings = await readDevVars();
console.log("[bindings]", JSON.stringify(bindingSummary(bindings)));

if (!bindings.OPENAI_API_KEY) {
  console.error("\nOPENAI_API_KEY is not present in .dev.vars. The loop cannot make real AI calls.");
  process.exit(1);
}
if (String(bindings.AI_VALUATION_ENABLED).toLowerCase() !== "true" && bindings.AI_VALUATION_MODE !== "public") {
  console.error('\nAI_VALUATION_ENABLED is not "true" (and AI_VALUATION_MODE is not "public"). runtimeConfig().enabled will be false.');
  process.exit(1);
}

installSurgicalShim();
const m = await loadAll(bindings);

// Record every tool invocation (name, args, result id, source, period) for §5.
const toolTrace = [];
const OriginalRun = m.researchTools.ResearchToolRunner.prototype.run;
m.researchTools.ResearchToolRunner.prototype.run = async function (toolName, args, evidence) {
  const result = await OriginalRun.call(this, toolName, args, evidence);
  toolTrace.push({ id: result.id, tool: toolName, args: args ?? {}, ok: result.ok, error: result.error ?? null, data: result.data, byteLength: result.byteLength });
  return result;
};

// Pre-flight: verify the key + model resolve before spending quota on 4 tickers.
const health = await m.valuationAi.probeAiHealth();
console.log("[preflight]", JSON.stringify({ aiEnabled: health.aiEnabled, ok: health.ok, model: health.model, error: health.error ?? null }));
if (!health.ok) {
  console.error("\nPre-flight failed; the full loop is NOT run (all four tickers would fall back to deterministic).");
  console.error(`  error: ${health.error} · model: ${health.model}`);
  console.error("  If the error is an auth failure, check the key in .dev.vars.");
  console.error('  If it is a model error, set OPENAI_VALUATION_MODEL / OPENAI_REVIEW_MODEL in .dev.vars to real model ids (the built-in defaults are placeholders).');
  process.exit(1);
}
openAiCalls.length = 0; // discard the health-probe call

// Optional ticker filter: `node scripts/research-live-run.mjs [TICKER...]`.
const requested = process.argv.slice(2).map((s) => s.trim().toUpperCase()).filter(Boolean);
const known = TICKERS.map(([t]) => t);
const unknown = requested.filter((t) => !known.includes(t));
if (unknown.length) {
  console.error(`Unknown ticker(s): ${unknown.join(", ")} (known: ${known.join(", ")})`);
  process.exit(1);
}
const selected = requested.length ? TICKERS.filter(([t]) => requested.includes(t)) : TICKERS;

const frozen = JSON.parse(await readFile(new URL("../tests/fixtures/pre-upgrade-baseline.json", import.meta.url), "utf8"));

const report = {
  meta: {
    purpose: "LIVE research-loop acceptance run (Task B Phases 2–7). Real OpenAI calls + real SEC for AMD/NVDA/OKLO; SPCX (SpaceX, private) served from the deterministic fixture. No production D1 writes.",
    generatedAt: new Date().toISOString(),
    engineVersion: m.packMod.ENGINE_VERSION,
    tickers: selected.map(([t]) => t),
    bindings: bindingSummary(bindings),
  },
  tickers: {},
};

for (const [ticker] of selected) {
  console.log(`\n[run] ${ticker} …`);
  report.tickers[ticker] = await auditTicker(m, frozen, ticker, toolTrace);
}

const values = Object.values(report.tickers);
const totalMutations = values.reduce((s, t) => s + (t.productionD1Mutations ?? 0), 0);
const totalAiCalls = values.reduce((s, t) => s + (t.aiCalls ?? 0), 0);
const totalToolCalls = values.reduce((s, t) => s + (t.toolCalls ?? 0), 0);

const failures = [];
for (const t of values) {
  if (t.fallbackUsed) failures.push(`${t.ticker}: deterministic fallback used`);
  if (t.compilationFailed) failures.push(`${t.ticker}: compilation failed`);
  if (t.capabilityGap) failures.push(`${t.ticker}: capability gap (${t.capabilityGap})`);
  if (t.schemaError) failures.push(`${t.ticker}: AI payload failed runtime validation (${t.schemaError})`);
  if (!Number.isFinite(t.publishedFairValue)) failures.push(`${t.ticker}: no finite fair value`);
  if (t.aiCalls < 3) failures.push(`${t.ticker}: ${t.aiCalls} AI calls (need 3)`);
  if (t.toolCalls < 1) failures.push(`${t.ticker}: no tool calls`);
  if (t.productionD1Mutations !== 0) failures.push(`${t.ticker}: ${t.productionD1Mutations} production D1 mutations`);
  for (const role of ["research_draft", "research_finalize", "research_reviewer"]) {
    const c = t.aiCallDetail.find((x) => x.role === role);
    if (!c || c.status >= 400) failures.push(`${t.ticker}: ${role} did not return 2xx (status ${c ? c.status : "missing"})`);
  }
  // Structural acceptance: probabilities applied exactly once, scenarios mutually
  // exclusive and summing to ≤ 1, and every material tool result consumed.
  for (const id of ["probability-double-count", "scenario-probability-sum", "scenario-exclusivity"]) {
    const c = t.J_checks.find((x) => x.id === id);
    if (c && c.status === "failed") failures.push(`${t.ticker}: ${id} failed`);
  }
  const uncalledButConsumed = t.tools.filter((tool) => tool.ok && tool.status === "CALLED_BUT_NOT_CONSUMED");
  if (uncalledButConsumed.length) failures.push(`${t.ticker}: ${uncalledButConsumed.map((tool) => tool.tool).join(", ")} called but not consumed by a material assumption`);
  // When the plan declares scenario_weighted aggregation, scenarios must actually
  // price through the ensemble and move the published value.
  if (t.aggregationRule === "scenario_weighted") {
    if (!t.researchScenarios) failures.push(`${t.ticker}: scenario_weighted aggregation produced no researchScenarios`);
    else if (!Number.isFinite(t.researchScenarios.expectedValue)) failures.push(`${t.ticker}: scenario-weighted expected value is not finite`);
    else if (t.researchScenarios.scenarios.some((s) => !Number.isFinite(s.value))) failures.push(`${t.ticker}: a scenario value is not finite`);
  }
}

const verdict = failures.length === 0 ? "READY FOR REVIEW" : "NOT READY";
report.proof = {
  productionD1Mutations: totalMutations,
  totalAiCalls,
  totalToolCalls,
  allNoFallback: values.every((t) => t.fallbackUsed === false),
  allThreeAiCalls: values.every((t) => t.aiCalls >= 3),
  verdict,
  failures,
};

const outPath = new URL("../tests/fixtures/research-live-run-report.json", import.meta.url);
await writeFile(outPath, JSON.stringify(report, null, 2));

// Human summary
console.log("\n=== Research engine LIVE run (production-isolated) ===\n");
for (const [ticker, t] of Object.entries(report.tickers)) {
  console.log(`${ticker}  (quote $${t.currentPrice})`);
  console.log(`  deterministic baseline $${t.deterministicBaselineDcf}  →  published FV $${t.publishedFairValue}  (Δ ${t.bridge.delta})`);
  console.log(`  Monte Carlo (p10/base/p90): $${t.monteCarlo.bearBaseBull.bear} / $${t.monteCarlo.bearBaseBull.base} / $${t.monteCarlo.bearBaseBull.bull}`);
  if (t.researchScenarios) {
    const names = t.researchScenarios.scenarios.map((s) => `${s.name}:$${s.value}@${s.probability}`).join(", ");
    console.log(`  research scenarios: ${names}  →  expected $${t.researchScenarios.expectedValue} (residual ${t.researchScenarios.residualProbability})`);
  } else {
    console.log(`  research scenarios: none (aggregation ${t.aggregationRule})`);
  }
  console.log(`  year-6 FCF: deterministic $${t.bridge.year6Fcf.deterministicB} → research $${t.bridge.year6Fcf.researchB} (Δ $${t.bridge.year6Fcf.deltaB})`);
  console.log(`  primary ${t.primaryMethod} · published model ${t.publishedModel} · businesses ${t.C_businessGraph.map((b) => b.name).join(", ")}`);
  console.log(`  AI calls ${t.aiCalls} (${t.aiCallDetail.map((c) => `${c.role}:${c.status}`).join(", ")}) · tool calls ${t.toolCalls} · reviewer patches ${t.reviewerRevisions.length} · fallback ${t.fallbackUsed} · schemaError ${t.schemaError ?? "none"} · D1 mutations ${t.productionD1Mutations}`);
  const notConsumed = t.tools.filter((tool) => tool.status === "CALLED_BUT_NOT_CONSUMED").map((tool) => tool.tool);
  if (notConsumed.length) console.log(`  tools not consumed: ${notConsumed.join(", ")}`);
  console.log(`  checks: ${t.J_checks.filter((c) => c.status === "failed").length} failed\n`);
}
console.log(`VERDICT: ${verdict}`);
console.log(`PROOF: production D1 mutations ${totalMutations} · AI calls ${totalAiCalls} · tool calls ${totalToolCalls}`);
if (failures.length) console.log(`Failures:\n  - ${failures.join("\n  - ")}`);
console.log(`Report written to ${outPath.pathname}`);
