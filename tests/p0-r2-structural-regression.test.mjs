// P0-R2 independent structural-boundary regressions. Synthetic data only.
// Run in the ORIGINAL repository: node --test tests/p0-r2-structural-regression.test.mjs
// Uses the supplied transpile-and-import loader and local provider fixtures.
// No network, paid AI, production D1 or authorization changes.
// Shared loader/fixtures adapted from the original independent boundary suite; new assertions below.
// Input fixtures are synthetic and are not real-company valuations.
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
// New cases. No implementation of a business filter exists in this test:
// expectations concern captured requests and cache behavior, not regex matching.
const marker = 811.23;
const metadataCases = [
  {key:'marketCapB',value:1622.46},
  {key:'lastTradePrice',value:marker},
  {key:'bidPrice',value:811.21},
  {key:'askPrice',value:811.25},
];
const record = (id,data) => console.log('R2_STRUCTURAL_OBSERVATION '+JSON.stringify({id,synthetic:true,...data}));
const paramsOf = body => {
  const data=JSON.parse(body.input); return data.draft?.businesses?.[0]?.revenueDriver?.params ?? data.plan?.businesses?.[0]?.revenueDriver?.params ?? null;
};
const hasKey = (value,key) => Boolean(value && typeof value==='object' && (Object.hasOwn(value,key) || Object.values(value).some(x=>hasKey(x,key))));
async function approvedEntry(id) {
  const {m,p}=await auditPack('r2-'+id); const plan=trustedPlan(m,p); let first;
  await withFakeAi(m,p,plan,async()=> {first=await m.valuationAi.runResearchValuation(p,auditOptions,new Request('https://audit.invalid'),{force:true});});
  const d=first.orchestration.research;
  const entry=await m.issuer.loadResearchPlan(p.issuerProfile.issuerId,d.policyVersion,d.evidenceVersion);
  assert.ok(entry?.approval,'Control must produce a clean approved plan before testing storage protection.');
  return {m,p,plan,first,entry};
}

test('R2-C01: original normalized price aliases are still rejected', async()=>{
  const {m,p}=await auditPack('r2-recognized');const plan=trustedPlan(m,p);
  for(const key of ['preliminaryFairValue','CURRENT_PRICE_USD','target-price-low','preliminaryFVNow','fairValuePerShare']) {
    const bad=structuredClone(plan);bad.businesses[0].revenueDriver.params[key]=marker;
    assert.throws(()=>m.researchValidate.validateResearchPayload('plan',bad),/RESEARCH_SCHEMA_INVALID/);
    assert.equal(hasKey(m.researchFirewall.sanitizeResearchInput(bad),key),false);
  }
});

test('R2-C02: declared operating fields and legitimate driver unit prices survive',async()=>{
  const {m,p}=await auditPack('r2-operating');const plan=trustedPlan(m,p);
  for(const [formula,params] of [
    ['volume_x_price',{volume:1e6,price:125}],
    ['capacity_x_utilization_x_price',{capacity:1e6,utilization:.8,price:125}],
    ['users_x_arpu',{users:1e6,arpu:125}],
    ['constant',{value:125e6}],
    ['reported_segment',{revenueB:.125}],
    ['growth',{revenueB:.125}],
    ['revenue_x_margin',{revenueB:.125}],
  ]) {
    const good=structuredClone(plan);good.businesses[0].revenueDriver={formula,params,evidenceId:plan.sources[0].id};
    assert.doesNotThrow(()=>m.researchValidate.validateResearchPayload('plan',good));
    assert.deepEqual(m.researchFirewall.sanitizeResearchInput(good).businesses[0].revenueDriver,good.businesses[0].revenueDriver);
  }
  const operating={operatingBaseline:{operatingIncomeB:8,operatingMargin:.2,cashFlows:[10,11,12],dilutedSharesB:2,netCashB:8,debtB:3,wacc:.1}};
  assert.deepEqual(m.researchFirewall.sanitizeResearchInput(operating),operating);
});

test('R2-C03: actual reviewer inputs remain invariant while market hard gates still work',async()=>{
  const {m,p}=await auditPack('r2-price-and-reference');p.profile.baseline.forwardPe=999;
  const sent=[];
  for(const price of [91,257,.001,2e6]) {
    const q=structuredClone(p);q.profile.referencePrice={value:price,asOf:'2026-09-21',source:'synthetic'};
    await withFakeAi(m,q,trustedPlan(m,q),async(payloads)=>{
      const r=await m.valuationAi.runAiOrchestratedValuation(q,{...auditOptions,currentPrice:price},new Request('https://audit.invalid'),{force:true});
      const body=payloads.find(x=>x.text.format.name==='valuation_review');assert.ok(body,'Reviewer must run.');
      sent.push(JSON.parse(body.input));
      if(price===.001||price===2e6){assert.equal(r.output.dataQuality.valuationRelease,'withheld');assert.equal(r.output.ensemble.fairValue,null);}
    });
  }
  for(const data of sent.slice(1)) assert.deepEqual(data,sent[0]);
  assert.ok(sent[0].checks.some(x=>x.id==='share-scale'));
});

