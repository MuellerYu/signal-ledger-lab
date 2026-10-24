import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const toModule = source => "data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  fileName: "component.tsx",
}).outputText.replace(/from ["'](react(?:\/jsx-runtime)?)["']/g,
  (_, name) => `from "${pathToFileURL(require.resolve(name)).href}"`)).toString("base64");
const helperUrl = toModule(await readFile(new URL("lib/earnings-presentation.ts", root), "utf8"));
const forwardUrl = toModule((await readFile(new URL("app/equity-forward.tsx", root), "utf8")).replace('import "./equity-forward.css";', ""));
const profileUrl = toModule((await readFile(new URL("app/project-profile.tsx", root), "utf8")).replace('import "./project-profile.css";', ""));
const equityHomeUrl = toModule("export default function EquityResearchHome(){ return null; }");
const valuationDeskUrl = toModule("export default function ValuationDesk(){ return null; }");
const picksPanelUrl = toModule("export default function PicksPanel(){ return null; }");
const forecastFormUrl = toModule("export const INITIAL_FORECAST = { ticker: '' }; export const clamp = (v, min = 0, max = 100) => Math.min(max, Math.max(min, v));");
const dynamicUrl = toModule("export default function dynamic(){ return () => null; }");
const linkUrl = toModule("export default \"a\";");
const accountControlUrl = toModule("export default function AccountControl(){ return null; }");
// dashboard-client renders the shared site nav in place of its old brand strip,
// so the harness stubs it rather than pulling in the whole navigation tree.
const siteNavUrl = toModule("export default function SiteNav(){ return null; }");
const { finiteNumber, researchNotes, settledPriceOutcome, earningsPhase, safeSourceUrl } = await import(helperUrl);
const source = await readFile(new URL("app/dashboard-client.tsx", root), "utf8");
const { EarningsForecastPanel, worldNewsEnglishBrief } = await import(toModule(
  source.replace('"../lib/earnings-presentation"', JSON.stringify(helperUrl)).replace('"./equity-forward"', JSON.stringify(forwardUrl)).replace('"./project-profile"', JSON.stringify(profileUrl)).replace('"./equity-research-home"', JSON.stringify(equityHomeUrl)).replace('"./valuation-desk"', JSON.stringify(valuationDeskUrl)).replace('"./picks-panel"', JSON.stringify(picksPanelUrl)).replace('"./forecast-form"', JSON.stringify(forecastFormUrl)).replace('"./account-control"', JSON.stringify(accountControlUrl)).replace('"./site-nav"', JSON.stringify(siteNavUrl)).replace('"next/dynamic"', JSON.stringify(dynamicUrl)).replace('"next/link"', JSON.stringify(linkUrl)) + "\nexport { EarningsForecastPanel, worldNewsEnglishBrief };"
));

test("research notes remove filler and duplicates without inventing replacements", () => {
  assert.deepEqual(researchNotes(["Company-reported operating highlight under review.", "中文说明", "EPS fell to a loss of $2.00.", "EPS fell to a loss of $2.00."]), ["EPS fell to a loss of $2.00."]);
  assert.equal(finiteNumber(0), 0);
  assert.equal(finiteNumber(""), null);
  assert.equal(finiteNumber(false), null);
  assert.equal(safeSourceUrl("javascript:alert(1)"), null);
});

test("missing results are not described as upcoming or invented as reported", () => {
  assert.equal(earningsPhase(false, false, true), "missing-results");
  assert.equal(earningsPhase(false, true, false), "missing-results");
  assert.equal(earningsPhase(true, false, true), "reported");
});

test("price review uses a frozen baseline and a recorded settlement only", () => {
  const outcome = settledPriceOutcome(100, 110, 90);
  assert.equal(outcome.directionHit, false);
  assert.ok(Math.abs(outcome.errorPct - 22.222222) < 0.000001);
  assert.equal(settledPriceOutcome(100, 110, null).directionHit, null);
  assert.equal(settledPriceOutcome(0, 110, 90).actualMove, null);
  assert.equal(settledPriceOutcome(100, 100.4, 99.7).directionHit, true);
  assert.equal(settledPriceOutcome(100, 100.6, 99.7).directionHit, false);
});

