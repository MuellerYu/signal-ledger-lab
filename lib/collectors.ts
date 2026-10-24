import { deliverAlertByDedupeKey, queueAlert } from "./alerts";
import { newId, sha256Hex } from "./crypto";
import { getBindings } from "./runtime";

type SecurityRow = {
  id: string;
  ticker: string;
  cik: string | null;
  watch_tier: number;
};

type CollectorSummary = {
  source: string;
  status: "completed" | "skipped" | "failed" | "busy";
  fetched: number;
  newEvents: number;
  alertsQueued: number;
  alertsSent: number;
  message?: string;
};

export type RefreshSummary = {
  id: string;
  status: "completed" | "partial" | "failed";
  startedAt: string;
  completedAt: string;
  fetched: number;
  newEvents: number;
  alertsQueued: number;
  alertsSent: number;
  collectors: CollectorSummary[];
};

const MATERIAL_SEC_FORMS = new Set([
  "8-K",
  "10-Q",
  "10-K",
  "6-K",
  "20-F",
  "40-F",
  "S-1",
  "S-3",
  "F-3",
  "424B2",
  "424B3",
  "424B5",
  "DEF 14A",
  "SC 13D",
  "SC 13G",
  "4",
  "NT 10-Q",
  "NT 10-K",
]);

