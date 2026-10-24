"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { LAUNCH_TICKERS, isLaunchTicker } from "@/lib/launch-universe";
import { computeOwnerForecastTree, type ForecastBusiness, type OwnerForecastTree } from "@/lib/owner-forecast-tree";

type Payload = { revision: number; tree: OwnerForecastTree | null; evidenceStatus?: string; evidenceReason?: string;
  published?: { id: string; revision: number; publishedAt: number } | null; newFiling?: boolean };

const percent = (value: number | null) => value === null ? "" : String(Number((value * 100).toFixed(4)));
const decimal = (value: number | null) => value === null ? "" : String(value);
const billions = (value: number | null) => value === null ? "—" : `$${value.toFixed(3)}B`;

function numberFromInput(value: string, percentInput = false) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? (percentInput ? parsed / 100 : parsed) : null;
}

function NumberInput({ label, value, onChange, step = "any", suffix = "" }: {
  label: string; value: number | null; onChange: (value: number | null) => void; step?: string; suffix?: string;
}) {
  const shown = suffix === "%" ? percent(value) : decimal(value);
  return <label className="ov-field"><span>{label}</span><div><input type="number" inputMode="decimal" step={step} value={shown}
    onChange={(event) => onChange(numberFromInput(event.target.value, suffix === "%"))} /><em>{suffix}</em></div></label>;
}

