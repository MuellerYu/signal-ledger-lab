CREATE TABLE `site_access_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`full_name` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`approval_token_hash` text NOT NULL,
	`requested_at_ms` integer NOT NULL,
	`email_sent_at_ms` integer,
	`decided_at_ms` integer,
	`decided_by_email` text,
	`decision_note` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "site_access_requests_status_check" CHECK("site_access_requests"."status" in ('pending', 'approved', 'denied', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_access_requests_email_unique` ON `site_access_requests` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_access_requests_token_hash_unique` ON `site_access_requests` (`approval_token_hash`);--> statement-breakpoint
CREATE INDEX `site_access_requests_status_requested_idx` ON `site_access_requests` (`status`,`requested_at_ms`);