import { getBindings } from "./runtime";
import { computeOwnerForecastTree, type OwnerForecastTree } from "./owner-forecast-tree";
import type { ReportedBusinessEvidence } from "./valuation-data";

type DraftRow = { revision: number; tree_json: string; updated_at_ms: number };
type PublicationRow = { id: string; revision: number; tree_json: string; published_at_ms: number };
type EvidenceRow = { cik: string; issuer_name: string; evidence_json: string; fetched_at_ms: number };

let initialized: Promise<void> | null = null;

export function ownerForecastDb(): D1Database | null {
  return getBindings().DB ?? null;
}

/** Only the authenticated owner route initializes these tables. Public reads never write. */
export async function ensureOwnerForecastTables(db: D1Database) {
  if (!initialized) initialized = db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS owner_forecast_drafts (
      ticker TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, tree_json TEXT NOT NULL,
      updated_by TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS owner_forecast_publications (
      id TEXT PRIMARY KEY NOT NULL, ticker TEXT NOT NULL, revision INTEGER NOT NULL,
      tree_json TEXT NOT NULL, forecast_json TEXT NOT NULL, published_by TEXT NOT NULL,
      published_at_ms INTEGER NOT NULL, UNIQUE(ticker, revision))`),
    db.prepare("CREATE INDEX IF NOT EXISTS owner_forecast_publications_latest ON owner_forecast_publications (ticker, published_at_ms DESC)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS company_business_evidence (
      ticker TEXT PRIMARY KEY NOT NULL, cik TEXT NOT NULL, issuer_name TEXT NOT NULL,
      evidence_json TEXT NOT NULL, fetched_at_ms INTEGER NOT NULL)`),
  ]).then(() => undefined).catch((error) => { initialized = null; throw error; });
  await initialized;
}

export async function saveCompanyBusinessEvidence(db: D1Database, ticker: string, cik: string, issuerName: string, evidence: ReportedBusinessEvidence) {
  await db.prepare(`INSERT INTO company_business_evidence (ticker, cik, issuer_name, evidence_json, fetched_at_ms)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(ticker) DO UPDATE SET cik = excluded.cik,
    issuer_name = excluded.issuer_name, evidence_json = excluded.evidence_json, fetched_at_ms = excluded.fetched_at_ms`)
    .bind(ticker, cik, issuerName, JSON.stringify(evidence), Date.now()).run();
}

export async function loadCompanyBusinessEvidence(ticker: string): Promise<{
  cik: string; issuerName: string; evidence: ReportedBusinessEvidence; fetchedAt: number;
} | null> {
  const db = ownerForecastDb();
  if (!db) return null;
  try {
    const row = await db.prepare("SELECT cik, issuer_name, evidence_json, fetched_at_ms FROM company_business_evidence WHERE ticker = ?")
      .bind(ticker).first<EvidenceRow>();
    if (!row) return null;
    return { cik: row.cik, issuerName: row.issuer_name, evidence: JSON.parse(row.evidence_json) as ReportedBusinessEvidence,
      fetchedAt: row.fetched_at_ms };
  } catch { return null; }
}

/** One bounded read for the coverage shelf instead of one D1 query per issuer. */
export async function loadCompanyBusinessEvidenceBatch(tickers: readonly string[]) {
  const db = ownerForecastDb();
  if (!db || tickers.length === 0) return new Map<string, Awaited<ReturnType<typeof loadCompanyBusinessEvidence>>>();
  const unique = [...new Set(tickers)].slice(0, 24);
  try {
    const placeholders = unique.map(() => "?").join(",");
    const rows = await db.prepare(`SELECT ticker, cik, issuer_name, evidence_json, fetched_at_ms FROM company_business_evidence WHERE ticker IN (${placeholders})`)
      .bind(...unique).all<EvidenceRow & { ticker: string }>();
    return new Map((rows.results ?? []).map((row) => [row.ticker, {
      cik: row.cik, issuerName: row.issuer_name, evidence: JSON.parse(row.evidence_json) as ReportedBusinessEvidence,
      fetchedAt: row.fetched_at_ms,
    }]));
  } catch {
    return new Map<string, Awaited<ReturnType<typeof loadCompanyBusinessEvidence>>>();
  }
}

