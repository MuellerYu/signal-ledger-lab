// Calendar announcements are mutable facts, never edits to frozen forecasts.
export interface CalendarCompany {
  ticker: string;
  name: string;
  yearEnd: number;
  urls: string[];
  issuer: RegExp;
}

export const CALENDAR_COMPANIES: CalendarCompany[] = [
  { ticker: "ORCL", name: "Oracle", yearEnd: 5, issuer: /Oracle/i, urls: ["https://www.prnewswire.com/news/oracle/", "https://investor.oracle.com/rss/pressrelease.aspx"] },
  { ticker: "AMD", name: "AMD", yearEnd: 12, issuer: /AMD|Advanced Micro Devices/i, urls: ["https://ir.amd.com/news-events/press-releases/rss"] },
  { ticker: "NVDA", name: "NVIDIA", yearEnd: 1, issuer: /NVIDIA/i, urls: ["https://nvidianews.nvidia.com/cats/press_release.xml"] },
  { ticker: "AVGO", name: "Broadcom", yearEnd: 10, issuer: /Broadcom/i, urls: ["https://investors.broadcom.com/rss/news-releases.xml"] },
  { ticker: "MSTR", name: "Strategy", yearEnd: 12, issuer: /Strategy|MicroStrategy/i, urls: ["https://www.strategy.com/press"] },
  { ticker: "MSFT", name: "Microsoft", yearEnd: 6, issuer: /Microsoft/i, urls: ["https://news.microsoft.com/source/feed/", "https://news.microsoft.com/feed/"] },
  { ticker: "AMZN", name: "Amazon", yearEnd: 12, issuer: /Amazon/i, urls: ["https://ir.aboutamazon.com/rss/pressrelease.aspx", "https://press.aboutamazon.com/press-releases"] },
  { ticker: "GOOGL", name: "Alphabet", yearEnd: 12, issuer: /Alphabet/i, urls: ["https://abc.xyz/investor/news/default.aspx"] },
  { ticker: "META", name: "Meta", yearEnd: 12, issuer: /Meta|Facebook/i, urls: ["https://www.prnewswire.com/news/meta/", "https://investor.atmeta.com/rss/pressrelease.aspx"] },
  { ticker: "COIN", name: "Coinbase", yearEnd: 12, issuer: /Coinbase/i, urls: ["https://investor.coinbase.com/rss/pressrelease.aspx"] },
  { ticker: "SMCI", name: "Supermicro", yearEnd: 6, issuer: /Supermicro|Super Micro/i, urls: ["https://ir.supermicro.com/rss/pressrelease.aspx"] },
  { ticker: "TSM", name: "TSMC", yearEnd: 12, issuer: /TSMC|Taiwan Semiconductor/i, urls: ["https://pr.tsmc.com/english/news"] },
];

export interface CalendarEntry {
  ticker: string;
  fiscalPeriod: string;
  date: string;
  dateLabel: string;
  timing: string;
  status: "confirmed";
  sourceName: string;
  sourceUrl: string;
  basis: string;
  expectedFiscalEnd: string;
  publishedAt: string;
  checkedAt: string;
}

export function readableCalendarText(html: string): string {
  return html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ").trim();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_DATE = "(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sept?\\.?|Oct\\.?|Nov\\.?|Dec\\.?)\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+20\\d{2})?";

export function announcementCandidate(title: string): boolean {
  return /earnings|financial results|quarter.{0,35}results/i.test(title) &&
    /sets? (?:the )?date|to (?:report|announce|release|hold)|will (?:report|announce|release|hold)|announces?.{0,60}(?:date|conference|webcast)|schedules?|reschedules?/i.test(title);
}

function tag(block: string, name: string): string {
  return readableCalendarText(block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] ?? "");
}

export function calendarLinks(html: string, base: string) {
  const links: { title: string; url: string; published: string }[] = [];
  const items = html.match(/<item\b[\s\S]*?<\/item>/gi);
  if (items) {
    for (const item of items) links.push({ title: tag(item, "title"), url: tag(item, "link"), published: tag(item, "pubDate") });
  } else {
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      links.push({ title: readableCalendarText(m[2]), url: m[1], published: "" });
    }
  }
  const seen = new Set<string>();
  return links.filter(link => {
    try {
      link.url = new URL(link.url.replace(/&amp;/g, "&"), base).href;
      if (new URL(link.url).origin !== new URL(base).origin || seen.has(link.url) || !announcementCandidate(link.title)) return false;
      seen.add(link.url);
      return true;
    } catch { return false; }
  }).slice(0, 3);
}

