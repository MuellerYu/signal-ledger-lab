import { ensureDatabase, getD1 } from "@/db";
import { queueAndSendTestAlert } from "@/lib/alerts";
import { isAuthorizedMutation, unauthorizedResponse } from "@/lib/auth";
import {
  DEFAULT_ALERT_RECIPIENT,
  getBindings,
} from "@/lib/runtime";
import { forwardMonitorTestEmail } from "@/lib/monitor-proxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthorizedMutation(request)) return unauthorizedResponse();

  try {
    const payload = (await request.json().catch(() => ({}))) as {
      email?: string;
    };
    const bindings = getBindings();
    const allowedRecipient = (
      bindings.ALERT_RECIPIENT ?? DEFAULT_ALERT_RECIPIENT
    ).toLowerCase();
    const recipient = (payload.email ?? allowedRecipient).trim().toLowerCase();
    if (recipient !== allowedRecipient) {
      return Response.json(
        {
          error: `Test delivery is restricted to ${allowedRecipient}.`,
          status: "invalid_recipient",
        },
        { status: 422 },
      );
    }

    const upstream = await forwardMonitorTestEmail(true);
    if (upstream.configured) {
      if (!upstream.ok) {
        return Response.json(
          {
            error: upstream.error,
            status: "failed",
            upstream: upstream.data,
          },
          { status: upstream.status },
        );
      }
      return Response.json(upstream.data, { status: upstream.status });
    }

    const d1 = getD1();
    if (!d1) {
      return Response.json(
        {
          error: "D1 is unavailable, so the email outbox cannot be audited.",
          status: "needs_setup",
        },
        { status: 503 },
      );
    }

    await ensureDatabase(d1);
    const result = await queueAndSendTestAlert(d1, recipient);
    if (result.status === "needs_setup") {
      return Response.json(
        {
          ...result,
          error: `Email is queued but not sent. Configure: ${result.missing.join(", ")}.`,
        },
        { status: 503 },
      );
    }
    if (!result.ok) {
      return Response.json(
        {
          ...result,
          error:
            "Email delivery did not complete; the outbox retained it for review.",
        },
        { status: 502 },
      );
    }
    return Response.json(result);
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Test email failed.",
        status: "failed",
      },
      { status: 500 },
    );
  }
}
