import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { CREATE_STATEMENTS } from "../lib/db-schema";
import { SOURCE_SEED, WATCHLIST_SEED } from "../lib/seed-data";
import * as schema from "./schema";

type RuntimeBindings = {
  DB?: D1Database;
};

let initialization: Promise<void> | null = null;

export function getD1(): D1Database | null {
  try {
    return (env as unknown as RuntimeBindings).DB ?? null;
  } catch {
    return null;
  }
}

export function getDb() {
  const d1 = getD1();
  if (!d1) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. The API will use its explicit partial-data fallback until the binding is attached.",
    );
  }

  return drizzle(d1, { schema });
}

async function seedDatabase(d1: D1Database) {
  const now = Date.now();
  const sourceStatements = SOURCE_SEED.map((source) =>
    d1
      .prepare(
        `INSERT INTO sources (
          id, name, source_kind, reliability_tier, base_url,
          poll_interval_sec, enabled, status, config_json, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
        ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        source.id,
        source.name,
        source.sourceKind,
        source.reliabilityTier,
        source.baseUrl,
        source.pollIntervalSec,
        source.enabled ? 1 : 0,
        source.status,
        now,
      ),
  );

  const securityStatements = WATCHLIST_SEED.map((security) =>
    d1
      .prepare(
        `INSERT INTO securities (
          id, ticker, issuer_name, exchange, asset_type, cik, sector, theme,
          watch_tier, benchmark, factors_json, status, enabled, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)
        ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        security.id,
        security.ticker,
        security.issuerName,
        security.exchange,
        security.assetType,
        security.cik,
        security.sector,
        security.theme,
        security.watchTier,
        security.benchmark,
        JSON.stringify(security.factors),
        now,
      ),
  );

  if (sourceStatements.length) {
    await d1.batch(sourceStatements);
  }
  if (securityStatements.length) {
    await d1.batch(securityStatements);
  }
}

export async function ensureDatabase(d1 = getD1()) {
  if (!d1) return false;
  if (!initialization) {
    initialization = (async () => {
      await d1.batch(
        CREATE_STATEMENTS.map((statement) => d1.prepare(statement)),
      );
      await seedDatabase(d1);
    })().catch((error) => {
      initialization = null;
      throw error;
    });
  }

  await initialization;
  return true;
}
