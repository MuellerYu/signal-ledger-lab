// TEST MODE ONLY.
// Stands in for the `cloudflare:workers` module when the pipeline runs outside
// a Worker. `lib/runtime.ts` reads `env` from that module; here it reads a
// plain object the harness populates from monitor-worker/.dev.vars.
export const env = globalThis.__TESTMODE_ENV__ ?? {};