export async function loadOwnerDraft(db: D1Database, ticker: string): Promise<{ revision: number; tree: OwnerForecastTree; updatedAt: number } | null> {
  const row = await db.prepare("SELECT revision, tree_json, updated_at_ms FROM owner_forecast_drafts WHERE ticker = ?")
    .bind(ticker).first<DraftRow>();
  if (!row) return null;
  try { return { revision: row.revision, tree: JSON.parse(row.tree_json) as OwnerForecastTree, updatedAt: row.updated_at_ms }; }
  catch { return null; }
}

export async function saveOwnerDraft(db: D1Database, tree: OwnerForecastTree, expectedRevision: number, owner: string): Promise<number | null> {
  const now = Date.now();
  const json = JSON.stringify(tree);
  if (json.length > 100_000 || !Number.isInteger(expectedRevision) || expectedRevision < 0) return null;
  if (expectedRevision === 0) {
    const insert = await db.prepare("INSERT OR IGNORE INTO owner_forecast_drafts (ticker, revision, tree_json, updated_by, updated_at_ms) VALUES (?, 1, ?, ?, ?)")
      .bind(tree.ticker, json, owner, now).run();
    return insert.meta.changes === 1 ? 1 : null;
  }
  const update = await db.prepare("UPDATE owner_forecast_drafts SET revision = revision + 1, tree_json = ?, updated_by = ?, updated_at_ms = ? WHERE ticker = ? AND revision = ?")
    .bind(json, owner, now, tree.ticker, expectedRevision).run();
  return update.meta.changes === 1 ? expectedRevision + 1 : null;
}

export async function publishOwnerDraft(db: D1Database, ticker: string, revision: number, owner: string): Promise<{ id: string; publishedAt: number } | null> {
  const draft = await loadOwnerDraft(db, ticker);
  if (!draft || draft.revision !== revision) return null;
  const result = computeOwnerForecastTree(draft.tree);
  if (!result.ready) return null;
  const id = crypto.randomUUID();
  const publishedAt = Date.now();
  const insert = await db.prepare(`INSERT OR IGNORE INTO owner_forecast_publications
    (id, ticker, revision, tree_json, forecast_json, published_by, published_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ticker, revision, JSON.stringify(draft.tree), JSON.stringify(result), owner, publishedAt).run();
  if (insert.meta.changes !== 1) {
    const existing = await db.prepare("SELECT id, published_at_ms FROM owner_forecast_publications WHERE ticker = ? AND revision = ?")
      .bind(ticker, revision).first<{ id: string; published_at_ms: number }>();
    return existing ? { id: existing.id, publishedAt: existing.published_at_ms } : null;
  }
  return { id, publishedAt };
}

export async function loadPublishedOwnerForecast(ticker: string): Promise<{
  id: string; revision: number; tree: OwnerForecastTree; publishedAt: number; result: ReturnType<typeof computeOwnerForecastTree>;
} | null> {
  const db = ownerForecastDb();
  if (!db) return null;
  let row: PublicationRow | null;
  try {
    row = await db.prepare("SELECT id, revision, tree_json, published_at_ms FROM owner_forecast_publications WHERE ticker = ? ORDER BY published_at_ms DESC, id DESC LIMIT 1")
      .bind(ticker).first<PublicationRow>();
  } catch { return null; } // Table is not initialized in this environment.
  if (!row) return null;
  try {
    const tree = JSON.parse(row.tree_json) as OwnerForecastTree;
    const result = computeOwnerForecastTree(tree);
    return result.ready ? { id: row.id, revision: row.revision, tree, publishedAt: row.published_at_ms, result } : null;
  } catch { return null; }
}
