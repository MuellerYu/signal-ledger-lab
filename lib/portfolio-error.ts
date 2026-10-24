/**
 * Maps a caught error from the portfolio pricing pipeline to a safe, public
 * result. Provider failures carry raw HTTP bodies — a 401 nginx page, a JSON
 * error object — that must never reach the page, so the detail is logged for
 * operators and the public message stays generic. Pure: no bindings, no server
 * imports, so it is unit-testable in isolation.
 */

export type PortfolioError = { code: string; error: string };

export function readableError(caught: unknown): PortfolioError {
  const message = caught instanceof Error ? caught.message : String(caught);

  if (message === "ALPACA_BARS_NOT_CONFIGURED") {
    return {
      code: "PRICE_PROVIDER_NOT_CONFIGURED",
      error: "Alpaca credentials are not configured, so adjusted daily closes cannot be read.",
    };
  }

  const provider = /^ALPACA_BARS_(\d+)\|([\s\S]*)$/.exec(message);
  if (provider) {
    const status = provider[1];
    const detail = provider[2].slice(0, 200).replace(/\s+/g, " ").trim();
    console.warn(`[pick-ny] price provider rejected the bars request (HTTP ${status}): ${detail}`);
    return {
      code: "PRICE_PROVIDER_ERROR",
      error: "Market data is temporarily unavailable. Pick-NY will return when verified market data is available.",
    };
  }

  // Unknown/internal: log it, surface a generic message. Our own deterministic
  // guard messages ("No adjusted daily history returned for …") are operator
  // diagnostics, not public copy, so they stay out of the page too.
  console.warn(`[pick-ny] portfolio unavailable: ${message}`);
  return { code: "PORTFOLIO_UNAVAILABLE", error: "Pick-NY is temporarily unavailable." };
}
