import type { Metadata } from "next";
import Link from "next/link";
import LegalPage from "../legal-page";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Privacy Policy | Signal Ledger",
  description:
    "How Signal Ledger collects, uses and protects account, subscription and usage information.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="September 20, 2026">
      <section>
        <p>
          Signal Ledger is a subscription-based digital investment research and
          analytics platform. This policy explains, at a high level, what
          information we collect, why we collect it, and the choices you have.
          It applies to the public website at signalledgerlab.com and the
          subscription service behind it.
        </p>
      </section>

      <section>
        <h2>Information we collect</h2>

        <h3>Account and email information</h3>
        <p>
          To create an account you provide an email address. We use it to send
          your sign-in link and, where you have opted in, the Daily Brief and
          other account notices. We may store a display name if you provide one.
        </p>

        <h3>Authentication data</h3>
        <p>
          You sign in with a one-time email link — there is no password. We keep
          only a hashed form of the sign-in token and session identifier so the
          underlying secret is never stored in a readable form.
        </p>

        <h3>Subscription and billing information</h3>
        <p>
          When you subscribe we store the status of your subscription — the plan
          (FREE or PRO), the billing interval, and the start and end of your
          access period — together with an identifier that links your account to
          your record with our payment processor. We do not store your full card
          number or banking credentials: card details are collected and handled
          directly by our payment processor.
        </p>

        <h3>Usage and analytics</h3>
        <p>
          We collect basic, aggregate usage information to operate and improve
          the service, for example which research pages are viewed and how the
          site performs. We do not sell personal information.
        </p>

        <h3>Market and product usage</h3>
        <p>
          The research product lets you look up companies, valuations, options
          and portfolios. We do not require you to disclose your own portfolio,
          holdings, or financial situation, and we do not use such information
          to provide the service.
        </p>
      </section>

      <section>
        <h2>Service providers</h2>
        <p>
          We rely on a small number of service providers to run the service,
          including our payment processor (which handles checkout, subscriptions
          and payment methods) and an email delivery provider. Each provider
          receives only the information needed to perform its function, under
          obligations to protect that information.
        </p>
      </section>

      <section>
        <h2>Retention and security</h2>
        <p>
          We retain account and subscription information for as long as your
          account is active and for a reasonable period afterwards for record
          keeping and compliance. We apply access controls and encryption in
          transit, and store secrets only in hashed or server-side form. No
          system is completely secure, but we take reasonable measures to
          protect the information we hold.
        </p>
      </section>

      <section>
        <h2>Your rights and contact</h2>
        <p>
          You can update or close your account and manage your email preferences
          from the <Link href="/account">account page</Link>. To request access
          to, correction of, or deletion of your personal information, or to ask
          a question about this policy, contact us at the address on our{" "}
          <Link href="/support">support page</Link>.
        </p>
      </section>
    </LegalPage>
  );
}
