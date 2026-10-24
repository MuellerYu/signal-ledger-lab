"use client";

import { useState } from "react";

/**
 * The one client-side Stripe surface.
 *
 * It holds no secret and no price id of its own: on click it asks the server
 * (`/api/billing/checkout`) for a hosted Checkout Session URL, then redirects
 * the browser to Stripe. The server decides the price, customer and user; the
 * browser only submits a logical plan and plays back the URL it was told.
 * Completion is granted by the webhook, never by the redirect, so the success
 * page stays restrained until the server confirms the subscription.
 */

export default function StripeCheckout({
  plan,
  label,
  className,
  endpoint = "/api/billing/checkout",
}: {
  plan: "monthly" | "annual";
  label: string;
  className?: string;
  endpoint?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function openCheckout() {
    if (busy) return;
    setBusy(true);
    setError("");

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (body?.error === "sign_in_required") throw new Error("Sign in to start checkout.");
        if (body?.error === "email_verification_required") throw new Error("Verify your email to upgrade.");
        throw new Error("Checkout is unavailable right now. Please try again shortly.");
      }
      const data = (await response.json()) as { url?: string };
      if (!data.url) throw new Error("Checkout could not be started.");
      window.location.href = data.url;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout is unavailable right now.");
      setBusy(false);
    }
  }

  return (
    <div className="stripe-checkout">
      <button type="button" className={className} onClick={openCheckout} disabled={busy}>
        {busy ? "Opening…" : label}
      </button>
      {error ? (
        <p className="pricing-plan-note pricing-plan-note-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
