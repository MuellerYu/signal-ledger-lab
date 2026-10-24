/**
 * Stripe server-side helpers for the Pages app.
 *
 * These call the Stripe API with the server-only secret key (never the client
 * bundle) to do the three things the browser cannot:
 *
 *   1. Create a Stripe customer for a signed-in user and persist the
 *      `billing_customers` mapping, so every later webhook object carrying
 *      `customer` resolves back to this user.
 *   2. Mint a Checkout Session for a chosen logical plan (monthly/annual). The
 *      browser never submits a price id — it submits only a plan, and the server
 *      maps that to the exact configured Stripe price.
 *   3. Mint a customer-portal session URL on demand.
 *
 * The webhook's signature verification and event mapping live in
 * lib/stripe-billing + monitor-worker/src/stripe-webhook.ts; nothing here
 * touches the webhook secret.
 *
 * Stripe has one API base for test and live; the secret key's prefix
 * (`sk_test_` / `sk_live_`) is what distinguishes them, but the prefix alone is
 * NOT authoritative. Live payments run only when the explicit environment gate
 * `STRIPE_PAYMENTS_MODE=live` is set AND the key is `sk_live_` AND both live
 * price ids are present. Any mismatch fails closed, so a misconfigured deploy
 * can never silently charge real cards — and Preview/Sandbox can never drift
 * into live mode just because a live key was dropped in.
 */

import { newId } from "./crypto";
import { getMembershipD1 } from "./membership-db";
import { getBindings } from "./runtime";

export type StripePlan = "monthly" | "annual";

export type StripePaymentsMode = "test" | "live";

export type StripeServerConfig = {
  /** True when the key and both price ids are present (independent of validity). */
  configured: boolean;
  /** The declared payments mode. "live" only when STRIPE_PAYMENTS_MODE=live. */
  mode: StripePaymentsMode;
  apiBaseUrl: string;
  secretKey: string;
  /** True when the key carries the sk_live_ prefix. Informational; `valid` rules. */
  live: boolean;
  /** True only when the declared mode matches the key and all required ids exist. */
  valid: boolean;
  /** Why the config is unusable, or null when valid. Never sent to the client. */
  reason: string | null;
  priceIds: { monthly: string; annual: string };
};

/**
 * The effective payments mode. Live is enabled ONLY by an explicit
 * `STRIPE_PAYMENTS_MODE=live`; a missing, empty, or unrecognized value resolves
 * to test, so no deploy can accidentally start charging real cards just because
 * a live key was dropped in.
 */
export function stripePaymentsMode(value: string | null | undefined): StripePaymentsMode {
  return (value ?? "").trim().toLowerCase() === "live" ? "live" : "test";
}

/**
 * The single rule both checkout and portal share. The declared mode is
 * authoritative — live is never inferred from the key prefix alone — and every
 * mismatch fails closed. Pure for tests.
 */
export function validateStripePayments(
  mode: StripePaymentsMode,
  secretKey: string,
  monthly: string,
  annual: string,
): { valid: boolean; reason: string | null } {
  if (!secretKey) {
    return { valid: false, reason: "STRIPE_SECRET_KEY is not configured" };
  }
  const keyLive = secretKey.startsWith("sk_live_");
  const keyTest = secretKey.startsWith("sk_test_");

  if (mode === "live") {
    if (!keyLive) {
      return {
        valid: false,
        reason: "STRIPE_PAYMENTS_MODE is live but STRIPE_SECRET_KEY is not a live key (sk_live_…)",
      };
    }
    if (!monthly || !annual) {
      return {
        valid: false,
        reason: "Live payments require STRIPE_PRICE_PRO_MONTHLY_USD and STRIPE_PRICE_PRO_ANNUAL_USD",
      };
    }
    return { valid: true, reason: null };
  }

  // Test mode (the default, and the only mode Preview/Sandbox may use).
  if (keyLive) {
    return {
      valid: false,
      reason: "STRIPE_PAYMENTS_MODE is test but STRIPE_SECRET_KEY is a live key (sk_live_…)",
    };
  }
  if (!keyTest) {
    return {
      valid: false,
      reason: "STRIPE_SECRET_KEY is not a test key (expected sk_test_…)",
    };
  }
  if (!monthly || !annual) {
    return {
      valid: false,
      reason: "Both STRIPE_PRICE_PRO_MONTHLY_USD and STRIPE_PRICE_PRO_ANNUAL_USD are required",
    };
  }
  return { valid: true, reason: null };
}

