import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

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

const {
  CHECKPOINT_UTC_HOUR,
  INSTRUMENTS,
  briefSendId,
  briefSubject,
  classifySemiconductorMove,
  closeAtHour,
  clusterEvents,
  describeRegime,
  detectAnomalies,
  isSendWindow,
  isTradingDay,
  portfolioDay,
  qualityGate,
  renderBrief,
  rollingContext,
  scoreCausality,
  scoreEvent,
  sessionMetrics,
  themeStreak,
  usMarketHolidays,
  valuationMovements,
  SEMICONDUCTOR_COHORT,
} = await import(briefUrl);
const { PICK_NY_TARGETS } = await import(pickNyUrl);

const instrument = (symbol) => INSTRUMENTS.find((entry) => entry.symbol === symbol);

/**
 * Checkpoint levels keyed by the ET hour they represent.
 *
 * Alpaca stamps a bar with the START of its period, so the bar whose close is
 * the price at ET hour `et` opened an hour earlier: a 16:00 ET close is carried
 * by the 19:00Z bar, not the 20:00Z one.
 */
function intraday(levels, date = "2026-09-18") {
  const map = new Map();
  const hour = (et) => String((et + 3) % 24).padStart(2, "0"); // EDT start-stamp → UTC
  for (const [et, price] of Object.entries(levels)) map.set(`${date}T${hour(Number(et))}:00:00Z`, price);
  return map;
}

function metricsFor(symbol, levels, priorClose) {
  const series = intraday(levels);
  return sessionMetrics(instrument(symbol), series, {
    close: closeAtHour(series, CHECKPOINT_UTC_HOUR.close),
    priorClose,
  }, { spy: null, qqq: null });
}

/** A full session: prior closes plus intraday levels, with SPY/QQQ for relatives. */
function session(rows) {
  const spyLevels = rows.SPY ?? {};
  const qqqLevels = rows.QQQ ?? {};
  const spyReturn = ((spyLevels[16] / rows.__prior.SPY) - 1) * 100;
  const qqqReturn = ((qqqLevels[16] / rows.__prior.QQQ) - 1) * 100;
  return Object.entries(rows)
    .filter(([symbol]) => symbol !== "__prior")
    .map(([symbol, levels]) => {
      const series = intraday(levels);
      return sessionMetrics(instrument(symbol) ?? { symbol, label: symbol, group: "semiconductor" }, series, {
        close: closeAtHour(series, CHECKPOINT_UTC_HOUR.close),
        priorClose: rows.__prior[symbol] ?? null,
      }, { spy: spyReturn, qqq: qqqReturn });
    });
}

/* ---------------------------------------------------------------- schedule */

test("the schedule skips weekends and every US market holiday", () => {
  assert.equal(isTradingDay("2026-09-18"), true, "a Friday");
  assert.equal(isTradingDay("2026-09-19"), false, "a Saturday");
  assert.equal(isTradingDay("2026-09-20"), false, "a Sunday");
  for (const holiday of usMarketHolidays(2026)) assert.equal(isTradingDay(holiday), false, holiday);
  // Good Friday 2026 falls on 3 April and Thanksgiving on 26 November.
  assert.ok(usMarketHolidays(2026).includes("2026-04-03"));
  assert.ok(usMarketHolidays(2026).includes("2026-11-26"));
  // New Year 2027 falls on a Friday and is traded; New Year 2028 falls on a
  // Saturday and is observed on the preceding Friday.
  assert.ok(!usMarketHolidays(2027).includes("2026-12-31"));
  assert.ok(usMarketHolidays(2028).includes("2027-12-31"), "New Year 2028 observed on 31 Dec 2027");
});