export default function OwnerValuationEditor({ initialTicker }: { initialTicker: string }) {
  const [ticker, setTicker] = useState(isLaunchTicker(initialTicker) ? initialTicker : "NVDA");
  const [tree, setTree] = useState<OwnerForecastTree | null>(null);
  const [revision, setRevision] = useState(0);
  const [published, setPublished] = useState<Payload["published"]>(null);
  const [evidenceNote, setEvidenceNote] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newFiling, setNewFiling] = useState(false);
  const preview = useMemo(() => tree ? computeOwnerForecastTree(tree) : null, [tree]);

  useEffect(() => {
    const controller = new AbortController();
    Promise.resolve().then(() => { setLoading(true); setMessage(""); setTree(null); setDirty(false); });
    fetch(`/api/owner/valuation/${ticker}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(`Owner research returned ${response.status}.`); return response.json() as Promise<Payload>; })
      .then((data) => { setRevision(data.revision); setTree(data.tree); setPublished(data.published); setNewFiling(Boolean(data.newFiling));
        setEvidenceNote(data.evidenceStatus === "verified" ? "SEC business rows verified." : data.evidenceReason ?? ""); setLoading(false); })
      .catch((error) => { if (controller.signal.aborted) return; setMessage(error instanceof Error ? error.message : "Could not load research."); setLoading(false); });
    return () => controller.abort();
  }, [ticker]);

  const updateTree = (change: (current: OwnerForecastTree) => OwnerForecastTree) => {
    setTree((current) => current ? change(current) : current);
    setDirty(true);
  };
  const updateBusiness = (id: string, change: (node: ForecastBusiness) => ForecastBusiness) =>
    updateTree((current) => ({ ...current, businesses: current.businesses.map((node) => node.id === id ? change(node) : node) }));
  const depth = (node: ForecastBusiness) => {
    let count = 0; let parentId = node.parentId;
    while (parentId && count < 5) { count += 1; parentId = tree?.businesses.find((item) => item.id === parentId)?.parentId ?? null; }
    return count;
  };
  const addChild = (parent: ForecastBusiness) => updateTree((current) => ({ ...current, businesses: [...current.businesses, {
    ...parent, id: `owner-${crypto.randomUUID().slice(0, 8)}`, parentId: parent.id, basis: "owner_split",
    baseRevenueB: current.businesses.some((node) => node.parentId === parent.id) ? 0 : parent.baseRevenueB,
    name: `${parent.name} sub-business`, annualGrowth: null, quantityYearOne: null, unitPriceUsdYearOne: null,
    quantityGrowth: null, unitPriceGrowth: null, netMargin: null, pe: null, note: "Owner analytical split; allocate disclosed parent revenue.",
  }] }));
  const removeChild = (id: string) => updateTree((current) => ({ ...current,
    businesses: current.businesses.filter((node) => node.id !== id) }));
  const save = async () => {
    if (!tree) return;
    setSaving(true); setMessage("");
    try {
      const response = await fetch(`/api/owner/valuation/${ticker}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", revision, tree }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `Save failed (${response.status}).`);
      setRevision(data.revision); setDirty(false); setMessage(`Draft saved as revision ${data.revision}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Save failed."); }
    finally { setSaving(false); }
  };
  const refreshSec = async () => {
    if ((revision > 0 || dirty) && !window.confirm("Refresh from the latest SEC filing? This replaces the saved business tree. Matching company and business assumptions are retained where possible.")) return;
    setSaving(true); setMessage("");
    try {
      const response = await fetch(`/api/owner/valuation/${ticker}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rebase", revision }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.reason ?? data.error ?? `Refresh failed (${response.status}).`);
      setTree(data.tree); setRevision(data.revision); setNewFiling(false); setDirty(false);
      setMessage("SEC anchor refreshed. Review the business tree before publishing.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Refresh failed."); }
    finally { setSaving(false); }
  };
  const publish = async () => {
    if (!preview?.ready || dirty || revision < 1) return;
    setSaving(true); setMessage("");
    try {
      const response = await fetch(`/api/owner/valuation/${ticker}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "publish", revision }) });
      const data = await response.json();
      if (!response.ok) throw new Error([data.error, ...(data.issues ?? [])].filter(Boolean).join(" ") || `Publish failed (${response.status}).`);
      setPublished({ ...data.published, revision }); setMessage("Published. The company page now reads this version.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Publish failed."); }
    finally { setSaving(false); }
  };

  return <main className="ov-page"><header className="ov-header"><div><span className="ov-kicker">SIGNAL LEDGER · OWNER DESK</span>
    <h1>Business forecast tree</h1><p>SEC evidence → your operating assumptions → a reviewable scenario → published company page.</p></div>
    <Link href="/companies">20-company overview ↗</Link></header>
    <nav className="ov-tickers" aria-label="Company coverage">{LAUNCH_TICKERS.map((symbol) => <button type="button" key={symbol}
      className={ticker === symbol ? "active" : ""} onClick={() => setTicker(symbol)}>{symbol}</button>)}</nav>
    {loading ? <section className="ov-card"><p>Loading SEC evidence and owner draft…</p></section> : !tree ?
      <section className="ov-card"><span className="ov-kicker">EVIDENCE PENDING</span><h2>{ticker} business split is not verified</h2>
        <p>{evidenceNote || "No reconciled SEC business table is available yet."}</p><p>The page will not invent segment numbers.</p>
        <div className="ov-actions"><button type="button" disabled={saving} onClick={refreshSec}>Check latest SEC filing</button></div></section> : <>
      <section className="ov-card ov-source"><div><span className="ov-kicker">SOURCE ANCHOR</span><h2>{tree.issuerName} · {ticker}</h2>
        <p>{tree.source.businessKind.replaceAll("_", " ")} · {tree.source.periodForm} period ended {tree.source.periodEnd} · consolidated revenue {billions(tree.source.consolidatedRevenueB)}</p>
        <a href={tree.source.url} target="_blank" rel="noreferrer">Read SEC filing ↗</a></div>
        <div className="ov-status"><strong>{published ? `Published revision ${published.revision}` : "Not published"}</strong>
          <span>{dirty ? "Unsaved changes" : `Draft revision ${revision}`}</span></div></section>
      {newFiling && <section className="ov-card"><span className="ov-kicker">NEW SEC FILING</span><p>A newer periodic report is available. Refresh the anchor and review assumptions before publishing.</p>
        <div className="ov-actions"><button type="button" disabled={saving} onClick={refreshSec}>Refresh SEC anchor</button></div></section>}
      <section className="ov-card"><span className="ov-kicker">COMPANY ASSUMPTIONS</span><h2>Forecast and capital bridge</h2>
        <div className="ov-grid"><NumberInput label="Forecast years" value={tree.horizonYears} step="1" onChange={(value) => updateTree((current) => ({ ...current, horizonYears: value ?? 0 }))} />
          <NumberInput label="Reported period → annual factor" value={tree.annualizationFactor} suffix="×" onChange={(value) => updateTree((current) => ({ ...current, annualizationFactor: value ?? 0 }))} />
          <NumberInput label="Discount rate" value={tree.discountRate} suffix="%" onChange={(value) => updateTree((current) => ({ ...current, discountRate: value }))} />
          <NumberInput label="Diluted shares" value={tree.dilutedSharesB} suffix="billion" onChange={(value) => updateTree((current) => ({ ...current, dilutedSharesB: value }))} />
          <NumberInput label="Net cash / (debt)" value={tree.netCashB} suffix="USD B" onChange={(value) => updateTree((current) => ({ ...current, netCashB: value }))} /></div></section>
      <section className="ov-card"><span className="ov-kicker">BUSINESS TREE</span><h2>{tree.issuerName}</h2>
        <p className="ov-help">Only leaf businesses enter the valuation. A parent groups children; children must sum to its disclosed base revenue. The reported {tree.source.periodForm === "10-Q" ? "quarter" : "year"} is multiplied by {tree.annualizationFactor}× to form a yearly starting point for growth forecasts; adjust for seasonality.</p>
        <div className="ov-tree">{tree.businesses.map((node) => {
          const hasChildren = tree.businesses.some((child) => child.parentId === node.id);
          return <article className="ov-node" key={node.id} style={{ marginLeft: `${depth(node) * 26}px` }}>
            <div className="ov-node-head"><div><span className="ov-kicker">{hasChildren ? "GROUP" : node.basis === "reported" ? "SEC REPORTED" : node.basis === "derived" ? "RECONCILED DERIVATION" : "OWNER SPLIT"}</span>
              <h3>{node.name}</h3><small>Base revenue {billions(node.baseRevenueB)}</small></div>
              <div className="ov-node-buttons"><button type="button" onClick={() => addChild(node)}>Add sub-business +</button>
                {node.basis === "owner_split" && !hasChildren && <button type="button" onClick={() => removeChild(node.id)}>Remove</button>}</div></div>
            <div className="ov-grid"><label className="ov-field"><span>Business name{node.parentId === null ? " · SEC anchor" : ""}</span><div><input value={node.name} disabled={node.parentId === null}
              onChange={(event) => updateBusiness(node.id, (current) => ({ ...current, name: event.target.value }))} /></div></label>
              {node.parentId === null ? <label className="ov-field"><span>SEC base revenue · USD B</span><div><input value={node.baseRevenueB} disabled /></div></label>
                : <NumberInput label="Base revenue" value={node.baseRevenueB} suffix="USD B" onChange={(value) => updateBusiness(node.id, (current) => ({ ...current, baseRevenueB: value ?? 0 }))} />}
              {!hasChildren && <><label className="ov-field"><span>Revenue driver</span><div><select value={node.driver}
                onChange={(event) => updateBusiness(node.id, (current) => ({ ...current, driver: event.target.value as ForecastBusiness["driver"] }))}>
                <option value="growth">Reported revenue × growth</option><option value="quantity_price">Quantity × unit price</option></select></div></label>
                {node.driver === "growth" ? <NumberInput label="Annual revenue growth" value={node.annualGrowth} suffix="%" onChange={(value) => updateBusiness(node.id, (current) => ({ ...current, annualGrowth: value }))} /> : <>
                  <NumberInput label="Year-one quantity" value={node.quantityYearOne} onChange={(value) => updateBusiness(node.id, (current) => ({ ...current, quantityYearOne: value }))} />
                  <NumberInput label="USD per unit" value={node.unitPriceUsdYearOne} onChange={(value) => updateBusiness(node.id, (current) => ({ ...current, unitPriceUsdYearOne: value }))} />
                  <NumberInput label="Quantity growth" value={node.quantityGrowth} suffix="%" onChange={(value) => updateBusiness(node.id, (current) => ({ ...current, quantityGrowth: value }))} />
                  <NumberInput label="Unit-price growth" value={node.unitPriceGrowth} suffix="%" onChange={(value) => updateBusiness(node.id, (current) => ({ ...current, unitPriceGrowth: value }))} /></>}
                <NumberInput label="Forecast net margin" value={node.netMargin} suffix="%" onChange={(value) => updateBusiness(node.id, (current) => ({ ...current, netMargin: value }))} />
                <NumberInput label="Terminal P/E" value={node.pe} suffix="×" onChange={(value) => updateBusiness(node.id, (current) => ({ ...current, pe: value }))} /></>}</div>
            <label className="ov-field ov-note"><span>Owner rationale / evidence note</span><div><textarea value={node.note} rows={2}
              onChange={(event) => updateBusiness(node.id, (current) => ({ ...current, note: event.target.value }))} /></div></label>
          </article>;
        })}</div></section>
      <section className="ov-card ov-preview"><span className="ov-kicker">LIVE PREVIEW · OWNER SCENARIO</span><h2>Terminal P/E forecast</h2>
        {preview?.ready ? <><div className="ov-value">${preview.perShareUsd?.toFixed(2)} <small>per share, present value</small></div>
          <p>Business terminal earnings × your P/E, discounted {tree.horizonYears} year(s), plus current net cash, divided by diluted shares. Interim cash flows are excluded.</p>
          <div className="ov-table-wrap"><table><thead><tr><th>Business</th><th>Final-year revenue</th><th>Final-year earnings</th><th>Present value</th></tr></thead>
            <tbody>{preview.rows.map((row) => <tr key={row.id}><th>{row.name}</th><td>{billions(row.revenueByYearB.at(-1) ?? null)}</td>
              <td>{billions(row.earningsByYearB.at(-1) ?? null)}</td><td>{billions(row.presentValueB)}</td></tr>)}</tbody></table></div></> :
          <ul className="ov-issues">{preview?.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
        <div className="ov-actions"><button type="button" disabled={saving} onClick={save}>Save draft</button>
          <button type="button" disabled={saving} onClick={refreshSec}>Check latest SEC filing</button>
          <button type="button" disabled={saving || dirty || newFiling || !preview?.ready || revision < 1} onClick={publish}>Publish to company page</button>
          {published && <Link href={`/companies/${ticker.toLowerCase()}`}>View public page ↗</Link>}</div>
        {message && <p role="status" className="ov-message">{message}</p>}</section></>}
    {!tree && message && <p role="status" className="ov-message">{message}</p>}
  </main>;
}
