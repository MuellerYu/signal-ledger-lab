/**
 * The post-close email: the ten-section layout, and the mapping from the
 * pipeline's model onto it.
 *
 * This lives in lib rather than beside the preview because it is the shipped
 * email. The preview and the send path both import it, so there is exactly one
 * renderer and one mapping, and a section cannot describe a session differently
 * depending on who asked for it.
 *
 * Rule for every section: if there is nothing real to say, say that briefly.
 * No section is padded with generic copy.
 */

import { buildValuationWatch, qualityGate, type BriefDraft, type PortfolioDay, type ValuationComparison } from "./daily-brief";

export const POST_CLOSE_SECTIONS = [
  "TODAY IN 30 SECONDS",
  "THE MOVE THAT MATTERED",
  "WHY THE MARKET MOVED",
  "LEADERS & LAGGARDS",
  "STOCKS THAT MATTERED",
  "SIGNAL LEDGER PORTFOLIO",
  "SIGNAL LEDGER VALUATION WATCH",
  "AFTER THE BELL",
  "TOMORROW",
  "UPCOMING EARNINGS",
  "OPTIONS / POSITIONING",
  "WHAT CHANGED IN OUR VIEW",
  "BOTTOM LINE",
] as const;

/** A section emitted only when the session genuinely had nothing to report there. */
export const DATA_NOTE_TITLE = "DATA NOTE";

type Table = { head: string[]; rows: string[][] };
type Section = { title: string; body: string[]; table?: Table | null };
type Ranked = { symbol: string; label: string; returnPct: number | null };

/** Everything the ten sections read. */
export type PostCloseEmailBrief = {
  sessionDate: string;
  subject: string;
  summaryBullets: string[];
  mainMove: { headline: string; detail: string; causality: string; catalyst: string | null } | null;
  causalityNote: string | null;
  drivers: Array<{ event: string; evidence: string; assets: string; causality: string; gapMinutes: number | null }>;
  leaders: Ranked[];
  laggards: Ranked[];
  breadth: { up: number; total: number; pct: number } | null;
  sectorLeadership: Array<{ group: string; avgReturnPct: number; count: number }>;
  movers: Array<{ symbol: string; returnPct: number | null; lateMovePct: number | null; finalHourMovePct: number | null }>;
  portfolio: PortfolioDay | null;
  valuationMovements: ValuationComparison[];
  valuationNote: string | null;
  /** Canonical sources that were unavailable this session, named explicitly. */
  dataGaps: string[];
  /** Whether any index/market data was present, so "quiet session" is a fact, not a gap. */
  marketDataAvailable: boolean;
  /** Null when no meaningful options/positioning data exists; the section is then omitted. */
  optionsPositioning: { items: string[]; note: string } | null;
  /** Deterministic view stance derived from excess return + valuation changes. */
  viewChange: { stance: "No change" | "More constructive" | "More cautious"; reason: string } | null;
  /** Concise research conclusion, or null when there is nothing to conclude from. */
  bottomLine: string | null;
  afterHours: { available: boolean; items: Array<{ symbol: string; pct: number; last: number | null }>; note: string };
  tomorrow: { items: string[]; note: string };
  upcomingEarnings: {
    available: boolean;
    items: Array<{ ticker: string; fiscalPeriod: string; window: string; confidence: string | null }>;
    note: string;
  };
};

const esc = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const pct = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || Number.isNaN(value)
    ? "—"
    : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;

const pts = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || Number.isNaN(value)
    ? "—"
    : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;

/**
 * Maps the pipeline's model onto the ten sections. This is the only place the
 * email's wording is assembled from raw pipeline output.
 */
