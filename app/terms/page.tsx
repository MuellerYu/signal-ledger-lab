import type { Metadata } from "next";
import Link from "next/link";
import LegalPage from "../legal-page";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Terms of Service | Signal Ledger",
  description:
    "The terms that govern use of the Signal Ledger research and analytics platform.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="September 20, 2026">
      <section>
        <p>
          These terms govern your use of Signal Ledger, an independent digital
          investment research and analytics platform. By creating an account or
          using the service you agree to these terms. If you do not agree, do
          not use the service.
        </p>
      </section>

      <section>
        <h2>What Signal Ledger is</h2>
        <p>
          Signal Ledger publishes stock research, valuation models, fair value
          estimates, options analytics, portfolio analytics, a post-close Daily
          Brief, market intelligence, and the Pick-NY model portfolio. It is a
          subscription research product, not a financial institution.
        </p>
      </section>

      <section>
        <h2>Informational and educational only</h2>
        <p>
          All content on Signal Ledger is provided for general informational and
          educational purposes only. It is not individualized investment advice
          and is not tailored to your portfolio, financial situation, or
          investment objectives. You are responsible for your own investment
          decisions, and you should consider consulting a qualified professional
          before acting on any information.
        </p>
        <p>
          Valuation models, forecasts, fair value estimates, ratings and research
          opinions are estimates and opinions that may be wrong. Past performance
          — including the Pick-NY model portfolio and published forecast records
          — does not guarantee future results.
        </p>
      </section>

      <section>
        <h2>What Signal Ledger does not do</h2>
        <ul>
          <li>Signal Ledger is not a broker and does not execute trades.</li>
          <li>It does not hold or take custody of customer funds or assets.</li>
          <li>It does not operate automated trading on your behalf.</li>
          <li>It does not manage accounts or portfolios, and provides no discretionary portfolio management.</li>
        </ul>
      </section>

      <section>
        <h2>Risk</h2>
        <p>
          Financial markets involve risk, including the possible loss of the
          money you invest. You should only rely on your own judgment and
          appropriate professional advice when making investment decisions.
        </p>
      </section>

      <section>
        <h2>Subscriptions and billing</h2>
        <p>
          The FREE tier costs nothing. PRO is a recurring subscription available
          monthly or annually at the prices shown on the{" "}
          <Link href="/pricing">pricing page</Link>. Subscriptions renew
          automatically until canceled. You may cancel at any time; cancellation
          stops the next renewal while your access continues through the end of
          the current paid period. Refunds are described in our{" "}
          <Link href="/refund-policy">refund policy</Link>.
        </p>
      </section>

      <section>
        <h2>Acceptable use</h2>
        <p>
          You agree not to misuse the service, to attempt to bypass its access
          controls, to redistribute premium content, or to use the service for
          any unlawful purpose.
        </p>
      </section>

      <section>
        <h2>Intellectual property</h2>
        <p>
          The research, models, analyses and other content on Signal Ledger are
          owned by Signal Ledger and are provided for your personal, non
          commercial use under your subscription. You may not resell or
          republish premium content.
        </p>
      </section>

      <section>
        <h2>No warranty and limitation of liability</h2>
        <p>
          The service is provided on an &ldquo;as is&rdquo; basis. To the extent
          permitted by law, Signal Ledger disclaims warranties and is not liable
          for investment losses or other indirect damages arising from use of
          the service. Nothing in these terms excludes rights that cannot be
          excluded under applicable law.
        </p>
      </section>

      <section>
        <h2>Changes to these terms</h2>
        <p>
          We may update these terms from time to time. Material changes will be
          reflected by updating the date above and, where appropriate, by notice
          on the site. Continued use after a change means you accept the updated
          terms.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about these terms can be sent to the address on our{" "}
          <Link href="/support">support page</Link>.
        </p>
      </section>
    </LegalPage>
  );
}
