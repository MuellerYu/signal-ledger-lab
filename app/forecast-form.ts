/**
 * Shape and defaults for the manual forecast form. Shared by the dashboard and
 * the lazily-loaded modal so neither owns a private copy.
 */

export type ForecastForm = {
  ticker: string;
  targetDefinition: string;
  horizon: string;
  probabilityUp: number;
  probabilityBase: number;
  probabilityDown: number;
  returnLow: string;
  returnHigh: string;
  benchmark: string;
  rationale: string;
};

export const INITIAL_FORECAST: ForecastForm = {
  ticker: "",
  targetDefinition: "",
  horizon: "30d",
  probabilityUp: 50,
  probabilityBase: 30,
  probabilityDown: 20,
  returnLow: "-10",
  returnHigh: "15",
  benchmark: "SPY",
  rationale: "",
};

export function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}
