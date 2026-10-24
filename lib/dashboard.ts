import { getEmailSetup } from "./alerts";

function iso(value: number | null | undefined) {
  return value ? new Date(value).toISOString() : null;
}

export async function buildDashboard(
  d1: D1Database,
  monitorFallbackError?: string,
) {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60_000;
  const [
    countRow,
    evaluationRow,
    eventRows,
    forecastRows,
    watchlistRows,
    runRows,
    sourceRows,
    alertRows,
    calibrationRows,
  ] = await Promise.all([
    d1
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM sources WHERE enabled = 1) AS source_count,
          (SELECT COUNT(*) FROM sources WHERE enabled = 1 AND status = 'online') AS sources_online,
          (SELECT COUNT(*) FROM events WHERE first_seen_at_ms >= ?) AS events_24h,
          (SELECT COUNT(*) FROM events WHERE first_seen_at_ms >= ? AND priority IN ('P0','P1')) AS priority_24h,
          (SELECT COUNT(*) FROM forecasts f
             WHERE NOT EXISTS (SELECT 1 FROM actuals a WHERE a.forecast_id = f.id)) AS active_forecasts,
          (SELECT COUNT(*) FROM securities WHERE enabled = 1 AND watch_tier > 0) AS watchlist_count,
          (SELECT COUNT(*) FROM alerts WHERE status IN ('queued','retry','needs_setup')) AS queued_alerts`,
      )
      .bind(dayAgo, dayAgo)
      .first<Record<string, number>>(),
    d1
      .prepare(
        `SELECT AVG(brier_score) AS mean_brier,
                AVG(CASE WHEN direction_hit = 1 THEN 1.0 ELSE 0.0 END) AS hit_rate,
                COUNT(*) AS resolved_count
         FROM evaluations`,
      )
      .first<{
        mean_brier: number | null;
        hit_rate: number | null;
        resolved_count: number;
      }>(),
    d1
      .prepare(
        `SELECT e.*, s.name AS source_name,
                s.reliability_tier AS source_tier,
                (SELECT sec.ticker
                 FROM event_securities es
                 JOIN securities sec ON sec.id = es.security_id
                 WHERE es.event_id = e.id
                 ORDER BY sec.watch_tier ASC LIMIT 1) AS ticker,
                (SELECT es.impact_direction
                 FROM event_securities es
                 WHERE es.event_id = e.id
                 ORDER BY es.directness DESC LIMIT 1) AS direction
         FROM events e
         JOIN sources s ON s.id = e.source_id
         ORDER BY e.first_seen_at_ms DESC, e.materiality DESC
         LIMIT 30`,
      )
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT f.*, a.outcome_key, a.actual_return, a.benchmark_return,
                a.relative_return, ev.brier_score, ev.direction_hit
         FROM forecasts f
         LEFT JOIN actuals a ON a.forecast_id = f.id AND a.revision_no = 1
         LEFT JOIN evaluations ev ON ev.forecast_id = f.id
         ORDER BY f.ledger_seq DESC
         LIMIT 30`,
      )
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT sec.*,
                (SELECT MAX(e.first_seen_at_ms)
                 FROM event_securities es
                 JOIN events e ON e.id = es.event_id
                 WHERE es.security_id = sec.id) AS last_event_at_ms
         FROM securities sec
         WHERE sec.enabled = 1 AND sec.watch_tier > 0
         ORDER BY sec.watch_tier ASC, sec.ticker ASC`,
      )
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT * FROM ingestion_runs
         ORDER BY started_at_ms DESC LIMIT 12`,
      )
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT * FROM sources
         ORDER BY reliability_tier ASC, name ASC`,
      )
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT * FROM alerts ORDER BY created_at_ms DESC LIMIT 20`,
      )
      .all<Record<string, unknown>>(),
    d1
      .prepare(
        `SELECT
           CAST(f.probability_up * 10 AS INTEGER) AS bucket_no,
           AVG(f.probability_up) AS predicted,
           AVG(CASE WHEN a.outcome_key = 'up' THEN 1.0 ELSE 0.0 END) AS actual,
           COUNT(*) AS sample_count
         FROM forecasts f
         JOIN actuals a ON a.forecast_id = f.id
         GROUP BY CAST(f.probability_up * 10 AS INTEGER)
         ORDER BY bucket_no ASC`,
      )
      .all<{
        bucket_no: number;
        predicted: number;
        actual: number;
        sample_count: number;
      }>(),
  ]);

  const counts = countRow ?? {};
  const emailSetup = getEmailSetup();
  const sources = sourceRows.results.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.source_kind,
    reliabilityTier: row.reliability_tier,
    status: row.status,
    enabled: Boolean(row.enabled),
    lastSuccessAt: iso(row.last_success_at_ms as number | null),
    lastError: row.last_error,
  }));
  const online = Number(counts.sources_online ?? 0);
  const enabledSources = Number(counts.source_count ?? 0);
  const status =
    monitorFallbackError || online === 0
      ? "partial"
      : sources.some((source) => source.status === "failed")
        ? "degraded"
        : "healthy";

  return {
    snapshotAt: new Date(now).toISOString(),
    status,
    mode: "d1",
    system: {
      monitoring: online > 0 ? "sites_manual" : "partial",
      dataMode: "D1",
      email: emailSetup.configured ? "online" : "needs_setup",
      emailEnabled: emailSetup.configured,
      lastRunAt: iso(
        (runRows.results[0]?.started_at_ms as number | undefined) ?? null,
      ),
      lastRunStatus: runRows.results[0]?.status ?? null,
      scheduler: "sites_manual",
      monitorApi: monitorFallbackError ? "degraded" : "not_configured",
      monitorError: monitorFallbackError ?? null,
    },
    metrics: {
      watchlistCount: Number(counts.watchlist_count ?? 0),
      healthySources: online,
      totalSources: enabledSources,
      openForecasts: Number(counts.active_forecasts ?? 0),
      resolvedForecasts: evaluationRow?.resolved_count ?? 0,
      directionHitRate: evaluationRow?.hit_rate ?? null,
      p95LatencyMs: null,
      sourcesOnline: online,
      sourceCount: enabledSources,
      events24h: Number(counts.events_24h ?? 0),
      highPriorityEvents: Number(counts.priority_24h ?? 0),
      activeForecasts: Number(counts.active_forecasts ?? 0),
      brierScore: evaluationRow?.mean_brier ?? null,
      hitRate: evaluationRow?.hit_rate ?? null,
      queuedAlerts: Number(counts.queued_alerts ?? 0),
    },
    kpis: {
      activeSources: online,
      watchlistCount: Number(counts.watchlist_count ?? 0),
      events24h: Number(counts.events_24h ?? 0),
      activeForecasts: Number(counts.active_forecasts ?? 0),
    },
    events: eventRows.results.map((row) => ({
      id: row.id,
      ticker: row.ticker,
      eventType: row.event_type,
      priority: row.priority,
      headline: row.headline,
      summary: row.summary,
      sourceName: row.source_name,
      sourceTier: row.source_tier,
      sourceUrl: row.source_url,
      url: row.source_url,
      publishedAt: iso(row.first_published_at_ms as number | null),
      discoveredAt: iso(row.first_seen_at_ms as number),
      detectedAt: iso(row.first_seen_at_ms as number),
      direction: row.direction ?? "unknown",
      status: row.status,
      confidence: row.confidence,
      materiality: row.materiality,
      revision: row.material_revision,
    })),
    forecasts: forecastRows.results.map((row) => ({
      id: row.id,
      ledgerSeq: row.ledger_seq,
      ticker: row.ticker,
      forecastType: row.forecast_type,
      targetDefinition: row.target_definition,
      hypothesis: row.hypothesis,
      direction: row.direction,
      probabilityUp: row.probability_up,
      probabilityBase: row.probability_base,
      probabilityDown: row.probability_down,
      horizon: row.horizon,
      resolutionAt: iso(row.resolution_at_ms as number | null),
      resolutionCriteria: row.resolution_criteria,
      benchmark: row.benchmark,
      returnLow: row.return_low,
      returnHigh: row.return_high,
      rationale: row.rationale,
      status: row.outcome_key ? "resolved" : row.status,
      eligibility: row.eligibility,
      slotCode: row.slot_code,
      frozenAt: iso(row.frozen_at_ms as number),
      informationCutoffAt: iso(row.information_cutoff_at_ms as number),
      chainHash: row.chain_hash,
      actualOutcome: row.outcome_key,
      actualReturn: row.actual_return,
      benchmarkReturn: row.benchmark_return,
      relativeReturn: row.relative_return,
      brierScore: row.brier_score,
      directionHit:
        row.direction_hit === null || row.direction_hit === undefined
          ? null
          : Boolean(row.direction_hit),
    })),
    calibration: calibrationRows.results.map((row) => ({
      id: `bin-${row.bucket_no}`,
      label: `${row.bucket_no * 10}–${Math.min(100, (row.bucket_no + 1) * 10)}%`,
      predicted: row.predicted,
      actual: row.actual,
      count: row.sample_count,
    })),
    watchlist: watchlistRows.results.map((row) => ({
      ticker: row.ticker,
      company: row.issuer_name,
      sector: row.sector,
      theme: row.theme,
      tier: row.watch_tier,
      benchmark: row.benchmark,
      status: row.status,
      lastEventAt: iso(row.last_event_at_ms as number | null),
    })),
    runs: runRows.results.map((row) => ({
      id: row.id,
      trigger: row.trigger,
      type: row.collector_key,
      status: row.status,
      startedAt: iso(row.started_at_ms as number),
      completedAt: iso(row.completed_at_ms as number | null),
      eventsSeen: row.fetched_count,
      newEvents: row.new_events,
      alertsQueued: row.alerts_queued,
      alertsSent: row.alerts_sent,
      errorCount: row.error_count,
      message: row.message,
    })),
    sources,
    sourceHealth: sources,
    scorecard: {
      resolvedForecasts: evaluationRow?.resolved_count ?? 0,
      meanBrier: evaluationRow?.mean_brier ?? null,
      hitRate: evaluationRow?.hit_rate ?? null,
      calibrationReady: (evaluationRow?.resolved_count ?? 0) >= 30,
    },
    alerts: alertRows.results.map((row) => ({
      id: row.id,
      priority: row.priority,
      recipient: row.recipient,
      subject: row.subject,
      status: row.status,
      createdAt: iso(row.created_at_ms as number),
      sentAt: iso(row.sent_at_ms as number | null),
      error: row.last_error,
    })),
  };
}
