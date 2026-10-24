// One-time, idempotent import of legacy site_access_requests approvals.
//
// An owner approval is NOT a user email verification. This importer therefore
// records provenance only: it never sets email_verified, never creates a
// subscription, and never grants anything. An imported address stays FREE and
// unverified until it completes a first-party magic link — at which point
// ensureVerifiedUser() flips the flag through the normal flow.
//
// The legacy table is read, never written or dropped. pending / denied /
// revoked rows are skipped.
//
// Usage:
//   node scripts/import-legacy-site-access.mjs > /tmp/legacy-import.sql
//   wrangler d1 execute market-signal-monitor --remote --file=/tmp/legacy-import.sql
//
// Re-running is a no-op: rows are matched on email and only provenance columns
// are touched, and existing provenance is left as it was first recorded.

import { readFile } from "node:fs/promises";

const rowsPath = process.argv[2];
if (!rowsPath) {
  console.error("Pass the JSON output of: wrangler d1 execute market-signal-monitor --remote --json --command \"SELECT email, user_id, full_name, status FROM site_access_requests WHERE status = 'approved'\"");
  process.exit(2);
}

const raw = await readFile(rowsPath, "utf8");
const start = raw.indexOf("[");
if (start < 0) {
  console.error("Could not find a JSON payload in the input.");
  process.exit(2);
}
const parsed = JSON.parse(raw.slice(start));
const rows = parsed[0]?.results ?? parsed.results ?? [];

const quote = (value) => (value === null || value === undefined ? "NULL" : `'${String(value).replace(/'/g, "''")}'`);
const normalize = (value) => String(value ?? "").trim().toLowerCase();

const now = new Date().toISOString();
const statements = [];

for (const row of rows) {
  const email = normalize(row.email);
  if (!email) continue;

  // Provenance only. email_verified stays 0 and no subscription is created:
  // the legacy approval proves the owner said yes, not that the user controls
  // the mailbox.
  statements.push(
    `INSERT INTO users (id, email, email_verified, email_verified_at, display_name, legacy_site_access_status, legacy_imported_at, created_at, updated_at)
VALUES ('legacy_' || lower(hex(randomblob(16))), ${quote(email)}, 0, NULL, ${quote(row.full_name ?? null)}, 'approved', ${quote(now)}, ${quote(now)}, ${quote(now)})
ON CONFLICT(email) DO UPDATE SET
  legacy_site_access_status = COALESCE(users.legacy_site_access_status, excluded.legacy_site_access_status),
  legacy_imported_at = COALESCE(users.legacy_imported_at, excluded.legacy_imported_at),
  updated_at = excluded.updated_at
WHERE users.email_verified = 0;`,
  );
}

console.log(statements.join("\n"));
console.error(`prepared ${statements.length} statement(s) for ${rows.length} approved legacy row(s)`);
