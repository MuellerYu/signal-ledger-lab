import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test, { after } from "node:test";
import ts from "typescript";

// Renders the real EarningsForecastPanel so a missing pre-earnings valuation
// block fails here instead of only showing up in production.
const root = new URL("..", import.meta.url);
const tmpDirectory = new URL(".test-tmp/", root);

const NOOP_COMPONENTS = [
  ['import EquityForward from "./equity-forward";', "EquityForward"],
  ['import EquityResearchHome from "./equity-research-home";', "EquityResearchHome"],
  ['import ValuationDesk from "./valuation-desk";', "ValuationDesk"],
  ['import PicksPanel from "./picks-panel";', "PicksPanel"],
  // dashboard-client renders the shared nav instead of its old brand strip.
  ['import SiteNav from "./site-nav";', "SiteNav"],
];

// next/dynamic and the shared forecast-form module are not components, so they
// get purpose-built stand-ins rather than the no-op component rewrite.
const NON_COMPONENT_STUBS = [
  ['import dynamic from "next/dynamic";', "const dynamic = () => () => null;"],
  ['import Link from "next/link";', 'const Link = "a";'],
  ['import { INITIAL_FORECAST, clamp, type ForecastForm } from "./forecast-form";',
   "const INITIAL_FORECAST = { ticker: \"\" };\n  const clamp = (v, min = 0, max = 100) => Math.min(max, Math.max(min, v));"],
];

