"use client";

import { useState } from "react";

/**
 * The one client-side Paddle surface.
 *
 * It holds no secret and no price id of its own: on click it asks the server
 * (`/api/billing/checkout`) for the client token, the price id and the
 * pre-created customer id, then loads Paddle.js lazily and opens the overlay
 * checkout. The server decides everything; the browser only plays back what it
 * was told. On a completed checkout it reloads the page so the server re-reads
 * the now-granted subscription and the nav flips to ACCOUNT · PRO.
 */

type CheckoutConfig = {
  environment: "sandbox" | "production";
  clientToken: string;
  customerId: string;
  priceId: string;
};

declare global {
  interface Window {
    Paddle?: {
      Environment: { set: (env: string) => void };
      Initialize: (options: {
        token: string;
        eventCallback?: (event: { name: string; data?: unknown }) => void;
      }) => void;
      Checkout: { open: (options: Record<string, unknown>) => void };
    };
  }
}

let paddleScriptPromise: Promise<void> | null = null;

function loadPaddleScript(): Promise<void> {
  if (!paddleScriptPromise) {
    paddleScriptPromise = new Promise((resolve, reject) => {
      if (window.Paddle) return resolve();
      const script = document.createElement("script");
      script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Paddle.js failed to load."));
      document.head.appendChild(script);
    });
  }
  return paddleScriptPromise;
}

export default function PaddleCheckout({
  plan,
  currency,
  label,
  className,
}: {
  plan: "monthly" | "annual" | "annual_onetime";
  currency: "usd" | "cny";
  label: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function openCheckout() {
    if (busy) return;
    setBusy(true);
    setError("");

    let config: CheckoutConfig;
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, currency }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (body?.error === "sign_in_required") throw new Error("Sign in to start checkout.");
        throw new Error("Checkout is unavailable right now. Please try again shortly.");
      }
      config = (await response.json()) as CheckoutConfig;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout is unavailable right now.");
      setBusy(false);
      return;
    }

    try {
      await loadPaddleScript();
      const Paddle = window.Paddle;
      if (!Paddle) throw new Error("Paddle.js is unavailable.");

      Paddle.Environment.set(config.environment);
      Paddle.Initialize({
        token: config.clientToken,
        eventCallback(event) {
          if (event.name === "checkout.completed") {
            window.location.reload();
          }
        },
      });
      Paddle.Checkout.open({
        items: [{ priceId: config.priceId, quantity: 1 }],
        customer: { id: config.customerId },
        customData: { plan },
        settings: { displayMode: "overlay", theme: "light", variant: "one-page" },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checkout could not be opened.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="paddle-checkout">
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
