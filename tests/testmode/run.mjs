// TEST MODE ONLY — post-close brief preview.
//
// Runs the real post-close reasoning pipeline for one session and prints the
// result. It deliberately does NOT do any of the following:
//   * INSERT / UPDATE / DELETE against briefings or briefing_outbox
//   * open a D1 binding at all
//   * reach Resend or send mail
// It reads market data from Alpaca and the canonical valuation endpoint, and
// writes only into tests/testmode/out/.
//
// Usage:
//   node --import ./register.mjs run.mjs 2026-09-18

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadDevVars } from "./env.mjs";
import { renderTestModeBrief } from "./render.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const SESSION_DATE = process.argv[2] ?? "2026-09-18";
const NEWS_WINDOW_HOURS = 20;

/* ------------------------------------------------------------------ */
/* Bindings                                                            */
/* ------------------------------------------------------------------ */

const vars = await loadDevVars(join(repo, "monitor-worker", ".dev.vars"));
const keyId = vars.ALPACA_API_KEY_ID?.trim();
const keySecret = vars.ALPACA_API_SECRET_KEY?.trim();
if (!keyId || !keySecret) {
  console.error("ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY must both be set in monitor-worker/.dev.vars");
  process.exit(2);
}

globalThis.__TESTMODE_ENV__ = {
  ...vars,
  ALPACA_API_KEY_ID: keyId,
  ALPACA_API_SECRET_KEY: keySecret,
  ALPACA_DATA_FEED: vars.ALPACA_DATA_FEED?.trim() || "iex",
};

const briefLib = await import(join(repo, "lib", "daily-brief.ts"));
const barLib = await import(join(repo, "lib", "alpaca-bars.ts"));

const {
  INSTRUMENTS,
  SEMICONDUCTOR_COHORT,
  PICK_NY_SYMBOLS,
  CHECKPOINT_UTC_HOUR,
  sessionMetrics,
  detectAnomalies,
  describeRegime,
  classifySemiconductorMove,
  clusterEvents,
  scoreEvent,
  scoreCausality,
  portfolioDay,
  valuationMovements,
  briefSubject,
  closeAtHour,
  isTradingDay,
} = briefLib;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const shiftDate = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Mirrors the worker's reader tiering so news quality is scored the same way. */
function readerTier(name, tier) {
  if (tier === 1) return 1;
  if (/reuters|bloomberg|wsj|financial times|associated press|ap\b/i.test(String(name))) return 2;
  const numeric = Number(tier);
  return numeric === 1 ? 1 : numeric === 2 ? 2 : 3;
}

const alpacaHeaders = {
  "APCA-API-KEY-ID": keyId,
  "APCA-API-SECRET-KEY": keySecret,
  accept: "application/json",
};

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

if (!isTradingDay(SESSION_DATE)) {
  console.error(`${SESSION_DATE} is not a US trading session.`);
  process.exit(2);
}
console.log(`[testmode] session ${SESSION_DATE}, feed ${globalThis.__TESTMODE_ENV__.ALPACA_DATA_FEED}`);

const universe = [...new Set([...INSTRUMENTS, ...SEMICONDUCTOR_COHORT].map((e) => e.symbol))];

console.log("[testmode] 1/6 fetching bars…");
const daily = await barLib.fetchDailyAdjustedBars(universe, { start: shiftDate(SESSION_DATE, -12) });
const intraday = await barLib.fetchIntradayBars(universe, { start: SESSION_DATE });

const priorCloseOf = (symbol) => {
  const series = daily.get(symbol);
  if (!series) return null;
  const dates = [...series.keys()].filter((d) => d < SESSION_DATE).sort();
  const last = dates.at(-1);
  return last ? series.get(last) ?? null : null;
};

const spyPrior = priorCloseOf("SPY");
const qqqPrior = priorCloseOf("QQQ");
const benchmarkReturns = {
  spy: spyPrior && spyPrior > 0 ? ((closeAtHour(intraday.get("SPY"), CHECKPOINT_UTC_HOUR.close) ?? spyPrior) / spyPrior - 1) * 100 : null,
  qqq: qqqPrior && qqqPrior > 0 ? ((closeAtHour(intraday.get("QQQ"), CHECKPOINT_UTC_HOUR.close) ?? qqqPrior) / qqqPrior - 1) * 100 : null,
};

// Diagnostic: bar stamp semantics decide every checkpoint reading, so show them.
const spyStamps = [...(intraday.get("SPY")?.keys() ?? [])].sort();
console.log(`[testmode] SPY intraday bar stamps (${spyStamps.length}): ${spyStamps.join(", ") || "none"}`);

