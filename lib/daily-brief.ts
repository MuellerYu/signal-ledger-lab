/**
 * The post-close daily intelligence brief.
 *
 * The pipeline is price-first, not news-first: market data establishes what
 * moved, when it moved and who led; only then is news searched for a cause and
 * classified by how well it fits. Every number in the brief is computed here —
 * the editorial layer may explain a move but may never invent one.
 */

import { PICK_NY_TARGETS } from "./pick-ny";
import { money, pct } from "./format";

export const DAILY_BRIEF_ENGINE = "signal-ledger.daily-brief.v1";

/* ------------------------------------------------------------------ */
/* Universe                                                            */
/* ------------------------------------------------------------------ */

/**
 * Cross-asset context. Macro is read through liquid ETF proxies and labelled as
 * such: the deployment has no direct index feed for rates, the dollar or
 * commodities, and a labelled proxy is honest where a silent one is not.
 */
export type Instrument = { symbol: string; label: string; group: InstrumentGroup; proxy?: string };
export type InstrumentGroup = "index" | "sector" | "rates" | "commodity" | "crypto" | "portfolio" | "semiconductor";

export const INSTRUMENTS: readonly Instrument[] = Object.freeze([
  { symbol: "SPY", label: "S&P 500", group: "index" },
  { symbol: "QQQ", label: "Nasdaq 100", group: "index" },
  { symbol: "DIA", label: "Dow 30", group: "index" },
  { symbol: "IWM", label: "Russell 2000", group: "index" },
  { symbol: "SMH", label: "Semiconductors", group: "sector" },
  { symbol: "SOXX", label: "Semiconductor index", group: "sector" },
  { symbol: "TLT", label: "Long Treasury", group: "rates", proxy: "20Y+ Treasury total return" },
  { symbol: "IEF", label: "Intermediate Treasury", group: "rates", proxy: "7–10Y Treasury total return" },
  { symbol: "UUP", label: "US dollar", group: "rates", proxy: "dollar index" },
  { symbol: "USO", label: "Crude oil", group: "commodity", proxy: "WTI" },
  { symbol: "GLD", label: "Gold", group: "commodity" },
  { symbol: "BTC-USD", label: "Bitcoin", group: "crypto", proxy: "BTC/USD reference" },
  { symbol: "SOXL", label: "SOXL", group: "portfolio" },
  { symbol: "AMD", label: "AMD", group: "portfolio" },
  { symbol: "ORCL", label: "Oracle", group: "portfolio" },
  { symbol: "MSTR", label: "Strategy", group: "portfolio" },
  { symbol: "TSLA", label: "Tesla", group: "portfolio" },
  { symbol: "ASTS", label: "AST SpaceMobile", group: "portfolio" },
]);

/** The semiconductor cohort used to characterise a chip move. */
export const SEMICONDUCTOR_COHORT: readonly Instrument[] = Object.freeze([
  { symbol: "NVDA", label: "NVIDIA", group: "semiconductor" },
  { symbol: "AMD", label: "AMD", group: "semiconductor" },
  { symbol: "MU", label: "Micron", group: "semiconductor" },
  { symbol: "AVGO", label: "Broadcom", group: "semiconductor" },
  { symbol: "INTC", label: "Intel", group: "semiconductor" },
  { symbol: "MRVL", label: "Marvell", group: "semiconductor" },
  { symbol: "ARM", label: "Arm", group: "semiconductor" },
  { symbol: "TSM", label: "TSMC", group: "semiconductor" },
  { symbol: "ASML", label: "ASML", group: "semiconductor" },
  { symbol: "SMCI", label: "Supermicro", group: "semiconductor" },
]);

export const PICK_NY_SYMBOLS: readonly string[] = Object.freeze(PICK_NY_TARGETS.map((target) => target.ticker));

/* ------------------------------------------------------------------ */
/* Session metrics                                                     */
/* ------------------------------------------------------------------ */

/**
 * Session checkpoints expressed as the UTC hour at which the price is read.
 * 17:00Z is 13:00 ET, 18:00Z is 14:00 ET, 19:00Z is 15:00 ET and 20:00Z is the
 * 16:00 ET close.
 */
export const CHECKPOINT_UTC_HOUR = { open: 14, earlyAfternoon: 17, lateAfternoon: 18, powerHour: 19, close: 20 } as const;

/**
 * US daylight time runs from the second Sunday in March to the first Sunday in
 * November. Hardcoding −4 would put the winter brief an hour out.
 */
export function etOffsetHours(date: Date): number {
  const year = date.getUTCFullYear();
  const secondSundayMarch = new Date(Date.UTC(year, 2, 1));
  secondSundayMarch.setUTCDate(1 + ((7 - secondSundayMarch.getUTCDay()) % 7) + 7);
  const firstSundayNovember = new Date(Date.UTC(year, 10, 1));
  firstSundayNovember.setUTCDate(1 + ((7 - firstSundayNovember.getUTCDay()) % 7));
  return date >= secondSundayMarch && date < firstSundayNovember ? -4 : -5;
}

export type SessionMetrics = {
  symbol: string;
  label: string;
  group: InstrumentGroup;
  proxy?: string;
  open: number | null;
  close: number | null;
  priorClose: number | null;
  returnPct: number | null;
  openToClosePct: number | null;
  /** close − 14:00 ET, in percentage points. */
  lateMovePct: number | null;
  /** close − 15:00 ET, in percentage points. */
  finalHourMovePct: number | null;
  relativeToSpyPct: number | null;
  relativeToQqqPct: number | null;
};

const pctChange = (from: number | null, to: number | null) =>
  from !== null && to !== null && from > 0 ? (to / from - 1) * 100 : null;

/**
 * The close of the last bar that had already finished by the given UTC hour.
 *
 * Alpaca stamps a bar with the START of its period, so the bar stamped 20:00Z
 * covers 16:00–17:00 ET: it is the first after-hours bar, not the close. The
 * regular-session close is the 19:00Z bar (15:00–16:00 ET), which is also what
 * the adjusted daily series prints. Reading strictly before the checkpoint is
 * what keeps extended-hours prints out of every return.
 */
export function closeAtHour(series: Map<string, number> | undefined, utcHour: number): number | null {
  if (!series) return null;
  let best: { stamp: string; value: number } | null = null;
  for (const [stamp, value] of series) {
    const hour = Number(stamp.slice(11, 13));
    if (!Number.isFinite(hour)) continue;
    // A bar opening at or after the checkpoint has not closed by it yet.
    if (hour >= utcHour) continue;
    if (!best || stamp > best.stamp) best = { stamp, value };
  }
  return best?.value ?? null;
}

export function sessionMetrics(
  instrument: Instrument,
  intraday: Map<string, number> | undefined,
  daily: { close: number | null; priorClose: number | null },
  benchmark: { spy: number | null; qqq: number | null },
): SessionMetrics {
  const close = closeAtHour(intraday, CHECKPOINT_UTC_HOUR.close) ?? daily.close;
  const late = closeAtHour(intraday, CHECKPOINT_UTC_HOUR.lateAfternoon);
  const power = closeAtHour(intraday, CHECKPOINT_UTC_HOUR.powerHour);
  const open = closeAtHour(intraday, CHECKPOINT_UTC_HOUR.open);
  const returnPct = pctChange(daily.priorClose, close);
  return {
    symbol: instrument.symbol,
    label: instrument.label,
    group: instrument.group,
    proxy: instrument.proxy,
    open,
    close,
    priorClose: daily.priorClose,
    returnPct,
    openToClosePct: pctChange(open, close),
    lateMovePct: returnPct !== null && late !== null && close ? ((close / late - 1) * 100) : null,
    finalHourMovePct: returnPct !== null && power !== null && close ? ((close / power - 1) * 100) : null,
    relativeToSpyPct: returnPct !== null && benchmark.spy !== null ? returnPct - benchmark.spy : null,
    relativeToQqqPct: returnPct !== null && benchmark.qqq !== null ? returnPct - benchmark.qqq : null,
  };
}

