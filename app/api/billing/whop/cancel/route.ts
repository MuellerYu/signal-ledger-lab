import { getCurrentUser } from "@/lib/access";
import { getMembershipD1 } from "@/lib/membership-db";
import { getBindings } from "@/lib/runtime";
import { whopApi, whopConfig } from "@/lib/whop-billing";

export const dynamic = "force-dynamic";
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return json({ error: "sign_in_required" }, 401);
  const config = whopConfig(getBindings());
  if (request.headers.get("origin") !== config.origin) return json({ error: "invalid_origin" }, 403);
  const db = getMembershipD1();
  if (!db || !config.valid) return json({ error: "billing_unavailable" }, 503);
  const subscriptions = await db.prepare("SELECT provider_subscription_id FROM subscriptions WHERE user_id = ? AND provider = 'whop' AND access_until > ? ORDER BY access_until DESC LIMIT 10")
    .bind(user.id, new Date().toISOString()).all<{ provider_subscription_id: string }>();
  if (!subscriptions.results.length) return json({ error: "no_subscription" }, 409);
  try {
    for (const sub of subscriptions.results) {
      if (!/^mem_[\w]+$/.test(sub.provider_subscription_id)) throw new Error("invalid_membership");
      await whopApi(config, `/memberships/${sub.provider_subscription_id}/cancel`, { body: { cancel_at_period_end: true }, idempotencyKey: `cancel:${sub.provider_subscription_id}` });
    }
    // Entitlement is only updated by verified webhooks; paid access is retained.
    return json({ requested: true }, 200);
  } catch { return json({ error: "billing_unavailable" }, 503); }
}
