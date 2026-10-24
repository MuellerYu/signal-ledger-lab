// A D1-shaped adapter over node:sqlite, so Phase 2 tests run against a real SQL
// engine — the same conditional-UPDATE semantics and the same CHECK constraints
// the migration declares — rather than a hand-written fake that could agree with
// a bug.

import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";

const clean = (values) => values.map((value) => (value === undefined ? null : value));

export function createD1() {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      return {
        bind(...values) {
          const bound = clean(values);
          return {
            async run() {
              const result = db.prepare(sql).run(...bound);
              return { success: true, meta: { changes: Number(result.changes ?? 0) } };
            },
            async first() {
              return db.prepare(sql).get(...bound) ?? null;
            },
            async all() {
              return { success: true, results: db.prepare(sql).all(...bound) };
            },
          };
        },
      };
    },
  };
}

/** Applies a migration file, statement by statement. */
export async function applyMigration(d1, path) {
  const sql = await readFile(new URL(path, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) d1.exec(trimmed);
  }
}

/** Every text column of every table, for "is this string anywhere in the DB" checks. */
export function allTextInDatabase(d1) {
  const tables = d1.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  const found = [];
  for (const { name } of tables) {
    for (const row of d1.raw.prepare(`SELECT * FROM "${name}"`).all()) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") found.push(value);
      }
    }
  }
  return found;
}

export const MIGRATION_PATH = "../../monitor-worker/migrations/0015_membership.sql";
