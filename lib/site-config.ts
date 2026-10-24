/**
 * Public site identity, shared by server and client components alike.
 *
 * This module MUST stay free of server-only imports (nothing from ./runtime,
 * which pulls in `cloudflare:workers`), so it can be imported from client
 * components such as the research disclaimer without dragging the Worker
 * runtime into the browser bundle.
 */

export const SITE_NAME = "Signal Ledger";

/**
 * One-line product identity, used verbatim on the legal pages and in the global
 * footer so a merchant reviewer can see at a glance what is sold and what the
 * customer receives.
 */
export const BUSINESS_DESCRIPTION =
  "A subscription-based digital investment research and analytics platform for general informational and educational purposes.";

/**
 * The concise research disclaimer, rendered in one place via <Disclaimer /> and
 * in the global footer. It is deliberately a single sentence: it must read as a
 * standard editorial disclosure, not a warning that the product is unusable.
 */
export const RESEARCH_DISCLAIMER =
  "Signal Ledger provides independent investment research and analytics for informational and educational purposes only, not personalized investment advice. It does not provide brokerage, trade execution, custody, or managed accounts, and it never places trades.";

/**
 * The public support inbox. It is live and receives mail through Cloudflare
 * Email Routing, so it is safe to render publicly. This is the single source of
 * truth: components import it rather than repeating the address, and the
 * optional `SUPPORT_EMAIL` binding (lib/runtime) overrides it per environment
 * when set.
 */
export const SUPPORT_EMAIL = "support@signalledgerlab.com";
