import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const securities = sqliteTable(
  "securities",
  {
    id: text("id").primaryKey(),
    ticker: text("ticker").notNull(),
    issuerName: text("issuer_name").notNull(),
    exchange: text("exchange"),
    assetType: text("asset_type").notNull().default("equity"),
    cik: text("cik"),
    sector: text("sector"),
    theme: text("theme"),
    watchTier: integer("watch_tier").notNull().default(2),
    benchmark: text("benchmark").notNull().default("SPY"),
    factorsJson: text("factors_json").notNull().default("[]"),
    status: text("status").notNull().default("active"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("securities_ticker_unique").on(table.ticker),
    uniqueIndex("securities_cik_unique").on(table.cik),
    index("securities_tier_enabled_idx").on(table.watchTier, table.enabled),
    check("securities_watch_tier_check", sql`${table.watchTier} between 0 and 3`),
  ],
);

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    sourceKind: text("source_kind").notNull(),
    reliabilityTier: integer("reliability_tier").notNull(),
    baseUrl: text("base_url"),
    pollIntervalSec: integer("poll_interval_sec").notNull().default(300),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    status: text("status").notNull().default("needs_refresh"),
    lastSuccessAtMs: integer("last_success_at_ms"),
    lastError: text("last_error"),
    configJson: text("config_json").notNull().default("{}"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    index("sources_enabled_idx").on(table.enabled),
    check(
      "sources_reliability_tier_check",
      sql`${table.reliabilityTier} between 1 and 4`,
    ),
  ],
);

export const collectorStates = sqliteTable(
  "collector_states",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    streamKey: text("stream_key").notNull(),
    cursor: text("cursor"),
    etag: text("etag"),
    lastModified: text("last_modified"),
    lastSeenSourceAtMs: integer("last_seen_source_at_ms"),
    lastSuccessAtMs: integer("last_success_at_ms"),
    lockedUntilMs: integer("locked_until_ms"),
    failureCount: integer("failure_count").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("collector_states_source_stream_unique").on(
      table.sourceId,
      table.streamKey,
    ),
    index("collector_states_due_idx").on(table.lockedUntilMs, table.lastSuccessAtMs),
  ],
);

export const ingestionRuns = sqliteTable(
  "ingestion_runs",
  {
    id: text("id").primaryKey(),
    collectorKey: text("collector_key").notNull(),
    trigger: text("trigger").notNull().default("manual"),
    status: text("status").notNull().default("running"),
    startedAtMs: integer("started_at_ms").notNull(),
    completedAtMs: integer("completed_at_ms"),
    fetchedCount: integer("fetched_count").notNull().default(0),
    newEvents: integer("new_events").notNull().default(0),
    alertsQueued: integer("alerts_queued").notNull().default(0),
    alertsSent: integer("alerts_sent").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    message: text("message"),
  },
  (table) => [
    index("ingestion_runs_started_idx").on(table.startedAtMs),
    index("ingestion_runs_status_idx").on(table.status),
  ],
);

export const rawItems = sqliteTable(
  "raw_items",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    externalId: text("external_id").notNull(),
    canonicalUrl: text("canonical_url"),
    canonicalUrlHash: text("canonical_url_hash"),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    sourcePublishedAtMs: integer("source_published_at_ms"),
    sourceUpdatedAtMs: integer("source_updated_at_ms"),
    firstSeenAtMs: integer("first_seen_at_ms").notNull(),
    lastSeenAtMs: integer("last_seen_at_ms").notNull(),
    contentHash: text("content_hash").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
  },
  (table) => [
    uniqueIndex("raw_items_source_external_unique").on(
      table.sourceId,
      table.externalId,
    ),
    index("raw_items_published_idx").on(table.sourcePublishedAtMs),
    index("raw_items_content_hash_idx").on(table.contentHash),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    eventFingerprint: text("event_fingerprint").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    rawItemId: text("raw_item_id").references(() => rawItems.id, {
      onDelete: "restrict",
    }),
    eventType: text("event_type").notNull(),
    priority: text("priority").notNull().default("P2"),
    headline: text("headline").notNull(),
    summary: text("summary"),
    sourceUrl: text("source_url"),
    effectiveAtMs: integer("effective_at_ms"),
    firstPublishedAtMs: integer("first_published_at_ms"),
    firstSeenAtMs: integer("first_seen_at_ms").notNull(),
    lastMaterialUpdateAtMs: integer("last_material_update_at_ms").notNull(),
    status: text("status").notNull().default("confirmed"),
    factStatus: text("fact_status").notNull().default("confirmed"),
    materiality: integer("materiality").notNull().default(3),
    confidence: real("confidence").notNull().default(0.8),
    novelty: real("novelty").notNull().default(1),
    materialRevision: integer("material_revision").notNull().default(1),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("events_fingerprint_unique").on(table.eventFingerprint),
    index("events_seen_priority_idx").on(table.firstSeenAtMs, table.priority),
    index("events_type_idx").on(table.eventType),
    check("events_materiality_check", sql`${table.materiality} between 1 and 5`),
    check("events_confidence_check", sql`${table.confidence} between 0 and 1`),
    check("events_novelty_check", sql`${table.novelty} between 0 and 1`),
  ],
);