/* ------------------------------------------------------------------ */
/* Anomaly detection                                                   */
/* ------------------------------------------------------------------ */

export type AnomalyKind = "late-acceleration" | "late-reversal" | "index-divergence" | "sector-dispersion" | "cross-asset-divergence" | "outlier-move";

export type Anomaly = {
  kind: AnomalyKind;
  symbol: string;
  headline: string;
  magnitude: number;
  detail: string;
};

const LATE_MOVE_THRESHOLD_PCT = 0.75;
const OUTLIER_THRESHOLD_PCT = 3;

/**
 * Ranks what was actually unusual about the session. Nothing is asserted about
 * causation here — this stage only establishes that something happened.
 */
export function detectAnomalies(metrics: SessionMetrics[]): Anomaly[] {
  const found: Anomaly[] = [];
  const bySymbol = new Map(metrics.map((entry) => [entry.symbol, entry]));

  for (const entry of metrics) {
    if (entry.lateMovePct !== null && Math.abs(entry.lateMovePct) >= LATE_MOVE_THRESHOLD_PCT) {
      found.push({
        kind: entry.lateMovePct > 0 ? "late-acceleration" : "late-reversal",
        symbol: entry.symbol,
        magnitude: Math.abs(entry.lateMovePct),
        headline: `${entry.label} ${entry.lateMovePct > 0 ? "accelerated into" : "faded into"} the close`,
        detail: `${entry.label} moved ${entry.lateMovePct >= 0 ? "+" : ""}${entry.lateMovePct.toFixed(2)} points after 14:00 ET.`,
      });
    }
    if (entry.returnPct !== null && Math.abs(entry.returnPct) >= OUTLIER_THRESHOLD_PCT) {
      found.push({
        kind: "outlier-move",
        symbol: entry.symbol,
        magnitude: Math.abs(entry.returnPct),
        headline: `${entry.label} moved ${entry.returnPct >= 0 ? "+" : ""}${entry.returnPct.toFixed(1)}%`,
        detail: `${entry.label} closed ${entry.returnPct >= 0 ? "up" : "down"} ${Math.abs(entry.returnPct).toFixed(2)}% on the session.`,
      });
    }
  }

  const spy = bySymbol.get("SPY");
  const qqq = bySymbol.get("QQQ");
  const iwm = bySymbol.get("IWM");
  if (spy?.returnPct !== null && qqq?.returnPct !== null && spy && qqq) {
    const spread = qqq.returnPct! - spy.returnPct!;
    if (Math.abs(spread) >= 0.5) {
      found.push({
        kind: "index-divergence",
        symbol: "QQQ",
        magnitude: Math.abs(spread),
        headline: `Nasdaq ${spread > 0 ? "outperformed" : "lagged"} the S&P 500 by ${Math.abs(spread).toFixed(2)} points`,
        detail: `QQQ ${qqq.returnPct!.toFixed(2)}% versus SPY ${spy.returnPct!.toFixed(2)}%.`,
      });
    }
  }
  if (iwm && spy && iwm.returnPct !== null && spy.returnPct !== null) {
    const spread = iwm.returnPct - spy.returnPct;
    if (Math.abs(spread) >= 1) {
      found.push({
        kind: "index-divergence",
        symbol: "IWM",
        magnitude: Math.abs(spread),
        headline: `Small caps ${spread > 0 ? "led" : "lagged"} by ${Math.abs(spread).toFixed(2)} points`,
        detail: `IWM ${iwm.returnPct.toFixed(2)}% versus SPY ${spy.returnPct.toFixed(2)}%.`,
      });
    }
  }

  const smh = bySymbol.get("SMH");
  if (smh && spy && smh.returnPct !== null && spy.returnPct !== null) {
    const spread = smh.returnPct - spy.returnPct;
    if (Math.abs(spread) >= 1) {
      found.push({
        kind: "sector-dispersion",
        symbol: "SMH",
        magnitude: Math.abs(spread),
        headline: `Semiconductors ${spread > 0 ? "led" : "lagged"} the market by ${Math.abs(spread).toFixed(2)} points`,
        detail: `SMH ${smh.returnPct.toFixed(2)}% versus SPY ${spy.returnPct.toFixed(2)}%.`,
      });
    }
  }

  return found.sort((left, right) => right.magnitude - left.magnitude);
}

/* ------------------------------------------------------------------ */
/* Sector characterisation                                             */
/* ------------------------------------------------------------------ */

export type MoveCharacter =
  | "BROAD SEMICONDUCTOR MOVE"
  | "MEMORY-LED"
  | "AI ACCELERATOR-LED"
  | "NETWORKING-LED"
  | "FOUNDRY-LED"
  | "SINGLE-STOCK DISTORTION"
  | "MIXED / UNCLEAR";

const COHORT_GROUP: Record<string, "memory" | "accelerator" | "networking" | "foundry"> = {
  MU: "memory",
  NVDA: "accelerator",
  AMD: "accelerator",
  AVGO: "networking",
  MRVL: "networking",
  TSM: "foundry",
  ASML: "foundry",
  INTC: "foundry",
  ARM: "accelerator",
  SMCI: "accelerator",
};

/**
 * Names the character of a chip move from the cohort itself: how many moved the
 * same way, and whether one name carried the rest.
 */
