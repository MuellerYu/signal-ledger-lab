CREATE TRIGGER IF NOT EXISTS forecasts_prevent_delete
BEFORE DELETE ON forecasts
BEGIN
  SELECT RAISE(ABORT, 'forecast ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS forecasts_protect_frozen_input
BEFORE UPDATE ON forecasts
WHEN
  NEW.id IS NOT OLD.id OR
  NEW.event_id IS NOT OLD.event_id OR
  NEW.forecast_key IS NOT OLD.forecast_key OR
  NEW.ticker IS NOT OLD.ticker OR
  NEW.forecast_type IS NOT OLD.forecast_type OR
  NEW.target_definition IS NOT OLD.target_definition OR
  NEW.horizon IS NOT OLD.horizon OR
  NEW.probability_up IS NOT OLD.probability_up OR
  NEW.probability_base IS NOT OLD.probability_base OR
  NEW.probability_down IS NOT OLD.probability_down OR
  NEW.return_low IS NOT OLD.return_low OR
  NEW.return_high IS NOT OLD.return_high OR
  NEW.benchmark IS NOT OLD.benchmark OR
  NEW.rationale IS NOT OLD.rationale OR
  NEW.created_at IS NOT OLD.created_at OR
  NEW.information_cutoff_at IS NOT OLD.information_cutoff_at OR
  NEW.resolution_at IS NOT OLD.resolution_at
BEGIN
  SELECT RAISE(ABORT, 'frozen forecast input is immutable');
END;