test("the brief only leaves in the 17:15 ET window", () => {
  const sessionDate = "2026-09-18";
  assert.equal(isSendWindow(new Date("2026-09-18T21:10:00Z"), sessionDate), false, "17:10 ET is early");
  assert.equal(isSendWindow(new Date("2026-09-18T21:16:00Z"), sessionDate), true, "17:16 ET");
  assert.equal(isSendWindow(new Date("2026-09-19T14:00:00Z"), sessionDate), false, "a different ET date");
  assert.equal(isSendWindow(new Date("2026-09-19T21:16:00Z"), "2026-09-19"), false, "a Saturday");
});

test("a retry can never send the same session twice", () => {
  assert.equal(briefSendId("2026-09-18"), "postclose:2026-09-18");
  assert.equal(briefSendId("2026-09-18"), briefSendId("2026-09-18"));
  assert.notEqual(briefSendId("2026-09-18"), briefSendId("2026-09-21"));
});

/* ------------------------------------------------------- anomaly detection */

test("a broad risk-on day reads as risk-on, not as an anomaly", () => {
  const metrics = session({
    __prior: { SPY: 500, QQQ: 430, IWM: 220, SMH: 260 },
    SPY: { 10: 502, 14: 505.5, 15: 505.9, 16: 506 },
    QQQ: { 10: 432, 14: 436.6, 15: 436.9, 16: 437 },
    IWM: { 10: 221, 14: 223.7, 15: 223.9, 16: 224 },
    SMH: { 10: 261, 14: 263.7, 15: 263.9, 16: 264 },
  });
  const { regime } = describeRegime(metrics);
  assert.equal(regime, "RISK-ON");
  assert.equal(detectAnomalies(metrics).length, 0, "nothing unusual happened");
});

test("a semiconductor rally that accelerates into the close is detected as late", () => {
  const smh = metricsFor("SMH", { 10: 261.0, 14: 261.8, 15: 263.0, 16: 266.5 }, 260);
  assert.ok(Math.abs(smh.lateMovePct - 1.8) < 0.05, `late move was ${smh.lateMovePct}`);
  assert.ok(Math.abs(smh.finalHourMovePct - 1.33) < 0.05, `final hour was ${smh.finalHourMovePct}`);
  const anomalies = detectAnomalies([smh]);
  assert.ok(anomalies.some((entry) => entry.kind === "late-acceleration"));
  assert.match(anomalies[0].headline, /accelerated into the close/);
});

test("a rate-driven selloff is attributed to rates, not to the index", () => {
  const metrics = session({
    __prior: { SPY: 500, QQQ: 430, TLT: 90, IWM: 220 },
    SPY: { 10: 499, 14: 496, 15: 495, 16: 494 },
    QQQ: { 10: 428, 14: 425, 15: 424, 16: 423 },
    TLT: { 10: 89.4, 14: 88.9, 15: 88.7, 16: 88.6 },
    IWM: { 10: 219, 14: 217, 15: 216, 16: 215 },
  });
  const { regime, rationale } = describeRegime(metrics);
  assert.equal(regime, "RATE-DRIVEN");
  assert.match(rationale, /Long Treasuries fell/);
});

test("one mega-cap carrying the index is flagged as concentrated", () => {
  const metrics = session({
    __prior: { SPY: 500, QQQ: 430, IWM: 220, SMH: 260, NVDA: 120 },
    SPY: { 10: 500, 14: 500.5, 15: 501, 16: 501.5 },
    QQQ: { 10: 430, 14: 431, 15: 432, 16: 434 },
    IWM: { 10: 220, 14: 219, 15: 218, 16: 217 },
    SMH: { 10: 260, 14: 261, 15: 262, 16: 263 },
    NVDA: { 10: 120, 14: 123, 15: 126, 16: 130 },
  });
  const anomalies = detectAnomalies(metrics);
  assert.ok(anomalies.some((entry) => entry.kind === "late-acceleration" && entry.symbol === "NVDA"));
  assert.ok(anomalies.some((entry) => entry.kind === "outlier-move" && entry.symbol === "NVDA"), "an 8.3% move is an outlier");
  const { regime } = describeRegime(metrics);
  assert.equal(regime, "DEFENSIVE", "growth up, small caps down");
});