/** Reads the Stripe configuration from server bindings. Never from the browser. */
export function stripeServerConfig(): StripeServerConfig {
  const bindings = getBindings();
  const secretKey = bindings.STRIPE_SECRET_KEY?.trim() ?? "";
  const monthly = bindings.STRIPE_PRICE_PRO_MONTHLY_USD?.trim() ?? "";
  const annual = bindings.STRIPE_PRICE_PRO_ANNUAL_USD?.trim() ?? "";
  const mode = stripePaymentsMode(bindings.STRIPE_PAYMENTS_MODE);
  const validation = validateStripePayments(mode, secretKey, monthly, annual);

  return {
    configured: Boolean(secretKey && monthly && annual),
    mode,
    apiBaseUrl: "https://api.stripe.com/v1",
    secretKey,
    live: secretKey.startsWith("sk_live_"),
    valid: validation.valid,
    reason: validation.reason,
    priceIds: { monthly, annual },
  };
}

/**
 * Parses the client checkout payload down to a logical plan. It reads only
 * `plan` — a client cannot smuggle a price id, customer id, or user id through
 * here, because every other field is ignored. Unknown plan → null.
 */
export function parseCheckoutPlan(payload: unknown): StripePlan | null {
  const value = payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>).plan
    : undefined;
  return value === "monthly" || value === "annual" ? value : null;
}

export type AuthorizeCheckoutResult =
  | { ok: true }
  | { ok: false; reason: "anonymous" | "email_unverified" };

/**
 * The checkout gate, pure for tests. Only an authenticated, email-verified user
 * may create a session. The route's `getCurrentUser()` already rejects
 * unverified sessions, but the gate is asserted here too so the endpoint never
 * relies on that ordering alone.
 */
export function authorizeCheckout(
  user: { id: string; email: string; emailVerified: boolean } | null,
): AuthorizeCheckoutResult {
  if (!user) return { ok: false, reason: "anonymous" };
  if (!user.emailVerified) return { ok: false, reason: "email_unverified" };
  return { ok: true };
}

/** The exact configured Stripe price id for a logical plan, or null. */
export function stripePriceForPlan(config: StripeServerConfig, plan: StripePlan): string | null {
  const priceId = plan === "monthly" ? config.priceIds.monthly : config.priceIds.annual;
  return priceId || null;
}

/** The API key, or null when it is not configured. */
export function stripeSecretKey(): string | null {
  return getBindings().STRIPE_SECRET_KEY?.trim() || null;
}

