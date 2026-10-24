# Signal Ledger — architecture

Current state only. One canonical path per concern; everything else is presentation.

## Market data

| Provider | Used for | Entry point |
|---|---|---|
| SEC (facts + submissions + filings) | Reported financials, XBRL parsing | `lib/valuation-data.ts` → `buildAutomatedValuationPack` |
| Alpaca | Adjusted daily bars, options chains, news | `lib/alpaca-bars.ts`, `lib/alpaca-options.ts` |
| Nasdaq | Live quotes | `fetchNasdaqQuoteCached` in `lib/valuation-data.ts` |

Adjusted daily bars are always requested with `adjustment=all`, so splits, reverse
splits and distributions are already reflected. A raw unadjusted close is never used.

## Valuation — one canonical path

```
buildAutomatedValuationPack(ticker)        lib/valuation-data.ts   SEC-derived profile
        ↓
runValuationProfile(profile, options)      lib/universal-valuation.ts   deterministic models
        ↓
toInvestmentSnapshot(output, meta)         lib/investment-snapshot.ts
        ↓
InvestmentSnapshot                         15-minute cache, one per ticker
```

`InvestmentSnapshot` is the **only** runtime producer of fair value, bear/base/bull,
rating, confidence, buy/sell zones, valuation family and the equity bridge. Every
surface reads it:

- homepage valuation cards → `app/valuation-desk.tsx`
- `/fair-value` → `app/fair-value/page.tsx`
- earnings cards → `app/dashboard-client.tsx`
- options desk → `app/options/chain-desk.tsx`
- Picks holdings overlay → `lib/pick-ny-store.ts`

There is no page-local valuation, no earnings-local valuation, and no curated
fallback: when live evidence fails the surface reports *unavailable* rather than a
stale number from a retired generation.

`runUniversalValuation` still exists in `lib/universal-valuation.ts`. It is not
called by any runtime path — only by `tests/universal-valuation.test.mjs` as the
deterministic curated engine under test.

## Earnings

`/api/dashboard` (edge-cached) → `earningsForecasts` + `earningsPriceForecasts` →
`EarningsForecastPanel`. The card binds the valuation block by looking the ticker up
in the same snapshot map the homepage shelf uses; it never computes a valuation.
Frozen forecasts are never rewritten after release.

## Options

`/api/options/chain` → normalized chain (`lib/options-provider.ts`, Alpaca adapter)
→ deterministic screen and ranking (`lib/options-screen.ts`, `lib/options-math.ts`)
→ optional explicit AI review (`lib/options-ai.ts`). Options data is never loaded
outside `/options`.

## Picks (model portfolios)

`lib/pick-ny.ts` is the engine: target weights, inception resolution, fractional
model shares, daily NAV, benchmark, drawdown, per-holding contribution. It is pure
arithmetic over adjusted closes — no network, no React.

`lib/pick-ny-store.ts` is the data adapter: it computes the series, persists it to
`PORTFOLIO_DB`, and serves `summary` / `history` / `holdings`. Pick-NY is
configuration plus a definition, not a separate engine, so Chicago and LA reuse the
same code.

Persistence is **durability, not a prerequisite**. When `PORTFOLIO_DB` is absent or
unreadable, the store serves the same deterministic series and logs the gap
server-side; the public page never shows a database message.

## Database boundaries

| Binding | Schema owner | Contents |
|---|---|---|
| `DB` | the Pages app | `lib/db-schema.ts` `CREATE_STATEMENTS`, applied at runtime by `db/index.ts` `ensureDatabase()` |
| `PORTFOLIO_DB` | the portfolio feature only | `lib/portfolio-db.ts` `PORTFOLIO_CREATE_STATEMENTS` — `sl_*` tables only |

`ensureDatabase()` must never run against `PORTFOLIO_DB`. The portfolio initializer
reads only `PORTFOLIO_DB` and creates only `sl_portfolios`,
`sl_portfolio_rebalances`, `sl_portfolio_daily_nav`, `sl_portfolio_daily_holdings`.
This is what makes it safe to point `PORTFOLIO_DB` at a database the always-on
monitor worker also owns, whose `sources`, `events` and `forecasts` have a different
shape from the app's tables of the same name.

## AI review

`lib/valuation-ai.ts` and `lib/options-ai.ts` run **only** on an explicit click
(`/api/valuation/run`, `/api/options/review`) or a scheduled server job. No ordinary
page render reaches an AI path.

## Caching

| Cache | TTL | Location |
|---|---|---|
| Dashboard snapshot | 60 s, edge-cached | `lib/snapshot-cache.ts` |
| InvestmentSnapshot | 15 min | `lib/investment-snapshot.ts` |
| Adjusted daily bars | 15 min | `lib/alpaca-bars.ts` |
| Options chain | 15 min | `lib/alpaca-options.ts` |
| Portfolio summary/history | 30 min freshness window | `lib/pick-ny-store.ts` |

## Client / server boundary

Server owns all financial logic: valuation, SEC/XBRL parsing, issuer datasets,
options ranking, portfolio math, database and AI access.

The browser receives prepared presentation data. Verified against the production
build: no client chunk contains `runValuationProfile`, `buildAutomatedValuationPack`,
`computeNavSeries`, `us-gaap` or any issuer dataset.

Client components exist for interaction only: charts, filters, tabs, forms.

`app/dashboard-client.tsx` is the homepage shell. Two things are deliberately
split out of its first-load payload:

- `app/forecast-modal.tsx` — owner-only entry form, `dynamic(..., { ssr: false })`,
  loaded only when the reader opens it
- `app/forecast-form.ts` — the form's type, defaults and one helper, shared by
  both so neither owns a private copy

## Homepage requests

Four, all batched, none per-ticker:

1. `/api/dashboard` — edge-cached research payload
2. `/api/valuation/snapshot?scope=home` — shelf snapshots in one call
3. `/api/valuation/snapshot?tickers=…` — only tickers the shelf does not cover
4. `/api/portfolios/ny/summary` — summary plus a capped 48-point sparkline

The homepage never requests options chains, portfolio history or any AI endpoint.
`/picks/ny` is the only page that loads the full daily series.
