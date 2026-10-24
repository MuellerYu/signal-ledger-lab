/**
 * The minimal structural D1 shape shared by lib modules that read or write the
 * membership database.
 *
 * The worker and the Pages app each compile against a different `D1Database`
 * interface (the worker declares its own slim one; the Pages app uses the
 * ambient Cloudflare type with `exec`/`dump`/`raw`). A lib function that takes
 * the ambient `D1Database` therefore cannot be called from the worker. This
 * type states only what those functions actually use — `prepare().bind()` then
 * `first`/`all`/`run` — so it is satisfied by BOTH the worker's and the ambient
 * interface, and a lib function typed against it stays callable from either
 * side.
 *
 * It is deliberately structural and narrow: nothing here can drift from what the
 * membership queries need, and nothing here can be pointed at a richer database
 * interface by accident.
 */

export interface MinimalD1PreparedStatement {
  bind(...values: unknown[]): MinimalD1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

export interface MinimalD1Database {
  prepare(query: string): MinimalD1PreparedStatement;
}
