import {
  DEFAULT_COVERAGE_SEED,
  getInvestmentSnapshot,
  getInvestmentSnapshots,
  rankSnapshotsByRecency,
  rankSnapshotsByValuationGap,
  readValuationViews,
  recordValuationView,
  SNAPSHOT_ENGINE_VERSION,
  supportedSnapshotUniverse,
} from "@/lib/investment-snapshot";
import { getCurrentEntitlement } from "@/lib/access";
import { isPublicSampleTicker } from "@/lib/public-samples";
import { teaserSnapshot } from "@/lib/valuation-teaser";

export const dynamic = "force-dynamic";

const MAX_REQUESTED = 24;

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const requested = String(query.get("tickers") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const single = String(query.get("ticker") ?? "").trim();
  const scope = String(query.get("scope") ?? "").trim();

  if (single && !requested.length) {
    const snapshot = await getInvestmentSnapshot(single);
    if (!snapshot) {
      return Response.json(
        { schema: SNAPSHOT_ENGINE_VERSION, status: "unavailable", ticker: single.toUpperCase(), error: "This security does not have enough verified public evidence for a valuation snapshot." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (query.get("view") === "1") await recordValuationView(snapshot.ticker);
    const entitlement = await getCurrentEntitlement();
    // The two public sample tickers serve their full snapshot even to FREE —
    // an explicit editorial exception, not a widened entitlement.
    const projected = entitlement.tier === "PRO" || isPublicSampleTicker(single) ? snapshot : teaserSnapshot(snapshot);
    return Response.json({ schema: SNAPSHOT_ENGINE_VERSION, generatedAt: new Date().toISOString(), snapshot: projected }, { headers: { "Cache-Control": "no-store" } });
  }

  const universe = requested.length
    ? requested
    : scope === "home"
      ? [...(await readValuationViews(8)), ...DEFAULT_COVERAGE_SEED]
      : DEFAULT_COVERAGE_SEED;

  const snapshots = await getInvestmentSnapshots(universe, MAX_REQUESTED);
  // Server-side shaping: ranking (largestGaps / recentUpdates) runs on the full
  // snapshots and yields only tickers — no premium numbers leave the server.
  // The snapshots array itself is projected to a teaser for FREE clients.
  const entitlement = await getCurrentEntitlement();
  const projectedSnapshots = entitlement.tier === "PRO" ? snapshots : snapshots.map((snapshot) => teaserSnapshot(snapshot));
  return Response.json(
    {
      schema: SNAPSHOT_ENGINE_VERSION,
      generatedAt: new Date().toISOString(),
      aiUsed: false,
      supportedUniverseSize: supportedSnapshotUniverse().length,
      universe: [...new Set(universe.map((ticker) => ticker.toUpperCase()))],
      snapshots: projectedSnapshots,
      sections: {
        mostViewed: [...(await readValuationViews(6))],
        largestGaps: rankSnapshotsByValuationGap(snapshots, 6).map((snapshot) => snapshot.ticker),
        recentUpdates: rankSnapshotsByRecency(snapshots, 6).map((snapshot) => snapshot.ticker),
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
