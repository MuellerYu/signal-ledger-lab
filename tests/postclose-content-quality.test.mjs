import assert from "node:assert/strict";
import test from "node:test";

import { applyMigration, createD1 } from "./helpers/sqlite-d1.mjs";
import { loadModule } from "./helpers/transpile.mjs";

/**
 * Canonical post-close Daily Brief CONTENT QUALITY.
 *
 * The billing sandbox has no market schema and no Alpaca credentials, so the
 * fan-out must reuse the ONE canonical brief the real pipeline produced — never
 * rebuild a low-data one. These tests pin that contract at both ends:
 *
 *  - the renderer (toPostCloseEmailBrief + renderPostCloseEmail) must never emit
 *    placeholder numeric fields ("—") or "nothing happened" sections when a feed
 *    is missing, and must name the missing source in a DATA NOTE instead;
 *  - the artifact store/validate layer must round-trip the canonical content
 *    verbatim and refuse a body that still carries placeholder markers.
 *
 * (The fan-out wrapper itself — renderDailyBriefFanout carrying the brief
 * verbatim, and enqueueDailyBriefFanout storing subject/text/html unchanged — is
 * pinned in phase5-daily-brief-fanout.test.mjs, which shares this contract.)
 */

/* ------------------------------------------------------------ module loading */

const pickNyUrl = await loadModule("pick-ny.ts");
const formatUrl = await loadModule("format.ts");
const briefUrl = await loadModule("daily-brief.ts", {
  "./pick-ny": pickNyUrl,
  "./format": formatUrl,
});
const postcloseUrl = await loadModule("postclose-email.ts", { "./daily-brief": briefUrl });
const cryptoUrl = await loadModule("crypto.ts");
const artifactUrl = await loadModule("daily-brief-artifact.ts", { "./crypto": cryptoUrl });

const { toPostCloseEmailBrief, renderPostCloseEmail, buildPostCloseSections, DATA_NOTE_TITLE } = await import(postcloseUrl);
const artifact = await import(artifactUrl);

const PLACEHOLDER_MARKERS = artifact.PLACEHOLDER_MARKERS;

const render = (model) => {
  const brief = toPostCloseEmailBrief(model);
  const rendered = renderPostCloseEmail(brief);
  return { brief, ...rendered };
};

/* ------------------------------------------- a complete, data-rich model */

function completeModel() {
  return {
    sessionDate: "2026-09-18",
    regime: "RISK-ON",
    indexReturns: { SPY: 0.42, QQQ: 0.55, NVDA: 1.2 },
    portfolio: {
      returnPct: 0.63,
      benchmarkReturnPct: 0.42,
      excessPct: 0.21,
      holdings: [],
      material: [],
    },
    anomalies: [{ detail: "NVDA diverged from SPY in the final hour." }],
    newsItemCount: 5,
    mainMove: {
      headline: "NVDA 拉升，半导体板块领涨",
      detail: "NVDA closed +1.20% on above-average volume while SPY was flat.",
      causality: "CONFIRMED",
      catalyst: "NVIDIA raised full-year guidance after the close.",
    },
    causality: {
      label: "CONFIRMED",
      components: { timing: 3, source: 3, sector: 2, relevance: 3, corroboration: 2, logic: 2 },
      gapMinutes: 12,
    },
    catalyst: {
      headline: "NVIDIA raised full-year guidance after the close.",
      sources: 3,
      firstPublishedAt: "2026-09-18T20:05:00Z",
      tickers: ["NVDA"],
      symbolMatch: true,
    },
    leaders: [{ symbol: "NVDA", label: "NVIDIA", returnPct: 1.2 }],
    laggards: [{ symbol: "MU", label: "Micron", returnPct: -0.8 }],
    breadth: { up: 6, total: 10, pct: 60 },
    sectorLeadership: [{ group: "GPUs", avgReturnPct: 0.9, count: 4 }],
    movers: [{ symbol: "NVDA", returnPct: 1.2, lateMovePct: 0.4, finalHourMovePct: 0.6 }],
    valuationMovements: [
      {
        ticker: "NVDA",
        priceChangePct: 1.2,
        classification: "PRICE MOVED ONLY",
        fairValuePrior: 100,
        fairValueCurrent: 100,
        fairValueChangePct: null,
        modelInputChanged: false,
        thesisChanged: false,
        inputChanges: [],
      },
    ],
    valuationNote: null,
    afterHours: { available: true, items: [{ symbol: "NVDA", pct: 0.3, last: 135.2 }], note: "Extended hours available." },
    nextSession: "2026-09-21",
    upcomingEarnings: [{ ticker: "MU", fiscalPeriod: "Q1 FY27", window: "Sep 2026", confidence: "high" }],
    tomorrow: { items: ["Watch the NVDA follow-through."], note: "No scheduled catalyst." },
    optionsPositioning: { items: ["NVDA call skew widened."], note: "Positioning read from the options feed." },
  };
}