/* ------------------------------------------------- sector characterisation */

test("the chip cohort is characterised by who actually moved", () => {
  // A name is "moved" at 0.5% or more, so the default is a quiet cohort member.
  const cohort = (overrides = {}, base = 1.2) =>
    SEMICONDUCTOR_COHORT.map((entry) => ({
      symbol: entry.symbol, label: entry.label, group: entry.group,
      open: null, close: null, priorClose: null, returnPct: overrides[entry.symbol] ?? base,
      openToClosePct: null, lateMovePct: null, finalHourMovePct: null, relativeToSpyPct: null, relativeToQqqPct: null,
    }));

  assert.equal(classifySemiconductorMove(cohort(), 1), "BROAD SEMICONDUCTOR MOVE");
  assert.equal(classifySemiconductorMove(cohort({ MU: 3.1, NVDA: 2.4 }), 1), "BROAD SEMICONDUCTOR MOVE");
  assert.equal(
    classifySemiconductorMove(cohort({ MU: 5, TSM: 4.2, ASML: 3.4, NVDA: 0.2, AMD: 0.1, AVGO: 0.3, INTC: 0.2, MRVL: 0.1, ARM: 0.4, SMCI: 0.3 }, 0.2), 1),
    "FOUNDRY-LED",
    "the foundry names carried a cohort where the accelerators did not move",
  );
  assert.equal(
    classifySemiconductorMove(cohort({ NVDA: 8, AMD: 0.2, MU: 0.3, AVGO: 0.1, INTC: 0.2, MRVL: 0.1, ARM: 0.3, TSM: 0.2, ASML: 0.1, SMCI: 0.2 }, 0.2), 1),
    "SINGLE-STOCK DISTORTION",
  );
  assert.equal(
    classifySemiconductorMove(cohort({ NVDA: 0.2, AMD: 0.1, MU: 0.2, AVGO: 0.1, INTC: 0.1, MRVL: 0.1, ARM: 0.2, TSM: 0.1, ASML: 0.1, SMCI: 0.2 }, 0.1), 1),
    "MIXED / UNCLEAR",
    "nothing moved, so nothing is characterised",
  );
});

/* -------------------------------------------------------------- causality */

test("causality is scored and labelled from evidence, never asserted", () => {
  // Relevance is required for the confirmed band: naming the instrument that
  // moved is what separates a cause from a story that merely happened nearby.
  const confirmed = scoreCausality({ timingGapMinutes: 5, sourceTier: 1, sectorConsistency: 0.8, symbolMatch: true, independentSources: 3, economicLogic: true });
  assert.equal(confirmed.label, "CONFIRMED");
  assert.ok(confirmed.score >= 13 && confirmed.score <= 15);

  const irrelevant = scoreCausality({ timingGapMinutes: 5, sourceTier: 1, sectorConsistency: 0.8, independentSources: 3, economicLogic: true });
  assert.notEqual(irrelevant.label, "CONFIRMED", "strong evidence with no relevance cannot be confirmed");
  assert.ok(irrelevant.score < confirmed.score);

  const likely = scoreCausality({ timingGapMinutes: 45, sourceTier: 2, sectorConsistency: 0.5, independentSources: 2, economicLogic: true });
  assert.equal(likely.label, "LIKELY");

  const unclear = scoreCausality({ timingGapMinutes: null, sourceTier: 3, sectorConsistency: 0.1, independentSources: 1, economicLogic: false });
  assert.equal(unclear.label, "UNCLEAR");
  assert.equal(unclear.score, 1, "a tier-3 story with no timing and no corroboration proves nothing");
});

