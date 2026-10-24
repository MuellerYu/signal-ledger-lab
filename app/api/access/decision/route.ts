import { ensureDatabase, getD1 } from "@/db";
import { isAuthorizedMutation } from "@/lib/auth";
import {
  decideSiteAccessRequest,
  siteOwnerEmail,
} from "@/lib/site-access";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthorizedMutation(request)) {
    return Response.json(
      { error: "Only the site owner can approve access.", status: "unauthorized" },
      { status: 403 },
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    token?: string;
    decision?: string;
  } | null;
  const token = payload?.token?.trim() ?? "";
  const decision =
    payload?.decision === "approved" || payload?.decision === "denied"
      ? payload.decision
      : null;
  if (!token || !decision) {
    return Response.json(
      { error: "The approval link or decision is invalid.", status: "invalid_request" },
      { status: 422 },
    );
  }

  const d1 = getD1();
  if (!d1) {
    return Response.json(
      { error: "The approval service is temporarily unavailable.", status: "unavailable" },
      { status: 503 },
    );
  }

  await ensureDatabase(d1);
  const result = await decideSiteAccessRequest(
    d1,
    token,
    decision,
    siteOwnerEmail(),
  );
  if (!result.ok) {
    return Response.json(
      { error: "This access request was not found.", status: result.status },
      { status: 404 },
    );
  }
  return Response.json({
    ok: true,
    status: result.status,
    message:
      result.status === "approved"
        ? "Approved. This account can now view the site."
        : result.status === "denied"
          ? "Declined. This request will not receive access."
          : "This request has already been processed.",
  });
}
