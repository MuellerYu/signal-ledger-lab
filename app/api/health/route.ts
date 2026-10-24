import { ensureDatabase, getD1 } from "@/db";
import { getEmailSetup } from "@/lib/alerts";
import { isAuthorizedMutation } from "@/lib/auth";
import { cleanBaseUrl, getBindings } from "@/lib/runtime";

export const dynamic = "force-dynamic";
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

function publicHealth(status: "available" | "degraded", code = 200) {
  return Response.json(
    { status, checkedAt: new Date().toISOString() },
    {
      status: code,
      headers: PRIVATE_HEADERS,
    },
  );
}

export async function GET(request: Request) {
  const canInspect = isAuthorizedMutation(request);
  const bindings = getBindings();
  const email = getEmailSetup();
  const d1 = getD1();
  if (!d1) {
    if (!canInspect) {
      return cleanBaseUrl(bindings.MONITOR_API_URL)
        ? publicHealth("available")
        : publicHealth("degraded", 503);
    }
    return Response.json(
      {
        status: "partial",
        database: "unavailable",
        email: email.configured ? "ready" : "needs_setup",
        missingEmailConfig: email.missing,
        monitorApi: cleanBaseUrl(bindings.MONITOR_API_URL)
          ? "configured"
          : "not_configured",
        checkedAt: new Date().toISOString(),
      },
      { headers: PRIVATE_HEADERS },
    );
  }

  try {
    await ensureDatabase(d1);
    const sourceHealth = (
      await d1
        .prepare(
          `SELECT id, name, status, last_success_at_ms, last_error
           FROM sources ORDER BY reliability_tier ASC, name ASC`,
        )
        .all<Record<string, unknown>>()
    ).results.map((source) => ({
      id: source.id,
      name: source.name,
      status: source.status,
      lastSuccessAt: source.last_success_at_ms
        ? new Date(source.last_success_at_ms as number).toISOString()
        : null,
      error: source.last_error,
    }));
    const databaseStatus = await d1
      .prepare("SELECT 1 AS ok")
      .first<{ ok: number }>();
    const status = sourceHealth.some((source) => source.status === "failed")
      ? "degraded"
      : "healthy";
    if (!canInspect) {
      return publicHealth(status === "healthy" ? "available" : "degraded");
    }
    return Response.json(
      {
        status,
        database: databaseStatus?.ok === 1 ? "ready" : "degraded",
        email: email.configured ? "ready" : "needs_setup",
        missingEmailConfig: email.missing,
        alpaca:
          bindings.ALPACA_API_KEY_ID && bindings.ALPACA_API_SECRET_KEY
            ? "configured"
            : "optional_not_configured",
        monitorApi: cleanBaseUrl(bindings.MONITOR_API_URL)
          ? "configured"
          : "not_configured",
        sources: sourceHealth,
        checkedAt: new Date().toISOString(),
      },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    if (!canInspect) return publicHealth("degraded", 503);
    return Response.json(
      {
        status: "degraded",
        database: "failed",
        error:
          error instanceof Error ? error.message : "Database health check failed.",
        checkedAt: new Date().toISOString(),
      },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
