/**
 * The explicit public/sample exceptions.
 *
 * Exactly these two tickers are published as complete FREE examples: the full
 * stored valuation (Bear / Base / Bull, model weights, assumptions and evidence)
 * is served to FREE readers so a new visitor can see precisely what a PRO
 * analysis looks like before subscribing.
 *
 * This is a deliberate, narrow whitelist — never a general entitlement branch.
 * Every other ticker keeps the structural FREE/PRO gate (`teaserSnapshot` /
 * `valuationOutputTeaser`), and the AI-orchestrated engine (`/api/valuation/run`)
 * stays PRO-only regardless of ticker. Adding a ticker here must remain an
 * explicit editorial decision, not a code path.
 */

export const PUBLIC_SAMPLE_TICKERS = new Set(["AMD", "SPCX"]);

export function isPublicSampleTicker(ticker: string | null | undefined): boolean {
  if (!ticker) return false;
  return PUBLIC_SAMPLE_TICKERS.has(ticker.trim().toUpperCase());
}