export const eventSecurities = sqliteTable(
  "event_securities",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    securityId: text("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "restrict" }),
    relationship: text("relationship").notNull().default("direct"),
    directness: real("directness").notNull().default(1),
    impactDirection: text("impact_direction").notNull().default("unknown"),
    mappingConfidence: real("mapping_confidence").notNull().default(1),
  },
  (table) => [
    uniqueIndex("event_securities_unique").on(
      table.eventId,
      table.securityId,
      table.relationship,
    ),
    index("event_securities_security_idx").on(table.securityId, table.eventId),
  ],
);

export const forecasts = sqliteTable(
  "forecasts",
  {
    id: text("id").primaryKey(),
    ledgerSeq: integer("ledger_seq").notNull(),
    securityId: text("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "restrict" }),
    ticker: text("ticker").notNull(),
    eventId: text("event_id").references(() => events.id, {
      onDelete: "restrict",
    }),
    forecastType: text("forecast_type").notNull().default("pre_event"),
    targetDefinition: text("target_definition").notNull(),
    hypothesis: text("hypothesis"),
    direction: text("direction").notNull(),
    probabilityUp: real("probability_up").notNull(),
    probabilityBase: real("probability_base").notNull(),
    probabilityDown: real("probability_down").notNull(),
    probabilitiesJson: text("probabilities_json").notNull(),
    horizon: text("horizon").notNull(),
    resolutionAtMs: integer("resolution_at_ms"),
    resolutionCriteria: text("resolution_criteria"),
    benchmark: text("benchmark").notNull().default("SPY"),
    returnLow: real("return_low"),
    returnHigh: real("return_high"),
    rationale: text("rationale"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    invalidationCondition: text("invalidation_condition"),
    modelVersion: text("model_version").notNull().default("manual-v1"),
    slotCode: text("slot_code").notNull().default("MANUAL"),
    eligibility: text("eligibility").notNull().default("official"),
    status: text("status").notNull().default("open"),
    createdAtMs: integer("created_at_ms").notNull(),
    frozenAtMs: integer("frozen_at_ms").notNull(),
    informationCutoffAtMs: integer("information_cutoff_at_ms").notNull(),
    prevChainHash: text("prev_chain_hash").notNull(),
    payloadHash: text("payload_hash").notNull(),
    chainHash: text("chain_hash").notNull(),
  },
  (table) => [
    uniqueIndex("forecasts_ledger_seq_unique").on(table.ledgerSeq),
    uniqueIndex("forecasts_chain_hash_unique").on(table.chainHash),
    index("forecasts_ticker_status_idx").on(table.ticker, table.status),
    index("forecasts_frozen_idx").on(table.frozenAtMs),
    check("forecasts_probability_up_check", sql`${table.probabilityUp} between 0 and 1`),
    check(
      "forecasts_probability_base_check",
      sql`${table.probabilityBase} between 0 and 1`,
    ),
    check(
      "forecasts_probability_down_check",
      sql`${table.probabilityDown} between 0 and 1`,
    ),
    check(
      "forecasts_probability_sum_check",
      sql`abs(${table.probabilityUp} + ${table.probabilityBase} + ${table.probabilityDown} - 1.0) < 0.000001`,
    ),
  ],
);

export const actuals = sqliteTable(
  "actuals",
  {
    id: text("id").primaryKey(),
    forecastId: text("forecast_id")
      .notNull()
      .references(() => forecasts.id, { onDelete: "restrict" }),
    outcomeKey: text("outcome_key"),
    actualValue: real("actual_value"),
    actualReturn: real("actual_return"),
    benchmarkReturn: real("benchmark_return"),
    relativeReturn: real("relative_return"),
    observedAtMs: integer("observed_at_ms").notNull(),
    availableAtMs: integer("available_at_ms").notNull(),
    sourceId: text("source_id").references(() => sources.id, {
      onDelete: "restrict",
    }),
    sourceUrl: text("source_url"),
    revisionNo: integer("revision_no").notNull().default(1),
    basis: text("basis").notNull().default("first_reported"),
    createdAtMs: integer("created_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("actuals_forecast_revision_unique").on(
      table.forecastId,
      table.revisionNo,
    ),
    index("actuals_available_idx").on(table.availableAtMs),
  ],
);

export const evaluations = sqliteTable(
  "evaluations",
  {
    id: text("id").primaryKey(),
    forecastId: text("forecast_id")
      .notNull()
      .references(() => forecasts.id, { onDelete: "restrict" }),
    actualId: text("actual_id")
      .notNull()
      .references(() => actuals.id, { onDelete: "restrict" }),
    evaluationVersion: text("evaluation_version").notNull().default("v1"),
    brierScore: real("brier_score"),
    logLoss: real("log_loss"),
    mae: real("mae"),
    intervalCovered: integer("interval_covered", { mode: "boolean" }),
    directionHit: integer("direction_hit", { mode: "boolean" }),
    baselineBrier: real("baseline_brier"),
    brierSkill: real("brier_skill"),
    evaluatedAtMs: integer("evaluated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("evaluations_forecast_version_unique").on(
      table.forecastId,
      table.evaluationVersion,
    ),
    index("evaluations_evaluated_idx").on(table.evaluatedAtMs),
  ],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").references(() => events.id, {
      onDelete: "restrict",
    }),
    recipient: text("recipient").notNull(),
    channel: text("channel").notNull().default("email"),
    priority: text("priority").notNull(),
    policyVersion: text("policy_version").notNull().default("alert-v1"),
    materialRevision: integer("material_revision").notNull().default(1),
    dedupeKey: text("dedupe_key").notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAtMs: integer("next_attempt_at_ms"),
    providerId: text("provider_id"),
    sourceToSeenMs: integer("source_to_seen_ms"),
    seenToSendMs: integer("seen_to_send_ms"),
    createdAtMs: integer("created_at_ms").notNull(),
    sentAtMs: integer("sent_at_ms"),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("alerts_dedupe_key_unique").on(table.dedupeKey),
    index("alerts_status_next_attempt_idx").on(
      table.status,
      table.nextAttemptAtMs,
    ),
    index("alerts_created_idx").on(table.createdAtMs),
  ],
);

export const siteAccessRequests = sqliteTable(
  "site_access_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    fullName: text("full_name"),
    status: text("status").notNull().default("pending"),
    approvalTokenHash: text("approval_token_hash").notNull(),
    requestedAtMs: integer("requested_at_ms").notNull(),
    emailSentAtMs: integer("email_sent_at_ms"),
    decidedAtMs: integer("decided_at_ms"),
    decidedByEmail: text("decided_by_email"),
    decisionNote: text("decision_note"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    uniqueIndex("site_access_requests_email_unique").on(table.email),
    uniqueIndex("site_access_requests_token_hash_unique").on(
      table.approvalTokenHash,
    ),
    index("site_access_requests_status_requested_idx").on(
      table.status,
      table.requestedAtMs,
    ),
    check(
      "site_access_requests_status_check",
      sql`${table.status} in ('pending', 'approved', 'denied', 'revoked')`,
    ),
  ],
);
