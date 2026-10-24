# Options workstation — delivery boundary

Implemented: independent `/options` page, American option scenario calculator,
date × stock-price matrix, IV stress comparison, CSV export, covered-call and
cash-secured-put coverage checks, private IBKR contract-snapshot adapter,
bounded 7–14 DTE option-chain discovery, net-per-trade screening, and transfer
of a selected contract into the scenario matrix.
The calculator does not use D1 and works even if the research feed is unavailable.

Not yet live: IBKR authentication/entitlements and the hosted-to-local bridge.
Historical IV series and verified forward event calendars are not connected.
Visible-tab polling every 15 seconds is available once a real chain loads;
it is not a WebSocket streaming feed. Screening uses full collateral, bid credit
less editable round-trip fees, liquidity/delta filters and expiry loss stresses.
Numerical matches are not marked trade-ready while event/IV evidence is missing.
No automatic trade recommendations or order execution are implemented.
Do not describe the snapshot scaffold as a live brokerage connection.

## Owner setup (never paste passwords into chat or the website)

1. Use the official IBKR Client Portal Gateway on an owner-controlled machine.
   Complete IBKR login and two-factor authentication there. A gateway session
   and the required US options/underlying market-data subscriptions must be active.
   Confirm live/paper market-data entitlements and redistribution terms with IBKR.
2. Generate a strong unique bridge token and supply it through a secret manager
   as `IBKR_BRIDGE_TOKEN`, not a tracked file. The bridge requires 32+ characters.
   Provide the gateway's trusted CA/certificate via `IBKR_GATEWAY_CA_FILE` where
   necessary. Never disable TLS verification globally.
3. Explicitly run `node scripts/ibkr-readonly-bridge.mjs`. It binds only to
   `127.0.0.1:8789` and communicates only with `https://localhost:5001/v1/api`.
   `IBKR_GATEWAY_PORT` may override the port (loopback remains mandatory).
   The gateway was prepared separately in the sibling `ibkr-gateway` directory.
   It must be running for localhost login to work; foreground task interruption
   may stop it. No persistent daemon, tunnel or hosted bridge is active yet.
   A fresh localhost certificate with DNS/IP SAN replaces the expired vendor
   certificate; its public certificate is `root/signal-ledger-public.pem`.
   Pass that absolute path as `IBKR_GATEWAY_CA_FILE`; do not disable TLS checks.
4. Establish an authenticated HTTPS tunnel to the read-only bridge, not the full
   IBKR gateway. Configure server-only Site secrets `IBKR_BRIDGE_URL` (origin)
   and `IBKR_BRIDGE_TOKEN`. No `NEXT_PUBLIC_` secrets. Any additional tunnel access
   controls must be configured before activation. Do not expose the full gateway.
5. Owner signs into `/options`, selects SOXL/SPCX/TSLA/AMD and loads the chain.
   No conid entry is required. Discovery scans at most 12 nearest OTM strikes per
   relevant month and 48 standard contracts. It is not an exhaustive option scan.
   Up to three snapshot attempts allow initial data to warm up. Missing, frozen,
   delayed and stale quotes fail the live screen. Bridge-owned subscriptions are
   removed when switching chains; other contracts are not blanket-unsubscribed.
6. Before operational use, validate actual bid/ask, IV units, multiplier,
   timestamps and contract identity against TWS. An entitled snapshot is not an
   executable fill. Reauthentication is manual; this is not an unattended daemon.

Private GET authorization is enforced server-side using Sites authenticated
owner identity, without local-host bypass. Responses are `private, no-store`;
no account balances/positions, order routes or raw errors are returned. The local
bridge discards the required IBKR account-bootstrap response. Request throttles
bound calls; no per-refresh D1 scans are added.

## Remaining live acceptance criteria

- Verify discovered identities, actual expirations and bid/ask/Greeks against
  an authenticated IBKR session. Confirm SPCX options exist; never substitute SPX.
- Verify visible-tab polling, gateway pacing and line limits on the live account.
- Compare IV against a source-backed constant-tenor/delta historical series;
  no invented IV rank from a single snapshot or cross-stock absolute-IV ranking.
- Require fresh two-sided quotes, spread/volume/OI filters, collateral, event and
  ex-dividend checks. Missing event data blocks automatic recommendations.
- Show bid-based credit, nonannualized credit/collateral, strike, DTE, downside
  breakeven, assignment exposure and explicit reasons. SOXL remains a daily-3×
  risk flag. Do not promise returns or infer willingness to own from premium alone.

## Model convention

American recombining binomial tree (300 steps), ACT/365, continuous dividend yield.
Date-only inputs are 16:00 America/New_York (DST-aware); expiry is intrinsic value.
The ±20-IV-point sensitivity is an input stress, not a forecast or probability.
Zero volatility has a deterministic early-exercise branch. Execution spread,
borrow, discrete dividends, skew and taxes are not included. Standard 100-share
contracts only; adjusted contracts are not supported. Position inputs are manual,
never persisted; sharing the public calculator does not share broker data.

Primary references:
- https://www.interactivebrokers.com/docs/web-api/v1/endpoints/market-data/live-market-data-snapshot
- https://www.interactivebrokers.com/docs/web-api/v1/endpoints/market-data/market-data-fields
- https://www.interactivebrokers.com/docs/web-api/v1/endpoints/contract/contract-information-by-contract-id
- https://www.interactivebrokers.com/docs/web-api/v1/endpoints/session/authentication-status
- https://www.direxion.com/product/daily-semiconductor-bull-bear-3x-etfs