test("an unexplained move is reported as unexplained", () => {
  const smh = metricsFor("SMH", { 10: 260, 14: 261, 15: 264, 16: 267 }, 260);
  const outcome = scoreCausality({ timingGapMinutes: null, sourceTier: null, sectorConsistency: 0.2, independentSources: 0, economicLogic: false });
  assert.equal(outcome.label, "UNCLEAR");
  assert.ok(smh.lateMovePct > 1, "the move itself is still reported");
});

/* ----------------------------------------------------------------- events */

test("three outlets covering one story produce one catalyst", () => {
  const items = [
    { id: "a", headline: "Nvidia unveils new accelerator", url: "https://reuters.com/a", source: "Reuters", sourceTier: 2, publishedAt: "2026-09-18T19:05:00Z", tickers: ["NVDA"], topics: ["AI accelerator"] },
    { id: "b", headline: "Nvidia launches new AI chip", url: "https://bloomberg.com/b", source: "Bloomberg", sourceTier: 2, publishedAt: "2026-09-18T19:20:00Z", tickers: ["NVDA"], topics: ["AI accelerator"] },
    { id: "c", headline: "Nvidia's latest AI chip", url: "https://cnbc.com/c", source: "CNBC", sourceTier: 3, publishedAt: "2026-09-18T19:40:00Z", tickers: ["NVDA"], topics: ["AI accelerator"] },
  ];
  const clustered = clusterEvents(items);
  assert.equal(clustered.length, 1, "one event, three sources");
  assert.equal(clustered[0].sources.length, 3);
  assert.equal(clustered[0].firstPublishedAt, "2026-09-18T19:05:00Z");
});

test("unrelated stories stay separate", () => {
  const clustered = clusterEvents([
    { id: "a", headline: "Nvidia accelerator", url: "u1", source: "Reuters", sourceTier: 2, publishedAt: "2026-09-18T19:00:00Z", tickers: ["NVDA"], topics: ["AI accelerator"] },
    { id: "b", headline: "Oil spikes", url: "u2", source: "Reuters", sourceTier: 2, publishedAt: "2026-09-18T19:10:00Z", tickers: ["XOM"], topics: ["crude supply"] },
  ]);
  assert.equal(clustered.length, 2);
});

test("event importance falls off with age and source tier", () => {
  const base = { marketImpact: 4, portfolioRelevance: 4, coverageRelevance: 4, novelty: 3 };
  const freshPrimary = scoreEvent({ ...base, ageHours: 2, sourceTier: 1 });
  const staleTertiary = scoreEvent({ ...base, ageHours: 40, sourceTier: 3 });
  assert.ok(freshPrimary > staleTertiary, `${freshPrimary} should beat ${staleTertiary}`);
  assert.ok(freshPrimary <= 100, "the score is a percentage");
});

/* --------------------------------------------------------------- portfolio */

test("portfolio attribution adds up to the portfolio return", () => {
  const prior = new Map([["SOXL", 100], ["AMD", 200], ["ORCL", 150], ["MSTR", 120], ["TSLA", 250], ["ASTS", 60]]);
  const today = new Map([["SOXL", 104.8], ["AMD", 206.2], ["ORCL", 148.5], ["MSTR", 121.2], ["TSLA", 247.0], ["ASTS", 60.6]]);
  const day = portfolioDay(prior, today, { previousClose: 500, close: 501.5 });

  const total = day.holdings.reduce((sum, holding) => sum + holding.contributionPoints, 0);
  assert.ok(Math.abs(total - day.returnPct) < 1e-9, "contributions reconcile to the portfolio return");
  assert.ok(Math.abs(day.holdings.reduce((sum, holding) => sum + holding.weight, 0) - 1) < 1e-9, "weights sum to 100%");
  assert.ok(day.excessPct !== null && Math.abs(day.excessPct - (day.returnPct - day.benchmarkReturnPct)) < 1e-9);
  assert.equal(day.material[0].ticker, "SOXL", "the largest contributor leads");
  assert.deepEqual([...new Set(day.material.map((holding) => holding.ticker))].length, day.material.length);
});

