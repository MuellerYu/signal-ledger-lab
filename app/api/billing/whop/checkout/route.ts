import { getCurrentUser } from "@/lib/access";
import { getMembershipD1 } from "@/lib/membership-db";
import { getBindings } from "@/lib/runtime";
import { createWhopCheckout, whopConfig } from "@/lib/whop-billing";

export const dynamic = "force-dynamic";
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return json({ error: "sign_in_required" }, 401);
  if (!user.emailVerified) return json({ error: "email_verification_required" }, 403);
  const config = whopConfig(getBindings());
  if (request.headers.get("origin") !== config.origin) return json({ error: "invalid_origin" }, 403);
  const db = getMembershipD1();
  if (!db || !config.checkoutEnabled) return json({ error: "checkout_unavailable" }, 503);
  const body = await request.json().catch(() => null);
  if (body?.plan !== "monthly" && body?.plan !== "annual") return json({ error: "invalid_plan" }, 400);
  try { return json(await createWhopCheckout(db, config, user, body.plan), 200); }
  catch { return json({ error: "checkout_unavailable" }, 503); }
}