/* ------------------------------------------------------------------- tests */

test("1. missing market data never produces placeholder numeric fields", () => {
  const { brief, text, sections } = render({});

  assert.equal(brief.marketDataAvailable, false, "no index data means market data is absent");

  // The five historical placeholders — and any other "—" numeric field — must
  // not appear. A missing feed is named, not rendered as a dash.
  for (const marker of PLACEHOLDER_MARKERS) {
    assert.ok(!text.includes(marker), `must not emit placeholder marker: "${marker}"`);
  }
  assert.ok(!text.includes("vs SPY"), "must not print a '— vs SPY' portfolio line");
  assert.ok(!text.includes("excess —"), "must not print an 'excess —' field");

  // "nothing happened" sections are omitted when the feed that would prove it is
  // missing; the DATA NOTE carries the explanation instead.
  const titles = sections.map((section) => section.title);
  assert.ok(titles.includes(DATA_NOTE_TITLE), "the missing sources are named in a DATA NOTE");
  assert.ok(!titles.includes("THE MOVE THAT MATTERED"), "no main-move section without market data");
  assert.ok(!titles.includes("WHY THE MARKET MOVED"), "no causality section without market data");
  assert.ok(!titles.includes("STOCKS THAT MATTERED"), "no movers section without market data");

  // The DATA NOTE names the three missing canonical sources.
  const note = sections.find((section) => section.title === DATA_NOTE_TITLE).body.join(" ");
  assert.ok(note.includes("index/market data"), "names the missing index feed");
  assert.ok(note.includes("Pick-NY portfolio"), "names the missing portfolio feed");
  assert.ok(note.includes("news feed"), "names the missing news feed");
});

test("2. a quiet-but-real session states the quiet fact, not a gap", () => {
  // Market data IS present (index returns + portfolio), but nothing moved enough
  // to rank or explain. The "nothing happened" lines are then facts about a real
  // session, so they are allowed to appear.
  const { brief, text } = render({
    sessionDate: "2026-09-18",
    indexReturns: { SPY: 0.05 },
    portfolio: { returnPct: 0.05, benchmarkReturnPct: 0.05, excessPct: 0.0, holdings: [], material: [] },
    newsItemCount: 3,
  });

  assert.equal(brief.marketDataAvailable, true, "index data is present");
  assert.ok(text.includes("No single move met the anomaly thresholds"), "the quiet main-move fact appears");
  assert.ok(!text.includes("vs SPY —"), "portfolio numbers are real, never dashed");
});

test("3. no-news condition degrades gracefully and fabricates nothing", () => {
  // Market data is present but the news feed returned nothing, and there is no
  // catalyst. The brief must name the gap and never invent a headline.
  const { brief, text, sections } = render({
    sessionDate: "2026-09-18",
    indexReturns: { SPY: 0.42 },
    portfolio: { returnPct: 0.4, benchmarkReturnPct: 0.42, excessPct: -0.02, holdings: [], material: [] },
    newsItemCount: 0,
    mainMove: null,
    catalyst: null,
    causality: null,
  });

  assert.deepEqual(brief.dataGaps, ["news feed (no events read in the window)"], "only the news feed is missing");
  assert.equal(brief.drivers.length, 0, "no driver is invented without news");
  assert.ok(sections.find((section) => section.title === DATA_NOTE_TITLE), "the news gap is named");
  assert.ok(!text.includes("0 news items were read"), "the legacy news-count placeholder is gone");
});