function publicationDate(html: string, supplied: string): string | null {
  const value = html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1] ??
    html.match(/<meta\b[^>]*(?:property|name)=["'](?:article:published_time|date|DC.date.issued)["'][^>]*content=["']([^"']+)/i)?.[1] ?? supplied;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function parseCalendarAnnouncement(company: CalendarCompany, html: string, sourceUrl: string, suppliedPublished = "", now = new Date().toISOString()): CalendarEntry | null {
  const title = tag(html, "h1") || tag(html, "title");
  if (!announcementCandidate(title) || !company.issuer.test(title)) return null;
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? html;
  const text = readableCalendarText(article);
  if (new URL(sourceUrl).hostname.endsWith("prnewswire.com") &&
      !company.issuer.test(text.match(/SOURCE\s+(.{1,100})/i)?.[1] ?? "")) return null;
  // Never infer a release date from an RSS publication timestamp or calendar guess.
  let publishedAt = publicationDate(html, suppliedPublished);
  if (!publishedAt) {
    const publishedText = text.match(new RegExp(`(${MONTH_DATE.replace("(?:,?\\s+20\\d{2})?", ",?\\s+20\\d{2}")})` , "i"))?.[1];
    if (publishedText) publishedAt = publicationDate("", publishedText.replace(/(\d)(st|nd|rd|th)/, "$1"));
  }
  if (!publishedAt || Date.parse(publishedAt) > Date.parse(now) + 86400000) return null;
  const periodText = title + " " + text.slice(Math.max(0, text.indexOf(title)), Math.max(0, text.indexOf(title)) + 2400);
  const quarter = periodText.match(/\b(first|second|third|fourth|[1-4](?:st|nd|rd|th))[- ]quarter\b/i) ?? periodText.match(/\bQ([1-4])\b/i);
  if (!quarter) return null;
  const q = ({ first: 1, second: 2, third: 3, fourth: 4 } as Record<string, number>)[quarter[1].toLowerCase()] ?? Number(quarter[1][0]);
  const fy = periodText.match(/(?:fiscal(?:\s+year)?|FY)\s*(20\d{2}|\d{2})\b/i)?.[1] ??
    periodText.match(/quarter(?:\s+(?:and\s+full[- ]year|of|fiscal\s+year|fiscal|year))?\s*(20\d{2})\b/i)?.[1];
  // A January announcement may describe the PREVIOUS fiscal year. Never use
  // the announcement year as the fiscal year just to fill an empty field.
  if (!fy) return null;
  const year = Number(fy) < 100 ? 2000 + Number(fy) : Number(fy);
  const dates = new Map<string, string>();
  for (const match of text.matchAll(new RegExp(MONTH_DATE, "gi"))) {
    const before = text.slice(Math.max(0, match.index! - 320), match.index);
    if (!/(?:will\s+(?:be\s+)?(?:report|release|publish|announce|hold|host)|(?:results|earnings).{0,55}(?:released|reported|published|announced)|conference\s+call|webcast|rescheduled).{0,220}(?:on\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday),?\s+)?|for\s*)$/i.test(before)) continue;
    const raw = match[0].match(/([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/)!;
    const month = MONTHS.indexOf(raw[1].slice(0, 3).toLowerCase());
    let releaseYear = raw[3] ? Number(raw[3]) : new Date(publishedAt).getUTCFullYear();
    if (!raw[3] && month < new Date(publishedAt).getUTCMonth() - 6) releaseYear++;
    const date = `${releaseYear}-${String(month + 1).padStart(2, "0")}-${raw[2].padStart(2, "0")}`;
    const delta = Date.parse(date) - Date.parse(publishedAt.slice(0, 10));
    if (!Number.isFinite(delta) || new Date(date).toISOString().slice(0, 10) !== date || delta < 0 || delta > 120 * 86400000) continue;
    if (!dates.has(date)) dates.set(date, before.slice(-160) + match[0] + text.slice(match.index! + match[0].length, match.index! + match[0].length + 100));
  }
  if (dates.size !== 1) return null; // Ambiguous/rescheduled dates need verification, never a guess.
  const [date, evidence] = [...dates][0];
  let timing = /after.{0,25}(?:market|close)|market.{0,15}close/i.test(evidence) ? "After market close" :
    /before.{0,25}(?:market|open)/i.test(evidence) ? "Before market open" : "Release time not specified";
  const call = text.match(/(?:conference call|webcast|video webinar).{0,90}?\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\s*(Central|Eastern|Pacific|[CEP][SD]?T)/i);
  if (call) {
    const hour = (Number(call[1]) % 12) + (/p/i.test(call[3]) ? 12 : 0) + (/^(Central|C)/i.test(call[4]) ? 1 : /^(Pacific|P)/i.test(call[4]) ? 3 : 0);
    timing += `; conference call ${String(hour % 24).padStart(2, "0")}:${call[2] ?? "00"} ET`;
  }
  const end = new Date(Date.UTC(year, company.yearEnd - 1 - 3 * (4 - q), 1));
  const periodEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0));
  if (Date.parse(date) < periodEnd.getTime() || Date.parse(date) - periodEnd.getTime() > 150 * 86400000) return null;
  return { ticker: company.ticker, fiscalPeriod: `${year}-Q${q}`, date, dateLabel: date, timing, status: "confirmed",
    sourceName: `${company.name} official announcement${new URL(sourceUrl).hostname.endsWith("prnewswire.com") ? " via PR Newswire" : ""}`,
    sourceUrl, basis: evidence.trim(), expectedFiscalEnd: end.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }), publishedAt, checkedAt: now };
}