/** Encodes form data the way Stripe expects (application/x-www-form-urlencoded). */
function encodeForm(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function stripeApi<T>(
  config: StripeServerConfig,
  path: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
  idempotencyKey?: string,
): Promise<T> {
  if (!config.valid) {
    throw new Error(config.reason ?? "Stripe payments are not configured.");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetchImpl(`${config.apiBaseUrl}${path}`, {
    method: "POST",
    headers,
    body: encodeForm(params),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Stripe API ${path} failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

/**
 * Returns the Stripe customer id for a user, creating the Stripe customer (and
 * the `billing_customers` mapping) on first use. The mapping is what lets the
 * webhook resolve `object.customer` back to this user.
 */
export async function ensureStripeCustomer(
  userId: string,
  email: string,
  nowIso: string,
  options: { config?: StripeServerConfig; fetchImpl?: typeof fetch } = {},
): Promise<{ customerId: string; created: boolean }> {
  const d1 = getMembershipD1();
  if (!d1) throw new Error("Membership database is not bound.");

  const existing = await d1
    .prepare(`SELECT provider_customer_id FROM billing_customers WHERE user_id = ? AND provider = 'stripe' LIMIT 1`)
    .bind(userId)
    .first<{ provider_customer_id: string }>();
  if (existing?.provider_customer_id) return { customerId: existing.provider_customer_id, created: false };

  const config = options.config ?? stripeServerConfig();
  // A deterministic idempotency key, so two concurrent first-time requests hit
  // the SAME Stripe customer-create and Stripe returns the SAME customer id to
  // both — rather than creating two customers and orphaning one. Keyed by the
  // verified user id (never email alone, so a changed email cannot fork it) and
  // carrying no secret material.
  const created = await stripeApi<{ id: string }>(
    config,
    "/customers",
    {
      email: email.trim().toLowerCase(),
      "metadata[signal_ledger_user_id]": userId,
    },
    options.fetchImpl,
    `signal-ledger-customer:${userId}`,
  );
  const customerId = created?.id;
  if (!customerId) throw new Error("Stripe did not return a customer id.");

  const inserted = await d1
    .prepare(
      `INSERT OR IGNORE INTO billing_customers
         (id, user_id, provider, provider_customer_id, created_at, updated_at)
       VALUES (?, ?, 'stripe', ?, ?, ?)`,
    )
    .bind(newId("billing"), userId, customerId, nowIso, nowIso)
    .run();

  // The UNIQUE(user_id, provider) index makes a lost race structurally
  // impossible to store twice, but the loser must not trust the customer id it
  // just created: the row the winner stored is canonical, and every later
  // resolution (the portal, the webhook mapping) must agree on it. Re-read the
  // mapped id rather than returning the just-created response.
  if (!(inserted.meta?.changes != null && Number(inserted.meta.changes) > 0)) {
    const canonical = await d1
      .prepare(
        `SELECT provider_customer_id FROM billing_customers WHERE user_id = ? AND provider = 'stripe' LIMIT 1`,
      )
      .bind(userId)
      .first<{ provider_customer_id: string }>();
    if (canonical?.provider_customer_id) {
      return { customerId: canonical.provider_customer_id, created: false };
    }
  }

  return { customerId, created: true };
}

/** Creates a Checkout Session (mode=subscription) and returns its hosted URL. */
export async function createCheckoutSession(
  input: {
    customerId: string;
    priceId: string;
    userId: string;
    successUrl: string;
    cancelUrl: string;
    config?: StripeServerConfig;
    fetchImpl?: typeof fetch;
  },
): Promise<{ url: string }> {
  const config = input.config ?? stripeServerConfig();
  const session = await stripeApi<{ url: string }>(
    config,
    "/checkout/sessions",
    {
      mode: "subscription",
      customer: input.customerId,
      "line_items[0][price]": input.priceId,
      "line_items[0][quantity]": "1",
      // The browser never submits these: they are set server-side from the
      // authenticated session, and they are how the webhook resolves identity.
      client_reference_id: input.userId,
      "metadata[signal_ledger_user_id]": input.userId,
      "subscription_data[metadata][signal_ledger_user_id]": input.userId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    },
    input.fetchImpl,
  );
  if (!session?.url) throw new Error("Stripe did not return a checkout URL.");
  return session;
}

/** Mints a customer-portal session and returns its hosted URL. */
export async function createPortalSessionUrl(
  customerId: string,
  options: { config?: StripeServerConfig; fetchImpl?: typeof fetch; returnUrl: string },
): Promise<string> {
  const config = options.config ?? stripeServerConfig();
  const session = await stripeApi<{ url: string }>(
    config,
    "/billing_portal/sessions",
    {
      customer: customerId,
      return_url: options.returnUrl,
    },
    options.fetchImpl,
  );
  if (!session?.url) throw new Error("Stripe did not return a portal URL.");
  return session.url;
}
