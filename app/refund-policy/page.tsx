import type { Metadata } from "next";
import Link from "next/link";
import LegalPage from "../legal-page";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Refund Policy | Signal Ledger",
  description:
    "Signal Ledger refund and cancellation terms for digital subscription access.",
};

export default function RefundPolicyPage() {
  return (
    <LegalPage title="Refund Policy" updated="September 20, 2026">
      <section>
        <p>
          Signal Ledger sells digital subscription access to research and
          analytics. Because access is delivered immediately, this policy
          distinguishes between <strong>cancellation</strong> (stopping future
          charges) and a <strong>refund</strong> (returning money already paid).
        </p>
      </section>

      <section>
        <h2>Cancellation</h2>
        <p>
          You may cancel your PRO subscription at any time from your{" "}
          <Link href="/account">account page</Link> or by contacting support.
          Cancellation stops the next renewal — you will not be charged again.
          Your access continues unchanged through the end of the period you have
          already paid for, and then reverts to the FREE tier.
        </p>
        <p>
          Canceling is separate from a refund: canceling prevents future
          charges but does not by itself return money already paid.
        </p>
      </section>

      <section>
        <h2>Refunds</h2>
        <p>
          Payments for digital subscription access are generally non-refundable
          except where a refund is required by applicable law.
        </p>
        <p>
          If you believe you were charged in error, charged twice, or there is
          an exceptional circumstance, contact us at the address on our{" "}
          <Link href="/support">support page</Link> and include the email address
          on your account. We will review these requests and issue a refund where
          a charge was made in error or where a refund is otherwise appropriate.
        </p>
      </section>

      <section>
        <h2>Statutory rights</h2>
        <p>
          Nothing in this policy limits any right to a refund or cancellation
          that you may have under applicable law. Where the law provides a
          right to a refund, that right remains available to you.
        </p>
      </section>
    </LegalPage>
  );
}
