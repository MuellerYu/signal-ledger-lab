import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const root = new URL('../lib/', import.meta.url), urls = new Map();
async function moduleUrl(name) {
  if (urls.has(name)) return urls.get(name);
  let code = ts.transpileModule(await readFile(new URL(name + '.ts', root), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const spec of new Set([...code.matchAll(/from "(\.\/[^"\n]+)"/g)].map(match => match[1])))
    code = code.replaceAll('from "' + spec + '"', 'from "' + await moduleUrl(spec.slice(2)) + '"');
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  urls.set(name, url); return url;
}
const [plans, validation, isolation] = await Promise.all(
  ['research-plan', 'research-validate', 'research-isolation'].map(async name => import(await moduleUrl(name))),
);
const fixtureBytes = await readFile(new URL('./fixtures/p0-a7-nvda-live-draft-bad-schema.json', import.meta.url));
const fixtureSha = '4600d13a7c25fc773d867b4637dade19003fd71babdfb2614501fcf4fb6be5d8';
const liveDraft = JSON.parse(fixtureBytes.toString('utf8'));
const finalDcf = JSON.parse(await readFile(new URL('./fixtures/p0-r8-final-dcf.json', import.meta.url), 'utf8'));
const accepted = value => validation.validateResearchPayload('draft', value);
const rejected = value => assert.throws(() => accepted(value), /RESEARCH_SCHEMA_INVALID/);

function numericLeaves(value, path = '$') {
  if (typeof value === 'number') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((child, index) => numericLeaves(child, `${path}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value)
    .flatMap(([key, child]) => numericLeaves(child, `${path}.${key}`));
  return [];
}

test('A7-DS01 live response fixture remains byte-exact and documents all seven raw gaps', () => {
  assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), fixtureSha);
  assert.deepEqual(liveDraft.businesses.map(business => business.id), ['accelerated_compute', 'networking', 'software']);
  assert.deepEqual(liveDraft.businesses.map(business => business.valuationMethod), ['dcf', 'dcf', 'dcf']);
  assert.equal(liveDraft.businesses.every(business => !Object.hasOwn(business, 'multiple')), true);
  assert.equal(Object.hasOwn(liveDraft.businesses[1], 'disclosedData'), false);
  assert.equal(Object.hasOwn(liveDraft.businesses[1], 'forecastAssumptions'), false);
  assert.equal(Object.hasOwn(liveDraft.businesses[2], 'disclosedData'), false);
  assert.equal(Object.hasOwn(liveDraft.businesses[2], 'forecastAssumptions'), false);
});

test('A7-DS02 sparse draft keeps business omissions without changing evidence or economics', () => {
  const before = structuredClone(liveDraft);
  const canonical = accepted(liveDraft);
  const expected = structuredClone(liveDraft);
  // Existing plan-level DCF normalization independently removes this unused null.
  delete expected.valuationMethods[0].multiple;
  assert.deepEqual(canonical, expected);
  assert.deepEqual(liveDraft, before);
  assert.deepEqual(numericLeaves(canonical), numericLeaves(liveDraft));
  assert.deepEqual(canonical.toolRequests, liveDraft.toolRequests);
  assert.deepEqual(canonical.businesses.map(business => business.id), liveDraft.businesses.map(business => business.id));
  assert.deepEqual(accepted(canonical), canonical);
});

test('A7-DS03 raw draft schema permits only the sanctioned omissions; final structure stays required', () => {
  const draft = plans.researchDraftSchema.properties.businesses.items;
  for (const field of ['disclosedData', 'forecastAssumptions', 'forecastYears', 'multiple'])
    assert.equal(draft.required.includes(field), false, `raw draft ${field}`);
  const finalBusiness = plans.researchPlanSchema.properties.businesses.items.anyOf[0];
  for (const field of ['disclosedData', 'forecastAssumptions', 'forecastYears', 'multiple'])
    assert.equal(finalBusiness.required.includes(field), true, `final ${field}`);
});

test('A7-DS04 missing exploratory multiple is allowed while malformed structural fields still fail', () => {
  const ev = structuredClone(liveDraft); ev.businesses[0].valuationMethod = 'ev_ebitda';
  assert.doesNotThrow(() => accepted(ev));
  const data = structuredClone(liveDraft); data.businesses[1].disclosedData = 'unknown';
  rejected(data);
  const assumptions = structuredClone(liveDraft); assumptions.businesses[1].forecastAssumptions = null;
  rejected(assumptions);
  const multiple = structuredClone(liveDraft); multiple.businesses[0].multiple = 'not supplied';
  rejected(multiple);
});

test('A7-DS05 draft validator does not create zero or any other numeric parameter', () => {
  const draft = structuredClone(liveDraft);
  draft.businesses[0].revenueDriver.params = {};
  const canonical = accepted(draft);
  assert.deepEqual(canonical.businesses[0].revenueDriver.params, {});
  assert.deepEqual(numericLeaves(canonical), numericLeaves(draft));
});

test('A7-DS06 price isolation, non-finite numbers and unknown fields remain hard failures', () => {
  for (const field of ['currentPrice', 'fairValue', 'targetPrice']) {
    const dirty = structuredClone(liveDraft); dirty.businesses[0][field] = 100;
    assert.ok(isolation.marketFieldPaths(dirty).length > 0);
    rejected(dirty);
  }
  for (const value of [NaN, Infinity]) {
    const dirty = structuredClone(liveDraft); dirty.businesses[0].revenueDriver.params.revenueB = value;
    rejected(dirty);
  }
  const top = structuredClone(liveDraft); top.unrecognizedAudit = 'x'; rejected(top);
  const nested = structuredClone(liveDraft); nested.businesses[0].inventedEconomicField = 1; rejected(nested);
});

test('A7-DS07 final ResearchPlan still requires full shape and executable forecast', () => {
  for (const field of ['disclosedData', 'forecastAssumptions', 'multiple', 'forecastYears']) {
    const final = structuredClone(finalDcf); delete final.businesses[0][field];
    assert.throws(() => validation.validateResearchPayload('plan', final), /RESEARCH_SCHEMA_INVALID/, field);
  }
  assert.doesNotThrow(() => validation.validateResearchPayload('plan', structuredClone(finalDcf)));
});

test('A7-DS08 revised draft prompt allows sparse fields without invented economics', async () => {
  const source = await readFile(new URL('../lib/valuation-ai.ts', import.meta.url), 'utf8');
  assert.match(source, /business fields forecastYears, multiple, disclosedData, and forecastAssumptions MAY be omitted/);
  assert.match(source, /do NOT carry forward implicitly/);
  assert.match(source, /forecastYears MAY be omitted/);
  assert.match(source, /Unknown economics are not zero/);
});
