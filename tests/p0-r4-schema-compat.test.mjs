// Offline regression from a real response; all providers and bindings stay isolated.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {installProviders,loadEngine} from './helpers/valuation-harness.mjs';
const root=new URL('../lib/',import.meta.url), urls=new Map();
async function moduleUrl(name){
 if(urls.has(name))return urls.get(name);
 let code=ts.transpileModule(await readFile(new URL(name+'.ts',root),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 code=code.replace('import { env } from "cloudflare:workers";','const env = {};');
 for(const spec of new Set([...code.matchAll(/from "(\.\/[^"\n]+)"/g)].map(x=>x[1])))code=code.replaceAll('from "'+spec+'"','from "'+await moduleUrl(spec.slice(2))+'"');
 const url='data:text/javascript;base64,'+Buffer.from(code).toString('base64');urls.set(name,url);return url;
}
const [validation,plans,compiler,firewall]=await Promise.all(['research-validate','research-plan','research-compiler','research-firewall'].map(async n=>import(await moduleUrl(n))));
const real=JSON.parse(await readFile(new URL('./fixtures/p0-r4-nvda-live-draft.json',import.meta.url),'utf8'));
const roleReal=structuredClone(real);roleReal.valuationMethods[0].purpose='valuation';
function plan(model='normalized_dcf'){
 return {policyVersion:'r4-synthetic',businesses:[{id:'core',name:'Core',stage:'mature',economicMeaning:'operating cash flow',segmentationBasis:'reported_segment',revenueDriver:{formula:'constant',params:{value:10},evidenceId:null},costDrivers:[],disclosedData:[],forecastAssumptions:[],growthConstraints:[],forecastYears:[{year:1,fcfB:10},{year:2,fcfB:11},{year:3,fcfB:12}],valuationMethod:model,multiple:null,rationale:'synthetic independent arithmetic',applicabilityConditions:[],overlaps:[]}],capitalRequirements:[],financing:[],dilution:[],valuationMethods:[{model,purpose:'valuation',appliesToBusinessIds:['core'],rationale:'method'}],scenarios:[],probabilitiesCheck:{owners:[],note:''},sources:[],missingEvidence:[],primaryMethod:model,aggregationRule:'single_model',crossChecks:[],thesisChanges:[],revisionRecords:[]};
}
let packPromise;
async function pack(){if(!packPromise)packPromise=(async()=>{const previousFetch=globalThis.fetch;installProviders();try{const {buildAutomatedValuationPack}=await loadEngine();return await buildAutomatedValuationPack('NVDA');}finally{globalThis.fetch=previousFetch;}})();return packPromise;}
function validated(p){return validation.validateResearchPayload('plan',p);}
function multiplePlan(model='ev_sales',multiple=3){const p=plan(model);p.primaryMethod='sotp';p.aggregationRule='sotp';p.businesses[0].revenueDriver={formula:'reported_segment',params:{revenueB:10},evidenceId:null};if(multiple!==undefined)p.valuationMethods[0].multiple=multiple;return p;}
test('R4-01 DCF null passes schema/compiler and is economically identical to absent',async()=>{
 for(const model of ['dcf','normalized_dcf']){const a=plan(model),b=structuredClone(a);b.valuationMethods[0].multiple=null;const canonical=validated(b);assert.equal(Object.hasOwn(canonical.valuationMethods[0],'multiple'),false);assert.deepEqual(compiler.compileResearchPlan(await pack(),b),compiler.compileResearchPlan(await pack(),a));assert.equal(compiler.hashPlan(b),compiler.hashPlan(a));}
});
test('R4-02 absent DCF multiple continues through schema/compiler',async()=>{assert.doesNotThrow(()=>validated(plan()));const c=compiler.compileResearchPlan(await pack(),plan());assert.equal(c.primaryMethod,'normalized_dcf');assert.ok(c.profile.baseline.normalizedCashFlows.length===3);});
test('R4-03 all non-DCF method nulls still fail closed',()=>{for(const model of plans.VALUATION_MODEL_IDS.filter(x=>!['dcf','normalized_dcf'].includes(x))){assert.throws(()=>validated(multiplePlan(model,null)),/RESEARCH_SCHEMA_INVALID/);}});
test('R4-04 missing multiple remains a capability gap; unsupported SOTP business stays closed',async()=>{for(const model of ['ev_sales','ev_ebitda','ev_fcf','sotp']){const p=multiplePlan(model);delete p.valuationMethods[0].multiple;if(model==='sotp'){assert.throws(()=>validated(p),/BUSINESS_METHOD/);assert.throws(()=>compiler.compileResearchPlan(multiplePack,p),/BUSINESS_METHOD/);}else{validated(p);assert.throws(()=>compiler.compileResearchPlan(multiplePack,p),/explicit positive multiple/);}} });
// Pack filled once before these test bodies execute; no provider HTTP is used.
const awaitPack=await pack();
const multiplePack={...awaitPack,profile:{...awaitPack.profile,classification:{...awaitPack.profile.classification,modelFamily:"auto_energy_optionality_sotp"}}};
test('R4-05 valid numeric multiples preserve the pre-R4 10 x 3 = 30 segment economics',async()=>{
 const p=multiplePlan('ev_sales',3),c=compiler.compileResearchPlan(multiplePack,validated(p));assert.equal(c.segments[0].metricValueB,10);assert.equal(c.segments[0].multiple,3);assert.equal(c.segments[0].metricValueB*c.segments[0].multiple,30);assert.equal(compiler.hashPlan(validated(p)),compiler.hashPlan(p));
});
test('R4-06 numeric strings remain invalid for every method',()=>{for(const model of ['normalized_dcf','ev_sales','ev_ebitda','sotp'])assert.throws(()=>validated(multiplePlan(model,'3')),/RESEARCH_SCHEMA_INVALID/);});
test('R4-07 nonfinite and negative multiples reject; zero cannot value a multiple business',()=>{
 for(const value of [NaN,Infinity,-Infinity,-1])for(const model of ['normalized_dcf','ev_sales'])assert.throws(()=>validated(multiplePlan(model,value)),/RESEARCH_SCHEMA_INVALID/);
 assert.throws(()=>compiler.compileResearchPlan(awaitPack,validated(multiplePlan('ev_sales',0))),/positive multiple/);
});
test('R4-08 canonicalization/validation/compiler do not mutate raw input',()=>{const p=plan();p.valuationMethods[0].multiple=null;const before=structuredClone(p);const c=plans.canonicalizeResearchPlan(p);validated(p);compiler.compileResearchPlan(awaitPack,p);assert.deepEqual(p,before);assert.notEqual(c,p);assert.notEqual(c.valuationMethods[0],p.valuationMethods[0]);});
test('R4-09 canonicalization is idempotent and does not erase other nulls',()=>{const p=plan();p.valuationMethods[0].multiple=null;const c=plans.canonicalizeResearchPlan(p);assert.deepEqual(plans.canonicalizeResearchPlan(c),c);assert.equal(c.businesses[0].multiple,null);const invalid=multiplePlan('ev_sales',null);assert.equal(plans.canonicalizeResearchPlan(invalid).valuationMethods[0].multiple,null);});
test('R4-10 historical draft needs an explicit role; DCF null normalization remains unchanged',()=>{assert.equal(real.valuationMethods[0].multiple,null);assert.throws(()=>validation.validateResearchPayload('draft',real),/RESEARCH_SCHEMA_INVALID/);const c=validation.validateResearchPayload('draft',roleReal);const expected=structuredClone(roleReal);delete expected.valuationMethods[0].multiple;assert.deepEqual(c,expected);});
test('R4-11 real fixture still goes through price isolation and structural firewall',()=>{
 const clean=validation.validateResearchPayload('draft',roleReal);const projected=firewall.sanitizeResearchInput({draft:clean});assert.ok(projected);
 for(const mutate of [p=>p.valuationMethods[0].currentPrice=123,p=>p.businesses[0].revenueDriver.params.fairValue=123,p=>p.toolRequests[0].args.targetPrice=123]){const dirty=structuredClone(roleReal);mutate(dirty);assert.throws(()=>validation.validateResearchPayload('draft',dirty),/RESEARCH_SCHEMA_INVALID/);}
 const p=structuredClone(roleReal);p.primaryMethod=null;assert.throws(()=>validation.validateResearchPayload('draft',p),/RESEARCH_SCHEMA_INVALID/);
});
test('R4-12 unknown fields, discriminators and method types remain rejected',()=>{for(const mutate of [p=>p.valuationMethods[0].unknown=null,p=>p.valuationMethods[0].model='dcf_fake',p=>p.valuationMethods[0].model=1,p=>p.valuationMethods[0]=null]){const p=structuredClone(roleReal);mutate(p);assert.throws(()=>validation.validateResearchPayload('draft',p),/RESEARCH_SCHEMA_INVALID/);}});
