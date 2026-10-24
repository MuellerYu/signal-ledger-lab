# D1 read-quota correction — 2026-09-05 UTC

## Evidence

The live monitor health endpoint returned D1 error 7500 (daily read limit
exceeded). Cloudflare query insights for the preceding 1-day window reported:

| Query | Average rows scanned per execution |
| --- | ---: |
| Latest 300 latency measurements from `run_sources`, ordered by `started_at` | 316,602 |
| Recent world-news briefing backfill | 3,800 |
| Dashboard world-news list | 4,795 |

These are query-insights statistics, not a reconciled account billing total.
The run-history index starts with `run_id`, so it cannot serve a global
`ORDER BY started_at`. `LIMIT 300` did not prevent a history scan.

## Changes

- Removed the run-history read from the dashboard. P95 now explicitly means
  the latest check per source, calculated from the already-loaded source rows.
- Both news queries use the existing `(region, published_at)` index and a
  24-hour range for the five supported regions. SQLite query-plan tests verify
  indexed searches instead of historical scans.
- Pending-email cleanup looks up each pending item's event by primary key;
  it no longer builds an ID list from historical events. Suppression rules
  themselves are unchanged.
- Monitor and site share 60-second read-through snapshots within each edge
  cache, with per-isolate in-flight request coalescing. This is not a globally
  serialized cache: separate Cloudflare locations may still refresh separately.
- Cached data may survive a source failure for up to 24 hours, visibly marked
  stale and keeping original timestamps. A cold failure returns an error,
  not demonstration data. Failed reads have a 60-second server cooldown.
- Visible pages refresh after one minute; hidden pages stop polling. Client
  failures back off to at most five minutes and overlapping reads are blocked.
- The production monitor is tried before any local fallback D1 initialization.
- Source definitions are written only when their configuration changes. Tasks
  skipped because they are not due no longer append empty logs or advance
  the timestamp of the last actual source check.

No new schema migration is required; no stored news, forecasts, actuals, or
audit history were deleted. Cron cadence and alert-delivery cadence are unchanged.

## Verification and limit

`tests/quota-efficiency.test.mjs` tests actual cache code, simulated concurrent
readers, stale/expired data, recovery, authorization on warm cache hits, and
SQLite query plans against the existing migrations. A 100-request concurrent
test performs one source load. This is a test result, not a measured full-day
production savings claim.

Previously consumed quota is not refunded by deploying code. Live D1 data
recovery must be checked after the account's next 00:00 UTC reset. No paid
plan upgrade was performed.

References: [D1 pricing and scan accounting](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/).
