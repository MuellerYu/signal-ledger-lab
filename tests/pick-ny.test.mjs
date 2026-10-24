import assert from "node:assert/strict";
import test from "node:test";
import {
  PICK_NY_BENCHMARK_SYMBOL,
  PICK_NY_INITIAL_NAV,
  PICK_NY_REQUESTED_START,
  PICK_NY_TARGETS,
  buildHoldings,
  computeNavSeries,
  pickNyTickers,
  resolveInceptionSession,
  summarizeNavSeries,
} from "../lib/pick-ny.ts";

const SESSIONS = ["2026-01-02", "2026-01-05", "2026-01-06"];

// Two 50% sleeves keep the arithmetic checkable by hand.
const TARGETS = [
  { ticker: "A", weight: 0.5 },
  { ticker: "B", weight: 0.5 },
];

function bars(series) {
  return new Map(Object.entries(series).map(([ticker, closes]) => [ticker, new Map(Object.entries(closes))]));
}

const PRICES = bars({
  A: { "2026-01-02": 10, "2026-01-05": 11, "2026-01-06": 12 },
  B: { "2026-01-02": 20, "2026-01-05": 19, "2026-01-06": 21 },
});
const BENCHMARK = new Map([
  ["2026-01-02", 500],
  ["2026-01-05", 505],
  ["2026-01-06", 500],
]);

test("the published Pick-NY weights are the specified 20/20/20/20/10/10", () => {
  assert.deepEqual(pickNyTickers(), ["SOXL", "ORCL", "MSTR", "TSLA", "AMD", "ASTS"]);
  assert.deepEqual(
    PICK_NY_TARGETS.map((target) => [target.ticker, target.weight]),
    [["SOXL", 0.2], ["ORCL", 0.2], ["MSTR", 0.2], ["TSLA", 0.2], ["AMD", 0.1], ["ASTS", 0.1]],
  );
  assert.equal(PICK_NY_TARGETS.reduce((sum, target) => sum + target.weight, 0), 1);
  assert.equal(PICK_NY_INITIAL_NAV, 100);
  assert.equal(PICK_NY_BENCHMARK_SYMBOL, "SPY");
  assert.equal(PICK_NY_REQUESTED_START, "2026-01-01");
});

test("inception is the first session on or after the requested start where everything traded", () => {
  assert.equal(resolveInceptionSession(PRICES, BENCHMARK, "2026-01-01", ["A", "B"]), "2026-01-02");

  // B did not trade on 2026-01-02, so inception moves to the next session.
  const halted = bars({
    A: { "2026-01-02": 10, "2026-01-05": 11, "2026-01-06": 12 },
    B: { "2026-01-05": 19, "2026-01-06": 21 },
  });
  assert.equal(resolveInceptionSession(halted, BENCHMARK, "2026-01-01", ["A", "B"]), "2026-01-05");

  // A requested start after the history ends has no valid inception.
  assert.equal(resolveInceptionSession(PRICES, BENCHMARK, "2026-06-01", ["A", "B"]), null);
});

test("model shares are allocation divided by the adjusted inception close", () => {
  const holdings = buildHoldings(PRICES, "2026-01-02", 100, TARGETS);
  assert.deepEqual(holdings, [
    { ticker: "A", weight: 0.5, inceptionPrice: 10, modelShares: 5 },
    { ticker: "B", weight: 0.5, inceptionPrice: 20, modelShares: 2.5 },
  ]);
  assert.throws(() => buildHoldings(PRICES, "2026-01-01", 100, TARGETS), /No adjusted close for A/);
});