export function toPostCloseEmailBrief(model: Record<string, unknown>): PostCloseEmailBrief {
  const read = <T>(key: string, fallback: T): T => (model[key] as T) ?? fallback;
  const mainMove = read<PostCloseEmailBrief["mainMove"]>("mainMove", null);
  const regime = read<string>("regime", "MIXED");
  const sessionDate = read<string>("sessionDate", "");
  const portfolio = read<PortfolioDay | null>("portfolio", null);
  const indexReturns = read<Record<string, number | null>>("indexReturns", {});
  const anomalies = read<Array<{ detail: string }>>("anomalies", []);
  const valuationMovements = read<ValuationComparison[]>("valuationMovements", []);
  const causality = read<{ label: string; components: Record<string, number>; gapMinutes: number | null } | null>("causality", null);
  const catalyst = read<{
    headline: string; sources: number; firstPublishedAt: string; tickers: string[];
    symbolMatch: boolean;
  } | null>("catalyst", null);

  const theme = mainMove?.headline ?? `${regime} 主导，指数窄幅波动`;

  // Section 1 is built only from what exists. A missing portfolio or index read
  // is omitted, never printed as "Pick-NY — vs SPY —".
  const indexLine = Object.entries(indexReturns)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([symbol, value]) => `${symbol} ${pct(value)}`)
    .join(" · ");
  const portfolioLine = portfolio
    ? `Pick-NY ${pct(portfolio.returnPct)} vs SPY ${pct(portfolio.benchmarkReturnPct)} · excess ${pct(portfolio.excessPct)}`
    : null;
  const summaryBullets = [
    indexLine || null,
    portfolioLine,
    ...anomalies.slice(0, 3).map((anomaly) => anomaly.detail),
  ].filter((line): line is string => Boolean(line));

  // Which canonical sources were missing this session, named so a degraded
  // section reads as a fact about the feed, not an unexplained blank.
  const dataGaps: string[] = [];
  if (!indexLine) dataGaps.push("index/market data (Alpaca bars)");
  if (!portfolio) dataGaps.push("Pick-NY portfolio (missing prior close for at least one holding)");
  if (read<number>("newsItemCount", 0) === 0) dataGaps.push("news feed (no events read in the window)");

  // Options/positioning only exists when meaningful data does; otherwise the
  // section is omitted rather than interpreted from nothing.
  const optionsRaw = read<{ items?: string[]; note?: string } | null>("optionsPositioning", null);
  const optionsPositioning =
    optionsRaw && optionsRaw.items && optionsRaw.items.length
      ? { items: optionsRaw.items, note: optionsRaw.note ?? "Positioning read from the options feed." }
      : null;

  // The view stance is a deterministic read of the session — excess return vs
  // the benchmark, tightened only by a valuation input change — never a forecast.
  const viewChange = (() => {
    const excess = portfolio?.excessPct ?? null;
    if (excess === null) return null;
    const valuationChanged = valuationMovements.some(
      (m) => m.classification === "VALUATION INPUT CHANGED" || m.classification === "FAIR VALUE CHANGED" || m.classification === "THESIS CHANGED",
    );
    if (excess > 0.25) {
      return {
        stance: "More constructive" as const,
        reason: `Pick-NY beat the S&P 500 by ${excess.toFixed(2)} points this session${valuationChanged ? ", and at least one valuation input moved" : ""}.`,
      };
    }
    if (excess < -0.25) {
      return {
        stance: "More cautious" as const,
        reason: `Pick-NY lagged the S&P 500 by ${Math.abs(excess).toFixed(2)} points this session.`,
      };
    }
    return {
      stance: "No change" as const,
      reason: `Pick-NY tracked the S&P 500 within ±0.25 points this session (excess ${excess.toFixed(2)} points).`,
    };
  })();

  // A concise conclusion, only when there is something to conclude from.
  const bottomLine = (() => {
    if (!portfolio && !mainMove && !valuationMovements.length) return null;
    const parts: string[] = [];
    if (portfolio) {
      parts.push(`Pick-NY closed ${pct(portfolio.returnPct)} against SPY ${pct(portfolio.benchmarkReturnPct)} (excess ${pct(portfolio.excessPct)}).`);
    }
    if (mainMove) {
      parts.push(`The move that mattered was ${mainMove.headline}.`);
    } else if (indexLine) {
      parts.push("No single instrument cleared the anomaly thresholds — an unconcentrated session.");
    }
    if (viewChange) parts.push(`Our view: ${viewChange.stance.toLowerCase()}.`);
    return parts.join(" ");
  })();

  const afterHoursRaw = read<{ available?: boolean; items?: Array<{ symbol: string; pct: number; last: number | null }> }>("afterHours", {});
  const afterHoursItems = afterHoursRaw.items ?? [];
  const nextSession = read<string | null>("nextSession", null);

  return {
    sessionDate,
    subject: `【Signal Ledger 收盘简报】${sessionDate} | ${theme}`,
    summaryBullets,
    mainMove: mainMove
      ? { ...mainMove, causality: causality?.label ?? "UNCLEAR", catalyst: catalyst?.headline ?? null }
      : null,
    causalityNote: causality
      ? `Timing ${causality.components.timing}/3 · source ${causality.components.source}/3 · sector ${causality.components.sector}/2 · relevance ${causality.components.relevance ?? 0}/3 · corroboration ${causality.components.corroboration}/2 · logic ${causality.components.logic}/2. Timing is measured from publication to the move window.`
      : null,
    drivers: catalyst
      ? [{
        event: catalyst.headline,
        evidence: `${catalyst.sources} independent source(s); first published ${catalyst.firstPublishedAt}; tagged ${catalyst.tickers.join(", ")}. ${catalyst.symbolMatch ? "Names the instrument that moved." : "Names a cohort peer, not the instrument itself."}`,
        assets: mainMove?.headline ?? "SPY, QQQ",
        causality: causality?.label ?? "UNCLEAR",
        gapMinutes: causality?.gapMinutes ?? null,
      }]
      : [],
    leaders: read<Ranked[]>("leaders", []),
    laggards: read<Ranked[]>("laggards", []),
    breadth: read<PostCloseEmailBrief["breadth"]>("breadth", null),
    sectorLeadership: read<PostCloseEmailBrief["sectorLeadership"]>("sectorLeadership", []),
    movers: read<PostCloseEmailBrief["movers"]>("movers", []),
    portfolio,
    valuationMovements,
    valuationNote: read<string | null>("valuationNote", null),
    dataGaps,
    marketDataAvailable: Boolean(indexLine),
    optionsPositioning,
    viewChange,
    bottomLine,
    afterHours: {
      available: afterHoursRaw.available === true,
      items: afterHoursItems,
      note: afterHoursRaw.available !== true
        ? "No extended-hours bars were returned by the feed, so after-hours moves cannot be measured."
        : afterHoursItems.length
          ? "Measured from the 16:00 ET regular close to the latest extended-hours bar."
          : "No tracked name moved materially after the close.",
    },
    tomorrow: read<PostCloseEmailBrief["tomorrow"]>("tomorrow", {
      items: [],
      note: nextSession
        ? `Next session ${nextSession}. No scheduled catalyst was verifiable for it from the sources this run can read, so none is claimed.`
        : "No scheduled catalyst was verifiable for the next session.",
    }),
    upcomingEarnings: (() => {
      const rows = read<Array<{ ticker: string; fiscalPeriod: string; window: string; confidence: string | null }>>("upcomingEarnings", []);
      return {
        available: true,
        items: rows,
        note: "No scheduled earnings windows are open in the calendar.",
      };
    })(),
  };
}

