import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const code = await readFile(new URL("../monitor-worker/src/earnings-calendar.ts", import.meta.url), "utf8");
const url = "data:text/javascript;base64," + Buffer.from(ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64");
const { CALENDAR_COMPANIES, parseCalendarAnnouncement, calendarLinks, collectCompanyCalendar, storeCalendar, loadCalendar } = await import(url);
const oracle = CALENDAR_COMPANIES.find(c => c.ticker === "ORCL");
const sourceUrl = "https://www.prnewswire.com/news-releases/oracle-announcement.html";
const now = "2026-09-06T20:00:00Z";
const doc = (day = "10", published = "2026-09-02T20:00:00Z") => `<script type="application/ld+json">{"datePublished":"${published}"}</script>
  <article><h1>Oracle Sets the Date for its First Quarter Fiscal Year 2027 Earnings Announcement</h1>
  Oracle announced that its first quarter fiscal year 2027 results will be released on Thursday, September ${day}th, after the close of the market.
  Oracle will host a conference call and live webcast at 4:00 p.m. Central Time. SOURCE Oracle</article>`;
const parse = html => parseCalendarAnnouncement(oracle, html, sourceUrl, "", now);

test("reads an official announcement, not its publication date; maps fiscal year and ET correctly", () => {
  const entry = parse(doc());
  assert.equal(entry.date, "2026-09-10");
  assert.equal(entry.publishedAt, "2026-09-02T20:00:00.000Z");
  assert.equal(entry.fiscalPeriod, "2027-Q1");
  assert.equal(entry.expectedFiscalEnd, "Aug 2026");
  assert.equal(entry.timing, "After market close; conference call 17:00 ET");
});

test("rejects publication-only, ambiguous, other-issuer and unrelated documents", () => {
  assert.equal(parse(doc().replace(/results will be released[\s\S]*?market\./, "results are upcoming.")), null);
  assert.equal(parse(doc().replace("SOURCE Oracle", "SOURCE Other Company")), null);
  assert.equal(parse(doc().replace("</article>", "Results will be released on September 11th, 2026.</article>")), null);
  assert.equal(parse(doc().replace(/Oracle Sets the Date[^<]+/, "Oracle Announces First Quarter Financial Results")), null);
  assert.equal(parse(doc("99")), null);
});

test("recognizes publishing financial results rather than requiring the verb release", () => {
  assert.equal(parse(doc().replace("results will be released", "results will be published")).date, "2026-09-10");
});

test("discovery works for future periods, without adding a code profile", () => {
  const entry = parseCalendarAnnouncement(oracle,
    doc("8", "2026-12-01T20:00:00Z").replaceAll("First Quarter", "Second Quarter").replaceAll("first quarter", "second quarter").replaceAll("September", "December"),
    sourceUrl, "", "2026-12-02T00:00:00Z");
  assert.equal(entry.date, "2026-12-08");
  assert.equal(entry.fiscalPeriod, "2027-Q2");
});

test("discovery deduplicates links and rejects cross-domain/unrelated links", () => {
  const title = "Oracle Sets the Date for First Quarter Fiscal Year 2027 Earnings Announcement";
  const html = `<a href="/news-releases/one">${title}</a><a href="/news-releases/one">${title}</a><a href="https://other.example/news">${title}</a><a href="/product">Product news</a>`;
  assert.equal(calendarLinks(html, sourceUrl).length, 1);
});

test("a January release of fourth-quarter/full-year results belongs to the preceding fiscal year", () => {
  const meta = CALENDAR_COMPANIES.find(c => c.ticker === "META");
  const html = `<h1>Meta to Announce Fourth Quarter and Full Year 2025 Results</h1>
    <script>{"datePublished":"2026-01-14T21:05:00Z"}</script>
    Meta will release its fourth quarter and full year 2025 financial results on January 28, 2026, after market close. SOURCE Meta Platforms`;
  const entry = parseCalendarAnnouncement(meta, html, sourceUrl, "", now);
  assert.equal(entry.fiscalPeriod, "2025-Q4");
  assert.equal(entry.date, "2026-01-28");
  assert.equal(parseCalendarAnnouncement(meta, html.replaceAll("2025", ""), sourceUrl, "", now), null);
});

test("collector uses a working official distribution feed when another source fails", async () => {
  const company = { ...oracle, urls: ["https://bad.example/feed", "https://www.prnewswire.com/news/oracle/"] };
  const mock = async url => url.includes("bad.example") ? new Response("blocked", { status: 403 }) :
    new Response(url.endsWith("/oracle/") ? `<a href="${sourceUrl}">Oracle Sets the Date for First Quarter Fiscal Year 2027 Earnings Announcement</a>` : doc());
  const result = await collectCompanyCalendar(company, now, mock);
  assert.equal(result.entries[0].date, "2026-09-10");
  await assert.rejects(collectCompanyCalendar(company, now, async () => new Response("blocked", { status: 403 })), /HTTP 403/);
});

test("persistent calendar survives reloads, accepts a newer date, rejects old news and avoids duplicate writes", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(await readFile(new URL("../monitor-worker/migrations/0011_earnings_calendar.sql", import.meta.url), "utf8"));
  let writes = 0;
  const db = { prepare(sql) { return { bind(...args) { return { async run() { const result = sqlite.prepare(sql).run(...args); writes += result.changes; return result; } }; }, async all() { return { results: sqlite.prepare(sql).all() }; } }; } };
  try {
    const first = parse(doc());
    await storeCalendar(db, [first]);
    await storeCalendar(db, [{ ...first, checkedAt: "2026-09-06T21:00:00Z" }]);
    assert.equal(writes, 1);
    const revision = parse(doc("11", "2026-09-04T20:00:00Z"));
    await storeCalendar(db, [revision]);
    await storeCalendar(db, [first]);
    assert.equal(writes, 2);
    assert.equal((await loadCalendar(db)).get("ORCL:2027-Q1").date, "2026-09-11");
  } finally { sqlite.close(); }
});

test("both scheduler and dashboard use the persisted calendar; forecast tables are never rewritten", async () => {
  const index = await readFile(new URL("../monitor-worker/src/index.ts", import.meta.url), "utf8");
  assert.match(index, /env = \{ \.\.\.env, earningsCalendar: await loadCalendar\(env.DB\) \}/);
  assert.match(index, /const earningsCalendar = await loadCalendar\(env.DB\)/);
  const resolver = index.slice(index.indexOf("function earningsEventProfile("), index.indexOf("async function processNasdaqEarningsConsensus"));
  assert.match(resolver, /calendar\?\.get\(key\)/);
  assert.match(resolver, /\.\.\.legacy, \.\.\.current/);
  assert.doesNotMatch(code, /UPDATE earnings_(forecasts|price_forecasts|reaction_forecasts)/);
});
