import { env } from "cloudflare:workers";

import type { WhopBindings } from "./whop-billing";

export type AppBindings = WhopBindings & {
  DB?: D1Database;
  /**
   * Dedicated store for the public model portfolios. It is deliberately
   * separate from `DB`: the portfolio tables are prefixed and its initializer
   * only ever creates those, so it is safe to point at a database the monitor
   * worker also owns.
   */
  PORTFOLIO_DB?: D1Database;
  /**
   * The membership store: users, auth, subscriptions, email preferences and the
   * service email queue. A dedicated binding rather than `DB`, so the Pages
   * app's legacy `ensureDatabase()` path can never be pointed at the live
   * market database. Read only through getMembershipD1() in lib/membership-db.
   */
  MEMBERSHIP_DB?: D1Database;
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  /** "iex" (default, available on free plans) or "sip" when the plan allows it. */
  ALPACA_DATA_FEED?: string;
  RESEND_API_KEY?: string;
  ALERT_FROM?: string;
  ALERT_FROM_EMAIL?: string;
  ALERT_TO_EMAIL?: string;
  ALERT_RECIPIENT?: string;
  ALLOWED_EMAIL?: string;
  ADMIN_TOKEN?: string;
  SEC_USER_AGENT?: string;
  MONITOR_API_URL?: string;
  MONITOR_READ_TOKEN?: string;
  CRON_SECRET?: string;
  /** Explicit loopback-only owner workspace switch for local preview. */
  LOCAL_OWNER_PREVIEW?: string;
  /** Opt-in, loopback-only AMD 2030 working-case display. Never set on public deployments. */
  AMD_2030_PREVIEW?: string;
  /**
   * The Worker that drains the service email queue (auth links). Defaults to
   * MONITOR_API_URL, since the flush route lives on the same always-on Worker.
   * Preview points this at the sandbox Worker, never the production one.
   */
  SERVICE_EMAIL_WORKER_URL?: string;
  /**
   * Shared secret for the server-to-server "flush now" nudge. Pages and the
   * Worker must hold the identical value; distinct from CRON_SECRET so nudging
   * the mail queue cannot trigger a monitor run. Preview-only value.
   */
  SERVICE_EMAIL_FLUSH_TOKEN?: string;
  IBKR_BRIDGE_URL?: string;
  IBKR_BRIDGE_TOKEN?: string;
  OPENAI_API_KEY?: string;
  OPENAI_VALUATION_MODEL?: string;
  OPENAI_REVIEW_MODEL?: string;
  OPENAI_REASONING_EFFORT?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  AI_VALUATION_ENABLED?: string;
  // Deprecated compatibility switch. New deployments use AI_VALUATION_ENABLED.
  AI_VALUATION_MODE?: "off" | "owner" | "public";
  /** Server-only secrets for first-party auth. Never exposed to the browser. */
  AUTH_LINK_DERIVATION_SECRET?: string;
  AUTH_SESSION_SECRET?: string;
  AUTH_RATE_LIMIT_SECRET?: string;
  /** Keys the signed preference links. Server-only. */
  EMAIL_PREFERENCE_SECRET?: string;
  /** Sender identities. Unset falls back to the current sender. */
  EMAIL_FROM_AUTH?: string;
  EMAIL_FROM_BRIEF?: string;
  /** The canonical public origin, for links that leave the site. */
  SITE_ORIGIN?: string;
  /**
   * Optional per-environment override for the public support inbox shown on
   * /support. When unset, the safe public default in lib/site-config is used.
   */
  SUPPORT_EMAIL?: string;
  /** Server-only. Creates Paddle customers and portal sessions. Never in the bundle. */
  PADDLE_API_KEY?: string;
  /**
   * The Paddle.js client-side token. Safe to publish (Paddle issues it for the
   * browser), but delivered server-side so it is not baked into a static bundle.
   */
  PADDLE_CLIENT_SIDE_TOKEN?: string;
  /** "sandbox" or "production". Must match the checkout environment. */
  PADDLE_ENVIRONMENT?: string;
  /** Sandbox price ids, selected by plan + currency at checkout time. */
  PADDLE_PRICE_PRO_MONTHLY_USD?: string;
  PADDLE_PRICE_PRO_MONTHLY_CNY?: string;
  PADDLE_PRICE_PRO_ANNUAL_USD?: string;
  PADDLE_PRICE_PRO_ANNUAL_CNY?: string;
  /** The one-time "WeChat Annual Access" price (billing_cycle = null). CNY only. */
  PADDLE_PRICE_PRO_ONETIME_CNY?: string;
  /**
   * The explicit payments gate. "test" (the default) refuses live keys; "live"
   * allows them and requires live price ids. A missing or unrecognized value
   * resolves to "test", so a misconfigured deploy can never accidentally enter
   * live mode. Live is never inferred from the key prefix alone.
   */
  STRIPE_PAYMENTS_MODE?: string;
  /**
   * Server-only Stripe secret key. Never exposed to the browser, never placed in
   * NEXT_PUBLIC_*. Whether it may be a live key is decided by STRIPE_PAYMENTS_MODE,
   * not by the key prefix itself.
   */
  STRIPE_SECRET_KEY?: string;
  /** Server-only. Verifies the Stripe-Signature header on inbound webhooks. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** The two Stripe recurring price ids (USD only), selected by plan at checkout. */
  STRIPE_PRICE_PRO_MONTHLY_USD?: string;
  STRIPE_PRICE_PRO_ANNUAL_USD?: string;
};

export function getBindings(): AppBindings {
  try {
    return env as unknown as AppBindings;
  } catch {
    return {};
  }
}

export function cleanBaseUrl(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

export const DEFAULT_ALERT_RECIPIENT = "owner@example.com";
