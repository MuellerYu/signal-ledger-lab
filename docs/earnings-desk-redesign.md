# Signal Ledger research desk — September 2026

The default equities view leads with company cards, not operational statistics.
Each card separates the latest timestamped quote from a historical forecast:

1. Company, quote, fiscal period and release status.
2. Recorded outcome or current data status.
3. Revenue/EPS: model estimate, consensus and reported result in one table.
4. Numerical forecast errors and concrete English source highlights, if present.
5. Frozen target, recorded target-session close and signed target error.
6. Sources and original forecast evidence in an expandable audit record.

Upcoming releases and the latest reported records appear first. Other records,
the full scorecard, all events and operating diagnostics remain accessible in
expandable sections. The BTC fixed-cycle forecast and audit history are unchanged.
The global news view no longer repeats its top stories or manufactures generic
market commentary when an English source note is absent.

No forecasts, reported values, stored notes or source links were deleted or
rewritten. Unsupported English placeholder prose is suppressed at presentation
time, not converted into invented research. This is not an enrichment-model
upgrade; missing source analysis still needs to be supplied upstream.

## Accounting rules

- A scheduled date passing does not prove that financial results were received.
- The latest quote never substitutes for the target-session close.
- No recorded target means no price backtest, including for reported companies.
- Target error = (frozen target − recorded close) / recorded close.
- Revenue model error = (model estimate − reported revenue) / reported revenue.
- EPS basis differences are disclosed; no consensus surprise score is inferred
  without matching accounting bases. Zero and negative EPS remain valid values.

## Verification

Tests render the actual React card for no-target, missing-settlement and settled
cases. Synthetic fixtures are confined to tests, never published as live data.
They verify that a much higher current quote cannot reverse a historical miss.
Tests also cover filler suppression, duplicate notes, URL schemes and feed gaps.
The production build and TypeScript checks pass. No browser screenshots or
browser automation were used.

The monitor's production health check at 2026-09-05 02:27 UTC still returned a
D1 daily read-limit error. Design and request-efficiency changes cannot refund
consumed quota. Live content recovery is therefore separate from UI deployment.
