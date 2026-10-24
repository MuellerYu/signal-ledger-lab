// Independent P0 acceptance regressions. Run from the ORIGINAL repository:
// node --test tests/p0-independent-regression.test.mjs
// Copy this file into tests/. It reuses tests/helpers/valuation-harness.mjs.
// All external providers and Cloudflare bindings are fixtures, not production.
// Nine safety assertions fail on the reviewed snapshot; that is the finding,
// not a claim that the existing project test suite failed.
// The loader below is adapted from the supplied research-engine.test.mjs.

// Acceptance tests for the adaptive research engine (Task B).
//
// Loads the full valuation pipeline (valuation-data, universal-valuation,
// valuation-ai) plus every research module through the same transpile-and-import
// technique the harness uses, with all Cloudflare bindings replaced by inert
// stand-ins and every provider served from deterministic fixtures. Nothing here
// writes to a production D1 table or consumes a production `claimAiCall` quota.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { installProviders } from "./helpers/valuation-harness.mjs";

const root = new URL("../lib/", import.meta.url);
const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");

async function transpile(path, replacements = []) {
  let code = await readFile(new URL(path, root), "utf8");
  for (const match of [...code.matchAll(/from "(\.\/company-business\/[^"]+)"/g)]) {
    const dependency = match[1];
    code = code.replaceAll(`from "${dependency}"`, `from "${dataUrl(await transpile(`${dependency.slice(2)}.ts`))}"`);
  }
  if (code.includes('from "./research-isolation"')) {
    code = code.replaceAll('from "./research-isolation"', `from "${dataUrl(await transpile("research-isolation.ts"))}"`);
  }
  for (const dependency of ["research-schema", "research-plan", "research-validate"]) {
    if (code.includes(`from "./${dependency}"`)) code = code.replaceAll(`from "./${dependency}"`, `from "${dataUrl(await transpile(`${dependency}.ts`))}"`);
  }
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

// ---------------------------------------------------------------------------
// Loader: every module, with import redirects to data-URL siblings.
// ---------------------------------------------------------------------------
let loadedPromise = null;

async function loadAll() {
  if (loadedPromise) return loadedPromise;
  loadedPromise = (async () => {
    const runtimeUrl = dataUrl(await transpile("runtime.ts", [['import { env } from "cloudflare:workers";', "const env = new Proxy({}, { get: (_, key) => globalThis.__p0TestBindings?.[key] });"]]));
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
    const researchHash = await import(researchHashUrl);
    const researchPlan = await import(researchPlanUrl);
    const researchPolicy = await import(researchPolicyUrl);
    const researchFirewall = await import(researchFirewallUrl);
    const researchCheck = await import(researchCheckUrl);
    const researchCompiler = await import(researchCompilerUrl);
    const researchTools = await import(researchToolsUrl);
    const researchValidate = await import(researchValidateUrl);
    const valuationAi = await import(valuationAiUrl);

    return { engine, packMod, issuer, researchHash, researchPlan, researchPolicy, researchFirewall, researchCheck, researchCompiler, researchTools, researchValidate, valuationAi };
  })();
  return loadedPromise;
}

const mods = () => loadAll();
installProviders();

// ---------------------------------------------------------------------------
// Plan builders
// ---------------------------------------------------------------------------

/** A deterministic single-business DCF plan compiled from evidence, never a price. */
function makePlan(pack, overrides = {}) {
  const ev = pack.evidenceAssumptions ?? pack.profile.baseline;
  const filingId = pack.cache?.latestFilingId ?? "evid";
  const base = {
    policyVersion: "test-policy",
    businesses: [{
      id: "core",
      name: "Core Business",
      stage: "mature",
      economicMeaning: "core operating economics",
      segmentationBasis: "reported_segment",
      revenueDriver: { formula: "reported_segment", params: {}, evidenceId: filingId },
      costDrivers: [],
      disclosedData: [{ label: "Revenue", value: ev?.forwardRevenueB ?? null, unit: "USD billions", evidenceId: filingId }],
      forecastAssumptions: [],
      growthConstraints: [],
      forecastYears: [
        { year: 2027, fcfB: 10 },
        { year: 2028, fcfB: 11 },
        { year: 2029, fcfB: 12 },
      ],
      valuationMethod: "dcf",
      multiple: null,
      rationale: "test business",
      applicabilityConditions: [],
      overlaps: [],
    }],
    capitalRequirements: [],
    financing: [],
    dilution: [],
    valuationMethods: [{ model: "dcf", purpose: "valuation", appliesToBusinessIds: ["core"], rationale: "test" }],
    scenarios: [],
    probabilitiesCheck: { owners: [], note: "" },
    sources: [{ id: filingId, kind: "filing", label: "test filing" }],
    missingEvidence: [],
    primaryMethod: "dcf",
    aggregationRule: "single_model",
    crossChecks: [],
    thesisChanges: [],
    revisionRecords: [],
  };
  return { ...base, ...overrides };
}

/** A two-business SOTP plan where the first business carries a segment-level probability. */
function makeSotpPlan(pack, { probability = 0.5 } = {}) {
  const filingId = pack.cache?.latestFilingId ?? "evid";
  const biz = (id, name, revenueB) => ({
    id, name,
    stage: "mature",
    economicMeaning: `${name} operating economics`,
    segmentationBasis: "reported_segment",
    revenueDriver: { formula: "constant", params: { value: revenueB * 1e9 }, evidenceId: filingId },
    costDrivers: [],
    disclosedData: [{ label: "Revenue", value: revenueB, unit: "USD billions", evidenceId: filingId }],
    forecastAssumptions: [],
    growthConstraints: [],
    forecastYears: [],
    valuationMethod: "ev_sales",
    multiple: 4,
    rationale: "test business",
    applicabilityConditions: [],
    overlaps: [],
  });
  return {
    policyVersion: "test-policy",
    businesses: [biz("b1", "Alpha", 20), biz("b2", "Beta", 30)],
    capitalRequirements: [],
    financing: [],
    dilution: [],
    valuationMethods: [{ model: "sotp", purpose: "valuation", appliesToBusinessIds: ["b1", "b2"], rationale: "test" }],
    scenarios: [{ id: "s1", name: "Alpha delivery", description: "probability-weighted optionality", probability, appliesTo: "segment", businessIds: ["b1"] }],
    probabilitiesCheck: { owners: [{ uncertaintyId: "b1", owner: "segment" }], note: "" },
    sources: [{ id: filingId, kind: "filing", label: "test filing" }],
    missingEvidence: [],
    primaryMethod: "sotp",
    aggregationRule: "sotp",
    crossChecks: [],
    thesisChanges: [],
    revisionRecords: [],
  };
}

function compileAndRun(m, pack, plan, price) {
  const compiled = m.researchCompiler.compileResearchPlan(pack, plan);
  const output = m.engine.runValuationProfile(compiled.profile, { currentPrice: price });
  return { compiled, output };
}

async function withFakeAi(m, pack, plan, action, { failReview = false } = {}) {
  const provider = globalThis.fetch;
  const payloads = [];
  globalThis.__p0TestBindings = { AI_VALUATION_ENABLED: 'true', OPENAI_API_KEY: 'isolated-test-key' };
  globalThis.fetch = async (input, init) => {
    if (String(input) !== 'https://api.openai.com/v1/responses') return provider(input, init);
    const body = JSON.parse(init.body); payloads.push(body);
    const name = body.text.format.name;
    if (failReview && name === 'research_reviewer') return new Response('unavailable', { status: 503 });
    let response;
    if (name === 'research_draft') response = { ...plan, toolRequests: [] };
    else if (name === 'research_finalize') response = plan;
    else if (name === 'research_reviewer') response = { revisions: [] };
    else if (name === 'valuation_plan') response = {
      recommendedFamily: pack.profile.classification.modelFamily, businessModel: 'Operating business', growthStage: 'mature', capitalIntensity: 'high', drivers: ['revenue'], confidence: .7,
      modelApplicability: [{ model: 'dcf', score: 1, action: 'use', reason: 'cash flow' }],
      forecastAdjustments: { growthDelta: 0, marginDelta: 0, multipleDelta: 0, rationale: 'unchanged' }, missingEvidence: [], reviewFocus: [], rationale: 'operating inputs',
    };
    else if (name === 'valuation_review') response = { modelReviews: [], overallConfidenceAdjustment: 0, reviewNotes: [] };
    else throw new Error(`unexpected AI request ${name}`);
    return Response.json({ output_text: JSON.stringify(response) });
  };
  try { return await action(payloads); }
  finally { globalThis.fetch = provider; delete globalThis.__p0TestBindings; }
}

function trustedPlan(m, pack) {
  const plan = makePlan(pack);
  const id = `evidence:${pack.cache.evidenceVersion}`;
  plan.sources = [{ id, kind: 'filing', label: 'fixture evidence pack' }];
  plan.businesses[0].revenueDriver.evidenceId = id;
  plan.businesses[0].disclosedData[0].evidenceId = id;
  return plan;
}




async function auditPack(id) {
  const m = await mods();
  const p = structuredClone(await m.packMod.buildAutomatedValuationPack('AMD'));
  p.issuerProfile.issuerId = `independent-audit-${id}`;
  p.evidenceAssumptions = {
    ...p.evidenceAssumptions, cashFlowBasis: 'analyst_fcff', cashFlows: [10,11,12],
    normalizedCashFlows: [10,11,12], wacc: .1, costOfEquity: .12, terminalGrowth: .03,
    netCashB: 8, dilutedSharesB: 2, forwardRevenueB: 100, fcfMargin: .1,
    forwardEps: 1, forwardFcfB: 10,
  };
  p.profile.capitalCost = null;
  p.profile.capitalBridge = undefined;
  p.profile.baseline = structuredClone(p.evidenceAssumptions);
  p.profile.dataQuality = {status: 'passed', valuationRelease: 'released', checks: []};
  return {m,p};
}
const auditOptions = {simulationCount: 1000};
function removeMultipleInputs(p) {
  for (const key of ['forwardPe','evFcfMultiple','evSalesMultiple','normalizedEbitdaB','evEbitdaMultiple','normalizedCashFlows']) delete p.profile.baseline[key];
}

async function loadAuditPostRoute(m,p) {
  let source = await readFile(new URL('../app/api/valuation/run/route.ts', import.meta.url), 'utf8');
  const replacements = [
    ['import { buildAutomatedValuationPack } from "@/lib/valuation-data";', 'const buildAutomatedValuationPack = async () => globalThis.__auditRoutePack;'],
    ['import { runAiOrchestratedValuation } from "@/lib/valuation-ai";', 'const runAiOrchestratedValuation = (...args) => globalThis.__auditRunAi(...args);'],
    ['import { isAuthorizedMutation } from "@/lib/auth";', 'const isAuthorizedMutation = () => true;'],
    ['import { requirePro, upgradeRequired } from "@/lib/access";', 'const requirePro = async () => true; const upgradeRequired = () => new Response(null,{status:403});'],
  ];
  for (const [from,to] of replacements) {
    assert.ok(source.includes(from), 'API dependency import changed; update the test adapter, not application behavior.');
    source = source.replaceAll(from,to);
  }
  globalThis.__auditRoutePack = p;
  globalThis.__auditRunAi = m.valuationAi.runAiOrchestratedValuation;
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText;
  return import(dataUrl(code));
}

// A control confirms that the reviewed all-year DCF fix is retained.
test('CONTROL: segment DCF still matches the independent five-year calculation', async () => {
  const {m,p} = await auditPack('control');
  const plan = makeSotpPlan(p,{probability:1}); plan.scenarios=[];
  plan.businesses[0] = {...plan.businesses[0],valuationMethod:'dcf',multiple:null,
    forecastYears:[2,3,4,5,6].map((fcfB,index)=>({year:2027+index,fcfB}))};
  const c = m.researchCompiler.compileResearchPlan(p,plan);
  const pv = [2,3,4,5,6].reduce((sum,f,index)=>sum+f/(1.1**(index+1)),0)+6*1.03/.07/(1.1**5);
  assert.ok(Math.abs(c.segments[0].metricValueB-pv)<1e-9);
  assert.ok(Math.abs(m.engine.VALUATION_MODELS.sotp.run(c.profile.baseline,null).value-(pv+120+8)/2)<1e-9);
  assert.equal(m.issuer.getProductionD1MutationCount(),0);
});

test('B01: actual legacy and research payloads preserve the operating baseline', async () => {
  const {m,p} = await auditPack('firewall'); const plan=trustedPlan(m,p);
  const captured=[];
  await withFakeAi(m,p,plan,async(payloads)=>{
    await m.valuationAi.runAiOrchestratedValuation(p,auditOptions,new Request('https://audit.invalid'),{force:true});
    await m.valuationAi.runResearchValuation(p,auditOptions,new Request('https://audit.invalid'),{force:true});
    captured.push(...payloads);
  });
  for (const name of ['valuation_plan','research_draft','research_finalize','research_reviewer']) {
    const payload=captured.find(item=>item.text.format.name===name);
    assert.ok(payload,`Did not exercise ${name}`);
    const evidence=JSON.parse(payload.input).evidence;
    assert.deepEqual(evidence.operatingBaseline?.cashFlows,p.evidenceAssumptions.cashFlows,
      `${name}: market filtering must not erase operating cash flows`);
    assert.equal(evidence.operatingBaseline?.dilutedSharesB,2);
  }
});

test('B02a: EV/sales must use revenue even with a revenue_x_margin driver', async () => {
  const {m,p}=await auditPack('sales'); const plan=makeSotpPlan(p,{probability:1});plan.scenarios=[];
  plan.businesses[0].revenueDriver={formula:'revenue_x_margin',params:{revenueB:20},evidenceId:p.cache.latestFilingId};
  plan.businesses[0].forecastYears=[{year:2027,revenueB:20,margin:.2,fcfB:1}];
  const c=m.researchCompiler.compileResearchPlan(p,plan);
  assert.equal(c.segments[0].metricValueB*c.segments[0].multiple,80,'20B revenue × 4, not 20B × 20% × 4');
});

test('B02b: EV/FCF without an explicit FCF metric must return a capability gap', async () => {
  const {m,p}=await auditPack('fcf'); const plan=makeSotpPlan(p,{probability:1});plan.scenarios=[];
  plan.businesses[0].valuationMethod='ev_fcf';
  assert.throws(()=>m.researchCompiler.compileResearchPlan(p,plan),/MODEL_CAPABILITY_GAP/,
    'The business discloses only revenue and has no forecast FCF; revenue is not an FCF fallback');
});

test('B03: a late failed release check must withhold the main FV field', async () => {
  const {m,p}=await auditPack('late-gate');
  p.profile.capitalBridge={cashB:200,investmentsB:0,debtB:0,otherClaimsB:0,preferredClaimsB:0,minorityInterestB:0};
  p.profile.sourcePosture='reported_internal_forecast';
  const r=m.engine.runValuationProfile(p.profile,auditOptions);
  assert.equal(r.releaseGate,'model_check_required');
  assert.ok(r.dataQuality.checks.some(c=>c.status==='failed'));
  assert.equal(r.dataQuality.valuationRelease,'withheld','One final decision must govern both release status and public numbers');
  assert.equal(r.ensemble.fairValue,null);
});

test('B04: a null scenario is not a known zero and must not become an approved plan', async () => {
  const {m,p}=await auditPack('null-scenario'); const plan=trustedPlan(m,p);
  plan.aggregationRule='scenario_weighted';
  plan.scenarios=[
    {id:'zero',name:'Zero operating cash flow',description:'No future operating cash flow; cash remains.',probability:.5,appliesTo:'company',businessIds:['core'],economics:{fcfMultiplier:0}},
    {id:'normal',name:'Normal',description:'The original operating path.',probability:.5,appliesTo:'company',businessIds:['core'],economics:{fcfMultiplier:1}},
  ];
  m.researchValidate.validateResearchPayload('plan',plan);
  await withFakeAi(m,p,plan,async()=>{
    const r=await m.valuationAi.runResearchValuation(p,auditOptions,new Request('https://audit.invalid'),{force:true});
    const states=r.output.researchScenarios?.scenarios;
    if (!states || states.some(s=>s.probability>0&&s.value===null)) {
      assert.equal(r.output.dataQuality.valuationRelease,'withheld','Uncomputed state must fail closed, not contribute an invented zero');
      assert.equal(r.output.ensemble.fairValue,null);
      const d=r.orchestration.research;
      assert.equal(await m.issuer.loadResearchPlan(p.issuerProfile.issuerId,d.policyVersion,d.evidenceVersion),null);
    } else {
      // Supporting a true zero-operating-value state is an alternative valid fix.
      assert.ok(Math.abs(states.find(s=>s.id==='zero').value-4)<1e-9,'8B cash / 2B shares remains, with no debt');
      const expected=states.reduce((sum,s)=>sum+s.probability*s.value,0);
      assert.ok(Math.abs(r.output.ensemble.fairValue-expected)<1e-9);
    }
  });
});

test('B05: unconditional capex is not multiplied by delivery probability', async () => {
  const {m,p}=await auditPack('capital');const plan=makeSotpPlan(p,{probability:.5});
  plan.businesses[0]={...plan.businesses[0],valuationMethod:'dcf',multiple:null,
    forecastYears:[2,3,4,5,6].map((fcfB,index)=>({year:2027+index,fcfB}))};
  const before=m.researchCompiler.compileResearchPlan(p,plan);
  plan.capitalRequirements=[{id:'committed',businessId:'b1',kind:'capex',incremental:true,amountB:10,timingYear:1,evidenceId:p.cache.latestFilingId,rationale:'Committed and paid irrespective of delivery success'}];
  let after;
  try {after=m.researchCompiler.compileResearchPlan(p,plan);}
  catch(error){assert.match(error.message,/MODEL_CAPABILITY_GAP/);return;} // P0 may reject the unsupported combination.
  const value=c=>m.engine.VALUATION_MODELS.sotp.run(c.profile.baseline,null).value;
  assert.ok(Math.abs(value(before)-value(after)-10/1.1/2)<1e-9,
    'Specify unconditional vs contingent capital explicitly, or reject; do not silently probability-discount all capex');
});

test('B06: a legacy AI input change regenerates the quantitative forecast narrative', async () => {
  const {m,p}=await auditPack('narrative');removeMultipleInputs(p);
  p.profile.variantPath='This run uses forward revenue of $100.00B and a forecast cash-flow path of $10.00B → $11.00B → $12.00B; these are model estimates based on the current evidence.';
  await withFakeAi(m,p,trustedPlan(m,p),async()=>{
    const fake=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const response=await fake(input,init);
      if(String(input)==='https://api.openai.com/v1/responses'&&JSON.parse(init.body).text.format.name==='valuation_plan'){
        const body=await response.json();const plan=JSON.parse(body.output_text);plan.forecastAdjustments.growthDelta=.05;
        return Response.json({output_text:JSON.stringify(plan)});
      }
      return response;
    };
    const r=await m.valuationAi.runAiOrchestratedValuation(p,auditOptions,new Request('https://audit.invalid'),{force:true});
    const a=r.output.aiBaseline.assumptions;
    assert.equal(a.forwardRevenueB,105,'The intended planner adjustment must have actually executed');
    const text=r.output.investorRead.variantPath;
    assert.ok(text.includes(a.forwardRevenueB.toFixed(2))&&a.cashFlows.every(f=>text.includes(f.toFixed(2))),
      'Narrative must describe the final same-run inputs, not the pre-planner baseline');
  });
});