console.log("[testmode] 2/6 session metrics…");
const allInstruments = [...INSTRUMENTS, ...SEMICONDUCTOR_COHORT];
const seen = new Set();
const metrics = [];
for (const instrument of allInstruments) {
  if (seen.has(instrument.symbol)) continue;
  seen.add(instrument.symbol);
  const series = intraday.get(instrument.symbol);
  const prior = priorCloseOf(instrument.symbol);
  if (!series?.size && prior === null) continue;
  metrics.push(
    sessionMetrics(instrument, series, {
      close: closeAtHour(series, CHECKPOINT_UTC_HOUR.close) ?? prior,
      priorClose: prior,
    }, benchmarkReturns),
  );
}

const anomalies = detectAnomalies(metrics);
const { regime, rationale } = describeRegime(metrics);
const bySymbol = new Map(metrics.map((m) => [m.symbol, m]));
const semiconductorMove = classifySemiconductorMove(
  metrics.filter((m) => SEMICONDUCTOR_COHORT.some((c) => c.symbol === m.symbol)),
  (bySymbol.get("SMH")?.returnPct ?? 0) >= 0 ? 1 : -1,
);

/* --- news, only now, only as a candidate cause --------------------- */
console.log("[testmode] 3/6 news (after price work)…");
const since = new Date(Date.now() - NEWS_WINDOW_HOURS * 3_600_000).toISOString();
let newsItems = [];
let newsStatus = "ok";
try {
  const url = new URL("https://data.alpaca.markets/v1beta1/news");
  url.searchParams.set("symbols", universe.filter((s) => !s.includes("-")).join(","));
  url.searchParams.set("start", since);
  url.searchParams.set("limit", "50");
  url.searchParams.set("sort", "desc");
  url.searchParams.set("include_content", "false");
  const response = await fetch(url, { headers: alpacaHeaders });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  newsItems = (payload.news ?? []).map((item) => ({
    id: item.id,
    headline: item.headline,
    summary: item.summary ?? undefined,
    url: item.url,
    source: item.source,
    sourceTier: readerTier(item.source, null),
    publishedAt: item.created_at,
    tickers: item.symbols ?? [],
    topics: [String(item.headline).split(/\s+/).slice(0, 4).join(" ")],
  }));
  console.log(`[testmode] alpaca news returned ${newsItems.length} items since ${since}`);
} catch (error) {
  newsStatus = `unavailable (${error instanceof Error ? error.message : "unknown"})`;
  console.log(`[testmode] alpaca news ${newsStatus}`);
}

const events = clusterEvents(newsItems)
  .map((event) => ({
    ...event,
    impact: scoreEvent({
      marketImpact: Math.min(5, anomalies[0]?.magnitude ?? 0),
      portfolioRelevance: event.tickers.some((t) => PICK_NY_SYMBOLS.includes(t)) ? 5 : 1,
      coverageRelevance: event.tickers.length ? 3 : 1,
      ageHours: Math.max(0, (Date.now() - Date.parse(event.firstPublishedAt)) / 3_600_000),
      sourceTier: Math.min(...event.sources.map((s) => s.tier)),
      novelty: 3,
    }),
  }))
  .sort((a, b) => b.impact - a.impact);

/* --- portfolio attribution ---------------------------------------- */
console.log("[testmode] 4/6 Pick-NY attribution…");
const priorCloses = new Map();
const todayCloses = new Map();
for (const ticker of PICK_NY_SYMBOLS) {
  const prior = priorCloseOf(ticker);
  const series = intraday.get(ticker);
  const close = closeAtHour(series, CHECKPOINT_UTC_HOUR.close) ?? prior;
  if (prior !== null) priorCloses.set(ticker, prior);
  if (close !== null && close !== undefined) todayCloses.set(ticker, close);
}
const portfolio = priorCloses.size === PICK_NY_SYMBOLS.length
  ? portfolioDay(priorCloses, todayCloses, {
    previousClose: spyPrior,
    close: closeAtHour(intraday.get("SPY"), CHECKPOINT_UTC_HOUR.close),
  })
  : null;

