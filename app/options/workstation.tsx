"use client";

import { useMemo, useState } from "react";
import PlanBoundary from "../research-guide";
import SiteNav from "../site-nav";
import type { MemberState } from "@/lib/member-session";
import { americanOption, optionSellerPnl, sellerRisk, optionDateMs, addOptionDays, type OptionRight } from "@/lib/options-math";
import ChainDesk from "./chain-desk";
import type { ChainTab } from "./chain-desk";
import type { ChainContract, OptionChain, ScreenInputs } from "@/lib/options-screen";

const WATCHLIST = { SPY: "S&P 500 ETF", QQQ: "Nasdaq-100 ETF", NVDA: "NVIDIA", TSLA: "Tesla", AMD: "Advanced Micro Devices", SOXL: "Daily 3× semiconductor ETF", SPCX: "Space Exploration Technologies" };
const money = (v: number) => Number.isFinite(v) ? v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }) : "—";
const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
type Form = { spot: string; strike: string; iv: string; credit: string; scenarioSpot: string; asOf: string; expiry: string; scenarioDate: string; quantity: string; rate: string; yield: string; fees: string; stockCost: string; shares: string; cash: string };
const initial: Form = { spot: "", strike: "", iv: "", credit: "", scenarioSpot: "", asOf: "", expiry: "", scenarioDate: "", quantity: "1", rate: "4", yield: "0", fees: "0", stockCost: "", shares: "0", cash: "0" };

