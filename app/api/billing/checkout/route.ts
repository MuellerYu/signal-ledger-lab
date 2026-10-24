import { getCurrentUser } from "@/lib/access";
import { getBindings } from "@/lib/runtime";
import {
  authorizeCheckout,
  createCheckoutSession,
  ensureStripeCustomer,
  parseCheckoutPlan,
  stripePriceForPlan,
  stripeServerConfig,
} from "@/lib/stripe-server";

export const dynamic = "force-dynamic";

/**
 * Prepares a Stripe Checkout Session for the signed-in user.
 *
 * The browser submits only a logical plan ("monthly" | "annual"); the server is
 * the sole source of the price id, customer id and user id. A client cannot
 * inject an arbitrary Stripe price id, because the payload is never read beyond
 * `plan` — `parseCheckoutPlan` ignores everything else. Success redirect grants
 * nothing; PRO is granted only when the webhook-confirmed subscription lands.
 *
 * No secret key or webhook secret ever reaches the browser: this returns only a
 * hosted `url` to redirect to.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "sign_in_required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const gate = authorizeCheckout(user);
  if (gate.ok === false) {
    return Response.json({ error: "email_verification_required" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  const payload = (await request.json().catch(() => null)) as unknown;
  const plan = parseCheckoutPlan(payload);
  if (!plan) {
    return Response.json({ error: "invalid_plan" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const config = stripeServerConfig();
  // The mode gate is authoritative: invalid here means a mode/key mismatch, a
  // missing key, or missing price ids — all fail closed with a generic error so
  // no reason leaks to the client.
  if (!config.valid) {
    return Response.json({ error: "checkout_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const priceId = stripePriceForPlan(config, plan);
  if (!priceId) {
    return Response.json({ error: "price_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const origin = getBindings().SITE_ORIGIN?.trim() || new URL(request.url).origin;

  try {
    const { customerId } = await ensureStripeCustomer(user.id, user.email, new Date().toISOString());
    const { url } = await createCheckoutSession({
      customerId,
      priceId,
      userId: user.id,
      successUrl: `${origin}/billing/success`,
      cancelUrl: `${origin}/pricing`,
    });
    return Response.json({ url }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: "checkout_unavailable", detail: error instanceof Error ? error.message : "Unknown failure" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
