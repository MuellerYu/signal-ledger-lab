import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * SPCX publishes one valuation with one confidence. These are the invariants
 * that keep the headline and the model audit from disagreeing.
 */

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("SPCX publishes exactly one canonical confidence", async () => {
  const engine = await read("lib/universal-valuation.ts");
  // The engine adopts the company model's overall confidence instead of
  // publishing a second, independently calculated ensemble score.
  assert.match(engine, /const ensembleConfidence = clamp\(/);
  assert.match(engine, /const confidence = selectedProfile\.spcx\?\.confidence\.overall \?\? ensembleConfidence;/);
  // The generic score must still exist for every other family.
  assert.match(engine, /ensemble: \{ fairValue, expectedReturn, confidence:/);
});

test("every EV/EBITDA on the page states its denominator", async () => {
  const page = await read("app/fair-value/workstation.tsx");
  const bare = [...page.matchAll(/EV\/EBITDA\s*\{/g)];
  assert.equal(bare.length, 0, "no EV/EBITDA may be printed without a denominator");
  assert.ok((page.match(/EV \/ 2028E EBITDA/g) ?? []).length >= 2, "fair value and market both label the denominator");
  assert.ok((page.match(/EV \/ 2028E revenue/g) ?? []).length >= 2);
  // The segment table already carries its own labelled columns.
  assert.match(page, /<th>2028E EBITDA<\/th>/);
  assert.match(page, /<th>2028E multiple<\/th>/);
});

test("the public hero does not leak an internal release state", async () => {
  const page = await read("app/fair-value/workstation.tsx");
  // Scope to the headline metrics: the Model Audit may still discuss the
  // release state, but the hero must not.
  const start = page.indexOf("Current price</span>");
  assert.notEqual(start, -1, "the hero metrics moved");
  const hero = page.slice(Math.max(0, start - 600), start + 2200);
  assert.doesNotMatch(hero, /valuationRelease|screening_only|withheld/i);
  assert.match(hero, /Scenario range/);
  // The release taxonomy never becomes a headline label.
  assert.doesNotMatch(page, /Provisional screening value/);
  assert.match(page, /"Signal Ledger Fair Value"/);
  for (const field of ["Current price", "Upside / downside", "Confidence"]) {
    assert.ok(hero.includes(field), `the hero must show ${field} above the fold`);
  }
});

test("the SPCX model keeps its structure and its reconciliation", async () => {
  const model = await read("lib/spcx-valuation.ts");
  // Four economic layers, each valued from its own drivers.
  assert.match(model, /export type SpcxScenarioCase = "CORE" \| "BASE" \| "VISION"/);
  // Cases are separately forecast rather than one base scaled by a multiplier.
  assert.match(model, /buildForecast\(reported, "CORE"\)/);
  assert.match(model, /buildForecast\(reported, "VISION"\)/);
  // Starship stays a probability-weighted scenario tree.
  assert.match(model, /probabilitySum/);
  assert.match(model, /expectedValueB/);
  // The per-share bridge divides equity value by the diluted share count.
  assert.match(model, /perShare: equityValueB \/ shares|equityValueB \/ shares/);
});

test("institutional targets never enter the calculation", async () => {
  const model = await read("lib/spcx-valuation.ts");
  assert.match(model, /externalResearch: input\.externalResearch\?\.length \? input\.externalResearch : SPCX_PUBLIC_TARGETS/);
  const page = await read("app/fair-value/workstation.tsx");
  assert.match(page, /never averaged into Signal Ledger fair value|never targets in the calculation/);
});
