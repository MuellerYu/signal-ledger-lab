"use client";

import { useState } from "react";
import Link from "next/link";
import ProCheckout from "../pro-checkout";

type AccountPanelProps = {
  billingProvider?: string | null;
  email: string | null;
  tier: "FREE" | "PRO";
  dailyBriefEnabled: boolean;
  accessUntil: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
};

/**
 * Formats an ISO instant for display.
 *
 * The locale and time zone are pinned deliberately. Leaving the locale as
 * `undefined` resolves to the runtime's default, which is the server's ICU
 * default on Cloudflare but the visitor's own locale in the browser — so the
 * same instant rendered as two different strings and React failed to hydrate
 * this page (error #418, "Hydration failed because the server rendered text
 * didn't match the client"). A fixed locale plus an explicit UTC zone makes
 * both sides agree, and matches `<html lang="en-US">`.
 */
const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

/**
 * The authenticated account console.
 *
 * The Daily Brief toggle posts to /api/account/preferences, which authenticates
 * the request from the session cookie exactly as /api/billing/portal does — the
 * member is already signed in here, so no extra credential is needed and the
 * switch can never be left dead by a missing server-side secret. Sign out is a
 * plain form POST that revokes the session server-side.
 */
export default function AccountPanel({
  billingProvider,
  email,
  tier,
  dailyBriefEnabled,
  accessUntil,
  cancelAtPeriodEnd,
  cancelAt,
}: AccountPanelProps) {
  const [brief, setBrief] = useState(dailyBriefEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [cancelRequested, setCancelRequested] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalError, setPortalError] = useState("");

  async function openPortal() {
    if (portalBusy) return;
    setPortalBusy(true);
    setPortalError("");
    try {
      const response = await fetch(billingProvider === "whop" ? "/api/billing/whop/cancel" : "/api/billing/portal", { method: "POST" });
      if (!response.ok) throw new Error("not ok");
      const data = (await response.json()) as { url?: string; requested?: boolean };
      if (data.requested) { setCancelRequested(true); return; }
      if (data.url) {
        window.location.href = data.url;
      } else {
        setPortalError("Couldn't open the billing portal.");
      }
    } catch {
      setPortalError(billingProvider === "whop" ? "Couldn't cancel automatic renewal. Please try again." : "Couldn't open the billing portal. Please try again.");
    } finally {
      setPortalBusy(false);
    }
  }

  /**
   * Flips the switch optimistically, then reconciles with the server.
   *
   * The response is authoritative — it reports what was actually stored — but
   * on any failure the switch is put back where it was and the error is shown,
   * so the UI never claims a preference the database did not take.
   */
  async function toggleBrief() {
    if (saving) return;
    const next = !brief;
    setBrief(next);
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/account/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daily_brief: next ? "on" : "off" }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { dailyBriefEnabled?: boolean };
      setBrief(typeof data.dailyBriefEnabled === "boolean" ? data.dailyBriefEnabled : next);
    } catch {
      setBrief(!next);
      setError("Couldn't update your preference. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="account-shell">
      <div className="account-head">
        <Link href="/" className="account-head-brand">
          <span className="brand-mark" aria-hidden="true">
            SL
          </span>
          <span className="brand-name">Signal Ledger</span>
        </Link>
        <Link href="/" className="account-head-back">
          ← Research
        </Link>
      </div>

      <h1 className="account-title">Account</h1>
      <p className="account-subtitle">
        Membership and email settings for the Signal Ledger research desk.
      </p>

      <section className="account-card account-section">
        <header className="account-section-head">
          <h2>Current plan</h2>
          <span className={`account-badge${tier === "PRO" ? " account-badge-pro" : ""}`}>
            {tier}
          </span>
        </header>
        {tier === "PRO" ? (
          <>
            <p className="account-copy">
              Full access to the research desk, including the complete Daily Brief.
            </p>
            {accessUntil ? (
              <p className="account-hint">
                Access through {formatDate(accessUntil)}
                {cancelAt
                  ? ` · Cancels on ${formatDate(cancelAt)}`
                  : cancelAtPeriodEnd
                    ? " · set to end this period"
                    : ""}
              </p>
            ) : null}
            <button
              type="button"
              className="button button-quiet account-portal"
              onClick={openPortal}
              disabled={portalBusy || (billingProvider === "whop" && (cancelRequested || cancelAtPeriodEnd))}
            >
              {portalBusy ? "Working…" : billingProvider === "whop" ? (cancelAtPeriodEnd ? "Automatic renewal canceled" : cancelRequested ? "Renewal cancellation requested" : "Cancel automatic renewal") : "Manage billing"}
            </button>
            {cancelRequested ? <p className="account-hint" role="status">Cancellation requested. Your paid access continues through the date above.</p> : null}
            {portalError ? (
              <p className="signin-error" role="alert">
                {portalError}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="account-copy">
              Your free plan includes stock summaries, basic option quotes and public research walkthroughs. It does not expire.
            </p>
            <div className="account-upsell">
              <span className="account-upsell-kicker">SIGNAL LEDGER PRO</span>
              <p className="account-upsell-copy">
                Pro adds the detail behind the free summaries: the full Daily Brief, the complete valuation framework
                and its history, Pick-NY holdings and attribution, the research archive and advanced options analysis.
              </p>
              <ProCheckout />
              <Link className="account-upsell-cta" href="/pricing">COMPARE FREE &amp; PRO</Link>
              <p><Link href="/examples">Read the two free walkthroughs →</Link></p>
            </div>
          </>
        )}
      </section>

      <section className="account-card account-section">
        <header className="account-section-head">
          <h2>Email</h2>
        </header>
        <p className="account-copy account-email">{email ?? ""}</p>
        <p className="account-hint">
          Sign-in links — and, when enabled, the Daily Brief — go to this address.
        </p>
      </section>

      <section className="account-card account-section">
        <header className="account-section-head">
          <h2>Daily Brief</h2>
        </header>
        <div className="account-row">
          <div className="account-row-copy">
            <p className="account-copy">
              {tier === "PRO"
                ? "Receive the complete post-close Signal Ledger research brief."
                : "Save your email preference. The complete post-close research brief requires Pro."}
            </p>
            <p className="account-hint">
              Off by default. Turning it off never affects your access.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={brief}
            aria-label="Daily Brief email"
            aria-busy={saving}
            className={`account-switch${brief ? " account-switch-on" : ""}`}
            onClick={toggleBrief}
            disabled={saving}
          >
            <span className="account-switch-knob" />
          </button>
        </div>
        <p className={`account-state${brief ? "" : " account-state-off"}`}>
          {saving ? "Saving…" : brief ? "Daily Brief is on" : "Daily Brief is off"}
        </p>
        {error ? (
          <p className="signin-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <section className="account-card account-section">
        <header className="account-section-head">
          <h2>Account</h2>
        </header>
        <p className="account-copy">Signed in as {email ?? ""}.</p>
        <form method="POST" action="/api/auth/signout">
          <button type="submit" className="button button-quiet account-signout">
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