async function loadPanel() {
  const source = await readFile(new URL("app/dashboard-client.tsx", root), "utf8");
  const presentationUrl = new URL("lib/earnings-presentation.ts", root).href;

  let patched = source.replace(
    /from "\.\.\/lib\/earnings-presentation"/,
    `from ${JSON.stringify(presentationUrl)}`,
  );
  for (const [statement, replacement] of NON_COMPONENT_STUBS) {
    assert.ok(patched.includes(statement), `stub target moved: ${statement}`);
    patched = patched.replace(statement, replacement);
  }
  for (const [statement, name] of NOOP_COMPONENTS) {
    assert.ok(patched.includes(statement), `${name} import moved; update this test`);
    patched = patched.replace(statement, `const ${name} = () => null;`);
  }

  const compiled = ts.transpileModule(patched, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  await mkdir(tmpDirectory, { recursive: true });
  const moduleUrl = new URL("dashboard-client.mjs", tmpDirectory);
  await writeFile(moduleUrl, compiled);
  return import(moduleUrl.href);
}

const forecast = (ticker) => ({
  ticker,
  fiscalPeriod: "2026-Q3",
  earningsEvent: { date: "2099-01-15", status: "scheduled" },
  revenueEstimate: 1000,
  epsEstimate: 1.5,
});

const snapshot = (ticker, fairValue) => ({
  ticker,
  quote: { price: 100, asOf: null, source: "test" },
  fairValue,
  upsidePct: 12.5,
  rating: "WATCH",
  confidence: 0.62,
  valuationStatus: "provisional",
  valuationFamilyLabel: "Digital Platform / Advertising + AI",
});

const { EarningsForecastPanel } = await loadPanel();
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

function render(tickers, snapshots) {
  return renderToStaticMarkup(
    createElement(EarningsForecastPanel, {
      earningsForecasts: tickers.map(forecast),
      earningsPriceForecasts: [],
      latestQuotes: [],
      valuationContext: snapshots,
    }),
  );
}

const hasBlock = (html, ticker) => html.includes(`aria-label="${ticker} pre-earnings valuation context"`);

after(() => rm(tmpDirectory, { recursive: true, force: true }));

test("a card renders the valuation block only once its snapshot is bound", () => {
  const shelfOnly = render(["AMD", "META"], [snapshot("AMD", 451.49)]);
  assert.ok(hasBlock(shelfOnly, "AMD"), "AMD snapshot was supplied and must render");
  assert.equal(hasBlock(shelfOnly, "META"), false, "META has no snapshot yet");

  // This is the state the two-request merge produces in the browser.
  const merged = render(["AMD", "META"], [snapshot("AMD", 451.49), snapshot("META", 644.95)]);
  assert.ok(hasBlock(merged, "META"), "a bound META snapshot must render the block");
  assert.match(merged, /644\.95/);
});

test("every earnings ticker outside the coverage shelf renders its block once merged", () => {
  const gap = ["AMZN", "AVGO", "COIN", "META", "MSFT", "SMCI"];
  const shelf = [snapshot("AMD", 451.49)];
  const merged = render(["AMD", ...gap], [...shelf, ...gap.map((ticker, index) => snapshot(ticker, 100 + index))]);

  assert.equal(merged.match(/pre-earnings valuation context/g)?.length, 1 + gap.length);
  for (const ticker of gap) {
    assert.ok(hasBlock(merged, ticker), `${ticker} must render its pre-earnings valuation block`);
  }
});

test("a withheld snapshot is flagged instead of showing a fabricated value", () => {
  const withheld = { ...snapshot("TSM", null), rating: "MODEL_CHECK_REQUIRED", valuationStatus: "unavailable" };
  const html = render(["TSM"], [withheld]);
  assert.ok(hasBlock(html, "TSM"));
  assert.match(html, /Withheld/);
  assert.match(html, /VALUATION WITHHELD/);
  // The internal lifecycle word must never reach the public card.
  assert.doesNotMatch(html, /UNAVAILABLE|PROVISIONAL|SCREENING/);

  const review = render(["TSM"], [{ ...withheld, fairValue: 100, releaseGate: "model_check_required" }]);
  assert.match(review, /MODEL REVIEW/);
});

test("the valuation gap renders the true percentage, not a fraction of it", () => {
  const html = render(["COIN", "SMCI"], [
    { ...snapshot("COIN", 63.02), upsidePct: -63.06 },
    { ...snapshot("SMCI", 168.95), upsidePct: 373.9 },
  ]);
  assert.match(html, /Gap<\/span><strong[^>]*>-63\.1%<\/strong>/, "COIN gap was divided by 100");
  assert.match(html, /Gap<\/span><strong[^>]*>\+373\.9%<\/strong>/, "SMCI gap was divided by 100");
});

test("a ticker with no snapshot renders no block", () => {
  const html = render(["AMD"], []);
  assert.equal(hasBlock(html, "AMD"), false);
  assert.doesNotMatch(html, /research-valuation-context/);
});

test("the default card is compact and keeps the wide table out of view", () => {
  const html = render(["META"], [snapshot("META", 644.95)]);

  // Estimates are compact rows, never the old four-column table.
  assert.match(html, /class="research-estimates"/);
  assert.doesNotMatch(html, /<table/);

  // Everything technical lives inside the single collapsed footer.
  const details = html.indexOf('<details class="research-details"><summary>Details</summary>');
  assert.notEqual(details, -1, "the card needs one Details footer");
  for (const section of ["Sources &amp; forecast record", "Open the model", "Fair value is produced by the shared deterministic engine"]) {
    assert.ok(html.indexOf(section) > details, `${section} must sit inside Details`);
  }
  assert.match(html, /Open valuation →/);
});

// The regression this guards: depending on `valuationSnapshots` meant the slower
// shelf request re-ran the effect, its cleanup discarded the in-flight earnings
// snapshots, and the already-marked tickers were never fetched again.
test("the earnings valuation fetch cannot be discarded mid-flight", async () => {
  const source = await readFile(new URL("app/dashboard-client.tsx", root), "utf8");
  const start = source.indexOf("const earningsTickerKey");
  assert.notEqual(start, -1, "the earnings valuation effect moved; update this test");
  const body = source
    .slice(start, source.indexOf("const handleRefresh", start))
    .replace(/^\s*\/\/.*$/gm, "");

  assert.match(body, /\}, \[earningsTickerKey, valuationLoading\]\)/, "must be keyed on a primitive plus the shelf gate");
  assert.doesNotMatch(body, /\[earningsTickers, valuationSnapshots/);
  assert.doesNotMatch(body, /cancelled/, "an in-flight merge must survive the shelf landing first");
  assert.match(body, /setValuationSnapshots\(\(current\) => mergeSnapshotsByTicker\(current, extra\)\)/, "must merge functionally");
});