const financial = {
  id: "fixture", ticker: "MSTR", fiscalPeriod: "2026-Q2", revenueEstimate: 126900000, epsEstimate: 23.43,
  earningsEvent: { date: "2026-07-30", status: "reported", actual: {
    revenue: 122400000, eps: -24.45, sourceUrl: "https://example.com/results",
    highlights: ["Company-reported operating highlight under review.", "尚待核验"],
  } },
  marketReaction: { keyDrivers: ["This evidence is included in the model, but its English source note is still being verified."] },
};
const render = (price = {}, forecast = financial) => renderToStaticMarkup(React.createElement(EarningsForecastPanel, {
  earningsForecasts: [forecast], earningsPriceForecasts: [{ ticker: "MSTR", fiscalPeriod: "2026-Q2", referencePrice: 100, predictedPostPrice: 110, ...price }],
  latestQuotes: [{ ticker: "MSTR", price: 999, asOfAt: "2026-09-04T16:00:00Z" }],
}));

test("Oracle's confirmed FY2027 Q1 announcement reaches the earnings card", async () => {
  const worker = await readFile(new URL("monitor-worker/src/index.ts", root), "utf8");
  const profileText = worker.match(/"ORCL:2027-Q1": (\{[\s\S]*?\n  \}),/)[1];
  const profile = (await import(toModule("export default " + profileText))).default;
  assert.equal(profile.date, "2026-09-10");
  assert.equal(profile.status, "confirmed");
  assert.match(profile.sourceUrl, /First-Quarter-Fiscal-Year-2027-Earnings-Announcement/);
  const html = renderToStaticMarkup(React.createElement(EarningsForecastPanel, {
    earningsForecasts: [{ id: "oracle", ticker: "ORCL", fiscalPeriod: "2027-Q1", earningsEvent: profile }],
    earningsPriceForecasts: [], latestQuotes: [],
  }));
  assert.match(html, /Sep(?:tember)? 10, 2026/);
  assert.match(html, /After market close; conference call 17:00 ET/);
  assert.doesNotMatch(html, /Date not confirmed/);
});

test("rendered reported card is compact and does not grade against the latest quote", () => {
  const html = render();
  assert.match(html, /The reported numbers/);
  assert.match(html, /Revenue model error/);
  assert.match(html, /3.7%/);
  assert.match(html, /A reported loss versus a projected profit/);
  assert.match(html, /class="research-estimates"/);
  assert.doesNotMatch(html, /<table class="research-figures"/);
  assert.match(html, /Target-session close/);
  assert.doesNotMatch(html, /Direction matched|Direction missed|awaiting the earnings result|under review|English source note|Distance to target/);
  assert.equal((html.match(/Read the original release/g) ?? []).length, 1);
});

test("rendered settled card reports the miss even if the latest quote is much higher", () => {
  const html = render({ actualPostPrice: 90, actualPriceAt: "2026-07-31T20:00:00Z" });
  assert.match(html, /Direction missed/);
  assert.match(html, /22.2%/);
});

test("no price forecast means no empty target panel or made-up target", () => {
  const html = renderToStaticMarkup(React.createElement(EarningsForecastPanel, { earningsForecasts: [financial], earningsPriceForecasts: [], latestQuotes: [] }));
  assert.match(html, /Excluded from the price backtest/);
  assert.doesNotMatch(html, /research-price-comparison|Awaiting evidence/);
});

test("news missing English analysis does not receive generic market commentary", () => {
  const brief = worldNewsEnglishBrief({ headline: "Company announces a new chip", region: "US", commentaryZh: "中文" });
  assert.equal(brief.commentary, "");
  assert.equal(brief.impactPath, "");
  assert.equal(brief.factSummary, "");
});