export function classifySemiconductorMove(cohort: SessionMetrics[], direction: 1 | -1): MoveCharacter {
  const moved = cohort.filter((entry) => entry.returnPct !== null && Math.sign(entry.returnPct) === direction && Math.abs(entry.returnPct) >= 0.5);
  if (moved.length === 0) return "MIXED / UNCLEAR";
  if (moved.length === 1) return "SINGLE-STOCK DISTORTION";

  const groups = new Map<string, number>();
  for (const entry of moved) {
    const group = COHORT_GROUP[entry.symbol];
    if (group) groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  const broad = moved.length >= Math.ceil(cohort.length * 0.6);
  if (broad) return "BROAD SEMICONDUCTOR MOVE";
  const leader = [...groups.entries()].sort((left, right) => right[1] - left[1])[0];
  if (!leader) return "MIXED / UNCLEAR";
  return leader[0] === "memory" ? "MEMORY-LED" : leader[0] === "accelerator" ? "AI ACCELERATOR-LED" : leader[0] === "networking" ? "NETWORKING-LED" : "FOUNDRY-LED";
}

/* ------------------------------------------------------------------ */
/* Causality                                                           */
/* ------------------------------------------------------------------ */

export type CausalityLabel = "CONFIRMED" | "LIKELY" | "UNCLEAR";

export type CatalystEvidence = {
  /**
   * Minutes between publication and the window the move actually happened in.
   * Never measured against the clock on the wall: a story that landed inside
   * the move's window is timely no matter how long ago the brief ran.
   */
  timingGapMinutes: number | null;
  sourceTier: 1 | 2 | 3 | null;
  /** Share of the cohort that moved the same way, 0–1. */
  sectorConsistency: number | null;
  /** The catalyst names the very instrument that moved. */
  symbolMatch?: boolean;
  /** The catalyst names a peer in the same cohort as the instrument that moved. */
  sectorMatch?: boolean;
  independentSources: number;
  /** Whether the stated mechanism is economically coherent. */
  economicLogic: boolean;
};

export type CausalityScore = { score: number; label: CausalityLabel; components: Record<string, number> };

/**
 * Timing 0–3, source quality 0–3, sector consistency 0–2, relevance 0–3,
 * corroboration 0–2, economic logic 0–2. 13–15 confirmed, 6–12 likely,
 * 0–5 unclear.
 *
 * Relevance is what stops an unrelated but widely covered story from being
 * scored as the cause. The confirmed band sits above the 12 points reachable
 * without any relevance at all, so strong-but-unrelated evidence can never be
 * promoted to confirmed.
 */
export function scoreCausality(evidence: CatalystEvidence): CausalityScore {
  const timing =
    evidence.timingGapMinutes === null ? 0
    : evidence.timingGapMinutes <= 15 ? 3
    : evidence.timingGapMinutes <= 60 ? 2
    : evidence.timingGapMinutes <= 240 ? 1
    : 0;
  const source = evidence.sourceTier === 1 ? 3 : evidence.sourceTier === 2 ? 2 : evidence.sourceTier === 3 ? 1 : 0;
  const sector = evidence.sectorConsistency === null ? 0 : evidence.sectorConsistency >= 0.7 ? 2 : evidence.sectorConsistency >= 0.4 ? 1 : 0;
  const relevance = evidence.symbolMatch ? 3 : evidence.sectorMatch ? 1 : 0;
  const corroboration = Math.min(2, Math.max(0, evidence.independentSources - 1));
  const logic = evidence.economicLogic ? 2 : 0;
  const score = timing + source + sector + relevance + corroboration + logic;
  return {
    score,
    label: score >= 13 ? "CONFIRMED" : score >= 6 ? "LIKELY" : "UNCLEAR",
    components: { timing, source, sector, relevance, corroboration, logic },
  };
}

/**
 * How far a publication sits from the window a move happened in. A story that
 * landed inside the window is a zero-gap story; one outside it is measured to
 * the nearest edge, so a stale headline cannot borrow the move's timing.
 */
export function timingGapMinutes(publishedAt: string, windowStartIso: string, windowEndIso: string): number | null {
  const at = Date.parse(publishedAt);
  const start = Date.parse(windowStartIso);
  const end = Date.parse(windowEndIso);
  if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if (at >= start && at <= end) return 0;
  return (at < start ? start - at : at - end) / 60_000;
}

/**
 * The window a move belongs to, in UTC ISO. A late-session move is explained
 * only by what was published into the 14:00 ET-to-close stretch; an all-day
 * move reaches back to the opening bell.
 */
export function moveWindowIso(anomaly: Anomaly, sessionDate: string): { start: string; end: string } {
  const late = anomaly.kind === "late-acceleration" || anomaly.kind === "late-reversal";
  return {
    // 18:00Z is 14:00 ET; 13:30Z is the 09:30 ET open; 20:00Z is the close.
    start: `${sessionDate}T${late ? "18:00" : "13:30"}:00Z`,
    end: `${sessionDate}T20:00:00Z`,
  };
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

export type NewsItem = {
  id: string;
  headline: string;
  summary?: string;
  url: string;
  source: string;
  sourceTier: 1 | 2 | 3;
  publishedAt: string;
  tickers: string[];
  topics: string[];
};

export type CatalystEvent = {
  id: string;
  headline: string;
  tickers: string[];
  topics: string[];
  sources: Array<{ source: string; url: string; publishedAt: string; tier: 1 | 2 | 3 }>;
  firstPublishedAt: string;
  impact: number;
};

const normaliseTopic = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Entities + topic + a publication window decide whether two stories are the
 * same event. Reuters, Bloomberg and CNBC covering one Nvidia story is one
 * catalyst with three sources, not three catalysts.
 */
export function clusterEvents(items: NewsItem[], windowMinutes = 180): CatalystEvent[] {
  const clusters: Array<NewsItem[]> = [];
  const sorted = [...items].sort((left, right) => Date.parse(left.publishedAt) - Date.parse(right.publishedAt));

  for (const item of sorted) {
    const itemTopics = new Set(item.topics.map(normaliseTopic));
    const target = clusters.find((cluster) => {
      const head = cluster[0];
      const sharesTicker = item.tickers.some((ticker) => head.tickers.includes(ticker));
      const sharesTopic = head.topics.map(normaliseTopic).some((topic) => itemTopics.has(topic));
      const gapMinutes = Math.abs(Date.parse(item.publishedAt) - Date.parse(head.publishedAt)) / 60_000;
      return (sharesTicker || sharesTopic) && gapMinutes <= windowMinutes;
    });
    if (target) target.push(item);
    else clusters.push([item]);
  }

  return clusters.map((cluster) => {
    const best = [...cluster].sort((left, right) => left.sourceTier - right.sourceTier || Date.parse(right.publishedAt) - Date.parse(left.publishedAt))[0];
    return {
      id: best.id,
      headline: best.headline,
      tickers: [...new Set(cluster.flatMap((item) => item.tickers))],
      topics: [...new Set(cluster.flatMap((item) => item.topics))],
      sources: cluster.map((item) => ({ source: item.source, url: item.url, publishedAt: item.publishedAt, tier: item.sourceTier })),
      firstPublishedAt: cluster.reduce((earliest, item) => (item.publishedAt < earliest ? item.publishedAt : earliest), cluster[0].publishedAt),
      impact: 0,
    };
  });
}

export type EventScoreInput = {
  /** Absolute index move the event plausibly explains, 0–5. */
  marketImpact: number;
  /** Relevance to Pick-NY holdings or published coverage, 0–5. */
  portfolioRelevance: number;
  /** Relevance to names Signal Ledger publishes on, 0–5. */
  coverageRelevance: number;
  /** Hours since publication, mapped onto 0–5. */
  ageHours: number;
  sourceTier: 1 | 2 | 3;
  /** How different this is from what the book already reflected, 0–5. */
  novelty: number;
};

export function scoreEvent(input: EventScoreInput): number {
  const clamp = (value: number, max = 5) => Math.max(0, Math.min(max, value));
  const freshness = input.ageHours <= 6 ? 5 : input.ageHours <= 18 ? 4 : input.ageHours <= 36 ? 2 : 0;
  const sourceQuality = input.sourceTier === 1 ? 5 : input.sourceTier === 2 ? 4 : 2;
  const total =
    clamp(input.marketImpact) + clamp(input.portfolioRelevance) + clamp(input.coverageRelevance) +
    freshness + sourceQuality + clamp(input.novelty);
  return Math.round((total / 30) * 100);
}

export type CatalystAttribution = {
  event: CatalystEvent;
  causality: CausalityScore;
  gapMinutes: number | null;
  symbolMatch: boolean;
  sectorMatch: boolean;
};

/**
 * Whether a cluster is about a symbol rather than merely listing it.
 *
 * A roundup tags a dozen tickers and names none of them in the headline; being
 * included in that list is not a relationship. A cluster counts as direct only
 * when it is focused on the name (one or two tickers) or when the headline
 * actually spells the symbol out.
 */
function namesDirectly(event: CatalystEvent, symbol: string) {
  if (!event.tickers.includes(symbol)) return false;
  if (event.tickers.length <= 2) return true;
  return new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(event.headline);
}

/**
 * Picks the one cluster that can actually explain a move, or nothing at all.
 *
 * A story qualifies only when it names the instrument that moved, or a peer in
 * the same cohort, and is directly about it. Merely being attached to some
 * other holding is not enough: an AI story tagged to one portfolio name is not
 * a cause for a crypto-linked name that happened to move, so it is rejected
 * rather than force-fitted. When nothing qualifies the caller reports that no
 * verifiable single catalyst was found.
 */
export function attributeCatalyst(input: {
  anomaly: Anomaly;
  events: CatalystEvent[];
  metrics: SessionMetrics[];
  sessionDate: string;
}): CatalystAttribution | null {
  const peers = new Set<string>([input.anomaly.symbol]);
  const group = input.metrics.find((entry) => entry.symbol === input.anomaly.symbol)?.group;

  // Only a real sector counts as a peer group. "portfolio" is the holdings
  // list, not a sector: sharing a model portfolio is not a reason to accept a
  // story as the cause of a move, which is exactly how an Nvidia headline was
  // once blamed for a Strategy move because Oracle happened to be tagged too.
  if (group && group !== "portfolio") {
    for (const entry of input.metrics) if (entry.group === group) peers.add(entry.symbol);
  }
  // A chip name is a chip name whatever group it was filed under, and the
  // semiconductor ETFs stand in for the cohort.
  const chips = SEMICONDUCTOR_COHORT.map((entry) => entry.symbol);
  if (group === "semiconductor" || chips.includes(input.anomaly.symbol) || input.anomaly.symbol === "SMH" || input.anomaly.symbol === "SOXX") {
    for (const symbol of chips) peers.add(symbol);
  }

  const direction = Math.sign(input.anomaly.magnitude);
  const sectorConsistency =
    input.metrics.filter((entry) => Math.sign(entry.returnPct ?? 0) === direction).length / Math.max(1, input.metrics.length);
  const window = moveWindowIso(input.anomaly, input.sessionDate);

  const scored = input.events.flatMap((event) => {
    const symbolMatch = namesDirectly(event, input.anomaly.symbol);
    // A sector read is about a *peer*, so the moved instrument is excluded:
    // otherwise a cluster that merely lists it would qualify as peer evidence
    // for itself. The cluster also has to be about a handful of names, not a
    // market-wide digest that happens to mention one.
    const sectorMatch = !symbolMatch && event.tickers.length <= 3 &&
      event.tickers.some((ticker) => ticker !== input.anomaly.symbol && peers.has(ticker));
    if (!symbolMatch && !sectorMatch) return [];
    const gapMinutes = timingGapMinutes(event.firstPublishedAt, window.start, window.end);
    return [{
      event,
      gapMinutes,
      symbolMatch,
      sectorMatch,
      causality: scoreCausality({
        timingGapMinutes: gapMinutes,
        sourceTier: Math.min(...event.sources.map((source) => source.tier)) as 1 | 2 | 3,
        sectorConsistency,
        symbolMatch,
        sectorMatch,
        independentSources: event.sources.length,
        economicLogic: true,
      }),
    }];
  });

  return scored.sort((left, right) =>
    Number(right.symbolMatch) - Number(left.symbolMatch) ||
    right.causality.score - left.causality.score ||
    right.event.impact - left.event.impact,
  )[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Portfolio attribution                                               */
/* ------------------------------------------------------------------ */

export type HoldingDay = { ticker: string; returnPct: number | null; weight: number; contributionPoints: number };

export type PortfolioDay = {
  returnPct: number | null;
  benchmarkReturnPct: number | null;
  excessPct: number | null;
  holdings: HoldingDay[];
  material: HoldingDay[];
};

/**
 * Reuses the Pick-NY engine so the brief and the published track record can
 * never disagree. Shares are fixed, so a day's contribution is the holding's
 * own return applied to its opening weight.
 */
export function portfolioDay(
  previousCloses: Map<string, number>,
  todayCloses: Map<string, number>,
  benchmark: { previousClose: number | null; close: number | null },
): PortfolioDay {
  const holdings = PICK_NY_TARGETS.map((target) => {
    const before = previousCloses.get(target.ticker) ?? null;
    const after = todayCloses.get(target.ticker) ?? null;
    const returnPct = pctChange(before, after);
    return { ticker: target.ticker, returnPct, weight: 0, contributionPoints: 0 };
  });

  const values = holdings.map((holding) => {
    const before = previousCloses.get(holding.ticker);
    const after = todayCloses.get(holding.ticker);
    return before !== undefined && after !== undefined && before > 0 ? (targetWeight(holding.ticker) * after) / before : null;
  });

  const usable = values.filter((value): value is number => value !== null);
  const total = usable.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return { returnPct: null, benchmarkReturnPct: pctChange(benchmark.previousClose, benchmark.close), excessPct: null, holdings, material: [] };
  }

  const weighted = holdings.map((holding, index) => {
    const value = values[index];
    const weight = value === null ? 0 : value / total;
    return {
      ...holding,
      weight,
      contributionPoints: holding.returnPct === null ? 0 : weight * holding.returnPct,
    };
  });
  const returnPct = weighted.reduce((sum, holding) => sum + holding.contributionPoints, 0);
  const benchmarkReturnPct = pctChange(benchmark.previousClose, benchmark.close);
  return {
    returnPct,
    benchmarkReturnPct,
    excessPct: returnPct !== null && benchmarkReturnPct !== null ? returnPct - benchmarkReturnPct : null,
    holdings: weighted,
    // Only holdings that actually moved the portfolio are discussed.
    material: weighted.filter((holding) => Math.abs(holding.contributionPoints) >= 0.1).sort((left, right) => Math.abs(right.contributionPoints) - Math.abs(left.contributionPoints)).slice(0, 4),
  };
}

function targetWeight(ticker: string) {
  return PICK_NY_TARGETS.find((target) => target.ticker === ticker)?.weight ?? 0;
}

/* ------------------------------------------------------------------ */
/* Valuation connection                                                */
/* ------------------------------------------------------------------ */

export type ValuationMovement = {
  ticker: string;
  priceChangePct: number | null;
  fairValueBefore: number | null;
  fairValueAfter: number | null;
  fairValueChangePct: number | null;
  /** PRICE MOVED ONLY | VALUATION INPUT CHANGED | NO COMPARABLE PRIOR SNAPSHOT */
  classification: "PRICE MOVED ONLY" | "VALUATION INPUT CHANGED" | "NO COMPARABLE PRIOR SNAPSHOT";
};

/**
 * A price move is not a valuation change. Only a new fair value with a changed
 * input counts as the second, and the distinction is the point of the section.
 *
 * A valuation can only be said to have changed against a real prior snapshot.
 * With no prior, the entry is labelled NO COMPARABLE PRIOR SNAPSHOT: comparing
 * a snapshot against itself would print a flat +0.00% and claim a comparison
 * that never took place.
 */
export function valuationMovements(
  entries: Array<{ ticker: string; priceChangePct: number | null; fairValueBefore: number | null; fairValueAfter: number | null; inputsChanged: boolean }>,
): ValuationMovement[] {
  return entries
    .map((entry) => {
      const comparable = entry.fairValueBefore !== null && entry.fairValueAfter !== null && entry.fairValueBefore > 0;
      const fairValueChangePct = comparable
        ? ((entry.fairValueAfter as number) / (entry.fairValueBefore as number) - 1) * 100
        : null;
      const classification =
        !comparable ? ("NO COMPARABLE PRIOR SNAPSHOT" as const)
        : entry.inputsChanged && Math.abs(fairValueChangePct as number) >= 0.05 ? ("VALUATION INPUT CHANGED" as const)
        : ("PRICE MOVED ONLY" as const);
      return {
        ticker: entry.ticker,
        priceChangePct: entry.priceChangePct,
        fairValueBefore: entry.fairValueBefore,
        fairValueAfter: entry.fairValueAfter,
        fairValueChangePct,
        classification,
      };
    })
    .filter((entry) => Math.abs(entry.priceChangePct ?? 0) >= 1 || entry.classification === "VALUATION INPUT CHANGED");
}

/* ------------------------------------------------------------------ */
/* Valuation history comparison                                        */
/* ------------------------------------------------------------------ */

export type ValuationClassification =
  | "NO COMPARABLE PRIOR SNAPSHOT"
  | "PRICE MOVED ONLY"
  | "VALUATION INPUT CHANGED"
  | "FAIR VALUE CHANGED"
  | "THESIS CHANGED";

export type ValuationComparison = {
  ticker: string;
  priceChangePct: number | null;
  classification: ValuationClassification;
  fairValuePrior: number | null;
  fairValueCurrent: number | null;
  fairValueChangePct: number | null;
  modelInputChanged: boolean;
  thesisChanged: boolean;
  /** The inputs that actually differ, in reading order. */
  inputChanges: string[];
};

/** The stored shape a comparison reads back. */
export type ValuationSnapshotRow = {
  ticker: string;
  sessionDate: string;
  fairValue: number | null;
  modelInputHash: string | null;
  thesisHash: string | null;
  snapshot: Record<string, unknown> | null;
};

/**
 * The canonical snapshot fields that can actually move a valuation, as a
 * stable JSON string.
 *
 * This is the contract behind model_input_hash. Price and time are deliberately
 * absent: a stock going up is not a valuation input changing, and a snapshot
 * re-read later is not a new valuation. Ids, cache state and derived values
 * (fair value itself, upside, buy zones) are excluded for the same reason —
 * they are outputs or bookkeeping, not inputs.
 */
export function valuationInputProjection(snapshot: Record<string, unknown> | null | undefined): string {
  const record = (entry: Record<string, unknown> | null | undefined) => ({
    model: entry?.model ?? null,
    label: entry?.label ?? null,
    value: entry?.value ?? null,
    role: entry?.role ?? null,
    effectiveWeight: entry?.effectiveWeight ?? null,
    applicability: entry?.applicability ?? null,
    confidence: entry?.confidence ?? null,
    priorReliability: entry?.priorReliability ?? null,
    status: entry?.status ?? null,
    reason: entry?.reason ?? null,
  });
  const list = (value: unknown) => (Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []);

  return stableJson({
    engineVersion: snapshot?.engineVersion ?? null,
    issuerProfileVersion: snapshot?.issuerProfileVersion ?? null,
    valuationFamily: snapshot?.valuationFamily ?? null,
    valuationStatus: snapshot?.valuationStatus ?? null,
    modelsIncluded: snapshot?.modelsIncluded ?? null,
    modelsRouted: snapshot?.modelsRouted ?? null,
    modelWeights: snapshot?.modelWeights ?? null,
    keyAssumptions: list(snapshot?.keyAssumptions).map(String).sort(),
    selectedModels: list(snapshot?.selectedModels).map(record).sort(byJson),
    rejectedModels: list(snapshot?.rejectedModels).map(record).sort(byJson),
    modelsUsed: list(snapshot?.modelsUsed).map(record).sort(byJson),
    keyDrivers: list(snapshot?.keyDrivers)
      .map((entry) => ({ driver: entry?.driver ?? null, assumption: entry?.assumption ?? null, source: entry?.source ?? null }))
      .sort(byJson),
    // Evidence values feed the models. `retrievedAt` is a timestamp and is the
    // one field that changes on every read, so it never reaches the hash.
    evidence: list(snapshot?.evidence)
      .map((entry) => ({
        metric: entry?.metric ?? null,
        value: entry?.value ?? null,
        unit: entry?.unit ?? null,
        asOfDate: entry?.asOfDate ?? null,
        sourceType: entry?.sourceType ?? null,
        sourceId: entry?.sourceId ?? null,
        confidence: entry?.confidence ?? null,
      }))
      .sort(byJson),
  });
}

/**
 * The same question for the written thesis. The canonical payload carries no
 * independent thesis document, so this is null and THESIS CHANGED stays
 * unreachable until one exists. Nullable was the agreed shape.
 */
export function valuationThesisProjection(_snapshot: Record<string, unknown> | null | undefined): string | null {
  return null;
}

const byJson = (left: unknown, right: unknown) => (stableJson(left) < stableJson(right) ? -1 : 1);

/** JSON with every object key sorted, so equal inputs always print equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** How much a fair value has to move before the change is worth reporting. */
export const FAIR_VALUE_CHANGE_EPSILON_PCT = 0.05;

/**
 * Compares a session's canonical snapshot against the most recent prior
 * session's, per instrument.
 *
 * A valuation can only have changed against a real prior. With none, the entry
 * is NO COMPARABLE PRIOR SNAPSHOT — never a comparison of a snapshot with
 * itself, and never a flat +0.00%. A price move alone never becomes a valuation
 * change: that requires the inputs (or the fair value) to differ.
 */
export function compareValuationSnapshots(
  entries: Array<{ ticker: string; priceChangePct: number | null; prior: ValuationSnapshotRow | null; current: ValuationSnapshotRow }>,
): ValuationComparison[] {
  return entries.map((entry) => {
    const { prior, current } = entry;
    const fairValuePrior = prior?.fairValue ?? null;
    const fairValueCurrent = current.fairValue ?? null;
    const comparable = prior !== null && fairValuePrior !== null && fairValuePrior > 0;

    if (!comparable) {
      return {
        ticker: entry.ticker,
        priceChangePct: entry.priceChangePct,
        classification: "NO COMPARABLE PRIOR SNAPSHOT" as const,
        fairValuePrior: null,
        fairValueCurrent,
        fairValueChangePct: null,
        modelInputChanged: false,
        thesisChanged: false,
        inputChanges: [],
      };
    }

    const fairValueChangePct = fairValueCurrent !== null
      ? (fairValueCurrent / (fairValuePrior as number) - 1) * 100
      : null;
    const fairValueChanged = fairValueChangePct !== null && Math.abs(fairValueChangePct) >= FAIR_VALUE_CHANGE_EPSILON_PCT;
    const modelInputChanged =
      prior?.modelInputHash != null && current.modelInputHash != null && prior.modelInputHash !== current.modelInputHash;
    const thesisChanged =
      prior?.thesisHash != null && current.thesisHash != null && prior.thesisHash !== current.thesisHash;

    const classification: ValuationClassification =
      thesisChanged ? "THESIS CHANGED"
      : modelInputChanged ? "VALUATION INPUT CHANGED"
      : fairValueChanged ? "FAIR VALUE CHANGED"
      : "PRICE MOVED ONLY";

    return {
      ticker: entry.ticker,
      priceChangePct: entry.priceChangePct,
      classification,
      fairValuePrior: fairValuePrior as number,
      fairValueCurrent,
      fairValueChangePct,
      modelInputChanged,
      thesisChanged,
      inputChanges: modelInputChanged
        ? describeValuationInputChanges(prior?.snapshot ?? null, current.snapshot ?? null)
        : [],
    };
  });
}

/** The differing inputs, named, so a change can be explained without re-running. */
export function describeValuationInputChanges(
  prior: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
  limit = 6,
): string[] {
  const changes: string[] = [];
  const walk = (left: unknown, right: unknown, path: string): void => {
    if (changes.length >= limit) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) walk(left[index], right[index], `${path}[${index}]`);
      return;
    }
    const bothObjects =
      left !== null && right !== null && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right);
    if (bothObjects) {
      const keys = new Set([...Object.keys(left as object), ...Object.keys(right as object)]);
      for (const key of [...keys].sort()) walk((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
      return;
    }
    if (JSON.stringify(left ?? null) !== JSON.stringify(right ?? null)) {
      changes.push(`${path}: ${renderInput(left)} → ${renderInput(right)}`);
    }
  };
  walk(JSON.parse(valuationInputProjection(prior)), JSON.parse(valuationInputProjection(current)), "");
  return changes;
}

const renderInput = (value: unknown) =>
  value === null || value === undefined ? "none" : typeof value === "number" ? String(Number(value.toFixed(4))) : String(value);



/* ------------------------------------------------------------------ */
/* Regime                                                              */
/* ------------------------------------------------------------------ */

export type Regime = "RISK-ON" | "RISK-OFF" | "GROWTH-LED" | "DEFENSIVE" | "RATE-DRIVEN" | "AI / SEMI-LED" | "ENERGY-LED" | "CRYPTO-LED" | "MIXED";

/** Descriptive only, read off the cross-asset evidence for the session. */
export function describeRegime(metrics: SessionMetrics[]): { regime: Regime; rationale: string } {
  const by = new Map(metrics.map((entry) => [entry.symbol, entry]));
  const spy = by.get("SPY")?.returnPct ?? null;
  const qqq = by.get("QQQ")?.returnPct ?? null;
  const iwm = by.get("IWM")?.returnPct ?? null;
  const smh = by.get("SMH")?.returnPct ?? null;
  const tlt = by.get("TLT")?.returnPct ?? null;
  const uso = by.get("USO")?.returnPct ?? null;
  const btc = by.get("BTC-USD")?.returnPct ?? null;

  if (smh !== null && spy !== null && smh - spy >= 1.5) {
    return { regime: "AI / SEMI-LED", rationale: `Semiconductors led by ${(smh - spy).toFixed(2)} points over the S&P 500.` };
  }
  if (tlt !== null && spy !== null && tlt <= -1 && spy < 0) {
    return { regime: "RATE-DRIVEN", rationale: `Long Treasuries fell ${tlt.toFixed(2)}% alongside equities, pointing to a rate move rather than an equity-specific one.` };
  }
  if (uso !== null && spy !== null && uso - spy >= 2) {
    return { regime: "ENERGY-LED", rationale: `Crude outperformed by ${(uso - spy).toFixed(2)} points.` };
  }
  if (btc !== null && spy !== null && btc - spy >= 3) {
    return { regime: "CRYPTO-LED", rationale: `Bitcoin outperformed by ${(btc - spy).toFixed(2)} points.` };
  }
  if (spy !== null && qqq !== null && iwm !== null && spy > 0.2 && qqq > spy && iwm < 0) {
    return { regime: "DEFENSIVE", rationale: "Large-cap growth rose while small caps fell, a narrow advance." };
  }
  if (spy !== null && spy >= 0.5 && iwm !== null && iwm >= 0) {
    return { regime: "RISK-ON", rationale: "Broad advance with small caps participating." };
  }
  if (spy !== null && spy <= -0.5 && iwm !== null && iwm <= 0) {
    return { regime: "RISK-OFF", rationale: "Broad decline with small caps participating." };
  }
  if (qqq !== null && spy !== null && qqq - spy >= 0.5) {
    return { regime: "GROWTH-LED", rationale: `Growth outperformed by ${(qqq - spy).toFixed(2)} points.` };
  }
  return { regime: "MIXED", rationale: "No single factor dominated the session." };
}

/* ------------------------------------------------------------------ */
/* Rolling context                                                     */
/* ------------------------------------------------------------------ */

export type PriorBrief = { sessionDate: string; regime: string; theme: string; expectedCatalyst?: string };

/**
 * One, five and twenty-session context, so a move is read as part of a run
 * rather than in isolation.
 */
export function rollingContext(history: Array<{ sessionDate: string; close: number; benchmarkClose: number }>): Map<string, string> {
  const notes = new Map<string, string>();
  const last = history.at(-1);
  if (!last || history.length < 2) return notes;

  for (const [window, label] of [[2, "1d"], [5, "5d"], [20, "20d"]] as const) {
    const from = history[Math.max(0, history.length - window)];
    if (!from || from === last) continue;
    const asset = from.close > 0 ? (last.close / from.close - 1) * 100 : null;
    const bench = from.benchmarkClose > 0 ? (last.benchmarkClose / from.benchmarkClose - 1) * 100 : null;
    if (asset === null) continue;
    notes.set(label, `${label} ${asset >= 0 ? "+" : ""}${asset.toFixed(2)}%${bench === null ? "" : ` versus S&P 500 ${bench >= 0 ? "+" : ""}${bench.toFixed(2)}%`}`);
  }
  return notes;
}

/** Whether the same theme has now run for consecutive sessions. */
export function themeStreak(todayTheme: string, prior: PriorBrief[]): number {
  let streak = 1;
  for (const entry of [...prior].reverse()) {
    if (entry.theme !== todayTheme) break;
    streak += 1;
  }
  return streak;
}

/* ------------------------------------------------------------------ */
/* Quality gate                                                        */
/* ------------------------------------------------------------------ */

export type BriefDraft = {
  sessionDate: string;
  subject: string;
  regime: string;
  summaryBullets: string[];
  mainMove?: { headline: string; analysis: string; causality: CausalityLabel } | null;
  drivers: Array<{ event: string; evidence: string; assets: string; causality: CausalityLabel }>;
  movers: Array<{ symbol: string; returnPct: number | null; note: string }>;
  portfolio?: PortfolioDay | null;
  valuationMovements: ValuationComparison[];
  afterHours: string[];
  upcoming: Array<{ when: string; what: string; matters: string }>;
  text: string;
  html: string;
};

export type QualityGateResult = { pass: boolean; failures: string[] };

const FILLER = ["财报将检验当前预期", "投资者需要密切关注", "该事件可能影响股价", "未来值得关注", "关键事件与财报观察"];

/**
 * Refuses to publish a brief that is calendar filler, has no explanation of the
 * index move, omits the portfolio, or makes an unlabelled causal claim.
 */
export function qualityGate(draft: BriefDraft): QualityGateResult {
  const failures: string[] = [];
  const body = `${draft.subject}\n${draft.summaryBullets.join("\n")}\n${draft.text}`;

  for (const phrase of FILLER) if (body.includes(phrase)) failures.push(`filler phrase: ${phrase}`);
  if (!draft.summaryBullets.length) failures.push("no session summary");
  if (!draft.mainMove && draft.drivers.length === 0) failures.push("no explanation of the index move");
  if (!draft.portfolio) failures.push("Pick-NY is absent");
  if (draft.drivers.length > 3) failures.push("more than three drivers");
  if (draft.upcoming.length > 5) failures.push("more than five upcoming catalysts");
  for (const driver of draft.drivers) {
    if (!/CONFIRMED|LIKELY|UNCLEAR/.test(driver.causality)) failures.push(`driver without a confidence label: ${driver.event}`);
  }
  if (draft.mainMove && !/CONFIRMED|LIKELY|UNCLEAR/.test(draft.mainMove.causality)) failures.push("main move without a confidence label");

  // A brief that is mostly calendar is not a session brief.
  const calendarChars = draft.upcoming.reduce((sum, entry) => sum + entry.when.length + entry.what.length + entry.matters.length, 0);
  if (body.length > 0 && calendarChars / Math.max(1, body.length) > 0.4) failures.push("calendar dominates the body");

  return { pass: failures.length === 0, failures };
}

/* ------------------------------------------------------------------ */
/* Schedule + idempotency                                              */
/* ------------------------------------------------------------------ */

/** US market holidays, computed rather than listed, so the calendar cannot go stale. */
export function usMarketHolidays(year: number): string[] {
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const observed = (month: number, day: number) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
    else if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
    return iso(date);
  };
  const nth = (month: number, weekday: number, n: number) => {
    const date = new Date(Date.UTC(year, month - 1, 1));
    const offset = (weekday - date.getUTCDay() + 7) % 7;
    return iso(new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7)));
  };
  const last = (month: number, weekday: number) => {
    const date = new Date(Date.UTC(year, month, 0));
    const offset = (date.getUTCDay() - weekday + 7) % 7;
    return iso(new Date(Date.UTC(year, month - 1, date.getUTCDate() - offset)));
  };
  // Anonymous Gregorian computus.
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  const goodFriday = new Date(Date.UTC(year, month - 1, day - 2));

  return [
    observed(1, 1),
    nth(1, 1, 3),
    nth(2, 1, 3),
    iso(goodFriday),
    last(5, 1),
    observed(6, 19),
    observed(7, 4),
    nth(9, 1, 1),
    nth(11, 4, 4),
    observed(12, 25),
  ];
}

