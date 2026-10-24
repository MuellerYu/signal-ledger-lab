// Read-through cache only: D1 remains the authoritative forecast/event ledger.
// Fixed keys share work across viewers; callers must authorize before lookup.
type Payload = Record<string, unknown>;
type Entry = { value?: Payload; storedAt: number; retryAt: number };
type EdgeCache = Pick<Cache, "match" | "put">;
export type Snapshot = { value: Payload; storedAt: number; stale: boolean };

export function workerEdgeCache(): EdgeCache | undefined {
  return (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default;
}

export function createSnapshotCache({
  freshMs = 60_000,
  staleMs = 24 * 60 * 60_000,
  retryMs = 60_000,
  now = Date.now,
} = {}) {
  const entries = new Map<string, Entry>();
  const flights = new Map<string, Promise<Snapshot>>();
  return async function getSnapshot(
    key: string,
    load: () => Promise<Payload>,
    edge = workerEdgeCache(),
  ): Promise<Snapshot> {
    const running = flights.get(key);
    if (running) return running;
    const work = (async () => {
      let entry = entries.get(key);
      if (!entry || now() - entry.storedAt >= freshMs) {
        try {
          const cached = await edge?.match(key);
          if (cached) {
            const candidate = await cached.json() as Entry;
            if (Number.isFinite(candidate.storedAt) && Number.isFinite(candidate.retryAt) &&
                (!entry || candidate.storedAt >= entry.storedAt)) entry = candidate;
          }
        } catch { /* Cache availability must not break source reads. */ }
      }
      if (entry) entries.set(key, entry);
      const usable = () => entry?.value && now() - entry.storedAt < staleMs;
      const result = (): Snapshot => ({ value: entry!.value!, storedAt: entry!.storedAt,
        stale: now() - entry!.storedAt >= freshMs });
      if (usable() && now() - entry!.storedAt < freshMs) return result();
      if (entry && now() < entry.retryAt) {
        if (usable()) return result();
        throw new Error("Live data is temporarily unavailable. Retrying in one minute.");
      }
      const save = async (next: Entry) => {
        entry = next;
        entries.set(key, next);
        try {
          await edge?.put(key, Response.json(next, { headers: {
            "Cache-Control": `public, max-age=${Math.ceil((next.value ? staleMs : retryMs) / 1000)}`,
          } }));
        } catch { /* Memory cache still prevents duplicate reads in this isolate. */ }
      };
      try {
        const value = await load();
        // Layered proxies must not reset the age of an upstream snapshot.
        const upstream = (value.system as Payload | undefined)?.snapshotCache as Payload | undefined;
        const upstreamTime = typeof upstream?.storedAt === "string" ? Date.parse(upstream.storedAt) : NaN;
        const storedAt = Number.isFinite(upstreamTime) ? Math.min(now(), upstreamTime) : now();
        if (now() - storedAt >= staleMs) throw new Error("Saved snapshot has expired");
        await save({ value, storedAt, retryAt: now() - storedAt >= freshMs ? now() + retryMs : 0 });
        return result();
      } catch (error) {
        const previous = usable() ? entry : undefined;
        await save({ value: previous?.value, storedAt: previous?.storedAt ?? 0,
          retryAt: now() + retryMs });
        if (previous) return result();
        throw error;
      }
    })();
    flights.set(key, work);
    try { return await work; } finally { flights.delete(key); }
  };
}

export function snapshotPayload(snapshot: Snapshot): Payload {
  const previousSystem = (snapshot.value.system ?? {}) as Payload;
  const upstreamStale = (previousSystem.snapshotCache as Payload | undefined)?.status === "stale";
  const stale = snapshot.stale || upstreamStale;
  return {
    ...snapshot.value,
    ...(stale ? { status: "partial" } : {}),
    system: {
      ...previousSystem,
      ...(stale ? { dataMode: "partial", monitorApi: "degraded" } : {}),
      snapshotCache: {
        status: stale ? "stale" : "fresh",
        storedAt: new Date(snapshot.storedAt).toISOString(),
        refreshSeconds: 60,
        ...(stale ? { message: "Live updates are unavailable. Showing the last saved snapshot; prices and news retain their original timestamps." } : {}),
      },
    },
  };
}