/** The ten sections, in order. */
export function buildPostCloseSections(brief: PostCloseEmailBrief): Section[] {
  const out: Section[] = [];

  if (brief.summaryBullets.length) {
    out.push({ title: POST_CLOSE_SECTIONS[0], body: brief.summaryBullets.slice() });
  }

  // Degraded feeds are named once, up front, so a missing section is a fact
  // about the source rather than an unexplained blank.
  if (brief.dataGaps.length) {
    out.push({ title: DATA_NOTE_TITLE, body: [`Sources unavailable this session: ${brief.dataGaps.join("; ")}.`] });
  }

  const move2: string[] = [];
  if (brief.mainMove) {
    move2.push(`**${brief.mainMove.headline}**`);
    move2.push(brief.mainMove.detail);
    move2.push(`Causality: ${brief.mainMove.causality}`);
    move2.push(brief.mainMove.catalyst ? `Candidate catalyst: ${brief.mainMove.catalyst}` : "未发现可验证的单一催化剂。");
  } else if (brief.marketDataAvailable) {
    // A genuinely quiet session is a fact worth stating. A missing feed is not a
    // quiet session: when market data was unavailable this section is omitted
    // and the DATA NOTE up top carries the explanation instead.
    move2.push("No single move met the anomaly thresholds today (no index divergence, no ≥3% outlier, no ≥0.75pt late move).");
  }
  if (move2.length) out.push({ title: POST_CLOSE_SECTIONS[1], body: move2 });

  const move3: string[] = [];
  if (brief.drivers.length) {
    for (const driver of brief.drivers) {
      move3.push(`**${driver.event}**`);
      move3.push(`Evidence: ${driver.evidence}`);
      move3.push(`Assets: ${driver.assets}`);
      move3.push(`Causality: **${driver.causality}**${driver.gapMinutes === null ? "" : ` (publication ${Math.round(driver.gapMinutes)} min from the move window)`}`);
    }
  } else if (brief.mainMove) {
    move3.push("未发现可验证的单一催化剂。");
    move3.push("The move is established from price evidence only; no headline cleared the attribution bar.");
  } else if (brief.marketDataAvailable) {
    move3.push("No session move required a causal explanation today.");
  }
  if (brief.causalityNote) move3.push(brief.causalityNote);
  if (move3.length) out.push({ title: POST_CLOSE_SECTIONS[2], body: move3 });

  const move4: string[] = [];
  if (brief.leaders.length) {
    move4.push("**Leaders**");
    for (const entry of brief.leaders) move4.push(`${entry.symbol} (${entry.label}) ${pct(entry.returnPct)}`);
  }
  if (brief.laggards.length) {
    move4.push("**Laggards**");
    for (const entry of brief.laggards) move4.push(`${entry.symbol} (${entry.label}) ${pct(entry.returnPct)}`);
  }
  if (!brief.leaders.length && !brief.laggards.length && brief.marketDataAvailable) {
    move4.push("No tracked instrument moved enough to rank.");
  }
  move4.push(brief.breadth
    ? `**Semiconductor breadth** ${brief.breadth.up}/${brief.breadth.total} higher (${brief.breadth.pct.toFixed(0)}%)`
    : "Semiconductor breadth: no cohort data available.");
  if (brief.sectorLeadership.length) {
    move4.push("**Sector leadership**");
    for (const entry of brief.sectorLeadership) move4.push(`${entry.group} ${pct(entry.avgReturnPct)} (${entry.count})`);
  }
  out.push({ title: POST_CLOSE_SECTIONS[3], body: move4 });

  const move5: string[] = [];
  const table5: Table | null = brief.movers.length
    ? {
        head: ["Ticker", "Close", "14:00→close", "15:00→close"],
        rows: brief.movers.map((m) => [m.symbol, pct(m.returnPct), pts(m.lateMovePct), pts(m.finalHourMovePct)]),
      }
    : null;
  if (!brief.movers.length && brief.marketDataAvailable) {
    move5.push("No watchlist name produced a material move today.");
  }
  // Omit entirely when there is neither a mover table nor market data to say
  // "nothing moved" about — a missing feed is not a quiet watchlist.
  if (table5 || move5.length) {
    out.push({ title: POST_CLOSE_SECTIONS[4], body: move5, table: table5 });
  }

  const move6: string[] = [];
  let table6: Table | null = null;
  if (brief.portfolio) {
    const p = brief.portfolio;
    move6.push(`Portfolio ${pct(p.returnPct)} · SPY ${pct(p.benchmarkReturnPct)} · Excess ${pct(p.excessPct)}`);
    if (p.material?.length) {
      table6 = {
        head: ["Holding", "Return", "Weight", "Contribution (pts)"],
        rows: p.material.map((h) => [h.ticker, pct(h.returnPct), `${(h.weight * 100).toFixed(1)}%`, pts(h.contributionPoints)]),
      };
    } else {
      move6.push("No holding contributed materially (all within ±0.10 points).");
    }
  } else {
    move6.push("Pick-NY could not be computed: at least one holding had no prior close.");
  }
  out.push({ title: POST_CLOSE_SECTIONS[5], body: move6, table: table6 });

  const move7: string[] = [];
  let table7: Table | null = null;
  if (!brief.valuationMovements.length) {
    move7.push(brief.valuationNote ?? "No canonical valuation input changed today.");
  } else {
    // One table for every instrument, one baseline explanation for the section,
    // and narrative only where the valuation itself moved.
    const watch = buildValuationWatch(brief.valuationMovements);
    if (watch.baselineNote) move7.push(watch.baselineNote);
    table7 = {
      head: ["Ticker", "Price Move", "Fair Value", "Status"],
      rows: watch.rows.map((row) => [row.ticker, row.priceMove, row.fairValue, row.status]),
    };
    for (const line of watch.detail) move7.push(line);
    if (brief.valuationNote) move7.push(brief.valuationNote);
  }
  out.push({ title: POST_CLOSE_SECTIONS[6], body: move7, table: table7 });

  const move8: string[] = [];
  let table8: Table | null = null;
  if (!brief.afterHours.available || !brief.afterHours.items.length) {
    move8.push(brief.afterHours.note);
  } else {
    table8 = {
      head: ["Ticker", "16:00 ET → now", "Last"],
      rows: brief.afterHours.items.map((a) => [a.symbol, pct(a.pct), a.last === null ? "—" : a.last.toFixed(2)]),
    };
    if (brief.afterHours.note) move8.push(brief.afterHours.note);
  }
  out.push({ title: POST_CLOSE_SECTIONS[7], body: move8, table: table8 });

  const move9 = brief.tomorrow.items.slice();
  if (!move9.length) move9.push(brief.tomorrow.note);
  out.push({ title: POST_CLOSE_SECTIONS[8], body: move9 });

  const move10: string[] = [];
  let table10: Table | null = null;
  if (!brief.upcomingEarnings.available || !brief.upcomingEarnings.items.length) {
    move10.push(brief.upcomingEarnings.note);
  } else {
    table10 = {
      head: ["Ticker", "Period", "Expected window", "Confidence"],
      rows: brief.upcomingEarnings.items.slice(0, 5).map((e) => [e.ticker, e.fiscalPeriod, e.window, e.confidence ?? "—"]),
    };
  }
  out.push({ title: POST_CLOSE_SECTIONS[9], body: move10, table: table10 });

  // OPTIONS / POSITIONING — rendered only when meaningful data exists, so an
  // empty options feed omits the section rather than interpreting nothing.
  if (brief.optionsPositioning) {
    out.push({
      title: POST_CLOSE_SECTIONS[10],
      body: [brief.optionsPositioning.note, ...brief.optionsPositioning.items],
    });
  }

  // WHAT CHANGED IN OUR VIEW — an explicit stance, never silent.
  if (brief.viewChange) {
    out.push({
      title: POST_CLOSE_SECTIONS[11],
      body: [`**${brief.viewChange.stance}**`, brief.viewChange.reason],
    });
  }

  // BOTTOM LINE — the concise research conclusion.
  if (brief.bottomLine) {
    out.push({ title: POST_CLOSE_SECTIONS[12], body: [brief.bottomLine] });
  }

  return out;
}