export function isTradingDay(sessionDate: string): boolean {
  const date = new Date(`${sessionDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return false;
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !usMarketHolidays(date.getUTCFullYear()).includes(sessionDate);
}

/** A brief is identified by its session, so a retry can never send twice. */
export function briefSendId(sessionDate: string) {
  return `postclose:${sessionDate}`;
}

/** 17:15 ET is 21:15 UTC during daylight time and 22:15 UTC in winter. */
export function isSendWindow(nowUtc: Date, sessionDate: string): boolean {
  if (!isTradingDay(sessionDate)) return false;
  const et = new Date(nowUtc.getTime() + etOffsetHours(nowUtc) * 60 * 60 * 1000);
  if (et.toISOString().slice(0, 10) !== sessionDate) return false;
  const hour = et.getUTCHours();
  const minute = et.getUTCMinutes();
  return hour === 17 && minute >= 15;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const signed = (value: number | null, digits = 2) =>
  value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;

/** The subject states the session's theme rather than a generic label. */
export function briefSubject(sessionDate: string, theme: string) {
  return `【Signal Ledger 收盘简报】${sessionDate} | ${theme}`;
}

/** Once, for the whole section, when at least one instrument has no prior. */
export const VALUATION_BASELINE_NOTE = "首次建立估值历史基线，暂无前一交易日可比较数据。";

export type ValuationWatchRow = {
  ticker: string;
  priceMove: string;
  fairValue: string;
  status: string;
};

export type ValuationWatchView = {
  /** Present once when any instrument is still establishing its baseline. */
  baselineNote: string | null;
  rows: ValuationWatchRow[];
  /** Narrative for the instruments whose valuation actually changed. */
  detail: string[];
};

const VALUATION_STATUS_LABEL: Record<ValuationClassification, string> = {
  "NO COMPARABLE PRIOR SNAPSHOT": "Baseline",
  "PRICE MOVED ONLY": "Price moved only",
  "VALUATION INPUT CHANGED": "Valuation input changed",
  "FAIR VALUE CHANGED": "Fair value changed",
  "THESIS CHANGED": "Thesis changed",
};

/**
 * The valuation-watch section: one compact table, plus the narrative that
 * explains anything that is not a plain price move.
 *
 * A price move must never read as a valuation change, and a real change has to
 * be auditable — which inputs moved, and the fair value before and after. The
 * baseline explanation is emitted **once** for the section rather than repeated
 * per instrument, and every number goes through the shared formatter, so a
 * reader never sees full floating-point precision and the website and the email
 * cannot disagree.
 */
export function buildValuationWatch(moves: ValuationComparison[], currency = "USD"): ValuationWatchView {
  const rows: ValuationWatchRow[] = [];
  const detail: string[] = [];
  let baselineNote: string | null = null;

  for (const move of moves) {
    rows.push({
      ticker: move.ticker,
      priceMove: pct(move.priceChangePct),
      fairValue: money(move.fairValueCurrent, currency),
      status: VALUATION_STATUS_LABEL[move.classification],
    });
    if (move.classification === "NO COMPARABLE PRIOR SNAPSHOT") {
      baselineNote = VALUATION_BASELINE_NOTE;
      continue;
    }
    detail.push(...valuationWatchDetail(move, currency));
  }

  return { baselineNote, rows, detail };
}

/** The per-instrument narrative for anything that is not a baseline. */
function valuationWatchDetail(move: ValuationComparison, currency: string): string[] {
  const lines: string[] = [];
  const price = pct(move.priceChangePct);
  const from = money(move.fairValuePrior, currency);
  const to = money(move.fairValueCurrent, currency);

  if (move.classification === "PRICE MOVED ONLY") {
    lines.push(`${move.ticker} PRICE MOVED ONLY — 股价发生变化，但 Signal Ledger 的核心估值输入和公允价值没有改变。价格 ${price}，公允价值维持 ${to}。`);
    return lines;
  }

  if (move.classification === "VALUATION INPUT CHANGED") {
    lines.push(`${move.ticker} VALUATION INPUT CHANGED — 核心估值输入发生变化。价格 ${price}，公允价值 ${from} → ${to}${move.fairValueChangePct === null ? "" : `（${pct(move.fairValueChangePct)}）`}。`);
    if (move.inputChanges.length) for (const change of move.inputChanges.slice(0, 5)) lines.push(`　· ${change}`);
    else lines.push("　· 输入哈希已变化，但未定位到具体字段。");
    return lines;
  }

  if (move.classification === "FAIR VALUE CHANGED") {
    lines.push(`${move.ticker} FAIR VALUE CHANGED — 公允价值发生变化，估值输入哈希未变。价格 ${price}，公允价值 ${from} → ${to}（${pct(move.fairValueChangePct)}）。`);
    if (move.inputChanges.length) for (const change of move.inputChanges.slice(0, 5)) lines.push(`　· ${change}`);
    else lines.push("　· 输入未变，公允价值由 canonical engine 重算产生，未定位到单一驱动。");
    return lines;
  }

  // THESIS CHANGED. Unreachable until the canonical product exposes a
  // first-class thesis object; the branch exists so the day it does, it works.
  lines.push(`${move.ticker} THESIS CHANGED — 投资论点内容发生变化。价格 ${price}，公允价值 ${from} → ${to}。`);
  return lines;
}

/** The valuation-watch section as text lines. */
function valuationWatchText(view: ValuationWatchView): string[] {
  const lines: string[] = [];
  if (view.baselineNote) lines.push(view.baselineNote);
  for (const row of view.rows) lines.push(`· ${row.ticker} | ${row.priceMove} | ${row.fairValue} | ${row.status}`);
  for (const line of view.detail) lines.push(line);
  return lines;
}

/** The same section as an HTML table, so text and HTML cannot disagree. */
function valuationWatchTableHtml(view: ValuationWatchView): string {
  if (!view.rows.length) return "";
  const head = ["Ticker", "Price Move", "Fair Value", "Status"];
  const rows = view.rows
    .map((row) => `<tr><td>${escapeHtml(row.ticker)}</td><td align="right">${escapeHtml(row.priceMove)}</td><td align="right">${escapeHtml(row.fairValue)}</td><td align="right">${escapeHtml(row.status)}</td></tr>`)
    .join("");
  const headings = head
    .map((cell, index) => `<th align="${index === 0 ? "left" : "right"}" style="border-bottom:1px solid #d8dee6;color:#516074;font-weight:600">${cell}</th>`)
    .join("");
  return `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px;margin:8px 0"><thead><tr>${headings}</tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderBrief(draft: BriefDraft): { text: string; html: string } {
  const lines: string[] = [];
  lines.push(draft.subject, "", "一、30 秒看懂今天", ...draft.summaryBullets.map((bullet) => `· ${bullet}`), `市场状态：${draft.regime}`, "");

  if (draft.mainMove) {
    lines.push("二、今天最重要的走势", draft.mainMove.headline, draft.mainMove.analysis, `因果判断：${draft.mainMove.causality}`, "");
  }
  if (draft.drivers.length) {
    lines.push("三、市场为什么这样走");
    for (const driver of draft.drivers) {
      lines.push(`· ${driver.event}\n  证据：${driver.evidence}\n  影响资产：${driver.assets}\n  因果：${driver.causality}`);
    }
    lines.push("");
  }
  if (draft.movers.length) {
    lines.push("五、值得注意的个股");
    for (const mover of draft.movers.slice(0, 5)) lines.push(`· ${mover.symbol} ${signed(mover.returnPct)} — ${mover.note}`);
    lines.push("");
  }
  if (draft.portfolio) {
    const p = draft.portfolio;
    lines.push("六、Pick-NY 今日", `组合 ${signed(p.returnPct)} · S&P 500 ${signed(p.benchmarkReturnPct)} · 超额 ${signed(p.excessPct)}`);
    for (const holding of p.material) {
      lines.push(`· ${holding.ticker} ${signed(holding.returnPct)} · 权重 ${(holding.weight * 100).toFixed(1)}% · 贡献 ${holding.contributionPoints >= 0 ? "+" : ""}${holding.contributionPoints.toFixed(2)} 点`);
    }
    lines.push("");
  }
  lines.push("七、Signal Ledger 估值观察");
  if (!draft.valuationMovements.length) lines.push("今天没有基本面估值输入发生变化。");
  else lines.push(...valuationWatchText(buildValuationWatch(draft.valuationMovements)));
  lines.push("");
  if (draft.afterHours.length) lines.push("八、盘后", ...draft.afterHours.map((line) => `· ${line}`), "");
  if (draft.upcoming.length) {
    lines.push("九、明天与以后");
    for (const entry of draft.upcoming.slice(0, 5)) lines.push(`${entry.when} | ${entry.what} | ${entry.matters}`);
  }
  lines.push("", "自动化研究简报，不构成投资建议。");

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#14243a;max-width:720px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(draft.subject)}</h1>
<h2 style="font-size:16px;margin:20px 0 8px">一、30 秒看懂今天</h2>
<ul style="padding-left:18px;margin:0">${draft.summaryBullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>
<p style="margin:10px 0 0"><strong>市场状态：${escapeHtml(draft.regime)}</strong></p>
${draft.mainMove ? `<h2 style="font-size:16px;margin:20px 0 8px">二、今天最重要的走势</h2><p><strong>${escapeHtml(draft.mainMove.headline)}</strong></p><p>${escapeHtml(draft.mainMove.analysis)}</p><p>因果判断：<strong>${draft.mainMove.causality}</strong></p>` : ""}
${draft.drivers.length ? `<h2 style="font-size:16px;margin:20px 0 8px">三、市场为什么这样走</h2>${draft.drivers.map((driver) => `<p><strong>${escapeHtml(driver.event)}</strong><br>证据：${escapeHtml(driver.evidence)}<br>影响资产：${escapeHtml(driver.assets)}<br>因果：<strong>${driver.causality}</strong></p>`).join("")}` : ""}
${draft.portfolio ? `<h2 style="font-size:16px;margin:20px 0 8px">六、Pick-NY 今日</h2><p>组合 <strong>${signed(draft.portfolio.returnPct)}</strong> · S&P 500 ${signed(draft.portfolio.benchmarkReturnPct)} · 超额 <strong>${signed(draft.portfolio.excessPct)}</strong></p><table cellpadding="6" style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr><th align="left">持仓</th><th align="right">涨跌</th><th align="right">权重</th><th align="right">贡献</th></tr></thead><tbody>${draft.portfolio.material.map((holding) => `<tr><td>${holding.ticker}</td><td align="right">${signed(holding.returnPct)}</td><td align="right">${(holding.weight * 100).toFixed(1)}%</td><td align="right">${holding.contributionPoints >= 0 ? "+" : ""}${holding.contributionPoints.toFixed(2)}</td></tr>`).join("")}</tbody></table>` : ""}
<h2 style="font-size:16px;margin:20px 0 8px">七、Signal Ledger 估值观察</h2>
${draft.valuationMovements.length ? (() => { const watch = buildValuationWatch(draft.valuationMovements); return `${watch.baselineNote ? `<p style="margin:6px 0">${escapeHtml(watch.baselineNote)}</p>` : ""}${valuationWatchTableHtml(watch)}${watch.detail.length ? `<ul style="padding-left:18px">${watch.detail.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : ""}`; })() : "<p>今天没有基本面估值输入发生变化。</p>"}
${draft.upcoming.length ? `<h2 style="font-size:16px;margin:20px 0 8px">九、明天与以后</h2><table cellpadding="6" style="border-collapse:collapse;width:100%;font-size:14px"><tbody>${draft.upcoming.slice(0, 5).map((entry) => `<tr><td>${escapeHtml(entry.when)}</td><td><strong>${escapeHtml(entry.what)}</strong></td><td>${escapeHtml(entry.matters)}</td></tr>`).join("")}</tbody></table>` : ""}
<p style="color:#516074;font-size:13px;margin-top:24px">自动化研究简报，不构成投资建议。</p>
</div>`;

  return { text: lines.join("\n"), html };
}

