// Offline compatibility checks. The live response fixture contains no credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { installProviders, loadEngine } from './helpers/valuation-harness.mjs';

const root = new URL('../lib/', import.meta.url);
const urls = new Map();
async function moduleUrl(name) {
  if (urls.has(name)) return urls.get(name);
  let code = ts.transpileModule(await readFile(new URL(name + '.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  code = code.replace('import { env } from "cloudflare:workers";', 'const env = {};');
  for (const spec of new Set([...code.matchAll(/from "(\.\/[^"\n]+)"/g)].map(x => x[1])))
    code = code.replaceAll('from "' + spec + '"', 'from "' + await moduleUrl(spec.slice(2)) + '"');
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  urls.set(name, url);
  return url;
}
const [validation, plans, compiler] = await Promise.all(
  ['research-validate', 'research-plan', 'research-compiler'].map(async name => import(await moduleUrl(name))),
);
const liveDraft = JSON.parse(await readFile(new URL('./fixtures/p0-r5-nvda-a5-live-draft.json', import.meta.url), 'utf8'));
const roleDraft = structuredClone(liveDraft);
roleDraft.valuationMethods.forEach((method, index) => { method.purpose = index === 0 ? 'valuation' : 'cross_check'; });

function plan() {
  return {
    policyVersion: 'r5-offline', businesses: [{
      id: 'core', name: 'Core', stage: 'mature', economicMeaning: 'cash flow',
      segmentationBasis: 'reported_segment',
      revenueDriver: { formula: 'reported_segment', params: { revenueB: 10 }, evidenceId: null },
      costDrivers: [], disclosedData: [], forecastAssumptions: [], growthConstraints: [],
      forecastYears: [{ year: 1, revenueB: 10, fcfB: 2 }, { year: 2, fcfB: 3 }, { year: 3, fcfB: 4 }],
      valuationMethod: 'normalized_dcf', multiple: null, rationale: 'offline arithmetic',
      applicabilityConditions: [], overlaps: [],
    }],
    capitalRequirements: [], financing: [], dilution: [],
    valuationMethods: [{ model: 'normalized_dcf', purpose: 'valuation', appliesToBusinessIds: ['core'], rationale: 'method' }],
    scenarios: [], probabilitiesCheck: { owners: [], note: '' }, sources: [], missingEvidence: [],
    primaryMethod: 'normalized_dcf', aggregationRule: 'single_model', crossChecks: [],
    thesisChanges: [], revisionRecords: [],
  };
}
const accepted = p => validation.validateResearchPayload('plan', p);
const rejected = p => assert.throws(() => accepted(p), /RESEARCH_SCHEMA_INVALID/);

test('R5-01 optional forecast capex null is absent and schema-valid', () => {
  const p = plan(); p.businesses[0].forecastYears[0].capexB = null;
  const c = accepted(p);
  assert.equal(Object.hasOwn(c.businesses[0].forecastYears[0], 'capexB'), false);
});
test('R5-02 null and absent forecast capex canonicalize identically', () => {
  const p = plan(); const absent = structuredClone(accepted(p));
  p.businesses[0].forecastYears[0].capexB = null;
  assert.deepEqual(accepted(p), absent);
});
test('R5-03 explicit zero stays present', () => {
  const p = plan(); p.businesses[0].forecastYears[0].capexB = 0;
  const c = validation.validateResearchPayload('draft', { ...p, toolRequests: [] });
  assert.equal(Object.hasOwn(c.businesses[0].forecastYears[0], 'capexB'), true);
  assert.equal(c.businesses[0].forecastYears[0].capexB, 0);
  rejected(p); // Final execution does not consume capexB, including a genuine zero.
});
test('R5-04 valid capex number is unchanged', () => {
  const p = plan(); p.businesses[0].forecastYears[0].capexB = 1.25;
  assert.equal(validation.validateResearchPayload('draft', { ...p, toolRequests: [] }).businesses[0].forecastYears[0].capexB, 1.25);
  rejected(p);
});
test('R5-05 prose forecast numeric is still rejected', () => {
  const p = plan(); p.businesses[0].forecastYears[0].capexB = 'not supplied'; rejected(p);
});
test('R5-06 declared optional numeric driver sentinel becomes absent', () => {
  const p = plan(); p.businesses[0].revenueDriver.params.revenueB = ' not supplied ';
  const c = accepted(p);
  assert.equal(Object.hasOwn(c.businesses[0].revenueDriver.params, 'revenueB'), false);
});
test('R5-07 absent and sentinel driver parameter canonicalize identically', () => {
  const p = plan(); delete p.businesses[0].revenueDriver.params.revenueB;
  const absent = structuredClone(accepted(p));
  p.businesses[0].revenueDriver.params.revenueB = 'not supplied';
  assert.deepEqual(accepted(p), absent);
});
test('R5-08 legal numeric string retains its schema contract', () => {
  const p = plan(); p.businesses[0].revenueDriver.params.revenueB = '123.45';
  assert.equal(accepted(p).businesses[0].revenueDriver.params.revenueB, '123.45');
});
test('R5-09 ordinary invalid strings and unapproved sentinels reject', () => {
  for (const value of ['abc', 'later', 'unknown', 'Not supplied']) {
    const p = plan(); p.businesses[0].revenueDriver.params.revenueB = value; rejected(p);
  }
});
test('R5-10 required economic input remains a compiler capability gap', async () => {
  const p = plan();
  p.businesses[0].valuationMethod = 'ev_sales';
  p.valuationMethods = [{ model: 'ev_sales', purpose: 'valuation', multiple: 3, appliesToBusinessIds: ['core'], rationale: 'method' }];
  p.primaryMethod = 'sotp'; p.aggregationRule = 'sotp';
  p.businesses[0].revenueDriver = { formula: 'volume_x_price', params: { volume: 'not supplied', price: 2 }, evidenceId: null };
  p.businesses[0].forecastYears[0] = { year: 1, fcfB: 2 };
  const canonical = accepted(p);
  assert.equal(Object.hasOwn(canonical.businesses[0].revenueDriver.params, 'volume'), false);
  const previous = globalThis.fetch;
  installProviders();
  let pack;
  try { pack = await (await loadEngine()).buildAutomatedValuationPack('NVDA'); }
  finally { globalThis.fetch = previous; }
  assert.throws(() => compiler.compileResearchPlan(pack, canonical), /EV\/sales requires explicit revenue/);
});
test('R5-11 canonicalization and validation never mutate the source', () => {
  const p = plan(); p.businesses[0].forecastYears[0].capexB = null;
  p.businesses[0].revenueDriver.params.revenueB = 'not supplied';
  p.valuationMethods[0].multiple = null;
  const original = structuredClone(p);
  accepted(p); plans.canonicalizeResearchPlan(p);
  assert.deepEqual(p, original);
});
test('R5-12 canonicalization is idempotent', () => {
  const p = plan(); p.businesses[0].forecastYears[0].capexB = null;
  p.businesses[0].revenueDriver.params.revenueB = 'not supplied';
  p.valuationMethods[0].multiple = null;
  const once = plans.canonicalizeResearchPlan(p);
  assert.deepEqual(plans.canonicalizeResearchPlan(once), once);
  assert.equal(plans.canonicalizeResearchPlan(once), once);
});
test('R5-13 unknown fields and required forecast year still reject', () => {
  const p = plan(); p.businesses[0].forecastYears[0].other = null; rejected(p);
  const q = plan(); q.businesses[0].forecastYears[0].year = null; rejected(q);
  const r = plan(); r.businesses[0].revenueDriver.params.extra = 'not supplied'; rejected(r);
});
test('R5-14 price isolation rejects smuggled targeting fields', () => {
  const p = plan(); p.businesses[0].revenueDriver.params.targetPrice = 'not supplied'; rejected(p);
  const q = plan(); q.businesses[0].forecastYears[0].fairValue = null; rejected(q);
});
test('R5-15 R4 DCF multiple null still canonicalizes to absent', () => {
  const p = plan(); p.valuationMethods[0].multiple = null;
  const c = accepted(p);
  assert.equal(Object.hasOwn(c.valuationMethods[0], 'multiple'), false);
  assert.equal(p.valuationMethods[0].multiple, null);
});
test('A5 real NVDA draft with explicit roles crosses R4/R5 schema gate without changing evidence or zeros', () => {
  const source = structuredClone(liveDraft);
  assert.throws(() => validation.validateResearchPayload('draft', liveDraft), /RESEARCH_SCHEMA_INVALID/);
  const c = validation.validateResearchPayload('draft', roleDraft);
  assert.equal(Object.hasOwn(c.valuationMethods[0], 'multiple'), false);
  assert.equal(Object.hasOwn(c.businesses[0].revenueDriver.params, 'revenueB'), false);
  assert.equal(Object.hasOwn(c.businesses[0].forecastYears[0], 'capexB'), false);
  for (const index of [1, 2]) for (const field of ['growth', 'margin', 'revenueB', 'capexB', 'fcfB'])
    assert.equal(c.businesses[0].forecastYears[index][field], 0);
  assert.deepEqual(liveDraft, source);
});