/** The ten sections as plain text and as HTML. */
export function renderPostCloseEmail(
  brief: PostCloseEmailBrief,
  options: { testMode?: boolean } = {},
): { text: string; html: string; sections: Section[] } {
  const sections = buildPostCloseSections(brief);
  return { text: renderText(brief, sections, options), html: renderHtml(brief, sections, options), sections };
}

/**
 * The same brief as a quality-gate draft, so a send is refused on exactly the
 * evidence a scheduled send would be refused on.
 */
export function postCloseEmailDraft(brief: PostCloseEmailBrief, rendered: { text: string; html: string }): BriefDraft {
  return {
    sessionDate: brief.sessionDate,
    subject: brief.subject,
    regime: brief.mainMove ? `CAUSALITY ${brief.mainMove.causality}` : "NO MAIN MOVE",
    summaryBullets: brief.summaryBullets,
    mainMove: brief.mainMove
      ? {
        headline: brief.mainMove.headline,
        analysis: brief.mainMove.detail,
        causality: /CONFIRMED|LIKELY|UNCLEAR/.test(brief.mainMove.causality) ? (brief.mainMove.causality as "CONFIRMED" | "LIKELY" | "UNCLEAR") : "UNCLEAR",
      }
      : null,
    drivers: brief.drivers.map((driver) => ({
      event: driver.event,
      evidence: driver.evidence,
      assets: driver.assets,
      causality: /CONFIRMED|LIKELY|UNCLEAR/.test(driver.causality) ? (driver.causality as "CONFIRMED" | "LIKELY" | "UNCLEAR") : "UNCLEAR",
    })),
    movers: brief.movers.map((m) => ({ symbol: m.symbol, returnPct: m.returnPct, note: `close ${pct(m.returnPct)}` })),
    portfolio: brief.portfolio,
    valuationMovements: brief.valuationMovements,
    afterHours: brief.afterHours.items.map((a) => `${a.symbol} ${pct(a.pct)}`),
    upcoming: brief.upcomingEarnings.items.slice(0, 5).map((e) => ({ when: e.window, what: `${e.ticker} ${e.fiscalPeriod}`, matters: "earnings window" })),
    text: rendered.text,
    html: rendered.html,
  };
}