test("4. complete canonical input produces the key portfolio/benchmark metrics", () => {
  const { brief, text, sections } = render(completeModel());

  assert.equal(brief.marketDataAvailable, true);
  assert.equal(brief.dataGaps.length, 0, "a complete run has no data gaps");

  // Summary bullets carry the index + portfolio line with real numbers.
  assert.ok(text.includes("SPY +0.42%"), "index return is present");
  assert.ok(text.includes("Pick-NY +0.63%"), "portfolio return is present");
  assert.ok(text.includes("vs SPY +0.42%"), "benchmark return is present");
  assert.ok(text.includes("excess +0.21%"), "excess return is present");

  // The portfolio section repeats the same numbers in its own line.
  assert.ok(text.includes("Portfolio +0.63% · SPY +0.42% · Excess +0.21%"), "portfolio section carries the metrics");

  // The derived stance and conclusion are present, and no placeholder survives.
  assert.equal(brief.viewChange.stance, "No change", "excess ±0.25 → No change");
  assert.ok(brief.bottomLine, "a complete run has a bottom line");
  assert.ok(sections.some((section) => section.title === "BOTTOM LINE"));
  for (const marker of PLACEHOLDER_MARKERS) {
    assert.ok(!text.includes(marker), `complete run must not emit "${marker}"`);
  }
});

test("5. the renderer preserves canonical content in the section list and text", () => {
  // buildPostCloseSections must not silently drop a supplied section's content.
  const { brief } = render(completeModel());
  const sections = buildPostCloseSections(brief);
  const titles = sections.map((section) => section.title);

  for (const expected of ["TODAY IN 30 SECONDS", "THE MOVE THAT MATTERED", "WHY THE MARKET MOVED", "LEADERS & LAGGARDS", "SIGNAL LEDGER PORTFOLIO", "SIGNAL LEDGER VALUATION WATCH"]) {
    assert.ok(titles.includes(expected), `section "${expected}" is present`);
  }
  const move = sections.find((section) => section.title === "THE MOVE THAT MATTERED");
  assert.ok(move.body.join(" ").includes("NVDA 拉升"), "the main move is preserved verbatim");
});

test("6. the artifact round-trips subject/text/html verbatim", async () => {
  const d1 = createD1();
  await applyMigration(d1, "../../monitor-worker/migrations-sandbox/0020_daily_brief_artifact.sql");

  const { text, html } = render(completeModel());
  const subject = `【Signal Ledger 收盘简报】2026-09-18 | NVDA 拉升，半导体板块领涨`;

  const { written } = await artifact.upsertDailyBriefArtifact(d1, {
    sessionDate: "2026-09-18",
    subject,
    text,
    html,
    nowIso: "2026-09-18T22:00:00.000Z",
  });
  assert.equal(written, true);

  const read = await artifact.readDailyBriefArtifact(d1, "2026-09-18");
  assert.ok(read, "the artifact reads back");
  assert.equal(read.subject, subject);
  assert.equal(read.text, text);
  assert.equal(read.html, html);
  assert.equal(read.bodyHash, await artifact.dailyBriefArtifactHash(text));

  // Re-importing an upsert replaces rather than appends — still one row.
  await artifact.upsertDailyBriefArtifact(d1, {
    sessionDate: "2026-09-18",
    subject,
    text,
    html,
    nowIso: "2026-09-18T23:00:00.000Z",
  });
  const count = d1.raw.prepare(`SELECT COUNT(*) AS n FROM daily_brief_artifacts`).get().n;
  assert.equal(count, 1, "a session has exactly one canonical artifact");
});

test("7. the import gate refuses an artifact that still carries placeholders", () => {
  const problems = artifact.validateCanonicalArtifact({
    subject: "【Signal Ledger 收盘简报】2026-09-18 | MIXED 主导，指数窄幅波动",
    text: [
      "Pick-NY — vs SPY — · excess —",
      "0 news items were read after the price work.",
      "No single move met the anomaly thresholds today.",
    ].join("\n"),
    html: "<p>placeholder</p>",
  });
  assert.ok(problems.length > 0, "a placeholder-bearing body is rejected");
  assert.ok(problems.some((problem) => problem.includes("placeholder marker")), "the reason is named");
});

test("8. the import gate accepts a real, complete artifact", () => {
  const { text, html } = render(completeModel());
  const problems = artifact.validateCanonicalArtifact({
    subject: "【Signal Ledger 收盘简报】2026-09-18 | NVDA 拉升，半导体板块领涨",
    text,
    html,
  });
  assert.deepEqual(problems, [], "a complete artifact passes validation");
});