export default function OptionsWorkstation({ initialTicker = null, member }: { initialTicker?: string | null; member: MemberState }) {
  // A ticker supplied by a link is accepted even when it is outside the
  // shortcut list, so any listed symbol can be opened directly.
  const [ticker, setTicker] = useState<string>(initialTicker ?? "SOXL");
  const watchlist = initialTicker && !(initialTicker in WATCHLIST)
    ? { [initialTicker]: "Selected symbol", ...WATCHLIST }
    : WATCHLIST;
  const [right, setRight] = useState<OptionRight>("put");
  const [form, setForm] = useState<Form>(() => { const day = todayET(); return { ...initial, asOf: day, scenarioDate: addOptionDays(day, 7), expiry: addOptionDays(day, 14) }; });
  const [example, setExample] = useState(false);
  const [display, setDisplay] = useState<"price" | "pnl">("price");
  const [snapshotNote, setSnapshotNote] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // The desk opens on the neutral chain. An explicit strategy choice is the
  // user's alone and simply persists while they change tickers.
  const [chainTab, setChainTab] = useState<ChainTab>("chain");
  const set = (key: keyof Form, value: string) => setForm(prev => ({ ...prev, [key]: value }));

  const result = useMemo(() => {
    const required: (keyof Form)[] = ["spot", "strike", "iv", "credit", "scenarioSpot", "quantity", "rate", "yield", "fees", "shares", "cash"];
    if (right === "call") required.push("stockCost");
    if (required.some(key => form[key].trim() === "")) return { error: "Enter the contract and scenario assumptions to calculate. No live prices are assumed." };
    const n = Object.fromEntries(required.map(key => [key, Number(form[key])])) as Record<string, number>;
    if (required.some(key => !Number.isFinite(n[key]))) return { error: "Every numeric input must be a valid number." };
    const start = optionDateMs(form.asOf), end = optionDateMs(form.expiry), scenario = optionDateMs(form.scenarioDate);
    if (![start, end, scenario].every(Number.isFinite) || end <= start || scenario < start || scenario > end) return { error: "Scenario date must be between the reference date and expiration; expiration must follow the reference date." };
    if (n.spot <= 0 || n.scenarioSpot < 0 || n.credit < 0 || n.credit > (right === "put" ? n.strike : n.spot) || n.fees < 0 || n.cash < 0 || n.shares < 0 || n.stockCost < 0 || !Number.isInteger(n.quantity) || n.quantity < 1 || n.quantity > 10000) return { error: "Check prices, premium, positive whole contracts and nonnegative capital/fees. Premium cannot exceed the underlying or put strike." };
    try {
      const priceAt = (spot: number, date: string, iv = n.iv) => americanOption({ spot, strike: n.strike, iv: iv / 100, years: Math.max(0, (end - optionDateMs(date)) / (365 * 86400000)), rate: n.rate / 100, dividendYield: n.yield / 100, right });
      // Validate the entire contract horizon even if the selected scenario is at expiry.
      priceAt(n.spot, form.asOf);
      const price = priceAt(n.scenarioSpot, form.scenarioDate);
      const pnl = optionSellerPnl(n.credit, price, n.quantity, n.fees);
      const risk = sellerRisk(right, n.strike, n.credit, n.quantity, n.stockCost || 0, n.fees);
      const covered = right === "call" ? n.shares >= risk.requiredShares : n.cash >= risk.cashReserve;
      const days = Math.round((Date.parse(form.expiry) - Date.parse(form.asOf)) / 86400000);
      const dates = [...new Set([form.asOf, addOptionDays(form.asOf, Math.round(days / 4)), form.scenarioDate, addOptionDays(form.asOf, Math.round(days / 2)), form.expiry])].sort();
      const spots = [...new Set([.8, .9, .95, 1, 1.05, 1.1, 1.2].map(x => Math.round(n.spot * x * 100) / 100).concat(n.scenarioSpot))].sort((a, b) => a - b);
      const rows = spots.map(spot => ({ spot, cells: dates.map(date => { const value = priceAt(spot, date); return { date, price: value, pnl: optionSellerPnl(n.credit, value, n.quantity, n.fees) }; }) }));
      const ivCases = [...new Set([Math.max(0, n.iv - 20), n.iv, Math.min(500, n.iv + 20)])].map(iv => ({ iv, price: priceAt(n.scenarioSpot, form.scenarioDate, iv) }));
      return { price, pnl, risk, covered, days, rows, dates, ivCases, n, totalPnl: right === "call" ? pnl + (n.scenarioSpot - n.stockCost) * 100 * n.quantity : pnl };
    } catch (error) { return { error: error instanceof Error ? error.message : "Unable to calculate this scenario." }; }
  }, [form, right]);

  const field = (key: keyof Form, label: string, type = "number", help?: string) => <label className="opt-field" key={key}>
    <span>{label}</span><input type={type} value={form[key]} onChange={e => set(key, e.target.value)} step={type === "number" ? "any" : undefined} aria-label={label} />{help && <small>{help}</small>}
  </label>;
  function selectContract(contract: ChainContract, chain: OptionChain, settings: ScreenInputs) {
    const day = todayET(); setExample(false);
    setSnapshotNote(`Alpaca indicative snapshot: ${contract.expiry} ${contract.strike} ${contract.right}; quote time ${contract.updatedAt || "unverified"}. Values are editable assumptions, not a current executable quote.`);
    setForm({ ...initial, spot: String(chain.spot), strike: String(contract.strike), iv: String(contract.ivPercent), credit: String(contract.bid), scenarioSpot: String(chain.spot), asOf: day, expiry: contract.expiry, scenarioDate: addOptionDays(day, 7), quantity: String(settings.quantity), cash: String(settings.cash), shares: String(settings.shares), fees: String(settings.feesPerContract * settings.quantity), stockCost: String(chain.spot) });
    setAdvancedOpen(true);
    document.getElementById("advanced-tools")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function loadExample() {
    const day = todayET(); setExample(true); setSnapshotNote("");
    setForm({ ...initial, spot: "100", strike: right === "put" ? "95" : "105", iv: "60", credit: "2", scenarioSpot: "98", stockCost: "100", shares: "100", cash: "10000", asOf: day, scenarioDate: addOptionDays(day, 7), expiry: addOptionDays(day, 14) });
  }
  function exportCsv() {
    if (!result.rows) return;
    const lines = [
      ["Scenario assumptions (not live quotes)", example ? "Illustrative" : "User inputs", ticker, right].join(","),
      ["Reference date", form.asOf, "Strike", form.strike, "IV percent", form.iv, "Rate percent", form.rate, "Dividend yield percent", form.yield, "Credit per share", form.credit, "Contracts", form.quantity, "Total fees", form.fees].join(","),
      ["Stock price", ...result.dates.map(d => `${d} ${display === "price" ? "option value USD per share" : "short option PnL USD total"}`)].join(","),
      ...result.rows.map(row => [row.spot, ...row.cells.map(c => c[display].toFixed(4))].join(",")),
    ];
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = `signal-ledger-${ticker}-scenario.csv`; a.click(); URL.revokeObjectURL(url);
  }

  return <main className="options-app">
    <SiteNav current="/options" member={member} />
    <div className="opt-shell">
      <div className="opt-title"><div><p className="opt-kicker">OPTIONS / CASH-SECURED PUTS & COVERED CALLS</p><h1>Options desk</h1></div><a className="opt-button" href="#advanced-tools">Advanced tools ↓</a></div>
      {member.tier !== "PRO" && <PlanBoundary />}
      <details className="research-guide"><summary>New to options? Read this first</summary><dl>
        <div><dt>Cash-secured put</dt><dd>You receive a premium and reserve enough cash to buy the shares at the strike if assigned. A falling stock can still cause a large loss.</dd></div>
        <div><dt>Covered call</dt><dd>You sell a call against shares you own. You keep the premium, but your shares can be sold at the strike and your upside is capped.</dd></div>
        <div><dt>Reading quotes</dt><dd>Bid is the quoted buying price; ask is the selling price. Midpoint is their average, not a guaranteed execution. These quotes are delayed or indicative.</dd></div>
      </dl></details>
      <div className="opt-watchlist" aria-label="Underlying selection">{Object.entries(watchlist).map(([symbol, name]) => <button key={symbol} className={ticker === symbol ? "selected" : ""} onClick={() => { setTicker(symbol); setSnapshotNote(""); setExample(false); setForm(prev => ({ ...initial, asOf: prev.asOf, expiry: prev.expiry, scenarioDate: prev.scenarioDate })); }}><strong>{symbol}</strong><span>{name}</span></button>)}</div>
      <p className="opt-note">{ticker === "SOXL" ? "SOXL targets daily 3× exposure. Multi-day returns are path-dependent; a cash-secured put still carries substantial downside." : ticker === "SPCX" ? "SPCX is Space Exploration Technologies, listed on Nasdaq in June 2026 and unrelated to the ETF that previously used this ticker (now SPCK). Pre-listing history is excluded and listed option availability must be confirmed with the data provider." : "Selling a call caps stock upside. Selling a put commits cash to buying shares if assigned, including after a sharp decline."}</p>

      <ChainDesk key={ticker} symbol={ticker} tab={chainTab} onTab={value => { setChainTab(value); if (value !== "chain") { setRight(value); setSnapshotNote(""); setForm(prev => ({ ...initial, asOf: prev.asOf, expiry: prev.expiry, scenarioDate: prev.scenarioDate })); } }} onSelect={selectContract} tier={member.tier} />
      <details className="opt-advanced" id="advanced-tools" open={advancedOpen} onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}>
        <summary><span>Advanced tools</span><strong>Option Scenario Analyzer</strong><small>Estimate future option value under different stock price, date and IV assumptions.</small></summary>
      <section className="opt-workspace" aria-labelledby="calculator-title">
        <div className="opt-input-panel"><div className="opt-panel-heading"><h2 id="calculator-title">Option Scenario Analyzer</h2><button className="opt-link" onClick={loadExample}>Load illustrative example</button></div>
          <p className="opt-note">{example ? "ILLUSTRATIVE VALUES — $100 reference, not the selected stock’s quote." : snapshotNote || "Select a contract above or enter your own assumptions. No live execution price is assumed."}</p>
          <div className="opt-fields">{field("spot", "Reference stock price ($)")}{field("strike", "Strike price ($)")}{field("credit", "Opening credit ($/share)", "number", "For a new sale, use a current bid; a midpoint is not a fill.")}{field("iv", "Future IV assumption (%)", "number", "Annualized; editable. This is not IV rank.")}{field("asOf", "Reference date", "date")}{field("expiry", "Contract expiration", "date", "Verify an actual listed expiry; all dates use 16:00 New York.")}</div>
          <div className="opt-scenario-input"><h3>Your what-if</h3><div className="opt-fields">{field("scenarioDate", "On this date", "date")}{field("scenarioSpot", "If the stock is ($)")}</div></div>
          <details className="opt-details" open><summary>Position coverage &amp; assumptions</summary><div className="opt-fields">{field("quantity", "Contracts (100 shares each)")}{right === "call" ? field("shares", "Unencumbered shares owned") : field("cash", "Cash reserved for this trade ($)")}{right === "call" && field("stockCost", "Stock cost basis ($/share)")}{field("fees", "Total opening + closing fees ($)")}{field("rate", "Annual risk-free rate (%)", "number", "4% is a user-editable assumption, not a current rate feed.")}{field("yield", "Annual dividend yield (%)")}</div></details>
        </div>
        <div className="opt-output-panel" aria-live="polite">
          <p className="opt-kicker">YOUR SCENARIO / MODEL ESTIMATE</p>
          {result.error ? <div className="opt-empty"><h2>What would this option cost?</h2><p>{result.error}</p><p>Input a future date, stock price and IV. The table updates automatically.</p></div> : result.risk && <>
            <h2>{ticker} {form.strike} {right === "put" ? "Put" : "Call"}</h2><p>{form.scenarioDate} · stock at {money(Number(form.scenarioSpot))} · assumed IV {form.iv}%</p>
            <div className="opt-main-number">{money(result.price!)}<span>estimated option value / share</span></div>
            <div className="opt-stat-grid"><div><span>Short option P/L · {form.quantity} contract(s)</span><strong className={result.pnl! >= 0 ? "opt-positive" : "opt-negative"}>{money(result.pnl!)}</strong></div><div><span>{right === "call" ? "Stock + call P/L (cost basis)" : "Cash reserve required"}</span><strong>{money(right === "call" ? result.totalPnl! : result.risk.cashReserve)}</strong></div></div>
            <p className="opt-note">P/L assumes repurchase at model value, minus the entered fees. Slippage, taxes, dividends and financing are excluded. Actual buyback generally occurs at an executable ask.</p>
            <div className={result.covered ? "opt-coverage" : "opt-coverage insufficient"}><strong>{result.covered ? "User-entered coverage is sufficient" : "Insufficient coverage — do not open this position"}</strong><span>{right === "call" ? `Requires ${result.risk.requiredShares} unencumbered shares.` : `Requires ${money(result.risk.cashReserve)} reserved cash.`} Account holdings are not verified.</span></div>
            <div className="opt-stat-grid"><div><span>Expiration breakeven</span><strong>{money(result.risk.breakeven)}</strong></div><div><span>Maximum profit at expiration</span><strong>{money(result.risk.maxProfit)}</strong></div><div><span>Loss if stock goes to zero</span><strong className="opt-negative">{money(result.risk.maxLoss)}</strong></div><div><span>Calendar days to expiry at reference</span><strong>{result.days}</strong></div></div>
            <h3>Same stock price. Different IV.</h3><div className="opt-iv-cases">{result.ivCases!.map(item => <div key={item.iv}><span>IV {item.iv}%</span><strong>{money(item.price)}</strong></div>)}</div><p className="opt-note">±20 percentage points around your IV assumption. Event-related IV collapse can materially change buyback cost.</p>
          </>}
        </div>
      </section>
      </details>

      <section className="opt-card" aria-labelledby="matrix-title"><div className="opt-panel-heading"><div><p className="opt-kicker">INTERACTIVE SENSITIVITY TABLE</p><h2 id="matrix-title">Stock price × future date</h2></div><div className="opt-tools"><div className="opt-toggle"><button className={display === "price" ? "selected" : ""} onClick={() => setDisplay("price")}>Option price</button><button className={display === "pnl" ? "selected" : ""} onClick={() => setDisplay("pnl")}>Short option P/L</button></div><button className="opt-button" disabled={!result.rows} onClick={exportCsv}>Export CSV</button></div></div>
        {result.rows ? <><p className="opt-note">{display === "price" ? "USD per share. Multiply by 100 for one standard contract." : "USD total for the entered number of contracts; excludes stock P/L."} Fixed IV {form.iv}%. Scroll horizontally; outlined cell is your selected scenario.</p><div className="opt-table-scroll" tabIndex={0} role="region" aria-label="Scrollable scenario table"><table><thead><tr><th>Stock price</th>{result.dates.map(date => <th key={date}>{date}{date === form.expiry ? " · expiry" : ""}</th>)}</tr></thead><tbody>{result.rows.map(row => <tr key={row.spot}><th>{money(row.spot)}</th>{row.cells.map(cell => <td key={cell.date} className={`${display === "pnl" ? (cell.pnl >= 0 ? "gain" : "loss") : ""} ${row.spot === Number(form.scenarioSpot) && cell.date === form.scenarioDate ? "chosen" : ""}`}>{money(cell[display])}</td>)}</tr>)}</tbody></table></div></> : <p className="opt-empty-line">Complete the inputs above to generate your scenario table.</p>}
      </section>

      <footer className="opt-footer"><strong>Model &amp; limits</strong><p>American binomial valuation with early exercise, actual calendar time / 365 and a continuous dividend yield. Standard USD, 100-share contracts only; no adjusted deliverables. Dates assume 16:00 New York—check the actual contract’s last trading time. Discrete dividends, volatility skew, borrow costs and execution spreads are not modelled. Covered calls can be assigned early; cash-secured puts can lose almost the entire reserved capital.</p><p><a href="https://docs.alpaca.markets/docs/about-market-data-api" target="_blank" rel="noreferrer">Alpaca market-data definitions ↗</a> · <a href="https://www.direxion.com/product/daily-semiconductor-bull-bear-3x-etfs" target="_blank" rel="noreferrer">SOXL product risks ↗</a></p></footer>
    </div>
  </main>;
}
