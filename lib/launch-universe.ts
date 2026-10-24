/** Owner-approved first coverage queue. Order is editorial; #19 is PLTR. */
export const LAUNCH_TICKERS = [
  "NVDA", "AMD", "AVGO", "MU", "INTC", "MSFT", "AMZN", "GOOGL", "META", "ORCL",
  "AAPL", "SNOW", "TSLA", "CRCL", "MSTR", "OKLO", "SPCX", "JPM", "PLTR", "REGN",
] as const;

export function isLaunchTicker(value: string): boolean {
  return (LAUNCH_TICKERS as readonly string[]).includes(value.trim().toUpperCase());
}