export async function collectCompanyCalendar(company: CalendarCompany, now = new Date().toISOString(), fetcher: typeof fetch = fetch): Promise<{ entries: CalendarEntry[]; warning: string | null }> {
  const failures: string[] = [];
  const get = async (url: string) => {
    const response = await fetcher(url, { headers: { "User-Agent": "SignalLedger/1.0", Accept: "application/rss+xml,text/html" }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    const html = await response.text();
    if (html.length > 2_000_000 || /<title>Just a moment|captcha/i.test(html.slice(0, 2000))) throw new Error("Source unavailable or too large");
    return html;
  };
  for (const url of company.urls) {
    try {
      const html = await get(url);
      const links = calendarLinks(html, url);
      if (!links.length) {
        if (/<rss\b/i.test(html) && /<item\b/i.test(html)) return { entries: [], warning: null };
        throw new Error("No readable earnings announcements in this source");
      }
      const entries: CalendarEntry[] = [];
      let recentUnparsed = 0;
      for (const link of links) {
        try {
          const doc = await get(link.url);
          const entry = parseCalendarAnnouncement(company, doc, link.url, link.published, now);
          if (entry) entries.push(entry);
          else recentUnparsed++;
        } catch { recentUnparsed++; }
      }
      const warning = recentUnparsed ? `${recentUnparsed} announcement(s) could not be verified; retained last confirmed dates` : null;
      if (!entries.length && warning) throw new Error(warning);
      return { entries, warning };
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new Error(failures.join("; ").slice(0, 500));
}

export interface CalendarDB {
  prepare(sql: string): { bind(...args: unknown[]): { run(): Promise<unknown> }; all<T>(): Promise<{ results?: T[] }> };
}

export const UPSERT_CALENDAR_SQL = `INSERT INTO earnings_calendar (ticker, fiscal_period, announcement_at, source_url, profile_json, updated_at)
  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ticker, fiscal_period) DO UPDATE SET
  announcement_at = excluded.announcement_at, source_url = excluded.source_url,
  profile_json = excluded.profile_json, updated_at = excluded.updated_at
  WHERE excluded.announcement_at >= earnings_calendar.announcement_at
    AND (excluded.source_url != earnings_calendar.source_url OR json_extract(excluded.profile_json, '$.date') != json_extract(earnings_calendar.profile_json, '$.date')
      OR json_extract(excluded.profile_json, '$.timing') != json_extract(earnings_calendar.profile_json, '$.timing'))`;

export async function storeCalendar(db: CalendarDB, entries: CalendarEntry[]): Promise<void> {
  for (const entry of entries) await db.prepare(UPSERT_CALENDAR_SQL).bind(entry.ticker, entry.fiscalPeriod, entry.publishedAt, entry.sourceUrl, JSON.stringify(entry), entry.checkedAt).run();
}

export async function loadCalendar(db: CalendarDB): Promise<Map<string, CalendarEntry>> {
  const rows = (await db.prepare("SELECT ticker, fiscal_period, profile_json FROM earnings_calendar").all<{ ticker: string; fiscal_period: string; profile_json: string }>()).results ?? [];
  return new Map(rows.map(row => [`${row.ticker}:${row.fiscal_period}`, JSON.parse(row.profile_json) as CalendarEntry]));
}
