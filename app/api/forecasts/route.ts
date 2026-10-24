import { ensureDatabase, getD1 } from "@/db";
import { isAuthorizedMutation, unauthorizedResponse } from "@/lib/auth";
import {
  ForecastValidationError,
  freezeForecast,
} from "@/lib/forecasts";
import { forwardMonitorForecast } from "@/lib/monitor-proxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthorizedMutation(request)) return unauthorizedResponse();
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: "A JSON request body is required.", status: "invalid_forecast" },
      { status: 400 },
    );
  }

  const upstream = await forwardMonitorForecast(payload);
  if (upstream.configured) {
    if (upstream.ok) {
      return Response.json(upstream.data, { status: upstream.status });
    }
    return Response.json(
      {
        error: upstream.error,
        status: "monitor_forecast_failed",
        detail: upstream.data ?? null,
      },
      { status: upstream.status },
    );
  }

  const d1 = getD1();
  if (!d1) {
    return Response.json(
      {
        error: "D1 is unavailable; an immutable forecast cannot be persisted.",
        status: "needs_setup",
      },
      { status: 503 },
    );
  }

  try {
    await ensureDatabase(d1);
    const forecast = await freezeForecast(d1, payload);
    return Response.json(
      { ok: true, status: "frozen", forecast },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ForecastValidationError) {
      return Response.json(
        { error: error.message, status: "invalid_forecast" },
        { status: 422 },
      );
    }
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to freeze the forecast.",
        status: "failed",
      },
      { status: 500 },
    );
  }
}