test("a quiet portfolio day reports nothing material", () => {
  const flat = new Map(PICK_NY_TARGETS.map((target) => [target.ticker, 100]));
  const barely = new Map(PICK_NY_TARGETS.map((target) => [target.ticker, 100.02]));
  const day = portfolioDay(flat, barely, { previousClose: 500, close: 500 });
  assert.equal(day.holdings.length, PICK_NY_TARGETS.length);
  assert.deepEqual(day.material, [], "a 0.02% move is not worth a paragraph");
});

/* -------------------------------------------------------------- valuation */

test("a price move is not a valuation change", () => {
  const moves = valuationMovements([
    { ticker: "AMD", priceChangePct: 5.8, fairValueBefore: 451, fairValueAfter: 451, inputsChanged: false },
    { ticker: "ORCL", priceChangePct: 1.2, fairValueBefore: 214, fairValueAfter: 228, inputsChanged: true },
    { ticker: "ASTS", priceChangePct: 0.3, fairValueBefore: 18, fairValueAfter: 18, inputsChanged: false },
  ]);
  const amd = moves.find((move) => move.ticker === "AMD");
  assert.equal(amd.classification, "PRICE MOVED ONLY");
  assert.equal(amd.fairValueChangePct, 0);
  const orcl = moves.find((move) => move.ticker === "ORCL");
  assert.equal(orcl.classification, "VALUATION INPUT CHANGED");
  assert.ok(orcl.fairValueChangePct > 6);
  assert.equal(moves.find((move) => move.ticker === "ASTS"), undefined, "an immaterial move is not reported");
});

/* ------------------------------------------------------- rolling context */

test("five-day context notices a run rather than reading one day alone", () => {
  const history = Array.from({ length: 6 }, (_, index) => ({
    sessionDate: `2026-09-${String(10 + index).padStart(2, "0")}`,
    close: 100 * 1.01 ** index,
    benchmarkClose: 100,
  }));
  const notes = rollingContext(history);
  assert.ok(notes.has("1d") && notes.has("5d"));
  assert.match(notes.get("5d"), /versus S&P 500/);
  assert.equal(themeStreak("SEMICONDUCTORS LED", [
    { sessionDate: "2026-09-16", regime: "MIXED", theme: "SEMICONDUCTORS LED" },
    { sessionDate: "2026-09-17", regime: "MIXED", theme: "SEMICONDUCTORS LED" },
  ]), 3, "three sessions running");
  assert.equal(themeStreak("RATES", [{ sessionDate: "2026-09-17", regime: "MIXED", theme: "SEMICONDUCTORS LED" }]), 1);
});

/* ------------------------------------------------------------ quality gate */

function draftFor(overrides = {}) {
  const base = {
    sessionDate: "2026-09-18",
    subject: briefSubject("2026-09-18", "半导体尾盘走强，Nasdaq 反弹"),
    regime: "AI / SEMI-LED",
    summaryBullets: ["Nasdaq +1.2%", "S&P 500 +0.4%", "Pick-NY +1.7%"],
    mainMove: { headline: "Semiconductors accelerated into the close", analysis: "SMH moved +1.7 points after 14:00 ET on broad participation.", causality: "LIKELY" },
    drivers: [{ event: "Chip cohort advanced", evidence: "8 of 10 names higher", assets: "SMH, SOXX, AMD, MU", causality: "LIKELY" }],
    movers: [{ symbol: "MU", returnPct: 4.5, note: "memory-led strength" }],
    portfolio: portfolioDay(
      new Map([["SOXL", 100], ["AMD", 200], ["ORCL", 150], ["MSTR", 120], ["TSLA", 250], ["ASTS", 60]]),
      new Map([["SOXL", 104.8], ["AMD", 206.2], ["ORCL", 148.5], ["MSTR", 121.2], ["TSLA", 247.0], ["ASTS", 60.6]]),
      { previousClose: 500, close: 501.5 },
    ),
    valuationMovements: [],
    afterHours: [],
    upcoming: [{ when: "Sep 23", what: "MU earnings", matters: "HBM pricing and gross margin" }],
    text: "",
    html: "",
  };
  return { ...base, ...overrides };
}

