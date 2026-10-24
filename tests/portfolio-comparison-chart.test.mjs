import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * One comparison chart: one date domain, one Y axis, one crosshair, and both
 * series rebased to 100 at the first visible session.
 */

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const toModule = (source) => "data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  fileName: "chart.tsx",
}).outputText.replace(/from ["'](react(?:\/jsx-runtime)?)["']/g,
  (_, name) => `from "${pathToFileURL(require.resolve(name)).href}"`)).toString("base64");

const formatUrl = toModule(await readFile(new URL("lib/portfolio-format.ts", root), "utf8"));
const chartPath = new URL("app/picks/portfolio-comparison-chart.tsx", root);
const chartSource = (await readFile(chartPath, "utf8")).replace('from "@/lib/portfolio-format"', `from "${formatUrl}"`);
const chart = await import(toModule(chartSource));

const DATES = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"];
const series = (id, label, values) => ({ id, label, points: DATES.map((date, index) => ({ date, value: values[index] })) });
const PORTFOLIO = series("ny", "Pick-NY", [100, 104, 108, 112, 118, 120.2]);
const BENCHMARK = series("spy", "S&P 500 / SPY", [100, 102, 105, 107, 109, 111.4]);

test("both series resolve on one shared date domain", () => {
  const domain = chart.alignDomain([PORTFOLIO, BENCHMARK]);
  assert.deepEqual(domain, DATES);
  // Every date is present for every series, so the crosshair can never show one
  // line without the other.
  for (const entry of [PORTFOLIO, BENCHMARK]) {
    const byDate = new Map(entry.points.map((point) => [point.date, point.value]));
    for (const date of domain) assert.equal(typeof byDate.get(date), "number", `${entry.id} missing ${date}`);
  }
});

test("the first visible point of every series rebases to 100", () => {
  const rebased = [PORTFOLIO, BENCHMARK].map((entry) => chart.rebaseWindow(entry.points.map((point) => point.value), "normalized"));
  assert.equal(rebased[0][0], 100);
  assert.equal(rebased[1][0], 100);
  assert.ok(Math.abs(rebased[0].at(-1) - 120.2) < 1e-9);
  assert.ok(Math.abs(rebased[1].at(-1) - 111.4) < 1e-9);
  // Rebased to a later window start, the same series restarts at 100.
  const windowed = chart.rebaseWindow(PORTFOLIO.points.slice(3).map((point) => point.value), "normalized");
  assert.equal(windowed[0], 100);
  assert.ok(Math.abs(windowed.at(-1) - (120.2 / 112) * 100) < 1e-9);
  // Raw mode leaves stored NAV untouched.
  assert.deepEqual(chart.rebaseWindow([112, 118, 120.2], "raw"), [112, 118, 120.2]);
});

test("range buttons and the navigator change the visible domain", () => {
  const domain = chart.alignDomain([PORTFOLIO, BENCHMARK]);
  const full = chart.rangeViewport(domain, "SI");
  assert.deepEqual(full, { from: 0, to: DATES.length - 1 });

  for (const range of ["1M", "3M", "6M", "YTD"]) {
    const viewport = chart.rangeViewport(domain, range);
    assert.ok(viewport.from >= 0 && viewport.to <= DATES.length - 1, `${range} stays inside the domain`);
    assert.ok(viewport.from <= viewport.to, `${range} is ordered`);
  }
  const oneMonth = chart.rangeViewport(domain, "1M");
  assert.ok(oneMonth.from >= full.from);

  const custom = chart.rangeViewport(domain, "CUSTOM", { from: "2026-01-06", to: "2026-01-08" });
  assert.deepEqual(custom, { from: 2, to: 4 });
  // A dropped handle would otherwise zoom past the whole series.
  const wide = chart.rangeViewport(domain, "CUSTOM", { from: "2025-01-01", to: "2027-01-01" });
  assert.deepEqual(wide, { from: 0, to: DATES.length - 1 });
});

