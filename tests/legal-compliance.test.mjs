import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Merchant-of-record / payment-provider compliance-readiness.
 *
 * These tests assert, against source, that the public site exposes what a
 * payment reviewer needs to find — product identity, pricing, subscription and
 * cancellation terms, refunds, a support contact, and a clear "we do not trade
 * or custody" disclosure — on public routes, without leaking premium content or
 * the owner's private email. They are targeted string assertions, not full-page
 * snapshots, so they stay green as copy evolves.
 */

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

/* ------------------------------------------------------------ legal routes */

test("public legal routes exist: /privacy, /terms, /refund-policy, /support", async () => {
  const [privacy, terms, refund, support] = await Promise.all([
    read("../app/privacy/page.tsx"),
    read("../app/terms/page.tsx"),
    read("../app/refund-policy/page.tsx"),
    read("../app/support/page.tsx"),
  ]);

  // Each is a public page rendered through the shared SiteNav shell, never a
  // gated route handler.
  for (const source of [privacy, terms, refund, support]) {
    assert.match(source, /SiteNav|LegalPage/, "legal page uses the public header/shell");
    assert.doesNotMatch(source, /redirect\(|getCurrentUser\b/, "legal page has no auth gate");
  }

  assert.match(privacy, /Privacy Policy/);
  assert.match(terms, /Terms of Service/);
  assert.match(refund, /Refund Policy/);
  assert.match(support, /Support/);
});

test("privacy policy explains data handling without claiming to store card numbers", async () => {
  const privacy = await read("../app/privacy/page.tsx");

  assert.match(privacy, /email address/i);
  assert.match(privacy, /hashed/i, "authentication tokens are described as hashed");
  assert.match(privacy, /payment processor/i);
  assert.match(privacy, /do not store your full card number|card details are collected and handled/i);
  assert.match(privacy, /service provider/i);
  assert.match(privacy, /retention/i);
  assert.match(privacy, /rights/i);
});

test("terms clearly describe a research platform that does not trade or custody", async () => {
  const terms = await read("../app/terms/page.tsx");

  assert.match(terms, /independent digital/i);
  assert.match(terms, /research and analytics platform/i);
  assert.match(terms, /informational and educational/i);
  assert.match(terms, /not individualized investment advice/i);
  assert.match(terms, /does not execute trades/i);
  assert.match(terms, /custody/i);
  assert.match(terms, /does not manage accounts|discretionary portfolio management/i);
  assert.match(terms, /risk/i);
  assert.match(terms, /estimates and opinions/i);
});

test("refund policy separates cancellation from refunds and preserves statutory rights", async () => {
  const refund = await read("../app/refund-policy/page.tsx");

  assert.match(refund, /cancellation/i);
  assert.match(refund, /refund/i);
  assert.match(refund, /stops the next renewal/i);
  assert.match(refund, /end of the period|end of the current paid period|end of the paid period/i);
  assert.match(refund, /applicable law|statutory rights/i);
});

/* ------------------------------------------------------------ footer + nav */

test("global footer links to pricing and the legal pages", async () => {
  const [footer, layout] = await Promise.all([
    read("../app/site-footer.tsx"),
    read("../app/layout.tsx"),
  ]);

  for (const [href, label] of [
    ["/pricing", "Pricing"],
    ["/privacy", "Privacy Policy"],
    ["/terms", "Terms of Service"],
    ["/refund-policy", "Refund Policy"],
    ["/support", "Support"],
  ]) {
    assert.ok(footer.includes(`href: "${href}"`), `footer links to ${href}`);
    assert.ok(footer.includes(label), `footer labels ${label}`);
  }
  assert.match(layout, /<SiteFooter \/>/, "footer is mounted from the root layout");
});

/* ------------------------------------------------------------ pricing */

test("pricing states FREE $0, PRO $19.99/month and $179/year with recurring terms", async () => {
  const pricing = await read("../app/pricing/page.tsx");

  assert.match(pricing, /\$0/);
  assert.match(pricing, /\$19\.99/);
  assert.match(pricing, /\$179/);
  assert.match(pricing, /recurring subscription|renew automatically/i);
  assert.match(pricing, /cancel/i);
  assert.match(pricing, /refund-policy/);
});

/* ------------------------------------------------------------ disclaimer */

test("the research disclaimer is one shared source and covers no-brokerage/no-custody", async () => {
  const [config, disclaimer] = await Promise.all([
    read("../lib/site-config.ts"),
    read("../app/disclaimer.tsx"),
  ]);

  assert.match(config, /RESEARCH_DISCLAIMER/);
  assert.match(config, /informational and educational purposes only/i);
  assert.match(config, /brokerage/i);
  assert.match(config, /custody/i);
  assert.match(config, /never places trades/i);
  assert.match(disclaimer, /RESEARCH_DISCLAIMER/, "the shared component imports the single source");
});

/* ------------------------------------------------------------ honesty */

test("support contact uses the public SUPPORT_EMAIL default and stays clickable", async () => {
  const [support, config, runtime] = await Promise.all([
    read("../app/support/page.tsx"),
    read("../lib/site-config.ts"),
    read("../lib/runtime.ts"),
  ]);

  // The active inbox is a single shared constant; the page resolves it (honoring
  // an optional per-environment binding override) and renders it as a mailto.
  assert.match(config, /export const SUPPORT_EMAIL = "support@signalledgerlab\.com"/);
  assert.match(runtime, /SUPPORT_EMAIL\?: string/);
  assert.match(support, /SUPPORT_EMAIL/, "the page imports the shared constant");
  assert.match(support, /mailto:\$\{supportEmail\}/, "the address is a clickable mailto link");
  assert.match(support, /Signal Ledger Support/, "the page has a clear support heading");
  assert.match(support, /account, subscription, billing, or product questions/i);
});

test("public compliance surfaces do not leak the owner's private email", async () => {
  const [footer, privacy, terms, refund, support, pricing] = await Promise.all([
    read("../app/site-footer.tsx"),
    read("../app/privacy/page.tsx"),
    read("../app/terms/page.tsx"),
    read("../app/refund-policy/page.tsx"),
    read("../app/support/page.tsx"),
    read("../app/pricing/page.tsx"),
  ]);

  for (const source of [footer, privacy, terms, refund, support, pricing]) {
    assert.doesNotMatch(source, /owner@example\.com/, "private owner email stays out of public surfaces");
  }
});
