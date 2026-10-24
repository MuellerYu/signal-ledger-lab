import { ensureDatabase, getD1 } from "@/db";
import { isAuthorizedMutation, unauthorizedResponse } from "@/lib/auth";
import { runRefresh } from "@/lib/collectors";
import { forwardMonitorRefresh } from "@/lib/monitor-proxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthorizedMutation(request)) return unauthorizedResponse();

  const forwarded = await forwardMonitorRefresh();
  if (forwarded.configured && forwarded.ok) {
    return Response.json({
      ok: true,
      status: "forwarded",
      mode: "external_monitor",
      result: forwarded.data,
    });
  }

  const d1 = getD1();
  if (!d1) {
    return Response.json(
      {
        error:
          "Neither the external monitor nor a local D1 collector is available.",
        status: "needs_setup",
        monitorError:
          forwarded.configured && !forwarded.ok ? forwarded.error : null,
      },
      { status: 503 },
    );
  }

  try {
    await ensureDatabase(d1);
    const result = await runRefresh(d1, "sites_manual");
    return Response.json({
      ok: result.status !== "failed",
      status: result.status,
      mode: "sites_single_run",
      monitorFallbackError:
        forwarded.configured && !forwarded.ok ? forwarded.error : null,
      result,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Refresh could not complete.",
        status: "failed",
      },
      { status: 500 },
    );
  }
}
