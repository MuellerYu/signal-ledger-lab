CREATE TABLE `actuals` (
	`id` text PRIMARY KEY NOT NULL,
	`forecast_id` text NOT NULL,
	`outcome_key` text,
	`actual_value` real,
	`actual_return` real,
	`benchmark_return` real,
	`relative_return` real,
	`observed_at_ms` integer NOT NULL,
	`available_at_ms` integer NOT NULL,
	`source_id` text,
	`source_url` text,
	`revision_no` integer DEFAULT 1 NOT NULL,
	`basis` text DEFAULT 'first_reported' NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`forecast_id`) REFERENCES `forecasts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actuals_forecast_revision_unique` ON `actuals` (`forecast_id`,`revision_no`);--> statement-breakpoint
CREATE INDEX `actuals_available_idx` ON `actuals` (`available_at_ms`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`recipient` text NOT NULL,
	`channel` text DEFAULT 'email' NOT NULL,
	`priority` text NOT NULL,
	`policy_version` text DEFAULT 'alert-v1' NOT NULL,
	`material_revision` integer DEFAULT 1 NOT NULL,
	`dedupe_key` text NOT NULL,
	`subject` text NOT NULL,
	`body_text` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at_ms` integer,
	`provider_id` text,
	`source_to_seen_ms` integer,
	`seen_to_send_ms` integer,
	`created_at_ms` integer NOT NULL,
	`sent_at_ms` integer,
	`last_error` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_dedupe_key_unique` ON `alerts` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `alerts_status_next_attempt_idx` ON `alerts` (`status`,`next_attempt_at_ms`);--> statement-breakpoint
CREATE INDEX `alerts_created_idx` ON `alerts` (`created_at_ms`);--> statement-breakpoint
CREATE TABLE `collector_states` (
	`source_id` text NOT NULL,
	`stream_key` text NOT NULL,
	`cursor` text,
	`etag` text,
	`last_modified` text,
	`last_seen_source_at_ms` integer,
	`last_success_at_ms` integer,
	`locked_until_ms` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collector_states_source_stream_unique` ON `collector_states` (`source_id`,`stream_key`);--> statement-breakpoint
CREATE INDEX `collector_states_due_idx` ON `collector_states` (`locked_until_ms`,`last_success_at_ms`);--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`forecast_id` text NOT NULL,
	`actual_id` text NOT NULL,
	`evaluation_version` text DEFAULT 'v1' NOT NULL,
	`brier_score` real,
	`log_loss` real,
	`mae` real,
	`interval_covered` integer,
	`direction_hit` integer,
	`baseline_brier` real,
	`brier_skill` real,
	`evaluated_at_ms` integer NOT NULL,
	FOREIGN KEY (`forecast_id`) REFERENCES `forecasts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actual_id`) REFERENCES `actuals`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evaluations_forecast_version_unique` ON `evaluations` (`forecast_id`,`evaluation_version`);--> statement-breakpoint
CREATE INDEX `evaluations_evaluated_idx` ON `evaluations` (`evaluated_at_ms`);--> statement-breakpoint
CREATE TABLE `event_securities` (
	`event_id` text NOT NULL,
	`security_id` text NOT NULL,
	`relationship` text DEFAULT 'direct' NOT NULL,
	`directness` real DEFAULT 1 NOT NULL,
	`impact_direction` text DEFAULT 'unknown' NOT NULL,
	`mapping_confidence` real DEFAULT 1 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_securities_unique` ON `event_securities` (`event_id`,`security_id`,`relationship`);--> statement-breakpoint
CREATE INDEX `event_securities_security_idx` ON `event_securities` (`security_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_fingerprint` text NOT NULL,
	`source_id` text NOT NULL,
	`raw_item_id` text,
	`event_type` text NOT NULL,
	`priority` text DEFAULT 'P2' NOT NULL,
	`headline` text NOT NULL,
	`summary` text,
	`source_url` text,
	`effective_at_ms` integer,
	`first_published_at_ms` integer,
	`first_seen_at_ms` integer NOT NULL,
	`last_material_update_at_ms` integer NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`fact_status` text DEFAULT 'confirmed' NOT NULL,
	`materiality` integer DEFAULT 3 NOT NULL,
	`confidence` real DEFAULT 0.8 NOT NULL,
	`novelty` real DEFAULT 1 NOT NULL,
	`material_revision` integer DEFAULT 1 NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "events_materiality_check" CHECK("events"."materiality" between 1 and 5),
	CONSTRAINT "events_confidence_check" CHECK("events"."confidence" between 0 and 1),
	CONSTRAINT "events_novelty_check" CHECK("events"."novelty" between 0 and 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_fingerprint_unique` ON `events` (`event_fingerprint`);--> statement-breakpoint
CREATE INDEX `events_seen_priority_idx` ON `events` (`first_seen_at_ms`,`priority`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`event_type`);--> statement-breakpoint
CREATE TABLE `forecasts` (
	`id` text PRIMARY KEY NOT NULL,
	`ledger_seq` integer NOT NULL,
	`security_id` text NOT NULL,
	`ticker` text NOT NULL,
	`event_id` text,
	`forecast_type` text DEFAULT 'pre_event' NOT NULL,
	`target_definition` text NOT NULL,
	`hypothesis` text,
	`direction` text NOT NULL,
	`probability_up` real NOT NULL,
	`probability_base` real NOT NULL,
	`probability_down` real NOT NULL,
	`probabilities_json` text NOT NULL,
	`horizon` text NOT NULL,
	`resolution_at_ms` integer,
	`resolution_criteria` text,
	`benchmark` text DEFAULT 'SPY' NOT NULL,
	`return_low` real,
	`return_high` real,
	`rationale` text,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`invalidation_condition` text,
	`model_version` text DEFAULT 'manual-v1' NOT NULL,
	`slot_code` text DEFAULT 'MANUAL' NOT NULL,
	`eligibility` text DEFAULT 'official' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at_ms` integer NOT NULL,
	`frozen_at_ms` integer NOT NULL,
	`information_cutoff_at_ms` integer NOT NULL,
	`prev_chain_hash` text NOT NULL,
	`payload_hash` text NOT NULL,
	`chain_hash` text NOT NULL,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "forecasts_probability_up_check" CHECK("forecasts"."probability_up" between 0 and 1),
	CONSTRAINT "forecasts_probability_base_check" CHECK("forecasts"."probability_base" between 0 and 1),
	CONSTRAINT "forecasts_probability_down_check" CHECK("forecasts"."probability_down" between 0 and 1),
	CONSTRAINT "forecasts_probability_sum_check" CHECK(abs("forecasts"."probability_up" + "forecasts"."probability_base" + "forecasts"."probability_down" - 1.0) < 0.000001)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forecasts_ledger_seq_unique` ON `forecasts` (`ledger_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `forecasts_chain_hash_unique` ON `forecasts` (`chain_hash`);--> statement-breakpoint
CREATE INDEX `forecasts_ticker_status_idx` ON `forecasts` (`ticker`,`status`);--> statement-breakpoint
CREATE INDEX `forecasts_frozen_idx` ON `forecasts` (`frozen_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `forecasts_official_slot_unique`
ON `forecasts` (`security_id`,`event_id`,`slot_code`)
WHERE `eligibility` = 'official' AND `event_id` IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER `forecasts_prevent_update`
BEFORE UPDATE ON `forecasts`
BEGIN
  SELECT RAISE(ABORT, 'forecast ledger is immutable');
END;--> statement-breakpoint
CREATE TRIGGER `forecasts_prevent_delete`
BEFORE DELETE ON `forecasts`
BEGIN
  SELECT RAISE(ABORT, 'forecast ledger is immutable');
END;--> statement-breakpoint
CREATE TABLE `ingestion_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`collector_key` text NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at_ms` integer NOT NULL,
	`completed_at_ms` integer,
	`fetched_count` integer DEFAULT 0 NOT NULL,
	`new_events` integer DEFAULT 0 NOT NULL,
	`alerts_queued` integer DEFAULT 0 NOT NULL,
	`alerts_sent` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE INDEX `ingestion_runs_started_idx` ON `ingestion_runs` (`started_at_ms`);--> statement-breakpoint
CREATE INDEX `ingestion_runs_status_idx` ON `ingestion_runs` (`status`);--> statement-breakpoint
CREATE TABLE `raw_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`canonical_url` text,
	`canonical_url_hash` text,
	`title` text NOT NULL,
	`excerpt` text,
	`source_published_at_ms` integer,
	`source_updated_at_ms` integer,
	`first_seen_at_ms` integer NOT NULL,
	`last_seen_at_ms` integer NOT NULL,
	`content_hash` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raw_items_source_external_unique` ON `raw_items` (`source_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `raw_items_published_idx` ON `raw_items` (`source_published_at_ms`);--> statement-breakpoint
CREATE INDEX `raw_items_content_hash_idx` ON `raw_items` (`content_hash`);--> statement-breakpoint
CREATE TABLE `securities` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`issuer_name` text NOT NULL,
	`exchange` text,
	`asset_type` text DEFAULT 'equity' NOT NULL,
	`cik` text,
	`sector` text,
	`theme` text,
	`watch_tier` integer DEFAULT 2 NOT NULL,
	`benchmark` text DEFAULT 'SPY' NOT NULL,
	`factors_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT "securities_watch_tier_check" CHECK("securities"."watch_tier" between 0 and 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `securities_ticker_unique` ON `securities` (`ticker`);--> statement-breakpoint
CREATE UNIQUE INDEX `securities_cik_unique` ON `securities` (`cik`);--> statement-breakpoint
CREATE INDEX `securities_tier_enabled_idx` ON `securities` (`watch_tier`,`enabled`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_kind` text NOT NULL,
	`reliability_tier` integer NOT NULL,
	`base_url` text,
	`poll_interval_sec` integer DEFAULT 300 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'needs_refresh' NOT NULL,
	`last_success_at_ms` integer,
	`last_error` text,
	`config_json` text DEFAULT '{}' NOT NULL,
	`created_at_ms` integer NOT NULL,
	CONSTRAINT "sources_reliability_tier_check" CHECK("sources"."reliability_tier" between 1 and 4)
);
--> statement-breakpoint
CREATE INDEX `sources_enabled_idx` ON `sources` (`enabled`);
