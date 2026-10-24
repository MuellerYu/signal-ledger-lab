import { reviewTopOptions, type OptionsReviewRequest } from "@/lib/options-ai";
import { requirePro, upgradeRequired } from "@/lib/access";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // AI options review is part of the advanced options intelligence tier.
  if (!(await requirePro())) return upgradeRequired();

  try {
    const body = await request.json() as OptionsReviewRequest;
    const review = await reviewTopOptions(body);
    return Response.json({ schema: "signal-ledger.options-review.v1", ...review }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "OPTIONS_AI_UNAVAILABLE";
    const status = code === "INVALID_OPTIONS_REVIEW" ? 400 : code === "OPTIONS_AI_NOT_CONFIGURED" ? 424 : 503;
    const message = status === 400 ? "The options review request is invalid." : status === 424 ? "The optional AI reviewer is not configured." : "The optional AI reviewer is temporarily unavailable.";
    return Response.json({ error: message, code, options_AI_used: false }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