test("the component renders one chart carrying both series", () => {
  const html = renderToStaticMarkup(React.createElement(chart.default, { series: [PORTFOLIO, BENCHMARK] }));
  assert.equal((html.match(/class="cmp-line /g) ?? []).length, 2, "exactly two lines in one plot");
  assert.equal((html.match(/<svg/g) ?? []).length, 2, "one plot plus one navigator, never two charts");
  assert.match(html, /Pick-NY/);
  assert.match(html, /S&amp;P 500 \/ SPY/);
  assert.match(html, /120\.2/, "legend carries the latest value");
  assert.match(html, /111\.4/);
  assert.match(html, /aria-label="Comparison of Pick-NY and S&amp;P 500 \/ SPY/);
  // One crosshair, one Y axis.
  assert.doesNotMatch(html, /second chart/i);
});

test("the outperforming series is drawn above the other on a shared scale", () => {
  const html = renderToStaticMarkup(React.createElement(chart.default, { series: [PORTFOLIO, BENCHMARK] }));
  const paths = [...html.matchAll(/class="cmp-line cmp-line-(\d)" d="([^"]+)"/g)];
  assert.equal(paths.length, 2, "one path per series");
  const lastY = (d) => Number(d.trim().split(/[ML]\s*/).filter(Boolean).at(-1).split(/\s+/)[1]);
  const [portfolioY, benchmarkY] = [lastY(paths[0][2]), lastY(paths[1][2])];
  // SVG y grows downward, so a smaller y is the higher line.
  assert.ok(portfolioY < benchmarkY, "Pick-NY at 120.2 must sit above SPY at 111.4 on the same axis");
  // Both paths begin at the shared 100 origin.
  const firstY = (d) => Number(d.trim().split(/[ML]\s*/).filter(Boolean)[0].split(/\s+/)[1]);
  assert.ok(Math.abs(firstY(paths[0][2]) - firstY(paths[1][2])) < 1e-9, "both lines start at the same indexed value");
});

test("the tooltip reports every series for the same date", () => {
  const html = renderToStaticMarkup(React.createElement(chart.default, { series: [PORTFOLIO, BENCHMARK] }));
  // The excess row carries an extra class, so match the prefix.
  const rows = html.match(/class="cmp-tooltip-row/g) ?? [];
  assert.ok(rows.length >= 3, "one row per series plus the excess row");
  assert.match(html, /Excess/);
  // Both series are measured against the same window start.
  assert.match(html, /NAV/);
});

test("no second chart implementation is left behind", async () => {
  const shared = await readFile(new URL("app/picks/charts.tsx", root), "utf8");
  assert.doesNotMatch(shared, /GrowthChart/, "the superseded growth chart must be deleted, not orphaned");

  const view = await readFile(new URL("app/picks/[slug]/portfolio-view.tsx", root), "utf8");
  assert.equal((view.match(/PortfolioComparisonChart/g) ?? []).length, 2, "imported and rendered once");
  assert.doesNotMatch(view, /GrowthChart/);

  // Only one module may draw the comparison lines.
  const files = ["app/picks/portfolio-comparison-chart.tsx", "app/picks/charts.tsx", "app/picks/page.tsx", "app/track-record/page.tsx"];
  let renderers = 0;
  for (const file of files) {
    if ((await readFile(new URL(file, root), "utf8")).includes("cmp-line")) renderers++;
  }
  assert.equal(renderers, 1, "exactly one component renders the comparison chart");
});

test("the homepage still never loads the daily history or the chart", async () => {
  const panel = await readFile(new URL("app/picks-panel.tsx", root), "utf8");
  assert.doesNotMatch(panel, /portfolio-comparison-chart|PortfolioComparisonChart/);
  assert.doesNotMatch(panel, /\/history/);
  assert.match(panel, /Sparkline/);
});
