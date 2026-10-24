import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The earnings desk is a dense institutional grid: several compact cards per
// screen, with every number and state string staying on one line.
const css = (await readFile(new URL("../app/globals.css", import.meta.url), "utf8"))
  .replace(/\s+/g, " ");

function rule(selector) {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `missing rule: ${selector}`);
  return css.slice(at + selector.length, css.indexOf("}", at));
}

function block(startMarker) {
  const at = css.indexOf(startMarker);
  assert.notEqual(at, -1, `missing block: ${startMarker}`);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error(`unbalanced block: ${startMarker}`);
}

test("cards tile two per row, three only on ultra-wide screens", () => {
  assert.match(rule(".research-cards"), /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 20px;/);
  assert.match(block("@media (min-width: 1900px)"), /\.research-cards \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(block("@media (max-width: 1099px)"), /\.research-cards \{ grid-template-columns: minmax\(0, 1fr\);/);
});

test("the valuation block is a 3 x 2 grid, not a six-across strip", () => {
  assert.match(rule(".research-valuation-grid"), /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.research-valuation-grid > div:nth-child\(3n\) \{ border-right: 0;/);
  assert.match(css, /\.research-valuation-grid > div:nth-last-child\(-n \+ 3\) \{ border-bottom: 0; \}/);
});

test("numbers and state strings stay on one line", () => {
  const numbers = rule(".research-valuation-grid strong");
  assert.match(numbers, /white-space: nowrap;/);
  assert.match(numbers, /word-break: normal;/);
  assert.match(numbers, /overflow-wrap: normal;/);
  assert.doesNotMatch(numbers, /overflow-wrap: anywhere;/, "per-glyph breaking is what split $504.01");
  // Cells 4 (View) and 6 (Status) hold the state text.
  assert.match(css, /\.research-valuation-grid > div:nth-child\(4\) strong, \.research-valuation-grid > div:nth-child\(6\) strong \{ font-size: 16px; white-space: normal; word-break: keep-all; overflow-wrap: normal; \}/);
});

test("the wide four-column table is gone and replaced by compact rows", () => {
  assert.doesNotMatch(css, /\.research-figures/, "the wide table CSS should be deleted, not orphaned");
  assert.match(rule(".research-estimates-row"), /grid-template-columns: minmax\(74px, 1\.1fr\) repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.research-estimates-row > \* \{ padding: 6px 12px; text-align: right; white-space: nowrap; \}/);
});

test("card padding and section spacing are tightened for density", () => {
  assert.match(rule(".research-card-header"), /padding: 13px 18px;/);
  assert.match(rule(".research-card-body"), /padding: 13px 18px 14px; display: flex; flex-direction: column; gap: 11px;/);
  assert.match(rule(".research-verdict h3"), /font-family: var\(--font-sans\); font-size: 21px;/);
  assert.match(rule(".research-company strong"), /font-size: 24px;/);
});

test("one collapsed footer holds the technical sections", () => {
  assert.match(rule(".research-details > summary"), /padding: 8px 0; font-size: 13px;/);
  assert.match(css, /\.research-valuation-note \{ margin: 0 0 12px; font-size: 12px;/);
});