const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? "value"}: ${actual} != ${expected}`);

test("daily NAV, return, benchmark and excess reconcile to hand arithmetic", () => {
  const holdings = buildHoldings(PRICES, "2026-01-02", 100, TARGETS);
  const points = computeNavSeries(holdings, PRICES, BENCHMARK, "2026-01-02", { initialNav: 100 });
  assert.deepEqual(points.map((point) => point.sessionDate), SESSIONS);

  const [first, second, third] = points;
  close(first.nav, 100, "inception NAV");
  assert.equal(first.dailyReturn, null, "the inception session has no prior NAV");
  close(first.cumulativeReturn, 0, "inception return");
  close(first.benchmarkNav, 100, "inception benchmark NAV");

  close(second.nav, 102.5, "session 2 NAV");
  close(second.dailyReturn, 0.025, "session 2 daily return");
  close(second.cumulativeReturn, 0.025, "session 2 cumulative return");
  close(second.benchmarkNav, 101, "session 2 benchmark NAV");
  close(second.benchmarkCumulativeReturn, 0.01, "session 2 benchmark return");
  close(second.excessCumulativeReturn, 0.015, "session 2 excess");

  close(third.nav, 112.5, "session 3 NAV");
  close(third.cumulativeReturn, 0.125, "session 3 cumulative return");
  close(third.benchmarkNav, 100, "session 3 benchmark NAV");
  close(third.excessCumulativeReturn, 0.125, "session 3 excess");
});

test("contribution points sum to the cumulative return", () => {
  const holdings = buildHoldings(PRICES, "2026-01-02", 100, TARGETS);
  const points = computeNavSeries(holdings, PRICES, BENCHMARK, "2026-01-02", { initialNav: 100 });
  for (const point of points) {
    const total = point.positions.reduce((sum, position) => sum + position.contributionPoints, 0);
    assert.ok(
      Math.abs(total - point.cumulativeReturn * 100) < 1e-9,
      `session ${point.sessionDate}: contributions ${total} vs return ${point.cumulativeReturn * 100}`,
    );
  }
  const latest = points.at(-1);
  assert.deepEqual(
    latest.positions.map((position) => [position.ticker, position.contributionPoints]),
    [["A", 10], ["B", 2.5]],
  );
});

test("shares are never rebalanced and weights drift with price", () => {
  const holdings = buildHoldings(PRICES, "2026-01-02", 100, TARGETS);
  const points = computeNavSeries(holdings, PRICES, BENCHMARK, "2026-01-02", { initialNav: 100 });
  assert.deepEqual(holdings.map((holding) => holding.modelShares), [5, 2.5]);

  const latest = points.at(-1);
  assert.equal(latest.positions[0].weight, 60 / 112.5);
  assert.equal(latest.positions[1].weight, 52.5 / 112.5);
  assert.equal(latest.positions.reduce((sum, position) => sum + position.weight, 0), 1);
});

test("a missing bar is carried forward instead of dropping the position", () => {
  const missing = bars({
    A: { "2026-01-02": 10, "2026-01-05": 11, "2026-01-06": 12 },
    B: { "2026-01-02": 20, "2026-01-05": 19 },
  });
  const holdings = buildHoldings(missing, "2026-01-02", 100, TARGETS);
  const points = computeNavSeries(holdings, missing, BENCHMARK, "2026-01-02", { initialNav: 100 });
  assert.equal(points.at(-1).nav, 60 + 2.5 * 19);
  assert.equal(points.at(-1).positions[1].adjustedClose, 19);
});

test("the summary ranks contributions by size and reports the latest session", () => {
  const holdings = buildHoldings(PRICES, "2026-01-02", 100, TARGETS);
  const summary = summarizeNavSeries(computeNavSeries(holdings, PRICES, BENCHMARK, "2026-01-02", { initialNav: 100 }));
  assert.equal(summary.inceptionDate, "2026-01-02");
  assert.equal(summary.asOfDate, "2026-01-06");
  assert.equal(summary.sessions, 3);
  assert.equal(summary.nav, 112.5);
  assert.equal(summary.excessCumulativeReturn, 0.125);
  assert.deepEqual(summary.contributions.map((position) => position.ticker), ["A", "B"]);
  assert.equal(summarizeNavSeries([]), null);
});