function parseTimestamp(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCik(cik: string) {
  return cik.replace(/\D/g, "").padStart(10, "0");
}

function secPriority(form: string, watchTier: number) {
  if (form === "4") return "P2";
  if (["SC 13D", "SC 13G", "DEF 14A"].includes(form)) return "P1";
  if (watchTier === 1) return "P0";
  return "P1";
}

function secEventType(form: string) {
  if (["S-1", "S-3", "F-3", "424B2", "424B3", "424B5"].includes(form)) {
    return "financing";
  }
  if (["10-Q", "10-K", "6-K", "20-F", "40-F"].includes(form)) {
    return "earnings";
  }
  if (form.startsWith("NT ")) return "filing_risk";
  if (form === "4") return "insider_filing";
  return "sec_filing";
}

function secMateriality(form: string) {
  if (form.startsWith("NT ")) return 5;
  if (form === "4") return 2;
  if (["SC 13D", "SC 13G", "DEF 14A"].includes(form)) return 3;
  return 4;
}

async function acquireLease(
  d1: D1Database,
  sourceId: string,
  streamKey: string,
) {
  const now = Date.now();
  await d1
    .prepare(
      `INSERT INTO collector_states (
        source_id, stream_key, failure_count
      ) VALUES (?, ?, 0)
      ON CONFLICT(source_id, stream_key) DO NOTHING`,
    )
    .bind(sourceId, streamKey)
    .run();
  const result = await d1
    .prepare(
      `UPDATE collector_states
       SET locked_until_ms = ?
       WHERE source_id = ? AND stream_key = ?
         AND (locked_until_ms IS NULL OR locked_until_ms < ?)`,
    )
    .bind(now + 55_000, sourceId, streamKey, now)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

async function finishCollector(
  d1: D1Database,
  sourceId: string,
  streamKey: string,
  status: "online" | "needs_setup" | "failed",
  cursor: string | null,
  error: string | null,
) {
  const now = Date.now();
  await d1.batch([
    d1
      .prepare(
        `UPDATE collector_states
         SET cursor = COALESCE(?, cursor),
             last_success_at_ms = CASE WHEN ? = 'online' THEN ? ELSE last_success_at_ms END,
             locked_until_ms = NULL,
             failure_count = CASE WHEN ? = 'failed' THEN failure_count + 1 ELSE 0 END,
             last_error = ?
         WHERE source_id = ? AND stream_key = ?`,
      )
      .bind(cursor, status, now, status, error, sourceId, streamKey),
    d1
      .prepare(
        `UPDATE sources
         SET status = ?,
             last_success_at_ms = CASE WHEN ? = 'online' THEN ? ELSE last_success_at_ms END,
             last_error = ?
         WHERE id = ?`,
      )
      .bind(status, status, now, error, sourceId),
  ]);
}

async function ingestSecFiling(
  d1: D1Database,
  security: SecurityRow,
  filing: {
    accession: string;
    form: string;
    filingDate: string;
    reportDate: string;
    acceptedAt: string;
    primaryDocument: string;
    description: string;
  },
) {
  const now = Date.now();
  const cikDigits = normalizeCik(security.cik ?? "").replace(/^0+/, "");
  const accessionPath = filing.accession.replaceAll("-", "");
  const sourceUrl = filing.primaryDocument
    ? `https://www.sec.gov/Archives/edgar/data/${cikDigits}/${accessionPath}/${filing.primaryDocument}`
    : `https://www.sec.gov/Archives/edgar/data/${cikDigits}/${accessionPath}`;
  const headline = `${security.ticker} filed Form ${filing.form}`;
  const acceptedAtMs =
    parseTimestamp(filing.acceptedAt) ??
    parseTimestamp(`${filing.filingDate}T00:00:00Z`) ??
    now;
  const externalId = filing.accession;
  const rawId = `raw_sec_${accessionPath}`;
  const urlHash = await sha256Hex(sourceUrl);
  const contentHash = await sha256Hex(
    [
      security.ticker,
      filing.accession,
      filing.form,
      filing.reportDate,
      filing.primaryDocument,
      filing.description,
    ].join("|"),
  );
  const rawInsert = await d1
    .prepare(
      `INSERT INTO raw_items (
        id, source_id, external_id, canonical_url, canonical_url_hash,
        title, excerpt, source_published_at_ms, first_seen_at_ms,
        last_seen_at_ms, content_hash, payload_json
      ) VALUES (?, 'sec-edgar', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, external_id) DO NOTHING`,
    )
    .bind(
      rawId,
      externalId,
      sourceUrl,
      urlHash,
      headline,
      filing.description || `SEC filing for report period ${filing.reportDate || "not specified"}.`,
      acceptedAtMs,
      now,
      now,
      contentHash,
      JSON.stringify(filing),
    )
    .run();
  const rawWasNew = Number(rawInsert.meta.changes ?? 0) > 0;
  if (!rawWasNew) {
    await d1
      .prepare(
        `UPDATE raw_items SET last_seen_at_ms = ?
         WHERE source_id = 'sec-edgar' AND external_id = ?`,
      )
      .bind(now, externalId)
      .run();
  }

  const eventFingerprint = await sha256Hex(
    `sec|${filing.accession}|${security.ticker}|${filing.form}`,
  );
  const eventId = `evt_sec_${accessionPath}_${security.ticker.toLowerCase()}`;
  const priority = secPriority(filing.form, security.watch_tier);
  const eventInsert = await d1
    .prepare(
      `INSERT INTO events (
        id, event_fingerprint, source_id, raw_item_id, event_type, priority,
        headline, summary, source_url, effective_at_ms, first_published_at_ms,
        first_seen_at_ms, last_material_update_at_ms, status, fact_status,
        materiality, confidence, novelty, material_revision, created_at_ms
      ) VALUES (
        ?, ?, 'sec-edgar', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'confirmed', 'confirmed', ?, 1, 1, 1, ?
      )
      ON CONFLICT(event_fingerprint) DO NOTHING`,
    )
    .bind(
      eventId,
      eventFingerprint,
      rawId,
      secEventType(filing.form),
      priority,
      headline,
      `${filing.description || "Official SEC filing"} · filed ${filing.filingDate}${filing.reportDate ? ` · report period ${filing.reportDate}` : ""}`,
      sourceUrl,
      acceptedAtMs,
      acceptedAtMs,
      now,
      now,
      secMateriality(filing.form),
      now,
    )
    .run();
  const eventWasNew = Number(eventInsert.meta.changes ?? 0) > 0;
  if (!eventWasNew) {
    return { eventWasNew: false, alertQueued: false, alertSent: false };
  }

  await d1
    .prepare(
      `INSERT INTO event_securities (
        event_id, security_id, relationship, directness,
        impact_direction, mapping_confidence
      ) VALUES (?, ?, 'direct', 1, 'unknown', 1)
      ON CONFLICT(event_id, security_id, relationship) DO NOTHING`,
    )
    .bind(eventId, security.id)
    .run();

  const freshEnoughForAlert = acceptedAtMs >= now - 15 * 60_000;
  if (!freshEnoughForAlert || priority === "P2") {
    return { eventWasNew: true, alertQueued: false, alertSent: false };
  }

  const dedupeKey = `sec/${filing.accession}/${security.ticker}/${priority}/v1`;
  const queued = await queueAlert(d1, {
    eventId,
    priority,
    dedupeKey,
    subject: `[${priority}] ${security.ticker} · SEC ${filing.form} · ${filing.filingDate}`,
    bodyText: [
      `${security.ticker} filed Form ${filing.form}.`,
      "",
      `Official source time: ${new Date(acceptedAtMs).toISOString()}`,
      `Why it matters: materiality ${secMateriality(filing.form)}/5; review the primary filing before acting.`,
      `Source: ${sourceUrl}`,
      "",
      "This is an automated fact alert, not investment advice.",
    ].join("\n"),
    sourcePublishedAtMs: acceptedAtMs,
    firstSeenAtMs: now,
  });
  const delivered = queued.inserted
    ? await deliverAlertByDedupeKey(d1, dedupeKey)
    : null;
  return {
    eventWasNew: true,
    alertQueued: queued.inserted,
    alertSent: delivered?.ok === true && delivered.status === "sent",
  };
}

async function collectSec(d1: D1Database): Promise<CollectorSummary> {
  const sourceId = "sec-edgar";
  const streamKey = "watchlist-submissions";
  if (!(await acquireLease(d1, sourceId, streamKey))) {
    return {
      source: sourceId,
      status: "busy",
      fetched: 0,
      newEvents: 0,
      alertsQueued: 0,
      alertsSent: 0,
      message: "Another SEC refresh is already running.",
    };
  }

  const bindings = getBindings();
  const userAgent =
    bindings.SEC_USER_AGENT?.trim() ||
    "Signal Ledger public research monitor";
  const securities = (
    await d1
      .prepare(
        `SELECT id, ticker, cik, watch_tier
         FROM securities
         WHERE enabled = 1 AND cik IS NOT NULL
         ORDER BY watch_tier ASC, ticker ASC`,
      )
      .all<SecurityRow>()
  ).results;

  let fetched = 0;
  let newEvents = 0;
  let alertsQueued = 0;
  let alertsSent = 0;
  try {
    for (const security of securities) {
      if (!security.cik) continue;
      const response = await fetch(
        `https://data.sec.gov/submissions/CIK${normalizeCik(security.cik)}.json`,
        {
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip, deflate",
            "User-Agent": userAgent,
          },
        },
      );
      if (!response.ok) {
        throw new Error(
          `SEC returned ${response.status} for ${security.ticker}.`,
        );
      }
      const payload = (await response.json()) as {
        filings?: {
          recent?: Record<string, unknown[]>;
        };
      };
      const recent = payload.filings?.recent;
      const accessions = (recent?.accessionNumber ?? []) as string[];
      const forms = (recent?.form ?? []) as string[];
      const filingDates = (recent?.filingDate ?? []) as string[];
      const reportDates = (recent?.reportDate ?? []) as string[];
      const acceptanceDateTimes = (recent?.acceptanceDateTime ?? []) as string[];
      const primaryDocuments = (recent?.primaryDocument ?? []) as string[];
      const descriptions = (recent?.primaryDocDescription ?? []) as string[];

      const selected = accessions
        .map((accession, index) => ({
          accession,
          form: forms[index] ?? "",
          filingDate: filingDates[index] ?? "",
          reportDate: reportDates[index] ?? "",
          acceptedAt: acceptanceDateTimes[index] ?? "",
          primaryDocument: primaryDocuments[index] ?? "",
          description: descriptions[index] ?? "",
        }))
        .filter((filing) => MATERIAL_SEC_FORMS.has(filing.form))
        .slice(0, 12);
      fetched += selected.length;
      for (const filing of selected) {
        const result = await ingestSecFiling(d1, security, filing);
        if (result.eventWasNew) newEvents += 1;
        if (result.alertQueued) alertsQueued += 1;
        if (result.alertSent) alertsSent += 1;
      }
    }

    await finishCollector(d1, sourceId, streamKey, "online", null, null);
    return {
      source: sourceId,
      status: "completed",
      fetched,
      newEvents,
      alertsQueued,
      alertsSent,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "SEC refresh failed.";
    await finishCollector(d1, sourceId, streamKey, "failed", null, message);
    return {
      source: sourceId,
      status: "failed",
      fetched,
      newEvents,
      alertsQueued,
      alertsSent,
      message,
    };
  }
}

type AlpacaNewsItem = {
  id: number | string;
  headline?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
  url?: string;
  symbols?: string[];
  source?: string;
};

async function collectAlpaca(d1: D1Database): Promise<CollectorSummary> {
  const sourceId = "alpaca-news";
  const streamKey = "watchlist-news";
  const bindings = getBindings();
  if (!bindings.ALPACA_API_KEY_ID || !bindings.ALPACA_API_SECRET_KEY) {
    await d1
      .prepare(
        `UPDATE sources
         SET status = 'needs_setup',
             last_error = 'ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY are required.'
         WHERE id = ?`,
      )
      .bind(sourceId)
      .run();
    return {
      source: sourceId,
      status: "skipped",
      fetched: 0,
      newEvents: 0,
      alertsQueued: 0,
      alertsSent: 0,
      message: "Alpaca credentials are not configured.",
    };
  }
  if (!(await acquireLease(d1, sourceId, streamKey))) {
    return {
      source: sourceId,
      status: "busy",
      fetched: 0,
      newEvents: 0,
      alertsQueued: 0,
      alertsSent: 0,
    };
  }

  try {
    const state = await d1
      .prepare(
        `SELECT cursor FROM collector_states
         WHERE source_id = ? AND stream_key = ?`,
      )
      .bind(sourceId, streamKey)
      .first<{ cursor: string | null }>();
    const start =
      state?.cursor ?? new Date(Date.now() - 5 * 60_000).toISOString();
    const watchlist = (
      await d1
        .prepare(
          `SELECT id, ticker, cik, watch_tier
           FROM securities
           WHERE enabled = 1 AND watch_tier > 0
           ORDER BY watch_tier ASC, ticker ASC`,
        )
        .all<SecurityRow>()
    ).results;
    const byTicker = new Map(
      watchlist.map((security) => [security.ticker, security]),
    );
    const url = new URL("https://data.alpaca.markets/v1beta1/news");
    url.searchParams.set("start", start);
    url.searchParams.set("sort", "asc");
    url.searchParams.set("limit", "50");
    url.searchParams.set("include_content", "false");
    url.searchParams.set(
      "symbols",
      watchlist.map((security) => security.ticker).join(","),
    );
    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": bindings.ALPACA_API_KEY_ID,
        "APCA-API-SECRET-KEY": bindings.ALPACA_API_SECRET_KEY,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Alpaca returned ${response.status}.`);
    }
    const payload = (await response.json()) as { news?: AlpacaNewsItem[] };
    const news = payload.news ?? [];
    let cursor = start;
    let newEvents = 0;
    let alertsQueued = 0;
    let alertsSent = 0;
    for (const article of news) {
      const externalId = String(article.id);
      const publishedAtMs = parseTimestamp(article.created_at) ?? Date.now();
      const updatedAtMs = parseTimestamp(article.updated_at);
      if (publishedAtMs > (parseTimestamp(cursor) ?? 0)) {
        cursor = new Date(publishedAtMs).toISOString();
      }
      const title = article.headline?.trim() || "Untitled market news";
      const contentHash = await sha256Hex(
        [title, article.summary ?? "", article.url ?? ""].join("|"),
      );
      const rawId = `raw_alpaca_${externalId}`;
      const rawInsert = await d1
        .prepare(
          `INSERT INTO raw_items (
            id, source_id, external_id, canonical_url, canonical_url_hash,
            title, excerpt, source_published_at_ms, source_updated_at_ms,
            first_seen_at_ms, last_seen_at_ms, content_hash, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_id, external_id) DO NOTHING`,
        )
        .bind(
          rawId,
          sourceId,
          externalId,
          article.url ?? null,
          article.url ? await sha256Hex(article.url) : null,
          title,
          article.summary ?? null,
          publishedAtMs,
          updatedAtMs,
          Date.now(),
          Date.now(),
          contentHash,
          JSON.stringify(article),
        )
        .run();
      if (Number(rawInsert.meta.changes ?? 0) === 0) continue;

      const mapped = (article.symbols ?? [])
        .map((ticker) => byTicker.get(ticker))
        .filter((security): security is SecurityRow => Boolean(security));
      if (!mapped.length) continue;
      const isTierOne = mapped.some((security) => security.watch_tier === 1);
      const eventId = `evt_alpaca_${externalId}`;
      const eventFingerprint = await sha256Hex(`alpaca|${externalId}`);
      const eventInsert = await d1
        .prepare(
          `INSERT INTO events (
            id, event_fingerprint, source_id, raw_item_id, event_type, priority,
            headline, summary, source_url, effective_at_ms, first_published_at_ms,
            first_seen_at_ms, last_material_update_at_ms, status, fact_status,
            materiality, confidence, novelty, material_revision, created_at_ms
          ) VALUES (
            ?, ?, ?, ?, 'news', ?, ?, ?, ?, ?, ?, ?, ?,
            'open', 'reported', 3, 0.75, 1, 1, ?
          )
          ON CONFLICT(event_fingerprint) DO NOTHING`,
        )
        .bind(
          eventId,
          eventFingerprint,
          sourceId,
          rawId,
          isTierOne ? "P1" : "P2",
          title,
          article.summary ?? null,
          article.url ?? null,
          publishedAtMs,
          publishedAtMs,
          Date.now(),
          Date.now(),
          Date.now(),
        )
        .run();
      if (Number(eventInsert.meta.changes ?? 0) === 0) continue;
      newEvents += 1;
      await d1.batch(
        mapped.map((security) =>
          d1
            .prepare(
              `INSERT INTO event_securities (
                event_id, security_id, relationship, directness,
                impact_direction, mapping_confidence
              ) VALUES (?, ?, 'direct', 1, 'unknown', 1)
              ON CONFLICT(event_id, security_id, relationship) DO NOTHING`,
            )
            .bind(eventId, security.id),
        ),
      );

      const freshEnough = publishedAtMs >= Date.now() - 10 * 60_000;
      if (!isTierOne || !freshEnough) continue;
      const dedupeKey = `alpaca/${externalId}/P1/v1`;
      const queued = await queueAlert(d1, {
        eventId,
        priority: "P1",
        dedupeKey,
        subject: `[P1] ${(article.symbols ?? []).join("/")} · ${title}`,
        bodyText: [
          title,
          "",
          article.summary ?? "No summary supplied.",
          `Source: ${article.source ?? "Alpaca / Benzinga"}`,
          `Published: ${new Date(publishedAtMs).toISOString()}`,
          article.url ? `Link: ${article.url}` : "",
          "",
          "Reported news pending primary-source confirmation. Not investment advice.",
        ]
          .filter(Boolean)
          .join("\n"),
        sourcePublishedAtMs: publishedAtMs,
        firstSeenAtMs: Date.now(),
      });
      if (queued.inserted) {
        alertsQueued += 1;
        const delivered = await deliverAlertByDedupeKey(d1, dedupeKey);
        if (delivered.ok && delivered.status === "sent") alertsSent += 1;
      }
    }

    await finishCollector(d1, sourceId, streamKey, "online", cursor, null);
    return {
      source: sourceId,
      status: "completed",
      fetched: news.length,
      newEvents,
      alertsQueued,
      alertsSent,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Alpaca refresh failed.";
    await finishCollector(d1, sourceId, streamKey, "failed", null, message);
    return {
      source: sourceId,
      status: "failed",
      fetched: 0,
      newEvents: 0,
      alertsQueued: 0,
      alertsSent: 0,
      message,
    };
  }
}

export async function runRefresh(
  d1: D1Database,
  trigger = "sites_manual",
): Promise<RefreshSummary> {
  const runId = newId("run");
  const startedAtMs = Date.now();
  await d1
    .prepare(
      `INSERT INTO ingestion_runs (
        id, collector_key, trigger, status, started_at_ms
      ) VALUES (?, 'official-plus-optional-news', ?, 'running', ?)`,
    )
    .bind(runId, trigger, startedAtMs)
    .run();

  const collectors = [await collectSec(d1), await collectAlpaca(d1)];
  const fetched = collectors.reduce((sum, item) => sum + item.fetched, 0);
  const newEvents = collectors.reduce((sum, item) => sum + item.newEvents, 0);
  const alertsQueued = collectors.reduce(
    (sum, item) => sum + item.alertsQueued,
    0,
  );
  const alertsSent = collectors.reduce((sum, item) => sum + item.alertsSent, 0);
  const failureCount = collectors.filter((item) => item.status === "failed").length;
  const completedCount = collectors.filter(
    (item) => item.status === "completed",
  ).length;
  const status =
    failureCount === collectors.length
      ? "failed"
      : failureCount > 0 || completedCount === 0
        ? "partial"
        : "completed";
  const completedAtMs = Date.now();
  const messages = collectors
    .map((item) => item.message)
    .filter((message): message is string => Boolean(message));
  await d1
    .prepare(
      `UPDATE ingestion_runs
       SET status = ?, completed_at_ms = ?, fetched_count = ?,
           new_events = ?, alerts_queued = ?, alerts_sent = ?,
           error_count = ?, message = ?
       WHERE id = ?`,
    )
    .bind(
      status,
      completedAtMs,
      fetched,
      newEvents,
      alertsQueued,
      alertsSent,
      failureCount,
      messages.join(" ") || "Refresh completed.",
      runId,
    )
    .run();

  return {
    id: runId,
    status,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    fetched,
    newEvents,
    alertsQueued,
    alertsSent,
    collectors,
  };
}
