"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { INITIAL_FORECAST, clamp, type ForecastForm } from "./forecast-form";

/**
 * Manual forecast entry. Split out of the dashboard so the homepage does not
 * ship the form until the user actually opens it.
 */
export default function ForecastModal({
  open,
  submitting,
  onClose,
  onSubmit,
}: {
  open: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (form: ForecastForm) => Promise<void>;
}) {
  const [form, setForm] = useState<ForecastForm>(INITIAL_FORECAST);
  const dialogRef = useRef<HTMLDivElement>(null);
  const tickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => tickerRef.current?.focus(), 20);
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, onClose, submitting]);

  if (!open) return null;

  const update = <K extends keyof ForecastForm>(
    key: K,
    value: ForecastForm[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const probabilityTotal =
    form.probabilityUp + form.probabilityBase + form.probabilityDown;
  const probabilityValid = probabilityTotal === 100;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit(form);
  };

  const preventBackdropKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
      onKeyDown={preventBackdropKeys}
    >
      <div
        className="forecast-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="forecast-modal-title"
        aria-describedby="forecast-modal-description"
        ref={dialogRef}
      >
        <div className="modal-header">
          <div>
            <p className="eyebrow">FREEZE A FORECAST</p>
            <h2 id="forecast-modal-title">Create a Testable Forecast</h2>
            <p id="forecast-modal-description">
              Submission freezes the probabilities and settlement rules. Future updates can only append evidence and outcomes.
            </p>
          </div>
          <button
            className="modal-close"
            type="button"
            aria-label="Close forecast dialog"
            onClick={onClose}
            disabled={submitting}
          >
            ×
          </button>
        </div>

        <form className="forecast-form" onSubmit={submit}>
          <div className="form-grid two-columns">
            <label className="field">
              <span>Ticker</span>
              <input
                ref={tickerRef}
                name="ticker"
                value={form.ticker}
                onChange={(event) =>
                  update(
                    "ticker",
                    event.target.value.toUpperCase().replace(/[^A-Z0-9.-]/g, ""),
                  )
                }
                placeholder="e.g., ORCL"
                maxLength={10}
                required
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>Forecast horizon</span>
              <select
                name="horizon"
                value={form.horizon}
                onChange={(event) => update("horizon", event.target.value)}
              >
                <option value="1d">1 trading day</option>
                <option value="5d">5 trading days</option>
                <option value="30d">30 calendar days</option>
                <option value="90d">90 calendar days</option>
              </select>
            </label>
          </div>

          <label className="field">
            <span>Forecast target and settlement definition</span>
            <textarea
              name="targetDefinition"
              value={form.targetDefinition}
              onChange={(event) => update("targetDefinition", event.target.value)}
              placeholder="Example: ORCL total return versus SPY over the next 30 days, using adjusted closing prices."
              rows={3}
              maxLength={500}
              required
            />
            <small>
              {form.targetDefinition.length}/500 · Specify the security, horizon, metric, and data convention
            </small>
          </label>

          <fieldset className="scenario-fieldset">
            <legend>Pre-event scenario probabilities</legend>
            <div className="scenario-grid">
              {[
                {
                  key: "probabilityUp" as const,
                  label: "Upside",
                  marker: "↑",
                },
                {
                  key: "probabilityBase" as const,
                  label: "Base",
                  marker: "→",
                },
                {
                  key: "probabilityDown" as const,
                  label: "Downside",
                  marker: "↓",
                },
              ].map((scenario) => (
                <label className={`scenario-input ${scenario.key}`} key={scenario.key}>
                  <span>
                    <i aria-hidden="true">{scenario.marker}</i>
                    {scenario.label}
                  </span>
                  <div>
                    <input
                      type="number"
                      name={scenario.key}
                      min="0"
                      max="100"
                      step="1"
                      value={form[scenario.key]}
                      onChange={(event) =>
                        update(
                          scenario.key,
                          clamp(Number(event.target.value), 0, 100),
                        )
                      }
                      required
                      aria-label={`${scenario.label} scenario probability`}
                    />
                    <b>%</b>
                  </div>
                </label>
              ))}
            </div>
            <div
              className={`probability-total ${probabilityValid ? "valid" : "invalid"}`}
              role="status"
            >
              <span>Total</span>
              <strong>{probabilityTotal}%</strong>
              <small>{probabilityValid ? "Valid distribution" : "The three scenarios must total 100%"}</small>
            </div>
          </fieldset>

          <div className="form-grid return-grid">
            <label className="field">
              <span>Return floor</span>
              <div className="suffix-input">
                <input
                  type="number"
                  name="returnLow"
                  step="0.1"
                  value={form.returnLow}
                  onChange={(event) => update("returnLow", event.target.value)}
                  required
                />
                <span>%</span>
              </div>
            </label>
            <label className="field">
              <span>Return ceiling</span>
              <div className="suffix-input">
                <input
                  type="number"
                  name="returnHigh"
                  step="0.1"
                  value={form.returnHigh}
                  onChange={(event) => update("returnHigh", event.target.value)}
                  required
                />
                <span>%</span>
              </div>
            </label>
            <label className="field">
              <span>Benchmark</span>
              <input
                name="benchmark"
                value={form.benchmark}
                onChange={(event) =>
                  update(
                    "benchmark",
                    event.target.value.toUpperCase().replace(/[^A-Z0-9.-]/g, ""),
                  )
                }
                placeholder="SPY"
                maxLength={10}
                required
              />
            </label>
          </div>

          <label className="field">
            <span>Rationale</span>
            <textarea
              name="rationale"
              value={form.rationale}
              onChange={(event) => update("rationale", event.target.value)}
              placeholder="Record the core evidence, expectation gap, major risks, and most important falsification condition."
              rows={4}
              maxLength={1500}
              required
            />
            <small>{form.rationale.length}/1500 · Use only facts and judgments known at submission</small>
          </label>

          <div className="freeze-notice">
            <span aria-hidden="true">◎</span>
            <p>
              <strong>This forecast becomes a permanent record</strong>
              Submission time, information cutoff, probability distribution, and settlement definition remain in the audit trail.
            </p>
          </div>

          <div className="modal-actions">
            <button
              className="button button-quiet"
              type="button"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              className="button button-accent"
              type="submit"
              disabled={submitting || !probabilityValid}
            >
              {submitting ? "Freezing…" : "Confirm and freeze forecast"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
