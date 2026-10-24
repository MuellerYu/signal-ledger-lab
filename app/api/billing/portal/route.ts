import { getCurrentEntitlement, getCurrentUser } from "@/lib/access";
import { getMembershipD1 } from "@/lib/membership-db";
import { getBindings } from "@/lib/runtime";
import { createPortalSessionUrl, stripeServerConfig } from "@/lib/stripe-server";

export const dynamic = "force-dynamic";

/**
 * Mints a Stripe customer-portal session for a mapped PRO member, on demand.
 *
 * The URL is fully hosted by Stripe and covers subscription management, payment
 * methods and invoices, so the account page never has to build its own billing
 * surface. The session is created server-side and never stored. Requires PRO —
 * the portal manages a subscription, so it is only useful (and only safe) to
 * hand to someone who has one.
 */
export async function POST() {
  const user = await getCurrentUser();
  const entitlement = await getCurrentEntitlement();

  if (!user) {
    return Response.json({ error: "sign_in_required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (entitlement.tier !== "PRO") {
    return Response.json({ error: "upgrade_required" }, { status: 402, headers: { "Cache-Control": "no-store" } });
  }

  // Same validated-config gate as checkout: a mode/key mismatch, missing key, or
  // missing price ids fails closed here before any Stripe call.
  const config = stripeServerConfig();
  if (!config.valid) {
    return Response.json({ error: "portal_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const d1 = getMembershipD1();
  const mapping = d1
    ? await d1
        .prepare(`SELECT provider_customer_id FROM billing_customers WHERE user_id = ? AND provider = 'stripe' LIMIT 1`)
        .bind(user.id)
        .first<{ provider_customer_id: string }>()
    : null;

  if (!mapping?.provider_customer_id) {
    return Response.json({ error: "no_billing_customer" }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const origin = getBindings().SITE_ORIGIN?.trim() || "https://signalledgerlab.com";
    const url = await createPortalSessionUrl(mapping.provider_customer_id, { returnUrl: `${origin}/account` });
    return Response.json({ url }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: "portal_unavailable", detail: error instanceof Error ? error.message : "Unknown failure" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
