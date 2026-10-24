import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Regression tests for five production correctness bugs, each pinned to the
 * evidence that exposed it:
 *
 *   P0-1  a crypto pair batched into the equity endpoint fails the whole request
 *   P0-2  Alpaca stamps an hourly bar at its START, so the close was read an
 *         hour late (SPY 2026-09-18 adjusted daily close = 761.62)
 *   P0-3  a story tagged to any holding could be offered as the cause of an
 *         unrelated move
 *   P0-4  timing was measured against the wall clock rather than the move
 *   P0-5  a snapshot was compared against itself and printed a flat +0.00%
 */

const dataUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const transpile = async (path, replacements = []) => {
  let code = await readFile(new URL(path, import.meta.url), "utf8");
  for (const [from, to] of replacements) code = code.replaceAll(from, to);
  return dataUrl(ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
};

const pickNyUrl = await transpile("../lib/pick-ny.ts");
const formatUrl = await transpile("../lib/format.ts");
const briefUrl = await transpile("../lib/daily-brief.ts", [
  ['from "./pick-ny"', `from "${pickNyUrl}"`],
  ['from "./format"', `from "${formatUrl}"`],
]);

// A stand-in for the Worker bindings so the bars module can run under node.
const bindingsUrl = dataUrl(`
export const getBindings = () => ({
  ALPACA_API_KEY_ID: "test-key",
  ALPACA_API_SECRET_KEY: "test-secret",
  ALPACA_DATA_FEED: "iex",
});
`);
const barsUrl = await transpile("../lib/alpaca-bars.ts", [
  ['from "./runtime"', `from "${bindingsUrl}"`],
  ['from "./pick-ny"', `from "${pickNyUrl}"`],
]);

const {
  CHECKPOINT_UTC_HOUR,
  attributeCatalyst,
  closeAtHour,
  moveWindowIso,
  scoreCausality,
  sessionMetrics,
  timingGapMinutes,
  valuationMovements,
} = await import(briefUrl);
const { fetchDailyAdjustedBars, isCryptoSymbol, resetBarCache } = await import(barsUrl);

/* ================================================================ P0-2 */

/**
 * The real 2026-09-18 SPY hourly bars. Volume is what tells the session apart:
 * the 12:00Z and 20:00Z bars trade a few hundred shares, the session trades
 * hundreds of thousands.
 */
const SPY_2026_09_18 = new Map([
  ["2026-09-18T12:00:00Z", 760.72], // 303 shares — premarket
  ["2026-09-18T13:00:00Z", 759.72], // 177,306
  ["2026-09-18T14:00:00Z", 759.93], // 207,323
  ["2026-09-18T15:00:00Z", 758.96], // 104,622
  ["2026-09-18T16:00:00Z", 759.37], // 106,170
  ["2026-09-18T17:00:00Z", 759.84], // 91,929  — 14:00 ET
  ["2026-09-18T18:00:00Z", 761.23], // 147,088 — 15:00 ET
  ["2026-09-18T19:00:00Z", 761.62], // 458,662 — 16:00 ET close
  ["2026-09-18T20:00:00Z", 762.63], // 300 shares — after hours
]);
const SPY_ADJUSTED_DAILY_CLOSE = 761.62;

test("P0-2 the close is the 19:00Z bar, reconciling with the adjusted daily close", () => {
  assert.equal(
    closeAtHour(SPY_2026_09_18, CHECKPOINT_UTC_HOUR.close),
    SPY_ADJUSTED_DAILY_CLOSE,
    "the 16:00 ET close is the 15:00-16:00 bar, which is what the daily series prints",
  );
  assert.equal(closeAtHour(SPY_2026_09_18, CHECKPOINT_UTC_HOUR.close), 761.62);
});

test("P0-2 the 14:00 and 15:00 ET checkpoints read the hour that ended at them", () => {
  assert.equal(closeAtHour(SPY_2026_09_18, CHECKPOINT_UTC_HOUR.lateAfternoon), 759.84, "14:00 ET");
  assert.equal(closeAtHour(SPY_2026_09_18, CHECKPOINT_UTC_HOUR.powerHour), 761.23, "15:00 ET");
});

test("P0-2 the 17:00 ET after-hours bar is never read as the close", () => {
  const withoutAfterHours = new Map([...SPY_2026_09_18].filter(([stamp]) => !stamp.startsWith("2026-09-18T20")));
  assert.equal(
    closeAtHour(SPY_2026_09_18, CHECKPOINT_UTC_HOUR.close),
    closeAtHour(withoutAfterHours, CHECKPOINT_UTC_HOUR.close),
    "adding the 20:00Z bar must not move the close",
  );
  assert.notEqual(closeAtHour(SPY_2026_09_18, CHECKPOINT_UTC_HOUR.close), SPY_2026_09_18.get("2026-09-18T20:00:00Z"));
});

test("P0-2 14:00→close and 15:00→close are measured from the right bars", () => {
  const metrics = sessionMetrics(
    { symbol: "SPY", label: "S&P 500", group: "index" },
    SPY_2026_09_18,
    { close: null, priorClose: 760.75 },
    { spy: null, qqq: null },
  );
  assert.equal(metrics.close, SPY_ADJUSTED_DAILY_CLOSE);
  assert.ok(Math.abs(metrics.lateMovePct - ((761.62 / 759.84 - 1) * 100)) < 1e-9, `late ${metrics.lateMovePct}`);
  assert.ok(Math.abs(metrics.finalHourMovePct - ((761.62 / 761.23 - 1) * 100)) < 1e-9, `final hour ${metrics.finalHourMovePct}`);
  // Read the old way the "close" would have been the 17:00 ET print.
  assert.ok(Math.abs(metrics.returnPct - ((761.62 / 760.75 - 1) * 100)) < 1e-9, "the return uses the real close");
});

/* ================================================================ P0-1 */

test("P0-1 crypto pairs are told apart from equity class shares", () => {
  assert.equal(isCryptoSymbol("BTC-USD"), true);
  assert.equal(isCryptoSymbol("BTC/USD"), true);
  assert.equal(isCryptoSymbol("ETH-USD"), true);
  assert.equal(isCryptoSymbol("SPY"), false);
  // The trap: a bare dash is not a crypto pair.
  assert.equal(isCryptoSymbol("BRK-B"), false, "Berkshire B is an equity");
  assert.equal(isCryptoSymbol("BF-B"), false);
  assert.equal(isCryptoSymbol("RDS-A"), false);
  assert.equal(isCryptoSymbol("XYZ-USD"), false, "an unknown base is not a pair");
});

/** A minimal Alpaca stand-in: the equity endpoint rejects a poison symbol. */
function stubAlpaca({ poison }) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    calls.push(target);
    const symbols = String(target.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
    const isCryptoPath = target.pathname.includes("/crypto/");

    if (!isCryptoPath && symbols.includes(poison)) {
      return new Response(JSON.stringify({ message: `invalid symbol: ${poison}` }), { status: 400 });
    }
    const bars = {};
    for (const symbol of symbols) {
      const key = isCryptoPath ? symbol.replace("/", "-") : symbol;
      bars[key] = [{ t: "2026-09-17T04:00:00Z", c: 100 }, { t: "2026-09-18T04:00:00Z", c: 101 }];
    }
    return new Response(JSON.stringify({ bars }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

test("P0-1 one rejected symbol cannot fail the equity batch", async () => {
  resetBarCache();
  const { calls, restore } = stubAlpaca({ poison: "BREAKS" });
  try {
    const universe = ["SPY", "QQQ", "BREAKS", "BTC-USD"];
    const bars = await fetchDailyAdjustedBars(universe, { start: "2026-09-17" });

    assert.equal(bars.get("SPY")?.get("2026-09-18"), 101, "the good equities still load");
    assert.equal(bars.get("QQQ")?.get("2026-09-18"), 101);
    assert.equal(bars.get("BREAKS")?.size, 0, "the rejected symbol is empty, not a flat return");
    assert.equal(bars.get("BTC-USD")?.get("2026-09-18"), 101, "the crypto pair loads from its own source");

    const equityCalls = calls.filter((call) => !call.pathname.includes("/crypto/"));
    const cryptoCalls = calls.filter((call) => call.pathname.includes("/crypto/"));
    assert.ok(equityCalls.length > 0 && cryptoCalls.length > 0, "the two asset classes use different endpoints");
    for (const call of equityCalls) {
      assert.ok(!String(call.searchParams.get("symbols")).includes("/"), "crypto pairs never reach the equity endpoint");
    }
    for (const call of cryptoCalls) {
      assert.equal(call.searchParams.get("symbols"), "BTC/USD", "crypto is quoted as a pair");
      assert.equal(call.searchParams.get("feed"), null, "the crypto endpoint takes no venue feed");
    }
  } finally {
    restore();
  }
});

test("P0-1 a venue outage is not mistaken for a bad symbol", async () => {
  resetBarCache();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream down", { status: 503 });
  try {
    await assert.rejects(
      () => fetchDailyAdjustedBars(["SPY", "QQQ"], { start: "2026-09-17" }),
      /ALPACA_BARS_503/,
      "a 5xx must surface rather than be swallowed as an empty series",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("P0-1 a malformed request is not split into one request per symbol", async () => {
  resetBarCache();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    // A bad query, not a bad symbol: splitting here would issue one request per
    // symbol and exhaust the invocation's subrequest budget.
    return new Response(JSON.stringify({ message: "invalid start: 2026-09-21" }), { status: 400 });
  };
  try {
    const symbols = Array.from({ length: 20 }, (_, index) => `TICK${index}`);
    await assert.rejects(() => fetchDailyAdjustedBars(symbols, { start: "2026-09-21" }), /ALPACA_BARS_400/);
    assert.equal(calls, 1, "a malformed request must fail once, not fan out");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ============================================================ P0-3/P0-4 */

const event = (headline, tickers, publishedAt, sources = 1) => ({
  id: headline,
  headline,
  tickers,
  topics: [headline.split(/\s+/).slice(0, 3).join(" ")],
  sources: Array.from({ length: sources }, (_, index) => ({
    source: index === 0 ? "Reuters" : `Wire ${index}`,
    url: `https://example.com/${index}`,
    publishedAt,
    tier: 2,
  })),
  firstPublishedAt: publishedAt,
  impact: 50,
});

const MSTR_ANOMALY = { kind: "outlier-move", symbol: "MSTR", magnitude: 16.37, headline: "Strategy moved +16.4%", detail: "Strategy closed up 16.37%." };
const CHIP_COHORT = ["NVDA", "AMD", "MU", "AVGO", "INTC", "MRVL", "ARM", "TSM", "ASML", "SMCI"];

const metric = (symbol, group, returnPct) => ({
  symbol, label: symbol, group, open: null, close: null, priorClose: null, returnPct,
  openToClosePct: null, lateMovePct: null, finalHourMovePct: null, relativeToSpyPct: null, relativeToQqqPct: null,
});

test("P0-3 a story tagged to another holding cannot be MSTR's cause", () => {
  const nvidiaStory = event(
    "Brad Gerstner Says AI Labs Need $180B Revenue Run Rate to Keep Nvidia Trade Alive",
    ["AMZN", "COIN", "GOOGL", "META", "MSFT", "NVDA", "ORCL"],
    "2026-09-18T16:55:21Z",
    10,
  );
  // The metrics carry the whole holdings list, Oracle included.
  const metrics = [
    metric("MSTR", "portfolio", 16.37),
    metric("ORCL", "portfolio", -1.98),
    metric("SOXL", "portfolio", 7.92),
    metric("TSLA", "portfolio", -0.47),
  ];
  const attributed = attributeCatalyst({ anomaly: MSTR_ANOMALY, events: [nvidiaStory], metrics, sessionDate: "2026-09-18" });
  assert.equal(
    attributed,
    null,
    "Oracle sharing a model portfolio with Strategy is not a reason to blame an Nvidia story for a Strategy move",
  );
});

test("P0-3 a market-wide roundup that merely lists the symbol is not a cause", () => {
  const roundup = event(
    "Fed Raises Rates, Yields Hit 2007 Highs as Fuel Costs Set Records: This Week On Wall Street",
    ["AMZN", "MSTR", "NVDA"],
    "2026-09-18T20:11:49Z",
    3,
  );
  const attributed = attributeCatalyst({
    anomaly: MSTR_ANOMALY,
    events: [roundup],
    metrics: [metric("MSTR", "portfolio", 16.37)],
    sessionDate: "2026-09-18",
  });
  assert.equal(attributed, null, "being listed in a weekly digest is not a relationship to the move");

  // The same ticker set is direct once the headline actually names the symbol.
  const named = event("Strategy lifts its bitcoin holdings again (MSTR)", ["AMZN", "MSTR", "NVDA"], "2026-09-18T18:20:00Z", 3);
  const hit = attributeCatalyst({
    anomaly: MSTR_ANOMALY,
    events: [named],
    metrics: [metric("MSTR", "portfolio", 16.37)],
    sessionDate: "2026-09-18",
  });
  assert.ok(hit?.symbolMatch, "a headline that spells out the symbol is direct");
});

test("P0-3 a story naming the moved instrument is attributed and scored", () => {
  const mstrStory = event("Strategy boosts its bitcoin holdings", ["MSTR"], "2026-09-18T18:20:00Z", 2);
  const attributed = attributeCatalyst({
    anomaly: MSTR_ANOMALY,
    events: [mstrStory],
    metrics: [metric("MSTR", "portfolio", 16.37), metric("ORCL", "portfolio", -1.98)],
    sessionDate: "2026-09-18",
  });
  assert.ok(attributed, "a story naming MSTR is a candidate cause");
  assert.equal(attributed.symbolMatch, true);
  assert.equal(attributed.sectorMatch, false, "a portfolio sibling is not a sector peer");
  assert.equal(attributed.gapMinutes, 0, "published inside the move window");
  assert.equal(attributed.causality.components.relevance, 3, "naming the instrument is what makes it relevant");
  assert.equal(attributed.causality.label, "LIKELY");

  // The same story with the instrument reference removed loses the relevance
  // points and drops a band, which is the whole point of scoring it.
  const unowned = attributeCatalyst({
    anomaly: MSTR_ANOMALY,
    events: [event("Strategy boosts its bitcoin holdings", ["COIN"], "2026-09-18T18:20:00Z", 2)],
    metrics: [metric("MSTR", "portfolio", 16.37), metric("COIN", "portfolio", 4)],
    sessionDate: "2026-09-18",
  });
  assert.equal(unowned, null, "COIN is not a Strategy peer and cannot stand in for one");
});

test("P0-3 a cohort peer is weaker evidence than the instrument itself", () => {
  const anomaly = { kind: "outlier-move", symbol: "NVDA", magnitude: 8, headline: "Nvidia moved +8%", detail: "Nvidia closed up 8%." };
  const peerStory = event("Micron guides memory prices higher", ["MU"], "2026-09-18T18:20:00Z", 2);
  const chips = CHIP_COHORT.map((symbol) => metric(symbol, "semiconductor", symbol === "NVDA" ? 8 : 1));

  const peerOnly = attributeCatalyst({ anomaly, events: [peerStory], metrics: chips, sessionDate: "2026-09-18" });
  assert.ok(peerOnly, "a cohort peer still qualifies");
  assert.equal(peerOnly.symbolMatch, false);
  assert.equal(peerOnly.sectorMatch, true);
  assert.equal(peerOnly.causality.components.relevance, 1);

  const named = attributeCatalyst({
    anomaly,
    events: [event("Nvidia guides higher", ["NVDA"], "2026-09-18T18:20:00Z", 2)],
    metrics: chips,
    sessionDate: "2026-09-18",
  });
  assert.ok(named.causality.score > peerOnly.causality.score, "naming the instrument must beat naming a peer");
  assert.equal(named.causality.label, "CONFIRMED");
  assert.notEqual(peerOnly.causality.label, "CONFIRMED", "a peer story alone cannot reach the confirmed band");
});

test("P0-4 timing is measured against the move window, never the wall clock", () => {
  const start = "2026-09-18T18:00:00Z";
  const end = "2026-09-18T20:00:00Z";
  assert.equal(timingGapMinutes("2026-09-18T18:30:00Z", start, end), 0, "inside the window");
  assert.equal(timingGapMinutes("2026-09-18T19:59:00Z", start, end), 0, "just before the close");
  assert.equal(timingGapMinutes("2026-09-18T17:00:00Z", start, end), 60, "an hour before the window opened");
  assert.equal(timingGapMinutes("2026-09-18T22:00:00Z", start, end), 120, "two hours after the close");
  assert.equal(timingGapMinutes("not-a-date", start, end), null);
});

test("P0-4 a late move reads only the late window; an all-day move reaches the open", () => {
  const late = moveWindowIso({ kind: "late-acceleration", symbol: "SMH", magnitude: 1.5, headline: "", detail: "" }, "2026-09-18");
  assert.equal(late.start, "2026-09-18T18:00:00Z", "14:00 ET");
  assert.equal(late.end, "2026-09-18T20:00:00Z", "the close");

  const allDay = moveWindowIso({ kind: "outlier-move", symbol: "MSTR", magnitude: 16, headline: "", detail: "" }, "2026-09-18");
  assert.equal(allDay.start, "2026-09-18T13:30:00Z", "the 09:30 ET open");
});

test("P0-4 a stale headline no longer borrows a late move's timing", () => {
  const stale = event("Overnight chip commentary", ["SMH"], "2026-09-18T09:00:00Z", 3);
  const attributed = attributeCatalyst({
    anomaly: { kind: "late-acceleration", symbol: "SMH", magnitude: 1.8, headline: "", detail: "" },
    events: [stale],
    metrics: [],
    sessionDate: "2026-09-18",
  });
  // 09:00Z is nine hours before the late window opens, so timing scores zero.
  assert.equal(attributed.gapMinutes, 540);
  assert.equal(attributed.causality.components.timing, 0);
});

test("P0-3 relevance is part of the score, not a post-hoc filter", () => {
  const base = { timingGapMinutes: 5, sourceTier: 1, sectorConsistency: 0.8, independentSources: 3, economicLogic: true };
  const unrelated = scoreCausality({ ...base, symbolMatch: false, sectorMatch: false });
  const named = scoreCausality({ ...base, symbolMatch: true });
  assert.ok(named.score > unrelated.score, "naming the instrument must raise the score");
  assert.equal(unrelated.label, "LIKELY", "strong evidence with no relevance stays below confirmed");
  assert.equal(named.label, "CONFIRMED");
});

/* ================================================================ P0-5 */

test("P0-5 a valuation with no prior snapshot is not compared against itself", () => {
  const moves = valuationMovements([
    { ticker: "MSTR", priceChangePct: 16.37, fairValueBefore: null, fairValueAfter: 165.56, inputsChanged: true },
  ]);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].classification, "NO COMPARABLE PRIOR SNAPSHOT");
  assert.equal(moves[0].fairValueChangePct, null, "no +0.00% is printed for a comparison that never happened");
});

test("P0-5 a real prior snapshot still separates price from valuation", () => {
  const moves = valuationMovements([
    { ticker: "AMD", priceChangePct: 5.8, fairValueBefore: 451, fairValueAfter: 451, inputsChanged: false },
    { ticker: "ORCL", priceChangePct: 1.2, fairValueBefore: 214, fairValueAfter: 228, inputsChanged: true },
  ]);
  assert.equal(moves.find((move) => move.ticker === "AMD").classification, "PRICE MOVED ONLY");
  assert.equal(moves.find((move) => move.ticker === "ORCL").classification, "VALUATION INPUT CHANGED");
});
