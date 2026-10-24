"use client";

import StripeCheckout from "./stripe-checkout";

/**
 * The PRO card's actionable checkout controls, rendered only for an
 * authenticated FREE member.
 *
 * Two recurring products in USD: monthly and annual. The server is the source
 * of truth for every price id; this component submits only a logical plan and
 * redirects to the server-selected sandbox checkout.
 */

export default function ProCheckout() {
  return (
    <div className="pro-checkout">
      <StripeCheckout
        endpoint="/api/billing/whop/checkout"
        plan="monthly"
        label="Monthly · $19.99"
        className="pricing-plan-cta pricing-plan-cta-pro"
      />
      <StripeCheckout
        endpoint="/api/billing/whop/checkout"
        plan="annual"
        label="Annual · $179"
        className="pricing-plan-cta pricing-plan-cta-pro"
      />

      <p className="pricing-plan-note">
        Monthly and annual renew automatically and can be canceled anytime. Access
        is confirmed from your billing provider before it activates.
      </p>
    </div>
  );
}