test('R2-C04: valid cached AI plan has no new AI call and retains approved origin',async()=>{
  const {m,p,entry}=await approvedEntry('clean-cache');
  const result=await m.valuationAi.runResearchValuation(p,auditOptions,new Request('https://audit.invalid'));
  assert.equal(result.orchestration.cached,true);assert.equal(result.orchestration.aiCalledThisRun,false);
  assert.equal(result.orchestration.planOrigin,'ai');assert.equal(result.orchestration.reviewStatus,'passed');
  assert.deepEqual(result.orchestration.research.plan,entry.plan);
});

test('R2-S01: ordinary stock-quote fields in driver params cannot reach finalize or reviewer',async()=>{
  const observations=[];
  for(const {key,value} of metadataCases) {
    const {m,p}=await auditPack('r2-driver-'+key);const plan=trustedPlan(m,p);plan.businesses[0].revenueDriver.params[key]=value;
    await withFakeAi(m,p,plan,async(payloads)=>{
      const result=await m.valuationAi.runResearchValuation(p,auditOptions,new Request('https://audit.invalid'),{force:true});
      const d=result.orchestration.research;const stored=await m.issuer.loadResearchPlan(p.issuerProfile.issuerId,d.policyVersion,d.evidenceVersion);
      const downstream=payloads.filter(x=>['research_finalize','research_reviewer'].includes(x.text.format.name));
      const o={key,value,stages:downstream.map(x=>({stage:x.text.format.name,params:paramsOf(x)})),forwarded:downstream.some(x=>hasKey(JSON.parse(x.input),key)),storedContamination:hasKey(stored?.plan,key),approved:Boolean(stored?.approval),release:result.output.dataQuality.valuationRelease};
      observations.push(o);record('R2-S01',o);
    });
  }
  assert.ok(observations.every(x=>!x.forwarded&&!x.storedContamination),'Reject/explicitly remove non-operating stock quote metadata, rather than forwarding and approving it.');
});

test('R2-S02: new contamination in finalized response is stopped before research reviewer',async()=>{
  const {m,p}=await auditPack('r2-finalized-only');const plan=trustedPlan(m,p);
  await withFakeAi(m,p,plan,async(payloads)=>{
    const provider=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const response=await provider(input,init);
      if(String(input)!=='https://api.openai.com/v1/responses'||JSON.parse(init.body).text.format.name!=='research_finalize')return response;
      const body=await response.json();const finalized=JSON.parse(body.output_text);
      finalized.businesses[0].revenueDriver.params.lastTradePrice=marker;
      return Response.json({output_text:JSON.stringify(finalized)});
    };
    const result=await m.valuationAi.runResearchValuation(p,auditOptions,new Request('https://audit.invalid'),{force:true});
    const d=result.orchestration.research;const stored=await m.issuer.loadResearchPlan(p.issuerProfile.issuerId,d.policyVersion,d.evidenceVersion);
    const reviewer=payloads.filter(x=>x.text.format.name==='research_reviewer');
    record('R2-S02',{reviewerParams:reviewer.map(paramsOf),storedParams:stored?.plan?.businesses?.[0]?.revenueDriver?.params??null,reviewStatus:result.orchestration.reviewStatus});
    assert.ok(reviewer.every(x=>!hasKey(JSON.parse(x.input),'lastTradePrice'))&&!hasKey(stored?.plan,'lastTradePrice'),'Finalized-response boundary must apply the same operating-only contract.');
  });
});

test('R2-S03: market capitalization cannot disclose quote or become a reused approved plan',async()=>{
  const {m,p}=await auditPack('r2-market-cap-cache');const plan=trustedPlan(m,p);plan.businesses[0].revenueDriver.params.marketCapB=1622.46;
  let first,payloads=[];await withFakeAi(m,p,plan,async(bodies)=>{first=await m.valuationAi.runResearchValuation(p,auditOptions,new Request('https://audit.invalid'),{force:true});payloads=bodies;});
  const hit=await m.valuationAi.runResearchValuation(p,auditOptions,new Request('https://audit.invalid'));
  const reviewer=payloads.find(x=>x.text.format.name==='research_reviewer');const input=reviewer?JSON.parse(reviewer.input):null;
  const cap=input?.plan?.businesses?.[0]?.revenueDriver?.params?.marketCapB;
  const shares=input?.evidence?.operatingBaseline?.dilutedSharesB;
  record('R2-S03',{marketCapB:cap??null,dilutedSharesB:shares??null,reconstructedQuote:cap!=null&&shares?cap/shares:null,cacheHit:hit.orchestration.cached,planOrigin:hit.orchestration.planOrigin,aiCalledThisRun:hit.orchestration.aiCalledThisRun,reviewStatus:hit.orchestration.reviewStatus,release:first.output.dataQuality.valuationRelease});
  assert.ok(!hasKey(input,'marketCapB')&&!hasKey(hit.orchestration.research.plan,'marketCapB'),'Market-cap metadata is a price-derived value, not a reported_segment revenue driver.');
});

