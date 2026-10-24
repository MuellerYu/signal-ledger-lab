"use client";

import { useEffect, useMemo, useState } from "react";
import ProAccessPanel from "../pro-access-panel";
import { applyOptionsPreset, buildOptionsPicks, optionsFilterHash, OPTIONS_PRESETS, rankCashSecuredPuts, rankCoveredCalls, selectDisplayStrikes, type ChainContract, type OptionChain, type OptionsPresetId, type ScreenInputs, type StrategyCandidate, type StrategyScreenSettings } from "@/lib/options-screen";
import type { NormalizedOptionChain, NormalizedOptionContract } from "@/lib/options-provider";
import type { OptionsReview } from "@/lib/options-ai";
import type { InvestmentSnapshot } from "@/lib/investment-snapshot";
import "./chain.css";

const usd = (value: number | null, digits = 2) => value === null || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
const decimal = (value: number | null, digits = 2) => value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
const iv = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
const pct = (value: number | null, digits = 2) => value === null || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)}%`;
const ratio = (value: number) => `${(value * 100).toFixed(2)}%`;
type Strategy = "put" | "call";
export type ChainTab = "chain" | Strategy;
type Props = { symbol: string; tab: ChainTab; onTab: (value: ChainTab) => void; onSelect: (contract: ChainContract, chain: OptionChain, settings: ScreenInputs) => void; tier: "FREE" | "PRO" };

function legacyContract(contract: NormalizedOptionContract): ChainContract {
  return {
    conid: [...contract.symbol].reduce((value, character) => Math.imul(value ^ character.charCodeAt(0), 16777619), 2166136261) >>> 0,
    symbol: contract.underlying,
    right: contract.type === "call" ? "C" : "P",
    strike: contract.strike,
    expiry: contract.expiration,
    dte: contract.dte,
    bid: contract.bid,
    ask: contract.ask,
    ivPercent: contract.iv === null ? null : contract.iv * 100,
    delta: contract.delta,
    volume: contract.volume,
    openInterest: contract.openInterest,
    updatedAt: contract.quoteTimestamp,
    availability: "Delayed / indicative",
    eligibleQuote: false,
  };
}

function PickCard({
  labels,
  candidate,
  onModel,
  available,
  strategy,
}: {
  labels: string;
  candidate: StrategyCandidate;
  onModel: () => void;
  available: boolean;
  strategy: Strategy;
}) {
  const kind = candidate.delta < 0 ? "Put" : "Call";
  return (
    <article className={`opt-pick pick-${candidate.recommendation.toLowerCase()}`}>
      <p className="opt-pick-label">{labels}</p>
      <h3>{candidate.expiration} · ${candidate.strike} {kind}</h3>
      <dl className="opt-pick-stats">
        <div><dt>DTE</dt><dd>{candidate.dte}</dd></div>
        <div><dt>Bid</dt><dd>{usd(candidate.bid)}</dd></div>
        <div><dt>Ask</dt><dd>{usd(candidate.ask)}</dd></div>
        <div><dt>Mid</dt><dd>{usd(candidate.midpoint)}</dd></div>
        <div><dt>Delta</dt><dd>{candidate.delta.toFixed(2)}</dd></div>
      </dl>
      <dl className="opt-pick-stats secondary">
        <div><dt>IV</dt><dd>{iv(candidate.iv)}</dd></div>
        <div><dt>OI</dt><dd>{candidate.openInterest}</dd></div>
        <div><dt>Volume</dt><dd>{candidate.volume ?? "—"}</dd></div>
        <div><dt>Distance</dt><dd>{candidate.distanceFromSpotPct.toFixed(1)}%</dd></div>
        <div><dt>Spread</dt><dd>{candidate.spreadPct.toFixed(1)}%</dd></div>
      </dl>
      <dl className="opt-pick-stats secondary">
        <div><dt>Premium</dt><dd>{usd(candidate.netPremium, 0)}</dd></div>
        <div><dt>Breakeven</dt><dd>{usd(candidate.breakeven)}</dd></div>
        <div><dt>{strategy === "put" ? "Collateral" : "Covered shares"}</dt><dd>{strategy === "put" ? usd(candidate.collateralRequired, 0) : candidate.sharesRequired}</dd></div>
        <div><dt>Return / trade</dt><dd>{pct(candidate.returnOnCashPct)}</dd></div>
        <div><dt>Annualized ref.</dt><dd>{pct(candidate.annualizedYieldPct, 0)}</dd></div>
      </dl>
      <dl className="opt-pick-flags">
        <div><dt>Fair value support</dt><dd className={`flag-${candidate.valuationSupportLabel.toLowerCase().replaceAll(" ", "-")}`}>{candidate.valuationSupportLabel}</dd></div>
        <div><dt>Liquidity score</dt><dd className={`flag-${candidate.liquidityLabel.toLowerCase()}`}>{candidate.liquidityLabel} · {(candidate.liquidityScore * 100).toFixed(0)}</dd></div>
        <div><dt>Risk</dt><dd className={`flag-${candidate.riskLabel.toLowerCase()}`}>{candidate.riskLabel}</dd></div>
        <div><dt>Recommendation</dt><dd className={`flag-${candidate.recommendation.toLowerCase()}`}>{candidate.recommendation}</dd></div>
      </dl>
      <p className="opt-pick-why">
        Score {candidate.score.toFixed(1)} · {ratio(candidate.components.premiumReturn)} premium quality × {candidate.components.liquidity.toFixed(2)} liquidity × {candidate.components.spread.toFixed(2)} spread
        {" "}× {candidate.components.delta.toFixed(2)} delta × {candidate.components.valuationSupport.toFixed(2)} valuation support
        {candidate.components.ivAttractiveness === undefined
          ? ` × ${(candidate.components.upsideRetained ?? 1).toFixed(2)} upside retained × ${(candidate.components.strikeVsFairValue ?? 1).toFixed(2)} strike vs fair value`
          : ` × ${candidate.components.ivAttractiveness.toFixed(2)} IV attractiveness`}
      </p>
      <button className="opt-link" type="button" disabled={!available} onClick={onModel}>Model this contract →</button>
    </article>
  );
}

function FairValueSupport({
  snapshot,
  strategy,
  candidate,
}: {
  snapshot: InvestmentSnapshot | null;
  strategy: Strategy;
  candidate: StrategyCandidate | null;
}) {
  if (!snapshot || snapshot.fairValue === null) {
    return (
      <div className="opt-support neutral">
        <strong>Fair-value support is not available for {snapshot?.ticker ?? "this symbol"}</strong>
        <span>The options engine keeps valuation support neutral until the valuation service publishes a fair value. It never invents a support level.</span>
      </div>
    );
  }
  const reference = strategy === "put" ? candidate?.breakeven ?? null : candidate?.strike ?? null;
  const comparison = reference === null
    ? null
    : strategy === "put"
      ? snapshot.buyZone === null ? null : reference <= snapshot.buyZone
      : reference >= snapshot.fairValue;
  const label = strategy === "put" ? "Put breakeven" : "Covered-call strike";
  return (
    <div className="opt-support">
      <div className="opt-support-values">
        <div><span>Current price</span><strong>{usd(snapshot.quote.price)}</strong></div>
        <div><span>Fair value</span><strong>{usd(snapshot.fairValue, 0)}</strong></div>
        <div><span>Buy zone</span><strong>{snapshot.buyZone === null ? "—" : usd(snapshot.buyZone, 0)}</strong></div>
        <div><span>Strong buy zone</span><strong>{snapshot.strongBuyZone === null ? "—" : usd(snapshot.strongBuyZone, 0)}</strong></div>
        <div><span>P10 / P90</span><strong>{snapshot.p10 === null || snapshot.p90 === null ? "—" : `${usd(snapshot.p10, 0)} – ${usd(snapshot.p90, 0)}`}</strong></div>
        <div><span>{label}</span><strong>{reference === null ? "—" : usd(reference)}</strong></div>
      </div>
      <p className={comparison === null ? "opt-support-verdict neutral" : comparison ? "opt-support-verdict good" : "opt-support-verdict warn"}>
        {comparison === null
          ? `Select a ${strategy === "put" ? "put" : "call"} candidate to compare its ${strategy === "put" ? "breakeven" : "strike"} with the published valuation range.`
          : comparison
            ? strategy === "put"
              ? "BELOW BUY ZONE ✓ — assignment would occur at or below the published buy zone."
              : "AT OR ABOVE FAIR VALUE ✓ — assignment would occur at the published fair value or better."
            : strategy === "put"
              ? "ABOVE BUY ZONE — assignment would occur above the published buy zone."
              : "BELOW FAIR VALUE — assignment would cap the stock below the published fair value."}
      </p>
      <p className="opt-support-source">{snapshot.valuationFamilyLabel} · the same cached valuation snapshot the valuation page publishes · updated {new Date(snapshot.valuationUpdatedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET</p>
    </div>
  );
}

export default function ChainDesk({ symbol, tab, onTab, onSelect, tier }: Props) {
  const isPro = tier === "PRO";
  const [chain, setChain] = useState<NormalizedOptionChain | null>(null);
  const [expiration, setExpiration] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<OptionsReview | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [message, setMessage] = useState("Loading listed contracts from the public indicative feed…");
  const [snapshot, setSnapshot] = useState<InvestmentSnapshot | null>(null);
  const [valuationLabel, setValuationLabel] = useState("Valuation support is loading independently.");
  const [moreGreeks, setMoreGreeks] = useState(false);
  const [showAllStrikes, setShowAllStrikes] = useState(false);
  const [preset, setPreset] = useState<OptionsPresetId>("balanced");
  const [settings, setSettings] = useState<StrategyScreenSettings>({
    cash: 25_000, shares: 100, contracts: 1, feesPerContract: 1.3, minReturnPct: 1, minDte: 7, maxDte: 30,
    minAbsDelta: 0.15, maxAbsDelta: 0.35, maxSpreadPct: 20, minOpenInterest: 100, averageCost: 0, desiredMinimumExitPrice: 0,
  });

  useEffect(() => {
    const controller = new AbortController();
    // One cached investment snapshot drives the whole page. The options engine
    // never re-derives fair value and never triggers an AI call.
    fetch(`/api/valuation/snapshot?ticker=${encodeURIComponent(symbol)}&view=1`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : null)
      .then((data) => {
        const next = (data?.snapshot ?? null) as InvestmentSnapshot | null;
        setSnapshot(next);
        // Valuation support is neutral unless the canonical snapshot published a
        // reconciled fair value; the options engine never invents a support level.
        const usable = next?.releaseGate === "passed" && next.fairValue !== null;
        setSettings((prior) => ({ ...prior, fairValue: usable ? next!.fairValue : null, buyZone: usable ? next!.buyZone : null, strongBuyZone: usable ? next!.strongBuyZone : null }));
        setValuationLabel(usable
          ? `Signal Ledger fair value ${usd(next!.fairValue)}${next!.buyZone ? ` · Buy Zone ${usd(next!.buyZone)}` : ""} · snapshot ${next!.snapshotId}.`
          : next
            ? `Valuation support is neutral: ${next.releaseGateDetail}`
            : "No published fair value; valuation support remains neutral.");
      })
      .catch(() => setValuationLabel("Valuation service unavailable; valuation support remains neutral."));
    return () => controller.abort();
  }, [symbol]);

  function applyChain(next: NormalizedOptionChain) {
    setChain(next);
    setExpiration(next.expiration);
    setMessage(`${next.provider} · ${next.dataFeed} · retrieved ${new Date(next.retrievedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`);
  }

  async function refreshExpiration(nextExpiration: string) {
    setExpiration(nextExpiration);
    setBusy(true);
    setReview(null);
    setReviewError("");
    try {
      const query = new URLSearchParams({ ticker: symbol, expiration: nextExpiration });
      const response = await fetch(`/api/options/chain?${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Options data is unavailable.");
      applyChain(body as NormalizedOptionChain);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Options data is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ ticker: symbol });
    Promise.resolve().then(() => setShowAllStrikes(false));
    fetch(`/api/options/chain?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => ({ response, body: await response.json() }))
      .then(({ response, body }) => {
        if (!response.ok) throw new Error(body.error || "Options data is unavailable.");
        applyChain(body as NormalizedOptionChain);
      })
      .catch((error) => { if (error instanceof Error && error.name !== "AbortError") { setChain(null); setMessage(error.message); } })
      .finally(() => setBusy(false));
    return () => controller.abort();
  }, [symbol]);

  const spot = chain?.underlyingPrice ?? null;
  // Default view: ±10 useful strikes around spot with dead contracts hidden.
  const display = useMemo(() => selectDisplayStrikes(chain?.contracts ?? [], spot, showAllStrikes), [chain, spot, showAllStrikes]);
  const rows = display.rows;
  const hiddenCount = display.hidden;
  // The tightest two-sided market on each side gets a small marker instead of a
  // bright fill, keeping the table readable at broker density.
  const bestBySide = useMemo(() => {
    const tightest = (side: "call" | "put") => rows
      .map((row) => row[side])
      .filter((contract): contract is NormalizedOptionContract => Boolean(contract) && contract!.bid !== null && contract!.spreadPct !== null)
      .sort((left, right) => (left.spreadPct ?? 99) - (right.spreadPct ?? 99))[0] ?? null;
    return { call: tightest("call"), put: tightest("put") };
  }, [rows]);
  // Both strategies are ranked independently so neither is a second-class tool.
  const putRanked = useMemo(() => chain?.underlyingPrice ? rankCashSecuredPuts(chain.contracts, chain.underlyingPrice, settings) : [], [chain, settings]);
  const callRanked = useMemo(() => chain?.underlyingPrice ? rankCoveredCalls(chain.contracts, chain.underlyingPrice, settings) : [], [chain, settings]);
  const putPicks = useMemo(() => buildOptionsPicks(putRanked), [putRanked]);
  const callPicks = useMemo(() => buildOptionsPicks(callRanked), [callRanked]);
  const recommended = useMemo(
    () => new Set([...putRanked, ...callRanked].map((candidate) => `${candidate.expiration}|${candidate.strike}`)),
    [putRanked, callRanked],
  );
  const strategy: Strategy | null = tab === "chain" ? null : tab;
  const primaryPick = (strategy === "call" ? callPicks : putPicks).find((pick) => pick.label === "BEST RISK-ADJUSTED")?.candidate
    ?? (strategy === "call" ? callRanked : putRanked)[0]
    ?? null;
  const contractFor = (candidate: StrategyCandidate, side: Strategy) => chain?.contracts.find((item) => item.type === side && item.expiration === candidate.expiration && item.strike === candidate.strike);

  const setNumber = (key: keyof StrategyScreenSettings, value: string) => {
    setReview(null);
    setReviewError("");
    setSettings((prior) => ({ ...prior, [key]: value === "" ? 0 : Number(value) }));
  };
  const field = (key: keyof StrategyScreenSettings, label: string) => <label className="opt-field"><span>{label}</span><input type="number" min="0" step="any" value={Number(settings[key] ?? 0)} onChange={(event) => setNumber(key, event.target.value)} /></label>;
  function choose(contract: NormalizedOptionContract) {
    if (!chain?.underlyingPrice) return;
    onTab(contract.type);
    onSelect(legacyContract(contract), {
      symbol: chain.underlying, companyName: chain.underlying, spot: chain.underlyingPrice,
      spotUpdatedAt: chain.underlyingQuoteTimestamp, spotAvailability: "IEX reference; options indicative/delayed", spotFresh: false,
      receivedAt: chain.retrievedAt, contracts: chain.contracts.map(legacyContract), scope: chain.dataFeed,
    }, { minReturnPct: settings.minReturnPct, cash: settings.cash, shares: settings.shares, quantity: settings.contracts, feesPerContract: settings.feesPerContract, maxSpreadPct: settings.maxSpreadPct });
  }

  async function requestAiReview() {
    const active = strategy === "call" ? callRanked : putRanked;
    if (!chain || !active.length) return;
    setReviewing(true);
    setReviewError("");
    try {
      const response = await fetch("/api/options/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          underlying: chain.underlying,
          strategy: strategy === "call" ? "covered_call" : "cash_secured_put",
          candidates: active,
          valuationContext: {
            currentPrice: chain.underlyingPrice,
            fairValue: snapshot?.fairValue ?? null,
            p10: snapshot?.p10 ?? null,
            p90: snapshot?.p90 ?? null,
            buyZone: snapshot?.buyZone ?? null,
            strongBuyZone: snapshot?.strongBuyZone ?? null,
          },
          riskSettings: {
            cash: settings.cash,
            shares: settings.shares,
            contracts: settings.contracts,
            minimumReturnPct: settings.minReturnPct,
            maximumSpreadPct: settings.maxSpreadPct,
          averageCost: settings.averageCost ?? null,
            desiredMinimumExitPrice: settings.desiredMinimumExitPrice ?? null,
          },
          snapshotKey: `${chain.underlying}:${chain.expiration}:${chain.retrievedAt}`,
          expiration: chain.expiration,
          chainTimestamp: chain.retrievedAt,
          filterHash: optionsFilterHash(settings),
          valuationSnapshotId: snapshot?.snapshotId ?? "unavailable",
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "AI review is unavailable.");
      setReview(body as OptionsReview);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "AI review is unavailable.");
    } finally {
      setReviewing(false);
    }
  }

  const chainColumn = (contract: NormalizedOptionContract | undefined, side: "call" | "put") => {
    const inTheMoney = Boolean(contract && spot && (side === "call" ? contract.strike < spot : contract.strike > spot));
    const liquid = Boolean(contract && ((contract.volume ?? 0) >= 500 || (contract.openInterest ?? 0) >= 1000));
    const highIv = Boolean(contract && contract.iv !== null && contract.iv >= 1);
    const best = Boolean(contract && bestBySide[side]?.symbol === contract.symbol);
    // Bid and Ask always sit immediately next to the central strike column on
    // both sides, mirroring a broker terminal. Greeks are secondary and appear
    // between the essential quotes and their wing columns when enabled.
    const quoting = <>
      <td className={`quote-cell ${side}-bid ${inTheMoney ? "itm" : "otm"}`}>{usd(contract?.bid ?? null)}</td>
      <td className={`quote-cell ${side}-ask ${best ? "best-quote" : ""}`}>{usd(contract?.ask ?? null)}</td>
    </>;
    // IV/Delta and the secondary Greeks are advanced analytics (PRO). FREE keeps
    // the basic chain: bid, ask, strike, volume and open interest only.
    const pricing = isPro ? <><td className={highIv ? "high-iv" : ""}>{iv(contract?.iv ?? null)}</td><td>{decimal(contract?.delta ?? null)}</td></> : null;
    const greeks = isPro && moreGreeks
      ? <><td>{decimal(contract?.gamma ?? null, 3)}</td><td>{decimal(contract?.theta ?? null, 3)}</td><td>{decimal(contract?.vega ?? null, 3)}</td></>
      : null;
    const liquidity = <><td className={liquid ? "liquid" : ""}>{contract?.volume ?? "—"}</td><td>{contract?.openInterest ?? "—"}</td></>;
    return side === "call" ? <>{liquidity}{greeks}{pricing}{quoting}</> : <>{quoting}{pricing}{greeks}{liquidity}</>;
  };
  const callLabels = ["OI", "Vol", ...(isPro && moreGreeks ? ["Vega", "Theta", "Gamma"] : []), ...(isPro ? ["IV", "Delta"] : []), "Bid", "Ask"];
  const putLabels = ["Bid", "Ask", ...(isPro ? ["IV", "Delta"] : []), ...(isPro && moreGreeks ? ["Gamma", "Theta", "Vega"] : []), "Vol", "OI"];
  const sideColumns = callLabels.length;

  const strategyPanel = (side: Strategy, ranked: StrategyCandidate[], picks: ReturnType<typeof buildOptionsPicks>) => (
    <section className={`opt-reco-panel ${strategy === side ? "focused" : ""}`} aria-label={side === "put" ? "Sell put recommendations" : "Covered call recommendations"}>
      <header>
        <div>
          <p className="opt-kicker">{side === "put" ? "SELL PUT" : "COVERED CALL"}</p>
          <h3>{side === "put" ? "Cash-secured put candidates" : "Covered call candidates"}</h3>
        </div>
        <button className="opt-link" type="button" onClick={() => onTab(side)}>{strategy === side ? "Focused" : "Focus this strategy"}</button>
      </header>
      <p className="opt-reco-rule">{side === "put"
        ? "premium return × liquidity × spread × delta × valuation support × IV attractiveness"
        : "premium yield × liquidity × spread × upside retained × strike vs fair value × delta"}</p>
      {ranked.length
        ? <div className="opt-pick-cards">{ranked.slice(0, 5).map((candidate, index) => {
          const pick = picks.find((item) => item.candidate.symbol === candidate.symbol);
          return <PickCard
            key={candidate.symbol}
            labels={pick ? pick.label : `#${index + 1}`}
            candidate={candidate}
            strategy={side}
            available={Boolean(contractFor(candidate, side))}
            onModel={() => { const contract = contractFor(candidate, side); if (contract) choose(contract); }}
          />;
        })}</div>
        : <p className="opt-empty-line"><strong>NO ATTRACTIVE TRADE</strong> — no {side === "put" ? "put" : "covered call"} clears every return, coverage, DTE, delta, spread and open-interest rule. The ranking is deterministic and never forced.</p>}
    </section>
  );

  return (
    <section className="opt-card opt-chain" id="chain" aria-labelledby="chain-title">
      <div className="opt-panel-heading">
        <div><p className="opt-kicker">OPTIONS DESK</p><h2 id="chain-title">{symbol} option chain{spot ? ` · ${usd(spot)}` : ""}</h2></div>
        <div className="opt-chain-badges">
          <span className={`tier-chip ${isPro ? "tier-chip-pro" : "tier-chip-free"}`}>
            {isPro ? "PRO · FULL CHAIN & ANALYTICS" : "FREE · BASIC CHAIN"}
          </span>
          <div className="opt-feed-badge">DELAYED / INDICATIVE OPTIONS DATA</div>
        </div>
      </div>
      <div className="opt-chain-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "chain"} className={tab === "chain" ? "selected" : ""} onClick={() => onTab("chain")}>Option Chain</button>
        {isPro ? (
          <>
            <button role="tab" aria-selected={tab === "put"} className={tab === "put" ? "selected" : ""} onClick={() => onTab("put")}>Sell Put</button>
            <button role="tab" aria-selected={tab === "call"} className={tab === "call" ? "selected" : ""} onClick={() => onTab("call")}>Covered Call</button>
          </>
        ) : null}
      </div>

      <div className="opt-panel-heading opt-chain-heading">
        <div><p className="opt-kicker">OPTION QUOTES</p><h3>{chain?.expiration ?? "Next listed expiration"}</h3></div>
        <div className="opt-chain-toggles">
          {isPro ? <label className="opt-check"><input type="checkbox" checked={moreGreeks} onChange={(event) => setMoreGreeks(event.target.checked)} /> More Greeks</label> : null}
          <label className="opt-check"><input type="checkbox" checked={showAllStrikes} onChange={(event) => setShowAllStrikes(event.target.checked)} /> Show all strikes</label>
        </div>
      </div>
      <div className="opt-chain-toolbar">
        <label className="opt-field"><span>Expiration</span><select value={expiration} disabled={!chain || busy} onChange={(event) => void refreshExpiration(event.target.value)}>{chain?.expirations.map((date) => <option key={date} value={date}>{date}</option>)}</select></label>
        <span className="opt-connection-status" role="status">{busy ? "Refreshing…" : message}</span>
      </div>
      <p className="opt-note">
        Bid and Ask sit beside the frozen strike column on both sides. Default view is ±10 strikes around spot with dead contracts (no bid or a very wide spread) hidden.
        {hiddenCount > 0 ? ` ${hiddenCount} row${hiddenCount === 1 ? "" : "s"} hidden until “Show all strikes”.` : ""}
        {" "}Highlights: <span className="opt-legend atm">ATM</span> <span className="opt-legend itm">ITM</span> <span className="opt-legend otm">OTM</span> <span className="opt-legend liquid">liquid</span>{isPro ? <><span className="opt-legend high-iv">high IV</span> <span className="opt-legend recommended">recommended</span></> : null}
      </p>
      {chain ? <div className="opt-table-scroll opt-broker-chain" role="region" aria-label={`${symbol} calls and puts`} tabIndex={0}>
        <table>
          <thead>
            <tr><th colSpan={sideColumns}>CALLS</th><th className="strike-head">STRIKE</th><th colSpan={sideColumns}>PUTS</th></tr>
            <tr>
              {callLabels.map((label, index) => <th key={`call-${label}-${index}`} className={label === "Bid" || label === "Ask" ? "quote-edge" : ""}>{label}</th>)}
              <th className="strike-head">Strike</th>
              {putLabels.map((label, index) => <th key={`put-${label}-${index}`} className={label === "Bid" || label === "Ask" ? "quote-edge" : ""}>{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ strike, call, put }) => {
              const nearMoney = Boolean(spot && Math.abs(strike - spot) / spot < 0.01);
              const recommendedRow = isPro && recommended.has(`${chain.expiration}|${strike}`);
              return <tr key={strike} className={`${nearMoney ? "atm-row" : ""} ${recommendedRow ? "recommended-strike" : ""}`}>
                {chainColumn(call, "call")}
                <th className="strike-cell">{usd(strike)}</th>
                {chainColumn(put, "put")}
              </tr>;
            })}
          </tbody>
        </table>
      </div> : null}
      {!chain && !busy && <div className="opt-empty-line" role="status"><p>Quotes could not load for this stock. This is not a plan restriction. Try another symbol or retry; no broker login is needed.</p><button className="opt-button" onClick={() => void refreshExpiration(expiration)}>Retry quotes</button></div>}

      {isPro ? (
        <>
          <div className="opt-panel-heading opt-reco-heading">
        <div><p className="opt-kicker">DETERMINISTIC RECOMMENDATIONS</p><h3>Top candidates per strategy</h3></div>
        <p>Screened from the chain above and the same cached valuation snapshot the valuation page publishes. No AI is used to build this ranking.</p>
      </div>
      <div className="opt-strategy-filters">
        <div className="opt-preset-row" role="group" aria-label="Screening preset">
          <span>Preset</span>
          {(Object.keys(OPTIONS_PRESETS) as OptionsPresetId[]).map((id) => <button
            key={id}
            type="button"
            className={preset === id ? "selected" : ""}
            onClick={() => { setPreset(id); setSettings((prior) => applyOptionsPreset(prior, id)); }}
          >{OPTIONS_PRESETS[id].label}</button>)}
          <small>{`DTE ${OPTIONS_PRESETS[preset].minDte}–${OPTIONS_PRESETS[preset].maxDte} · |delta| ${OPTIONS_PRESETS[preset].minAbsDelta}–${OPTIONS_PRESETS[preset].maxAbsDelta} · OI ≥ ${OPTIONS_PRESETS[preset].minOpenInterest} · spread ≤ ${OPTIONS_PRESETS[preset].maxSpreadPct}% · return ≥ ${OPTIONS_PRESETS[preset].minReturnPct}%`}</small>
        </div>
        {field("minReturnPct", "Minimum return / trade (%)")}
        {field("contracts", "Contracts")}
        {field("cash", "Cash reserved for puts ($)")}
        {field("shares", "Unencumbered shares")}
        {field("averageCost", "Average cost ($/share)")}
        {field("desiredMinimumExitPrice", "Minimum exit price ($)")}
        {field("maxSpreadPct", "Maximum spread (%)")}
        {field("minOpenInterest", "Minimum open interest")}
      </div>
      <div className="opt-reco-grid">
        {strategyPanel("put", putRanked, putPicks)}
        {strategyPanel("call", callRanked, callPicks)}
      </div>
      <div className="opt-reco-footer">
        <FairValueSupport snapshot={snapshot} strategy={strategy ?? "put"} candidate={primaryPick} />
        <div className="opt-reco-side">
          <p className="opt-note">{valuationLabel}</p>
          <p className="opt-note">Cash-secured puts use net bid premium ÷ full strike cash collateral. Covered calls use net bid premium ÷ current covered-share value and require unencumbered shares. The primary return is per trade; annualized yield is only a standardized reference. DTE 7–30 and |delta| 0.15–0.35 are enforced.</p>
          <div className="opt-ai-review-controls">
            <button className="opt-button" disabled={reviewing || !(strategy === "call" ? callRanked : putRanked).length} onClick={() => void requestAiReview()}>
              {reviewing ? "Reviewing top trades…" : `Ask AI to review ${strategy === "call" ? "covered call" : "sell put"} candidates`}
            </button>
            <span>Optional and user-triggered. The reviewer receives only the ticker, the valuation context and the screened candidates — never the full chain. Results are cached for five minutes.</span>
          </div>
          {reviewError && <p className="opt-empty-line">{reviewError}</p>}
          {review && <div className={`opt-ai-review ${review.decision === "NO_TRADE" ? "no-trade" : ""}`}>
            <p className="opt-kicker">AI RISK REVIEW · {review.cached ? "CACHED" : "NEW"}</p>
            <h3>{review.decision === "SELECT" ? `Preferred: ${review.selectedSymbol}` : "NO TRADE"}</h3>
            {review.alternativeSymbol && <p><strong>Alternative:</strong> {review.alternativeSymbol}</p>}
            <p><strong>Why:</strong> {review.summary}</p>
            {review.tradeoffs.length > 0 && <p><strong>Trade-offs:</strong> {review.tradeoffs.join(" · ")}</p>}
            {review.risks.length > 0 && <p><strong>Main risk:</strong> {review.risks.join(" · ")}</p>}
          </div>}
        </div>
      </div>

        </>
      ) : (
        <div className="opt-pro-lock">
          <ProAccessPanel
            kicker="SIGNAL LEDGER PRO"
            title="Advanced options intelligence"
            description="The quote table above is free. Pro adds the analysis layer on top of it: implied volatility, Greeks, a ranked comparison of strikes, and the cash-secured put and covered-call screeners with a fair-value check."
            features={[
              "AI Sell Put and AI Covered Call",
              "IV / Greeks and strategy ranking",
              "Deterministic strategy screeners",
              "Fair-value support and risk review",
            ]}
            cta="COMPARE FREE & PRO"
          />
        </div>
      )}

      <p className="opt-note">Indicative quotes may be modified and trades may be delayed by approximately 15 minutes. This page never labels the free feed as real-time OPRA and never places orders.</p>
    </section>
  );
}