test("the quality gate refuses filler, missing portfolio and unlabelled causes", () => {
  const good = draftFor();
  const rendered = renderBrief(good);
  assert.equal(qualityGate({ ...good, ...rendered }).pass, true, JSON.stringify(qualityGate({ ...good, ...rendered }).failures));

  const filler = draftFor({ summaryBullets: ["财报将检验当前预期"] });
  assert.ok(qualityGate({ ...filler, ...renderBrief(filler) }).failures.some((failure) => failure.includes("filler")));

  const noPortfolio = draftFor({ portfolio: null });
  assert.ok(qualityGate({ ...noPortfolio, ...renderBrief(noPortfolio) }).failures.includes("Pick-NY is absent"));

  const noCause = draftFor({ mainMove: null, drivers: [] });
  assert.ok(qualityGate({ ...noCause, ...renderBrief(noCause) }).failures.includes("no explanation of the index move"));

  const tooMany = draftFor({ drivers: Array.from({ length: 4 }, (_, index) => ({ event: `e${index}`, evidence: "x", assets: "y", causality: "LIKELY" })) });
  assert.ok(qualityGate({ ...tooMany, ...renderBrief(tooMany) }).failures.some((failure) => failure.includes("three drivers")));
});

test("a brief that is mostly calendar is rejected", () => {
  const calendar = draftFor({
    summaryBullets: ["x"],
    mainMove: null,
    drivers: [],
    upcoming: Array.from({ length: 5 }, (_, index) => ({ when: `Sep ${20 + index}`, what: `Event ${index}`, matters: "x".repeat(60) })),
  });
  const result = qualityGate({ ...calendar, ...renderBrief(calendar) });
  assert.equal(result.pass, false);
});

/* --------------------------------------------------- degraded operation */

test("a news outage still produces a price-action brief, labelled as such", () => {
  const metrics = session({
    __prior: { SPY: 500, QQQ: 430, SMH: 260 },
    SPY: { 10: 501, 14: 502, 15: 503, 16: 504 },
    QQQ: { 10: 431, 14: 432, 15: 433, 16: 434 },
    SMH: { 10: 261, 14: 262, 15: 264, 16: 266 },
  });
  const anomalies = detectAnomalies(metrics);
  assert.ok(anomalies.length > 0, "price action alone is enough to report");

  const draft = draftFor({
    summaryBullets: ["新闻源部分不可用，以下因果解释仅基于价格与跨资产表现。"],
    mainMove: null,
    drivers: [{ event: "Price action only", evidence: "SMH +2.3% with 14:00→close +1.5 points", assets: "SMH, QQQ", causality: "UNCLEAR" }],
  });
  const result = qualityGate({ ...draft, ...renderBrief(draft) });
  assert.equal(result.pass, true, "an unlabelled source outage must not block the brief");
});

/* ----------------------------------------------- five session patterns */

