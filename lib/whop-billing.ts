/** Server-only Whop integration. This release deliberately has NO live mode. */
export const WHOP_VERSION = "2026-09-15";
export const WHOP_API = "https://sandbox-api.whop.com/api/v1";
export const WHOP_EVENTS = ["payment.succeeded", "payment.failed", "membership.activated", "membership.deactivated", "membership.cancel_at_period_end_changed", "refund.created", "refund.updated"];
export type WhopPlan = "monthly" | "annual";
export type WhopBindings = {
  WHOP_API_KEY?: string;
  WHOP_WEBHOOK_SECRET?: string;
  WHOP_ENVIRONMENT?: string;
  WHOP_CHECKOUT_ENABLED?: string;
  WHOP_ACCOUNT_ID?: string;
  WHOP_PRODUCT_ID?: string;
  WHOP_PLAN_MONTHLY_ID?: string;
  WHOP_PLAN_ANNUAL_ID?: string;
  SITE_ORIGIN?: string;
};
export type WhopConfig = ReturnType<typeof whopConfig>;
export function whopConfig(env: WhopBindings) {
  const key = env.WHOP_API_KEY?.trim() || "";
  const account = env.WHOP_ACCOUNT_ID?.trim() || "";
  const product = env.WHOP_PRODUCT_ID?.trim() || "";
  const plans = { monthly: env.WHOP_PLAN_MONTHLY_ID?.trim() || "", annual: env.WHOP_PLAN_ANNUAL_ID?.trim() || "" };
  const origin = env.SITE_ORIGIN?.trim().replace(/\/+$/, "") || "";
  // Require explicit isolation: the production origin can never receive sandbox grants.
  let isolated = false;
  try {
    const u = new URL(origin);
    isolated = (u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "localhost"))
      && !["signalledgerlab.com", "www.signalledgerlab.com", "your-project.pages.dev"].includes(u.hostname)
      && u.origin === origin;
  } catch { /* missing/invalid origin fails closed */ }
  const apiReady = env.WHOP_ENVIRONMENT === "sandbox" && isolated && Boolean(key) && /^biz_[\w]+$/.test(account);
  const valid = apiReady && /^prod_[\w]+$/.test(product)
    && Object.values(plans).every(id => /^plan_[\w]+$/.test(id)) && plans.monthly !== plans.annual;
  return { key, account, product, plans, origin, apiReady, valid, checkoutEnabled: valid && env.WHOP_CHECKOUT_ENABLED === "true" };
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }
export function iso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
/** Parse dollar amounts as integers, never binary floating-point arithmetic. */
export function cents(value: unknown): number | null {
  const s = typeof value === "number" ? String(value) : value;
  if (typeof s !== "string" || !/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, fraction = ""] = s.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : null;
}
export const planTerms = (plan: WhopPlan) => plan === "monthly" ? { cents: 1999, days: 30, interval: "month" } : { cents: 17900, days: 365, interval: "year" };
export function planKind(config: WhopConfig, id: unknown): WhopPlan | null {
  return id === config.plans.monthly ? "monthly" : id === config.plans.annual ? "annual" : null;
}
export function assertPlan(plan: Record<string, unknown>, config: WhopConfig, kind: WhopPlan) {
  const terms = planTerms(kind);
  if (plan.id !== config.plans[kind] || record(plan.account).id !== config.account || record(plan.product).id !== config.product
    || plan.currency !== "usd" || plan.plan_type !== "renewal" || plan.billing_period !== terms.days
    || cents(plan.initial_price) !== 0 || cents(plan.renewal_price) !== terms.cents
    || record(plan.initial_price_due).currency !== "usd" || cents(record(plan.initial_price_due).amount) !== terms.cents
    || (plan.trial_period_days != null && plan.trial_period_days !== 0)
    || (plan.expiration_days != null && plan.expiration_days !== 0)
    || plan.split_pay_required_payments != null || plan.adaptive_pricing_enabled === true
    || plan.release_method !== "buy_now" || !["hidden", "quick_link", "visible"].includes(string(plan.visibility))) {
    throw new Error("whop_plan_mismatch");
  }
}
/** No response body, request headers or provider error is ever logged/returned. */
export async function whopApi(config: WhopConfig, path: string, options: { body?: unknown; idempotencyKey?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
  if (!config.apiReady || !path.startsWith("/")) throw new Error("whop_unavailable");
  const response = await (options.fetchImpl ?? fetch)(WHOP_API + path, {
    method: options.body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${config.key}`, "Api-Version-Date": WHOP_VERSION, "Content-Type": "application/json", ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error("whop_api_unavailable");
  return record(await response.json());
}
export function sandboxCheckoutUrl(value: unknown): string {
  const url = new URL(string(value));
  if (url.protocol !== "https:" || url.hostname !== "sandbox.whop.com" || url.port || url.username || url.password) throw new Error("invalid_checkout_url");
  return url.href;
}
export type Order = { id: string; user_id: string; plan_id: string; plan: WhopPlan; membership_id: string | null; checkout_id: string | null; checkout_url: string | null; created_at: string; status: string };
export async function createWhopCheckout(db: D1Database, config: WhopConfig, user: { id: string; emailVerified: boolean }, kind: WhopPlan, fetchImpl?: typeof fetch) {
  if (!config.checkoutEnabled || !user.emailVerified) throw new Error("checkout_unavailable");
  const current = await db.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND status != 'expired' AND access_until > ? LIMIT 1").bind(user.id, new Date().toISOString()).first();
  if (current) throw new Error("subscription_exists");
  assertPlan(await whopApi(config, `/plans/${config.plans[kind]}`, { fetchImpl }), config, kind);
  // One pending order per user and plan. Concurrent retries share the API key.
  await db.prepare("INSERT OR IGNORE INTO whop_orders (id, user_id, plan_id, plan, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
    .bind(`order_${crypto.randomUUID()}`, user.id, config.plans[kind], kind, new Date().toISOString()).run();
  const order = await db.prepare("SELECT * FROM whop_orders WHERE user_id = ? AND plan_id = ? AND status = 'pending' LIMIT 1").bind(user.id, config.plans[kind]).first<Order>();
  if (!order) throw new Error("checkout_unavailable");
  if (order.checkout_url) return { url: sandboxCheckoutUrl(order.checkout_url), order_id: order.id };
  // Do not reuse an expired provider idempotency key after an ambiguous failure.
  if (Date.now() - Date.parse(order.created_at) > 23 * 3600000) throw new Error("checkout_reconciliation_required");
  const checkout = await whopApi(config, "/checkout_configurations", { fetchImpl, idempotencyKey: order.id, body: {
    account_id: config.account, plan_id: order.plan_id, mode: "payment",
    metadata: { user_id: user.id, order_id: order.id }, redirect_url: `${config.origin}/billing/success`,
  } });
  const url = sandboxCheckoutUrl(checkout.purchase_url);
  if (!/^ch_[\w]+$/.test(string(checkout.id))) throw new Error("checkout_unavailable");
  await db.prepare("UPDATE whop_orders SET checkout_id = ?, checkout_url = ? WHERE id = ?").bind(checkout.id, url, order.id).run();
  return { url, order_id: order.id };
}

/** Standard Webhooks: Whop ws_ secret is the raw UTF-8 HMAC key. */
export async function verifyWhopSignature(raw: string, headers: Headers, secret: string, now = Date.now()): Promise<boolean> {
  const id = headers.get("webhook-id") || "";
  const timestamp = headers.get("webhook-timestamp") || "";
  if (!secret.startsWith("ws_") || !id || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const data = new TextEncoder().encode(`${id}.${timestamp}.${raw}`);
  for (const part of (headers.get("webhook-signature") || "").split(/\s+/)) {
    if (!part.startsWith("v1,")) continue;
    try {
      const signature = Uint8Array.from(atob(part.slice(3)), c => c.charCodeAt(0));
      if (signature.length === 32 && await crypto.subtle.verify("HMAC", key, signature, data)) return true;
    } catch { /* invalid signature */ }
  }
  return false;
}
