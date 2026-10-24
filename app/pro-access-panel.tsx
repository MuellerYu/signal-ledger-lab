"use client";

import Link from "next/link";

/**
 * The one reusable institutional lock surface.
 *
 * Deliberately restrained: cream on navy, thin rules, a small PRO wordmark and
 * a single CTA. No oversized lock icon, no gradient, no blurred content behind
 * it — the locked content is never in the DOM at all, so there is nothing to
 * blur. It renders the same on every surface that gates a section to PRO.
 */
export default function ProAccessPanel({
  kicker = "SIGNAL LEDGER PRO",
  title,
  description,
  features,
  cta = "COMPARE FREE & PRO",
  href = "/pricing",
}: {
  kicker?: string;
  title: string;
  description: string;
  features?: readonly string[];
  cta?: string;
  href?: string;
}) {
  return (
    <aside className="pro-access" aria-label={`${title} — Signal Ledger PRO`}>
      <span className="pro-access-kicker">{kicker}</span>
      <h3 className="pro-access-title">{title}</h3>
      <p className="pro-access-description">{description}</p>
      {href === "/pricing" && <p className="pro-access-context">Your free summaries stay available. Pro opens the research detail behind them.</p>}
      {features && features.length ? (
        <ul className="pro-access-features">
          {features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      ) : null}
      <Link className="pro-access-cta" href={href}>
        {cta}
      </Link>
    </aside>
  );
}

/**
 * The active counterpart to the lock surface, for readers who already have PRO.
 * A member who has paid must never be shown an upgrade panel — it reads as if
 * their subscription did not register.
 */
export function ProActivePanel({
  title,
  description,
  href = "/account",
  cta = "MANAGE ACCOUNT",
}: {
  title: string;
  description: string;
  href?: string;
  cta?: string;
}) {
  return (
    <aside className="pro-access pro-access-active" aria-label={`${title} — included in your plan`}>
      <span className="pro-access-kicker">PRO ACTIVE</span>
      <h3 className="pro-access-title">{title}</h3>
      <p className="pro-access-description">{description}</p>
      <Link className="pro-access-cta" href={href}>
        {cta}
      </Link>
    </aside>
  );
}
