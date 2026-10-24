"use client";

import { useEffect } from "react";

const MAX_CHECKS = 10;
const INTERVAL_MS = 6000;

/**
 * Bounded confirmation poll. It never fabricates success: it simply reloads the
 * success page (which re-reads the server-resolved entitlement) a fixed number
 * of times, then hands off to a manual message. Each reload increments `check`
 * in the URL, so the loop always terminates.
 */
export default function BillingSuccessPoll({ check }: { check: number }) {
  const exhausted = check >= MAX_CHECKS;

  useEffect(() => {
    if (exhausted) return;
    const timer = setTimeout(() => {
      window.location.href = `/billing/success?check=${check + 1}`;
    }, INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [check, exhausted]);

  return (
    <p className="account-hint">
      {exhausted
        ? "Still confirming — this can take a moment. Check your email for a receipt, then refresh."
        : `Checking automatically (${check + 1} of ${MAX_CHECKS})…`}
    </p>
  );
}