/* --- canonical valuation ------------------------------------------ */
console.log("[testmode] 5/6 canonical valuation…");
const origin = (vars.SIGNAL_LEDGER_ORIGIN ?? "https://signalledgerlab.com").replace(/\/+$/, "");
let valuation = [];
let valuationNote = null;
try {
  const response = await fetch(`${origin}/api/valuation/snapshot?tickers=${PICK_NY_SYMBOLS.join(",")}`, {
    headers: { Accept: "application/json", "User-Agent": vars.SEC_USER_AGENT ?? "SignalLedger" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const snapshots = payload.snapshots ?? [];
  valuation = valuationMovements(snapshots.map((s) => ({
    ticker: s.ticker,
    priceChangePct: bySymbol.get(s.ticker)?.returnPct ?? null,
    fairValueBefore: s.fairValue,
    fairValueAfter: s.fairValue,
    inputsChanged: String(s.valuationUpdatedAt ?? "").slice(0, 10) === SESSION_DATE,
  })));
  const refreshedToday = snapshots.filter((s) => String(s.valuationUpdatedAt ?? "").slice(0, 10) === SESSION_DATE);
  valuationNote = refreshedToday.length
    ? null
    : `Canonical endpoint reachable (${snapshots.length} snapshots). No valuation input carries today's date, so no fair-value change is attributable to this session.`;
  console.log(`[testmode] valuation snapshots=${snapshots.length}, refreshed today=${refreshedToday.length}`);
} catch (error) {
  valuationNote = `Canonical valuation endpoint could not be read (${error instanceof Error ? error.message : "unknown"}). No valuation change is claimed.`;
  console.log(`[testmode] ${valuationNote}`);
}

/* --- after the bell, from real extended-hours bars ----------------- */
console.log("[testmode] 6/6 after-hours + assembly…");
const CLOSE_UTC_HOUR = 20; // 16:00 ET
const afterHoursRows = [];
for (const instrument of allInstruments) {
  const series = intraday.get(instrument.symbol);
  if (!series?.size) continue;
  const stamps = [...series.keys()].sort();
  const regular = stamps.filter((s) => Number(s.slice(11, 13)) < CLOSE_UTC_HOUR).at(-1);
  const post = stamps.filter((s) => Number(s.slice(11, 13)) >= CLOSE_UTC_HOUR);
  if (!regular || !post.length) continue;
  const regularClose = series.get(regular);
  const lastStamp = post.at(-1);
  const last = series.get(lastStamp);
  if (!regularClose || !last || regularClose <= 0) continue;
  const pctMove = (last / regularClose - 1) * 100;
  if (Math.abs(pctMove) >= 0.5) {
    afterHoursRows.push({ symbol: instrument.symbol, pct: pctMove, last, lastStamp });
  }
}
afterHoursRows.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
const hasExtendedHours = [...intraday.values()].some((series) =>
  [...series.keys()].some((s) => Number(s.slice(11, 13)) >= CLOSE_UTC_HOUR),
);

/* --- upcoming earnings (read-only cache from D1) ------------------- */
let earnings = { available: false, items: [], note: "Upcoming earnings data was not loaded for this run." };
try {
  const cached = JSON.parse(await readFile(join(here, "out", "earnings.json"), "utf8"));
  const rows = cached.results?.[0]?.results ?? cached.results ?? [];
  earnings = {
    available: true,
    items: rows.map((r) => ({
      ticker: r.ticker,
      fiscalPeriod: r.fiscal_period,
      window: `${String(r.expected_window_start).slice(0, 10)} → ${String(r.expected_window_end).slice(0, 10)}`,
      confidence: r.window_confidence,
    })),
    note: "No scheduled earnings windows are open in the calendar.",
  };
} catch {
  earnings = { available: false, items: [], note: "Upcoming earnings: the earnings calendar could not be read for this run." };
}

/* ------------------------------------------------------------------ */
/* Assemble the model                                                  */
/* ------------------------------------------------------------------ */

const mainAnomaly = anomalies[0] ?? null;
const theme = mainAnomaly
  ? mainAnomaly.headline
  : regime === "MIXED"
    ? "市场缺乏单一主线"
    : `${regime} 主导，指数窄幅波动`;
const subject = briefSubject(SESSION_DATE, theme);

const indexLine = ["SPY", "QQQ", "DIA", "IWM"]
  .map((s) => `${s} ${bySymbol.get(s)?.returnPct === undefined || bySymbol.get(s)?.returnPct === null ? "—" : `${bySymbol.get(s).returnPct >= 0 ? "+" : ""}${bySymbol.get(s).returnPct.toFixed(2)}%`}`)
  .join(" · ");
const summaryBullets = [
  indexLine,
  `Regime: ${regime} — ${rationale}`,
  `Pick-NY ${portfolio ? `${portfolio.returnPct >= 0 ? "+" : ""}${portfolio.returnPct.toFixed(2)}%` : "—"} vs SPY ${benchmarkReturns.spy === null ? "—" : `${benchmarkReturns.spy >= 0 ? "+" : ""}${benchmarkReturns.spy.toFixed(2)}%`}`,
  `Semiconductor read: ${semiconductorMove}`,
];
for (const anomaly of anomalies.slice(0, 3)) summaryBullets.push(anomaly.detail);
summaryBullets.push(newsStatus === "ok" ? `News source available (${newsItems.length} items in the last ${NEWS_WINDOW_HOURS}h).` : `News source ${newsStatus}; causality is degraded.`);

const ranked = metrics.filter((m) => m.returnPct !== null).sort((a, b) => b.returnPct - a.returnPct);
const cohort = metrics.filter((m) => SEMICONDUCTOR_COHORT.some((c) => c.symbol === m.symbol) && m.returnPct !== null);
const breadth = cohort.length
  ? { up: cohort.filter((m) => m.returnPct > 0).length, total: cohort.length, pct: (cohort.filter((m) => m.returnPct > 0).length / cohort.length) * 100 }
  : null;

const groups = new Map();
for (const m of metrics) {
  if (m.returnPct === null) continue;
  const bucket = groups.get(m.group) ?? [];
  bucket.push(m.returnPct);
  groups.set(m.group, bucket);
}
const sectorLeadership = [...groups.entries()]
  .map(([group, values]) => ({ group, avgReturnPct: values.reduce((a, b) => a + b, 0) / values.length, count: values.length }))
  .sort((a, b) => b.avgReturnPct - a.avgReturnPct);

const WATCHLIST = ["SOXL", "AMD", "ORCL", "MSTR", "TSLA", "ASTS", "SMH", "SOXX"];
const movers = WATCHLIST
  .map((symbol) => bySymbol.get(symbol))
  .filter(Boolean)
  .map((m) => ({ symbol: m.symbol, label: m.label, returnPct: m.returnPct, lateMovePct: m.lateMovePct, finalHourMovePct: m.finalHourMovePct }));

const topEvent = events[0] ?? null;
const gapMinutes = topEvent ? Math.abs(Date.parse(topEvent.firstPublishedAt) - Date.now()) / 60_000 : null;
const causality = mainAnomaly
  ? scoreCausality({
    timingGapMinutes: gapMinutes,
    sourceTier: topEvent ? Math.min(...topEvent.sources.map((s) => s.tier)) : null,
    sectorConsistency: metrics.filter((m) => Math.sign(m.returnPct ?? 0) === Math.sign(mainAnomaly.magnitude)).length / Math.max(1, metrics.length),
    independentSources: topEvent?.sources.length ?? 0,
    economicLogic: newsItems.length > 0,
  })
  : null;

const nextSession = (() => {
  let d = shiftDate(SESSION_DATE, 1);
  while (!isTradingDay(d)) d = shiftDate(d, 1);
  return d;
})();

const brief = {
  sessionDate: SESSION_DATE,
  subject,
  regime,
  rationale,
  summaryBullets,
  mainMove: mainAnomaly
    ? {
      headline: mainAnomaly.headline,
      detail: mainAnomaly.detail,
      causality: causality.label,
      catalyst: topEvent?.headline ?? null,
    }
    : null,
  causalityNote: `Causality scoring components: ${causality ? JSON.stringify(causality.components) : "n/a"} (score ${causality?.score ?? "n/a"}). Timing is measured from publication to run time, mirroring the worker.`,
  drivers: causality && topEvent
    ? [{
      event: topEvent.headline,
      evidence: `${topEvent.sources.length} source(s), earliest ${topEvent.firstPublishedAt}; tickers ${topEvent.tickers.join(", ") || "—"}.`,
      assets: [mainAnomaly?.symbol, "SPY", "QQQ"].filter(Boolean).join(", "),
      causality: causality.label,
      gapMinutes,
    }]
    : [],
  leaders: ranked.slice(0, 5).map((m) => ({ symbol: m.symbol, label: m.label, returnPct: m.returnPct })),
  laggards: ranked.slice(-5).reverse().map((m) => ({ symbol: m.symbol, label: m.label, returnPct: m.returnPct })),
  breadth,
  sectorLeadership,
  movers,
  portfolio,
  valuationMovements: valuation,
  valuationNote,
  afterHours: {
    available: hasExtendedHours,
    items: afterHoursRows.slice(0, 6),
    note: !hasExtendedHours
      ? "No extended-hours bars were returned by the market-data feed, so after-hours moves cannot be measured."
      : afterHoursRows.length
        ? "Moves measured from the 16:00 ET regular close to the latest extended-hours bar."
        : "No tracked name moved 0.5% or more after the close.",
  },
  tomorrow: {
    items: [],
    note: `Next session ${nextSession}. No scheduled catalyst was verifiable for it from the sources this run can read, so none is claimed.`,
  },
  upcomingEarnings: earnings,
};

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

const { text, html } = renderTestModeBrief(brief);
await mkdir(join(here, "out"), { recursive: true });
await writeFile(join(here, "out", `${SESSION_DATE}.model.json`), JSON.stringify(brief, null, 2));
await writeFile(join(here, "out", `${SESSION_DATE}.txt`), text);
await writeFile(join(here, "out", `${SESSION_DATE}.html`), html);

console.log("\n" + "=".repeat(72));
console.log(text);
console.log("=".repeat(72));
console.log(`\n[testmode] wrote tests/testmode/out/${SESSION_DATE}.{model.json,txt,html}`);
console.log("[testmode] no database write, no outbox row, no email sent.");
