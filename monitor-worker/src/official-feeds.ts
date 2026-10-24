export type OfficialFeedDefinition = {
  id: string;
  name: string;
  url: string;
  eventType: "macro" | "trade_halt";
};

export type OfficialFeedItem = {
  feedId: string;
  sourceName: string;
  sourceUrl: string;
  sourceEventId: string;
  headline: string;
  summary: string;
  publishedAt: string;
  url: string;
  eventType: "macro" | "trade_halt";
  ticker: string;
};

export type OfficialFeedResult = {
  feed: OfficialFeedDefinition;
  items: OfficialFeedItem[];
  latencyMs: number;
  error: string | null;
};

export const OFFICIAL_FEEDS: OfficialFeedDefinition[] = [
  {
    id: "fed:press-all",
    name: "Federal Reserve",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    eventType: "macro",
  },
  {
    id: "bls:employment-situation",
    name: "U.S. Bureau of Labor Statistics",
    url: "https://www.bls.gov/feed/empsit.rss",
    eventType: "macro",
  },
  {
    id: "bls:cpi",
    name: "U.S. Bureau of Labor Statistics",
    url: "https://www.bls.gov/feed/cpi.rss",
    eventType: "macro",
  },
  {
    id: "bls:ppi",
    name: "U.S. Bureau of Labor Statistics",
    url: "https://www.bls.gov/feed/ppi.rss",
    eventType: "macro",
  },
  {
    id: "bea:releases",
    name: "U.S. Bureau of Economic Analysis",
    url: "https://apps.bea.gov/rss/rss.xml",
    eventType: "macro",
  },
  {
    id: "nasdaq:trade-halts",
    name: "Nasdaq Trader",
    url: "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts",
    eventType: "trade_halt",
  },
];

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/\s+/g, " ")
    .trim();
}

function tagValue(block: string, names: string[]): string {
  for (const name of names) {
    const match = block.match(
      new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"),
    );
    if (match?.[1]) return decodeXml(match[1]);
  }
  return "";
}

function itemLink(block: string): string {
  const bodyLink = tagValue(block, ["link"]);
  if (/^https?:\/\//i.test(bodyLink)) return bodyLink;
  const href = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1];
  return decodeXml(href ?? "");
}

function stableId(
  feed: OfficialFeedDefinition,
  block: string,
  headline: string,
  publishedAt: string,
  url: string,
): string {
  return (
    tagValue(block, ["guid", "id"]) ||
    `${feed.id}|${publishedAt}|${url}|${headline}`
  );
}

function normalizeDate(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function inferHaltTicker(text: string): string {
  const headlineSymbol = text.match(
    /^\s*([A-Z][A-Z0-9.\-]{0,9})(?:\s|$)/,
  )?.[1];
  const explicit = text.match(
    /(?:symbol|issue)\s*[:\-]\s*([A-Z][A-Z0-9.\-]{0,9})\b/i,
  )?.[1];
  return (
    headlineSymbol?.toUpperCase() ||
    explicit?.toUpperCase() ||
    "MARKET"
  );
}

export function parseOfficialFeed(
  feed: OfficialFeedDefinition,
  xml: string,
): OfficialFeedItem[] {
  const blocks =
    xml.match(/<item\b[\s\S]*?<\/item>/gi) ??
    xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ??
    [];
  const seen = new Set<string>();
  const items: OfficialFeedItem[] = [];
  for (const block of blocks) {
    const headline = tagValue(block, ["title"]);
    const summary = tagValue(block, [
      "description",
      "summary",
      "content",
      "content:encoded",
    ]);
    const publishedAt = normalizeDate(
      tagValue(block, ["pubDate", "published", "updated", "dc:date"]),
    );
    const url = itemLink(block) || feed.url;
    if (!headline || !publishedAt) continue;
    const sourceEventId = stableId(
      feed,
      block,
      headline,
      publishedAt,
      url,
    );
    if (seen.has(sourceEventId)) continue;
    seen.add(sourceEventId);
    const combined = `${headline} ${summary}`;
    items.push({
      feedId: feed.id,
      sourceName: feed.name,
      sourceUrl: feed.url,
      sourceEventId,
      headline,
      summary,
      publishedAt,
      url,
      eventType: feed.eventType,
      ticker:
        feed.eventType === "trade_halt"
          ? inferHaltTicker(combined)
          : "MARKET",
    });
  }
  return items;
}

export async function collectOfficialFeeds(
  fetcher: typeof fetch = fetch,
): Promise<OfficialFeedResult[]> {
  return Promise.all(
    OFFICIAL_FEEDS.map(async (feed) => {
      const startedAt = Date.now();
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12_000);
        let response: Response;
        try {
          response = await fetcher(feed.url, {
            headers: {
              accept: "application/rss+xml, application/atom+xml, text/xml",
              "user-agent": "SignalLedger/1.0 owner@example.com",
            },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!response.ok) {
          throw new Error(`${new URL(feed.url).hostname} returned ${response.status}`);
        }
        return {
          feed,
          items: parseOfficialFeed(feed, await response.text()),
          latencyMs: Date.now() - startedAt,
          error: null,
        };
      } catch (error) {
        return {
          feed,
          items: [],
          latencyMs: Date.now() - startedAt,
          error:
            error instanceof Error ? error.message : "Official feed failed",
        };
      }
    }),
  );
}