/** Runs the shipped quality gate over the ten-section email. */
export function gatePostCloseEmail(brief: PostCloseEmailBrief, rendered: { text: string; html: string }) {
  return qualityGate(postCloseEmailDraft(brief, rendered));
}

function renderText(brief: PostCloseEmailBrief, sections: Section[], options: { testMode?: boolean }): string {
  const lines = [brief.subject, ""];
  sections.forEach((section, index) => {
    lines.push(`${index + 1}. ${section.title}`);
    for (const line of section.body) lines.push(String(line).replace(/\*\*/g, ""));
    if (section.table) {
      lines.push(section.table.head.join(" | "));
      for (const row of section.table.rows) lines.push(row.join(" | "));
    }
    lines.push("");
  });
  lines.push("Automated research brief. Not investment advice.");
  if (options.testMode) lines.push("TEST MODE — nothing was persisted or emailed.");
  return lines.join("\n");
}

function renderHtml(brief: PostCloseEmailBrief, sections: Section[], options: { testMode?: boolean }): string {
  const body = sections
    .map((section, index) => {
      const paras = section.body
        .map((line) => {
          const text = String(line);
          const bold = /^\*\*(.+)\*\*$/.exec(text);
          if (bold) return `<p style="margin:12px 0 4px"><strong>${esc(bold[1])}</strong></p>`;
          return `<p style="margin:4px 0">${esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`;
        })
        .join("");
      const table = section.table
        ? `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px;margin:8px 0">
<thead><tr>${section.table.head
            .map((h, i) => `<th align="${i === 0 ? "left" : "right"}" style="border-bottom:1px solid #d8dee6;color:#516074;font-weight:600">${esc(h)}</th>`)
            .join("")}</tr></thead>
<tbody>${section.table.rows
            .map((row) => `<tr>${row.map((cell, i) => `<td align="${i === 0 ? "left" : "right"}" style="border-bottom:1px solid #eef2f6">${esc(cell)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`
        : "";
      return `<h2 style="font-size:15px;letter-spacing:.04em;text-transform:uppercase;color:#0f5c4a;margin:26px 0 6px;border-top:1px solid #e3e9ef;padding-top:14px">${index + 1}. ${esc(section.title)}</h2>${paras}${table}`;
    })
    .join("");

  const strap = options.testMode
    ? `TEST MODE preview — not persisted, not emailed. Session ${esc(brief.sessionDate)}.`
    : `Session ${esc(brief.sessionDate)}. Post-close intelligence brief.`;

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#14243a;max-width:720px">
<h1 style="font-size:20px;margin:0 0 4px">${esc(brief.subject)}</h1>
<p style="margin:0 0 8px;color:#516074;font-size:13px">${strap}</p>
${body}
<p style="color:#516074;font-size:13px;margin-top:24px;border-top:1px solid #e3e9ef;padding-top:12px">Automated research brief. Not investment advice.</p>
</div>`;
}
