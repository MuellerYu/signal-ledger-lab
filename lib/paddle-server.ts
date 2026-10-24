/**
 * Paddle server-side helpers for the Pages app.
 *
 * These call the Paddle API with the server-only API key (never the client
 * bundle) to do two things the browser cannot:
 *
 *   1. Pre-create a Paddle customer for a signed-in user, so checkout can pass
 *      `customer.id` and every later webhook carries a `customer_id` we already
 *      map back through `billing_customers`.
 *   2. Mint a customer-portal session URL on demand, so the account page can
 *      hand the member to Paddle's hosted subscription management.
 *
 * The webhook's signature verification and event mapping live in
 * lib/paddle-billing + monitor-worker/src/paddle-webhook.ts; nothing here
 * touches the webhook secret.
 */

import { newId } from "./crypto";
import { getMembershipD1 } from "./membership-db";
import { getBindings } from "./runtime";

export type PaddlePlan = "monthly" | "annual" | "annual_onetime";
export type PaddleCurrency = "usd" | "cny";

export type PaddlePriceKey = "monthly_usd" | "monthly_cny" | "annual_usd" | "annual_cny" | "onetime_cny";

/** Resolves a plan + currency to a concrete price id key. The one-time plan is CNY-only. */
export function priceKeyFor(plan: PaddlePlan, currency: PaddleCurrency): PaddlePriceKey | null {
  if (plan === "annual_onetime") return "onetime_cny";
  if (plan === "monthly") return currency === "cny" ? "monthly_cny" : "monthly_usd";
  return currency === "cny" ? "annual_cny" : "annual_usd";
}

export type PaddleServerConfig = {
  configured: boolean;
  environment: "sandbox" | "production";
  apiBaseUrl: string;
  clientToken: string;
  priceIds: Record<PaddlePriceKey, string>;
};

/** Reads the Paddle configuration from server bindings. Never from the browser. */
export function paddleServerConfig(): PaddleServerConfig {
  const bindings = getBindings();
  const environment = bindings.PADDLE_ENVIRONMENT?.trim() === "production" ? "production" : "sandbox";
  const apiBaseUrl = environment === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
  const apiKey = bindings.PADDLE_API_KEY?.trim() ?? "";
  const clientToken = bindings.PADDLE_CLIENT_SIDE_TOKEN?.trim() ?? "";

  const priceIds: Record<PaddlePriceKey, string> = {
    monthly_usd: bindings.PADDLE_PRICE_PRO_MONTHLY_USD?.trim() ?? "",
    monthly_cny: bindings.PADDLE_PRICE_PRO_MONTHLY_CNY?.trim() ?? "",
    annual_usd: bindings.PADDLE_PRICE_PRO_ANNUAL_USD?.trim() ?? "",
    annual_cny: bindings.PADDLE_PRICE_PRO_ANNUAL_CNY?.trim() ?? "",
    onetime_cny: bindings.PADDLE_PRICE_PRO_ONETIME_CNY?.trim() ?? "",
  };

  return {
    configured: Boolean(apiKey && clientToken && Object.values(priceIds).every(Boolean)),
    environment,
    apiBaseUrl,
    clientToken,
    priceIds,
  };
}

/** The API key, or null when it is not configured. */
export function paddleApiKey(): string | null {
  return getBindings().PADDLE_API_KEY?.trim() || null;
}

async function paddleApi<T>(config: PaddleServerConfig, path: string, init?: RequestInit): Promise<T> {
  const apiKey = paddleApiKey();
  if (!apiKey) throw new Error("PADDLE_API_KEY is not configured.");
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Paddle API ${path} failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

/**
 * Returns the Paddle customer id for a user, creating the Paddle customer (and
 * the `billing_customers` mapping) on first use. The mapping is what lets the
 * webhook resolve `data.customer_id` back to this user.
 */
export async function ensurePaddleCustomer(
  userId: string,
  email: string,
  nowIso: string,
): Promise<{ customerId: string; created: boolean }> {
  const d1 = getMembershipD1();
  if (!d1) throw new Error("Membership database is not bound.");

  const existing = await d1
    .prepare(`SELECT provider_customer_id FROM billing_customers WHERE user_id = ? AND provider = 'paddle' LIMIT 1`)
    .bind(userId)
    .first<{ provider_customer_id: string }>();
  if (existing?.provider_customer_id) return { customerId: existing.provider_customer_id, created: false };

  const config = paddleServerConfig();
  const created = await paddleApi<{ data: { id: string } }>(config, "/customers", {
    method: "POST",
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
  });
  const customerId = created?.data?.id;
  if (!customerId) throw new Error("Paddle did not return a customer id.");

  await d1
    .prepare(
      `INSERT OR IGNORE INTO billing_customers
         (id, user_id, provider, provider_customer_id, created_at, updated_at)
       VALUES (?, ?, 'paddle', ?, ?, ?)`,
    )
    .bind(newId("billing"), userId, customerId, nowIso, nowIso)
    .run();

  return { customerId, created: true };
}

/** Mints a customer-portal session and returns its overview URL. */
export async function createPortalSessionUrl(customerId: string): Promise<string> {
  const config = paddleServerConfig();
  const session = await paddleApi<{ data: { urls?: { general?: { overview?: string } } } }>(
    config,
    `/customers/${encodeURIComponent(customerId)}/portal-sessions`,
    { method: "POST", body: JSON.stringify({}) },
  );
  const url = session?.data?.urls?.general?.overview;
  if (!url) throw new Error("Paddle did not return a portal URL.");
  return url;
}