test("five session patterns each produce their own signature", () => {
  const patterns = {
    quiet: {
      theme: "窄幅震荡，半导体小幅回落",
      metrics: session({ __prior: { SPY: 500, QQQ: 430 }, SPY: { 10: 500.2, 14: 500.1, 15: 499.9, 16: 500.0 }, QQQ: { 10: 430.1, 14: 429.9, 15: 429.8, 16: 429.7 } }),
      // Nothing happened, and the brief must say so rather than inventing a story.
      expect: (anomalies, regime) => {
        assert.equal(anomalies.length, 0);
        assert.equal(regime, "MIXED");
      },
    },
    semis: {
      theme: "半导体尾盘走强，Nasdaq 反弹",
      metrics: session({ __prior: { SPY: 500, QQQ: 430, SMH: 260 }, SPY: { 10: 501, 14: 502, 15: 503, 16: 504 }, QQQ: { 10: 431, 14: 432, 15: 434, 16: 436 }, SMH: { 10: 261, 14: 262, 15: 265, 16: 268 } }),
      expect: (anomalies, regime) => {
        assert.ok(anomalies.some((entry) => entry.kind === "late-acceleration" && entry.symbol === "SMH"));
        assert.equal(regime, "AI / SEMI-LED");
      },
    },
    rates: {
      theme: "长端利率上行压制成长股",
      metrics: session({ __prior: { SPY: 500, QQQ: 430, TLT: 90 }, SPY: { 10: 499, 14: 496, 15: 495, 16: 494 }, QQQ: { 10: 428, 14: 425, 15: 424, 16: 423 }, TLT: { 10: 89.4, 14: 88.9, 15: 88.7, 16: 88.6 } }),
      // The signature of a rates day is the regime, not a late-session anomaly.
      expect: (anomalies, regime) => {
        assert.equal(regime, "RATE-DRIVEN");
        assert.equal(anomalies.length, 0, "an orderly decline is not an anomaly");
      },
    },
    singleStock: {
      theme: "NVDA 独力支撑指数，广度偏弱",
      metrics: session({ __prior: { SPY: 500, QQQ: 430, IWM: 220, NVDA: 120 }, SPY: { 10: 500, 14: 500.5, 15: 501, 16: 501.5 }, QQQ: { 10: 430, 14: 431, 15: 432, 16: 434 }, IWM: { 10: 220, 14: 219, 15: 218, 16: 217 }, NVDA: { 10: 120, 14: 123, 15: 126, 16: 130 } }),
      expect: (anomalies, regime) => {
        assert.ok(anomalies.some((entry) => entry.kind === "outlier-move" && entry.symbol === "NVDA"));
        assert.equal(regime, "DEFENSIVE");
      },
    },
    energy: {
      theme: "原油走强带动能源板块",
      metrics: session({ __prior: { SPY: 500, USO: 70 }, SPY: { 10: 500, 14: 500.4, 15: 500.6, 16: 501 }, USO: { 10: 71, 14: 72.5, 15: 73.4, 16: 74.2 } }),
      expect: (anomalies, regime) => {
        assert.equal(regime, "ENERGY-LED");
        assert.ok(anomalies.length > 0, "a 6% oil move is unusual");
      },
    },
  };

  const subjects = new Set();
  const regimes = new Set();
  const bodies = new Set();
  for (const [name, pattern] of Object.entries(patterns)) {
    const anomalies = detectAnomalies(pattern.metrics);
    const { regime } = describeRegime(pattern.metrics);
    pattern.expect(anomalies, regime);

    subjects.add(briefSubject("2026-09-18", pattern.theme));
    regimes.add(regime);

    const draft = draftFor({
      subject: briefSubject("2026-09-18", pattern.theme),
      regime,
      summaryBullets: anomalies.length ? anomalies.slice(0, 3).map((entry) => entry.headline) : ["指数窄幅波动，无异常走势。"],
      mainMove: anomalies.length ? { headline: anomalies[0].headline, analysis: anomalies[0].detail, causality: "UNCLEAR" } : null,
      drivers: anomalies.length ? [{ event: anomalies[0].headline, evidence: anomalies[0].detail, assets: anomalies[0].symbol, causality: "UNCLEAR" }] : [],
      upcoming: [],
    });
    const rendered = renderBrief(draft);
    assert.ok(rendered.text.includes(pattern.theme), `${name}: the theme reaches the body`);
    bodies.add(rendered.text);
  }

  assert.equal(subjects.size, 5, "five distinct subjects");
  assert.equal(regimes.size, 5, `each session gets its own regime, saw ${[...regimes].join(", ")}`);
  assert.equal(bodies.size, 5, "a quiet day must not read like a semiconductor day");
});