test('R2-S04: contaminated storage attempt preserves the last clean approved plan',async()=>{
  const {m,p,entry}=await approvedEntry('memory-protection');const dirty=structuredClone(entry);dirty.plan.businesses[0].revenueDriver.params.marketCapB=1622.46;
  let rejected=false;try{await m.issuer.persistResearchPlan(dirty);}catch{rejected=true;}
  const loaded=await m.issuer.loadResearchPlan(p.issuerProfile.issuerId,entry.policyVersion,entry.evidenceVersion);
  record('R2-S04',{rejected,storedParams:loaded?.plan?.businesses?.[0]?.revenueDriver?.params??null,approved:Boolean(loaded?.approval)});
  assert.deepEqual(loaded?.plan,entry.plan,'A rejected or explicitly cleaned metadata write must not replace the clean plan with a polluted one.');
});

test('R2-S05: historical stock-metadata row is not hydrated or reused as approved research',async()=>{
  const {m,p,entry}=await approvedEntry('db-protection-template');const q=structuredClone(p);q.issuerProfile.issuerId+='-historical-row';
  const plan=structuredClone(entry.plan);plan.businesses[0].revenueDriver.params.marketCapB=1622.46;
  const row={issuer_id:q.issuerProfile.issuerId,policy_version:entry.policyVersion,evidence_version:entry.evidenceVersion,assumption_version:'synthetic-contaminated-history',plan_json:JSON.stringify({plan,approval:entry.approval})};
  let reads=0,mutations=0;
  globalThis.__p0TestBindings={DB:{batch:async()=>[],prepare:(sql)=>({bind(){return this;},first:async()=>{assert.match(sql,/^SELECT \* FROM research_plans/);reads++;return structuredClone(row);},run:async()=>{mutations++;throw new Error('No database mutations permitted in this fixture');}})}};
  try{
    const loaded=await m.issuer.loadResearchPlan(q.issuerProfile.issuerId,entry.policyVersion,entry.evidenceVersion);
    const r=await m.valuationAi.runResearchValuation(q,auditOptions,new Request('https://audit.invalid'));
    record('R2-S05',{loadedPollution:hasKey(loaded?.plan,'marketCapB'),cacheHit:r.orchestration.cached,planOrigin:r.orchestration.planOrigin,reviewStatus:r.orchestration.reviewStatus,reads,mutations});
    assert.equal(mutations,0);
    assert.ok(!hasKey(loaded?.plan,'marketCapB')&&!hasKey(r.orchestration.research.plan,'marketCapB'),'Historical price-derived metadata must not return as an approved clean source.');
  }finally{delete globalThis.__p0TestBindings;}
});

test('R2-S06: tool args and undeclared business objects cannot tunnel stock quote fields',async()=>{
  const observations=[];
  for(const route of ['tool-args','business-extra']){
    const {m,p}=await auditPack('r2-extra-'+route);const plan=trustedPlan(m,p);
    if(route==='business-extra')plan.businesses[0].marketData={lastTradePrice:marker};
    await withFakeAi(m,p,plan,async(payloads)=>{
      if(route==='tool-args'){
        const provider=globalThis.fetch;
        globalThis.fetch=async(input,init)=>{
          const response=await provider(input,init);
          if(String(input)!=='https://api.openai.com/v1/responses'||JSON.parse(init.body).text.format.name!=='research_draft')return response;
          const b=await response.json();const draft=JSON.parse(b.output_text);
          draft.toolRequests=[{tool:'list_filing_documents',args:{limit:1,lastTradePrice:marker}}];
          return Response.json({output_text:JSON.stringify(draft)});
        };
      }
      await m.valuationAi.runResearchValuation(p,auditOptions,new Request('https://audit.invalid'),{force:true});
      const downstream=payloads.filter(x=>['research_finalize','research_reviewer'].includes(x.text.format.name));
      const leaks=downstream.filter(x=>hasKey(JSON.parse(x.input),'lastTradePrice')).map(x=>x.text.format.name);
      observations.push({route,leaks});record('R2-S06',{route,leaks});
    });
  }
  assert.ok(observations.every(x=>!x.leaks.length),'Declared object keys and tool-specific arguments need an enforced positive contract, not only a name blacklist.');
});
