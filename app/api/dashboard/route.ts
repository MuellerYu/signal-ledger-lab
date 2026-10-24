import { ensureDatabase, getD1 } from "@/db";
import { buildDashboard } from "@/lib/dashboard";
import { fetchMonitorDashboard } from "@/lib/monitor-proxy";
import { publicDashboard } from "@/lib/public-dashboard";
import { resolveMember } from "@/lib/member-session";
import { buildFixtureDashboard } from "@/lib/seed-data";
import { createSnapshotCache, snapshotPayload } from "@/lib/snapshot-cache";

export const dynamic = "force-dynamic";
const getSnapshot = createSnapshotCache();

function noStoreJson(payload: unknown, status = 200) {
  return Response.json(payload, {
    status,
    // This response is now user-specific (PRO gating), so it must never be
    // stored by a shared or intermediate cache. `no-store` alone already
    // forbids every cache; `private` states the intent explicitly.
    headers: { "Cache-Control": "private, no-store" },
  });
}

async function loadDashboard() {
  // The monitor is the production source. Do not initialize a second database
  // on public reads, or substitute demo/local data when that source is down.
  const monitor = await fetchMonitorDashboard();
  if (monitor.configured && monitor.ok) {
    return monitor.data;
  }
  if (monitor.configured) throw new Error(monitor.error);
  const d1 = getD1();

  if (!d1) {
    const fixture = buildFixtureDashboard();
    return {
      ...fixture,
      system: {
        ...fixture.system,
        monitorApi: "not_configured",
      },
    };
  }

  try {
    await ensureDatabase(d1);
    return await buildDashboard(d1);
  } catch (error) {
    const fixture = buildFixtureDashboard();
    return {
      ...fixture,
      status: "partial",
      system: {
        ...fixture.system,
        database: "degraded",
        databaseError:
          error instanceof Error ? error.message : "D1 initialization failed.",
      },
    };
  }
}

export async function GET(request: Request) {
  // Fail closed to FREE. Member resolution is the entitlement boundary, and it
  // must never default to PRO: a missing or invalid session is FREE (handled
  // inside resolveMember), and a membership-DB / lookup error must also land on
  // FREE rather than grant PRO or take the public dashboard down with it.
  let tier: "FREE" | "PRO" = "FREE";
  try {
    tier = (await resolveMember()).tier;
  } catch {
    tier = "FREE";
  }

  try {
    const key = new URL("/__snapshot/dashboard-v1", request.url).href;
    return noStoreJson(
      publicDashboard(
        snapshotPayload(await getSnapshot(key, loadDashboard)),
        tier,
      ),
    );
  } catch (error) {
    const quotaExceeded = /daily.*(?:read|limit)|exceeded.*D1|row read limit/i.test(error instanceof Error ? error.message : "");
    return Response.json({
      code: quotaExceeded ? "DATA_QUOTA_EXCEEDED" : "DATA_UNAVAILABLE",
      error: quotaExceeded
        ? "The daily database read limit has been reached. Cloudflare resets this allowance at 00:00 UTC. Automatic retries are enabled; refreshing the page does not reset the allowance."
        : "Live data is temporarily unavailable. Previously loaded data, if any, is preserved. Retrying automatically.",
    }, {
      status: 503,
      headers: { "Cache-Control": "private, no-store", "Retry-After": "60" },
    });
  }
}