test('B07a: planner-only API output never says independently reviewed', async () => {
  const {m,p}=await auditPack('route');removeMultipleInputs(p);
  try {
    const {POST}=await loadAuditPostRoute(m,p);
    await withFakeAi(m,p,trustedPlan(m,p),async(payloads)=>{
      const response=await POST(new Request('https://audit.invalid/api/valuation/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticker:'AMD',forceAi:true})}));
      assert.equal(response.status,200);
      const body=await response.json();
      assert.deepEqual(payloads.map(x=>x.text.format.name),['valuation_plan']);
      assert.equal(body.review,null);
      assert.doesNotMatch(body.pipeline.find(s=>s.id==='classification').detail,/independently reviewed/i);
    });
  } finally {delete globalThis.__auditRoutePack;delete globalThis.__auditRunAi;}
});

test('B07b: a failed actual legacy request records aiCalledThisRun=true', async () => {
  const {m,p}=await auditPack('failed-call');const provider=globalThis.fetch;let actualCalls=0;
  globalThis.__p0TestBindings={AI_VALUATION_ENABLED:'true',OPENAI_API_KEY:'isolated-test-key'};
  globalThis.fetch=async(input,init)=>{
    if(String(input)==='https://api.openai.com/v1/responses'){actualCalls++;return new Response('unavailable',{status:503});}
    return provider(input,init);
  };
  try {
    const r=await m.valuationAi.runAiOrchestratedValuation(p,auditOptions,new Request('https://audit.invalid'),{force:true});
    assert.equal(actualCalls,1);
    assert.equal(r.orchestration.status,'deterministic_fallback');
    assert.equal(r.orchestration.aiCalledThisRun,true,'Request-attempt metadata is independent of whether an AI result was usable');
    assert.equal(r.orchestration.planOrigin,'deterministic');
    assert.equal(m.issuer.getProductionD1MutationCount(),0);
  } finally {globalThis.fetch=provider;delete globalThis.__p0TestBindings;}
});
