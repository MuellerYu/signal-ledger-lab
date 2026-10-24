// P0-R9 uses the immutable A6 model output and local synthetic issuer fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { installProviders, loadEngine } from './helpers/valuation-harness.mjs';

const root = new URL('../lib/', import.meta.url), urls = new Map();
async function moduleUrl(name) {
  if (urls.has(name)) return urls.get(name);
  let code = ts.transpileModule(await readFile(new URL(name + '.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  code = code.replace('import { env } from "cloudflare:workers";', 'const env = {};');
  for (const spec of new Set([...code.matchAll(/from "(\.\/[^"\n]+)"/g)].map(x => x[1])))
    code = code.replaceAll('from "' + spec + '"', 'from "' + await moduleUrl(spec.slice(2)) + '"');
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  urls.set(name, url); return url;
}
const [validation, plans, compiler, isolation] = await Promise.all(
  ['research-validate', 'research-plan', 'research-compiler', 'research-isolation']
    .map(async name => import(await moduleUrl(name))),
);
const actualDraft = JSON.parse(await readFile(new URL('./fixtures/p0-r9-a6-live-draft.json', import.meta.url), 'utf8'));
const finalDcf = JSON.parse(await readFile(new URL('./fixtures/p0-r8-final-dcf.json', import.meta.url), 'utf8'));
const finalSotp = JSON.parse(await readFile(new URL('./fixtures/p0-r8-final-sotp.json', import.meta.url), 'utf8'));
let packPromise;
async function pack() {
  if (!packPromise) packPromise = (async () => {
    const prior = globalThis.fetch; installProviders();
    try { return await (await loadEngine()).buildAutomatedValuationPack('NVDA'); }
    finally { globalThis.fetch = prior; }
  })();
  return packPromise;
}
const asDraft = p => validation.validateResearchPayload('draft', p);
const asFinal = p => validation.validateResearchPayload('plan', p);
function finalFailure(p, pattern) {
  assert.throws(() => asFinal(p), error => {
    assert.match(error.message, /RESEARCH_SCHEMA_INVALID/);
    assert.match(error.message, pattern);
    return true;
  });
}

test('R9-01 A6 real draft with absent forecastYears passes only the exploratory draft schema', () => {
  assert.equal(Object.hasOwn(actualDraft.businesses[0], 'forecastYears'), false);
  assert.equal(actualDraft.toolRequests.length, 3);
  assert.equal(plans.researchDraftSchema.properties.businesses.items.required.includes('forecastYears'), false);
  assert.ok(asDraft(actualDraft));
});
test('R9-02 the same A6 draft cannot masquerade as a final ResearchPlan', () => {
  const p = structuredClone(actualDraft); delete p.toolRequests;
  finalFailure(p, /forecastYears/);
});
test('R9-03 final DCF still rejects an empty forecastYears array', () => {
  const p = structuredClone(finalDcf); p.businesses[0].forecastYears = [];
  finalFailure(p, /forecastYears/);
});
test('R9-04 final DCF still requires fcfB in each executable year', () => {
  const p = structuredClone(finalDcf); delete p.businesses[0].forecastYears[0].fcfB;
  finalFailure(p, /fcfB/);
});
test('R9-05 legal final DCF still validates and compiles', async () => {
  const c = compiler.compileResearchPlan(await pack(), asFinal(structuredClone(finalDcf)));
  assert.deepEqual(c.profile.baseline.cashFlows, [2, 3, 4]);
});
test('R9-06 validation does not mutate the raw A6 draft', () => {
  const original = structuredClone(actualDraft); asDraft(actualDraft);
  assert.deepEqual(actualDraft, original);
});
test('R9-07 validation does not fill absent forecastYears with [] or zero', () => {
  const accepted = asDraft(actualDraft);
  assert.equal(Object.hasOwn(accepted.businesses[0], 'forecastYears'), false);
  assert.equal(Object.hasOwn(actualDraft.businesses[0], 'forecastYears'), false);
});
test('R9-08 other required draft business fields remain required', () => {
  const p = structuredClone(actualDraft); delete p.businesses[0].revenueDriver;
  assert.throws(() => asDraft(p), /revenueDriver/);
});
test('R9-09 unknown draft fields remain forbidden', () => {
  const p = structuredClone(actualDraft); p.businesses[0].inventedEconomicField = 1;
  assert.throws(() => asDraft(p), /unknown field/);
});
test('R9-10 draft price and FV targeting remain forbidden', () => {
  for (const field of ['currentPrice', 'fairValue', 'targetPrice']) {
    const p = structuredClone(actualDraft); p.businesses[0][field] = 150;
    assert.throws(() => asDraft(p), /RESEARCH_SCHEMA_INVALID/);
  }
});
test('R9-15 R8 final capability rejection remains intact', () => {
  const p = structuredClone(finalDcf);
  p.businesses[0].costDrivers.push({ formula: 'constant', params: { value: 1 }, evidenceId: null });
  finalFailure(p, /COST_DRIVERS/);
});
test('R9-16 R7 cross_check cannot change the compiled FV profile', async () => {
  const a = structuredClone(finalDcf), b = structuredClone(finalDcf);
  b.valuationMethods.push({ model: 'ev_fcf', purpose: 'cross_check', appliesToBusinessIds: ['core'], multiple: 34, rationale: 'advisory' });
  const source = await pack(), x = compiler.compileResearchPlan(source, asFinal(a)), y = compiler.compileResearchPlan(source, asFinal(b));
  assert.deepEqual(x.profile, y.profile);
  assert.equal(y.advisoryMethods.length, 1);
});
test('R9-17 R4/R5/R6 numeric contracts remain intact', async () => {
  const a = structuredClone(finalDcf), b = structuredClone(finalDcf);
  b.valuationMethods[0].multiple = null;
  assert.deepEqual(asFinal(a), asFinal(b));
  const absent = structuredClone(finalDcf), zero = structuredClone(finalDcf);
  absent.businesses[0].forecastYears[0].capexB = null;
  zero.businesses[0].forecastYears[1].fcfB = 0;
  assert.equal(Object.hasOwn(asFinal(absent).businesses[0].forecastYears[0], 'capexB'), false);
  assert.equal(asFinal(zero).businesses[0].forecastYears[1].fcfB, 0);
  const sotp = structuredClone(finalSotp), source = await pack();
  source.profile.classification.modelFamily = 'auto_energy_optionality_sotp';
  assert.equal(compiler.compileResearchPlan(source, asFinal(sotp)).segments[0].multiple, 3);
});
test('R9-18 price isolation and new cache isolation version remain bound', () => {
  const p = structuredClone(actualDraft); p.currentPrice = 150;
  assert.throws(() => asDraft(p), /RESEARCH_SCHEMA_INVALID/);
  assert.equal(isolation.RESEARCH_ISOLATION_VERSION, 'p0-r11-draft-sparse-v1');
});
