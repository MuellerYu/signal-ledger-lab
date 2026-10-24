import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ALLOWED_FIELDS, CALIBRATION_VERSION, calculateCase, calculateHorizon, compareCases,
  reverseHorizonUnits, validDate, validateCase, type BusinessCase, type BusinessId, type CalibrationCase,
  type FeedbackRule, type ThesisProposal } from "../../lib/thesis-calibration";
import { BASELINE, EVIDENCE, EVIDENCE_VERSION, SOURCE_URL, illustrativeCase } from "./data";
import "./styles.css";

const STORAGE = "signal-ledger-thesis-lab-tsla-v1";
const money = (v: number | null | undefined, digits = 2) => v == null || !Number.isFinite(v) ? "待建模" :
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
const number = (v: number | null | undefined, digits = 2) => v == null ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(v);
const signed = (v: number | null) => v == null ? "未知 → 已建模" : `${v >= 0 ? "+" : "−"}${money(Math.abs(v))}`;
const fieldLabels: Record<string, string> = { growth: "年收入增长", unitsM: "成熟年规模", annualRevenuePerUnitUsd: "单单位年收入",
  captureRate: "收入获取比例", launchYear: "商业化开始年份", rampYears: "达到规模的爬坡年数", ebitdaMargin: "EBITDA 利润率",
  depreciationRate: "折旧 / 收入", maintenanceCapexRate: "持续 CapEx / 收入", workingCapitalRate: "营运资本 / 新增收入", taxRate: "税率",
  discountRate: "折现率", terminalMultiple: "终值 EV/EBITDA", successProbability: "成功概率", investmentPvB: "建设资金现值", failureCostPvB: "失败额外损失现值" };
type Analysis = { proposal: ThesisProposal; aiCalled: boolean; model: string; analyzedAt: string; targetWasProvided: boolean };
type Snapshot = { revision: number; savedAt: string; scenario: CalibrationCase; target: number; targetDate: string; thesis: string;
  rules: FeedbackRule[]; analysis: Analysis | null; evidenceVersion: string; engineVersion: string };
function anchored(s: CalibrationCase) {
  return validateCase(s).length === 0 && s.valuationDate === BASELINE.valuationDate && s.revenueAnchorDate === BASELINE.revenueAnchorDate
    && s.sharesB === BASELINE.sharesB && s.netCashB === BASELINE.netCashB &&
    ["automotive", "energy", "services"].every((id) => s.businesses.find((b) => b.id === id)?.baseAnnualRevenueB === BASELINE.businesses.find((b) => b.id === id)?.baseAnnualRevenueB);
}
function loadSnapshots(): Snapshot[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter((s) => s.evidenceVersion === EVIDENCE_VERSION && s.engineVersion === CALIBRATION_VERSION && anchored(s.scenario)
      && typeof s.thesis === "string" && Array.isArray(s.rules) && validDate(s.targetDate) && Number.isFinite(s.target)).slice(-20);
  } catch { return []; }
}
function Numeric({ label, value, onChange, unit = "%", step = "0.1", min, max }: {
  label: string; value: number | null; onChange: (n: number | null) => void; unit?: string; step?: string; min?: number; max?: number;
}) {
  const display = value == null ? "" : Number((unit === "%" ? value * 100 : value).toFixed(5));
  return <label className="number-field"><span>{label}</span><div><input aria-label={label} type="number" inputMode="decimal"
    step={step} min={min} max={max} value={display} placeholder="待填写" onChange={(e) => {
      const value = e.target.value === "" ? null : Number(e.target.value);
      onChange(value == null ? null : unit === "%" ? value / 100 : value);
    }} /><small>{unit}</small></div></label>;
}
function App() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>(loadSnapshots);
  const latest = snapshots.at(-1);
  const [scenario, setScenario] = useState<CalibrationCase>(() => structuredClone(latest?.scenario ?? BASELINE));
  const [target, setTarget] = useState(latest?.target ?? 500);
  const [targetDate, setTargetDate] = useState(latest?.targetDate ?? "2027-09-30");
  const [thesis, setThesis] = useState(latest?.thesis ?? "");
  const [rules, setRules] = useState<FeedbackRule[]>(latest?.rules ?? []);
  const [analysis, setAnalysis] = useState<Analysis | null>(latest?.analysis ?? null);
  const [selected, setSelected] = useState<BusinessId>("robotaxi");
  const [tab, setTab] = useState("workbench");
  const [reverseId, setReverseId] = useState<BusinessId>("robotaxi");
  const [configured, setConfigured] = useState<{ configured: boolean; model: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiMessage, setAiMessage] = useState(analysis ? "已恢复本地保存的 AI 分析；本次尚未调用。" : "本次尚未调用 AI。");
  const [message, setMessage] = useState("");
  const [ruleText, setRuleText] = useState("");
  const [ruleExpiry, setRuleExpiry] = useState("2027-09-30");
  const [dirty, setDirty] = useState(false);
  const [analysisStale, setAnalysisStale] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const researchRevision = useRef(0);
  const baseResult = useMemo(() => calculateCase(BASELINE), []);
  const comparison = useMemo(() => compareCases(BASELINE, scenario), [scenario]);
  const result = comparison.after;
  const future = useMemo(() => calculateHorizon(scenario, targetDate), [scenario, targetDate]);
  const baseFuture = useMemo(() => calculateHorizon(BASELINE, targetDate), [targetDate]);
  const reverse = useMemo(() => reverseHorizonUnits(scenario, reverseId, targetDate, target), [scenario, reverseId, targetDate, target]);
  const business = scenario.businesses.find((b) => b.id === selected)!;
  const businessResult = result.rows.find((r) => r.id === selected);
  const modeledCount = result.rows.filter((r) => r.ready).length;
  const gap = future.complete && future.valid ? target - future.perShareUsd! : null;
  const update = (fn: (s: CalibrationCase) => CalibrationCase) => { setScenario(fn); setDirty(true); setAnalysisStale(Boolean(analysis)); };
  const updateBusiness = (patch: Partial<BusinessCase>) => update((s) => ({ ...s, businesses: s.businesses.map((b) => b.id === selected ? { ...b, ...patch, provenance: "owner_assumption" } : b) }));
  const field = (key: typeof ALLOWED_FIELDS[number], unit = "%", step = "0.1") => <Numeric key={key} label={fieldLabels[key]} value={business[key]}
    unit={unit} step={step} onChange={(value) => updateBusiness({ [key]: value })} />;
  useEffect(() => { fetch("/__thesis/status").then((r) => r.json()).then(setConfigured).catch(() => setAiMessage("本地 AI 服务未连接，手动校准可用。")); }, []);
  useEffect(() => { researchRevision.current += 1; }, [scenario, thesis, rules]);
  const analyze = async () => {
    const revision = researchRevision.current;
    setAnalyzing(true); setAiMessage("正在分析经营观点…");
    try {
      const response = await fetch("/__thesis/research", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario, thesis, rules }) });
      const data = await response.json();
      if (!response.ok) throw new Error(`${data.message ?? data.error} ${data.aiCalled ? "AI 已尝试调用，未产生有效结果。" : "本次没有调用 AI。"}`);
      setAnalysis(data); setAnalysisStale(revision !== researchRevision.current); setDirty(true);
      setAiMessage(`AI 已完成观点分析 · ${data.model} · 未收到目标价 · 尚未修改任何数字`);
    } catch (error) { setAiMessage(error instanceof Error ? error.message : "AI 分析失败。"); }
    finally { setAnalyzing(false); }
  };
  const save = () => {
    if (!anchored(scenario) || !validDate(targetDate) || !Number.isFinite(target) || target <= 0) {
      setMessage("请先修正日期、资本或目标输入；未建模业务可以保存在草稿中。"); return;
    }
    const snapshot: Snapshot = { revision: (snapshots.at(-1)?.revision ?? 0) + 1, savedAt: new Date().toISOString(),
      scenario: structuredClone(scenario), target, targetDate, thesis, rules: structuredClone(rules), analysis: analysisStale ? null : analysis,
      evidenceVersion: EVIDENCE_VERSION, engineVersion: CALIBRATION_VERSION };
    const next = [...snapshots, snapshot].slice(-20);
    try { localStorage.setItem(STORAGE, JSON.stringify(next)); setSnapshots(next); setDirty(false); setMessage(`本地 v${snapshot.revision} 已保存，可恢复与导出。`); }
    catch { setMessage("浏览器存储不可用；请导出 JSON 保存当前草稿。"); }
  };
  const restore = (snapshot: Snapshot) => { setScenario(structuredClone(snapshot.scenario)); setTarget(snapshot.target); setTargetDate(snapshot.targetDate);
    setThesis(snapshot.thesis); setRules(structuredClone(snapshot.rules)); setAnalysis(snapshot.analysis); setAnalysisStale(false); setDirty(false);
    setAiMessage(snapshot.analysis ? "已恢复该版本的 AI 分析；本次尚未调用。" : "该版本没有有效 AI 分析。"); setMessage(`已恢复本地 v${snapshot.revision}。`); };
  const exportCase = () => {
    const payload = { format: "signal-ledger-thesis-demo", evidenceVersion: EVIDENCE_VERSION, engineVersion: CALIBRATION_VERSION,
      exportedAt: new Date().toISOString(), scenario, target, targetDate, thesis, rules, analysis: analysisStale ? null : analysis,
      currentCalculation: result, horizonCalculation: future, evidence: EVIDENCE, sourceUrl: SOURCE_URL, snapshots };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "TSLA-thesis-calibration.json"; link.click(); URL.revokeObjectURL(url);
    setMessage("已导出假设、来源、公式结果、观点和本地版本。");
  };
  const importCase = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("文件过大。");
      const data = JSON.parse(await file.text());
      if (data.format !== "signal-ledger-thesis-demo" || data.evidenceVersion !== EVIDENCE_VERSION || data.engineVersion !== CALIBRATION_VERSION ||
        !anchored(data.scenario) || typeof data.thesis !== "string" || data.thesis.length > 6000 || !validDate(data.targetDate) ||
        !Number.isFinite(data.target) || data.target <= 0 || !Array.isArray(data.rules) || data.rules.length > 20 ||
        data.rules.some((r: FeedbackRule) => typeof r.text !== "string" || r.text.length > 2000 || r.scope !== "TSLA" || !validDate(r.expiresAt)))
        throw new Error("版本或申报锚定不匹配，导入已拒绝。");
      setScenario(data.scenario); setTarget(data.target); setTargetDate(data.targetDate); setThesis(data.thesis); setRules(data.rules);
      setAnalysis(null); setAnalysisStale(false); setDirty(true); setAiMessage("导入后尚未调用 AI。"); setMessage("草稿已导入；所有估值已按当前公式重新计算。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "导入失败。"); }
    if (importRef.current) importRef.current.value = "";
  };
  const addRule = () => {
    if (ruleText.trim().length < 5 || !validDate(ruleExpiry) || ruleExpiry < BASELINE.valuationDate || rules.length >= 20) {
      setMessage("规则至少 5 个字，需有效到期日；最多保存 20 条。"); return;
    }
    setRules([...rules, { id: crypto.randomUUID(), scope: "TSLA", text: ruleText.trim(), expiresAt: ruleExpiry, createdAt: new Date().toISOString() }]);
    setRuleText(""); setDirty(true); setAnalysisStale(Boolean(analysis)); setMessage("规则已确认加入草稿；下一次 AI 分析会使用有效规则。");
  };
  const loadExample = () => { setScenario(illustrativeCase()); setDirty(true); setAnalysisStale(Boolean(analysis));
    if (!thesis) setThesis("演示观点：Tesla 的增量价值需要分别研究外部 FSD 授权、第三方 Robotaxi 平台和对外机器人销售。重点检验付费采用、监管许可、单位经济及建设资金，不能把尚未盈利的业务直接当作零，也不能把成熟规模全额当作已经实现。");
    setMessage("已载入明确标注的演示经营假设。它们没有按目标价拟合，也不是你的正式观点。"); };
  const stresses = [
    { name: "商业化推迟 2 年", description: "FSD、Robotaxi、Optimus 的开始年份后移，爬坡速度不变。", change: (s: CalibrationCase) => ({ ...s, businesses: s.businesses.map((b) => b.driver === "units" && b.launchYear != null ? { ...b, launchYear: b.launchYear + 2 } : b) }) },
    { name: "成功概率降低 20 个百分点", description: "仅调整三项增量业务的成功概率。", change: (s: CalibrationCase) => ({ ...s, businesses: s.businesses.map((b) => b.driver === "units" && b.successProbability != null ? { ...b, successProbability: Math.max(0, b.successProbability - 0.20) } : b) }) },
    { name: "建设资金增加 50%", description: "同样的经营规模需要更多前期投入。", change: (s: CalibrationCase) => ({ ...s, businesses: s.businesses.map((b) => b.investmentPvB != null ? { ...b, investmentPvB: b.investmentPvB * 1.5 } : b) }) },
    { name: "新增稀释增加 10 个百分点", description: "相同的公司价值由更多股份分配。", change: (s: CalibrationCase) => ({ ...s, additionalDilution: Math.min(2, s.additionalDilution + 0.10) }) },
  ];
  return <>
    <header className="site-header"><a className="brand" href="#root"><span className="monogram">SL</span><strong>Signal Ledger<span>Research & valuation</span></strong></a>
      <div className="local-label"><i /> 本地研究工作台 <span>TSLA · DEMO</span></div></header>
    <main>
      <section className="hero"><div><p className="eyebrow">THE THESIS LAB / 01</p><h1>把估值分歧，<br /><em>拆成经营假设。</em></h1>
        <p className="hero-copy">你给出判断，AI 找出关键变量；每一美元价值，都能追溯到业务、资本和概率。</p></div>
        <aside className="target-card"><p className="eyebrow">你的 12 个月目标价</p><label className="target-price"><span>$</span><input aria-label="12个月目标价" type="number" min="1" max="100000" value={target}
          onChange={(e) => { setTarget(Number(e.target.value)); setDirty(true); }} /></label><label className="date-line">目标日期 <input aria-label="目标日期" type="date" value={targetDate} onChange={(e) => { setTargetDate(e.target.value); setDirty(true); }} /></label>
          <p>目标用于比较和反向检验。<br />经营研究 AI 不接收这个价格。</p></aside></section>
      <div className="context-strip"><span><b>TSLA</b> Tesla, Inc.</span><span>申报截至 2026-06-30</span><span>估值日 2026-09-30</span><span>终值日 {scenario.maturityDate}</span><a href={SOURCE_URL} target="_blank" rel="noreferrer">原始 10-Q ↗</a></div>
      <section className="value-grid" aria-label="价值与目标对比">
        <div className="value-card"><span>基准 · 今日已建模价值</span><strong data-testid="baseline-now">{money(baseResult.modeledPerShareUsd)}</strong><p>3 / 6 项业务 · 增量业务未知</p></div>
        <div className="value-card"><span>草稿情景 · 今日{result.complete ? "条件价值" : "已建模价值"}</span><strong data-testid="view-now">{money(result.modeledPerShareUsd)}</strong><p>{modeledCount} / 6 项业务 · {result.complete ? "经营假设可复算" : "覆盖尚未完整"}</p></div>
        <div className="value-card emphasis"><span>{targetDate} · 条件内在价值{future.complete ? "" : "（部分）"}</span><strong data-testid="view-horizon">{money(future.perShareUsd)}</strong><p>剩余现金流 + 期间资本变化</p></div>
        <div className="value-card"><span>与目标尚需解释的差额</span><strong data-testid="target-gap">{gap == null ? "待完整建模" : signed(gap)}</strong><p>{gap == null ? "先补齐或明确排除未知业务" : "目标价依然需要市场定价假设"}</p></div>
      </section>
      <div className="notice"><span>研究口径</span><p>你提到的旧结果 <b>$70</b> 保留为待复现参考，原版本与估值时点尚未核对。这里从申报锚定重新计算。<b>未来 12 个月的价格目标</b>与<b>条件内在价值</b>分别展示。</p></div>
      {future.fundingGapB != null && future.fundingGapB > 0 && <div className="notice funding-notice"><span>资本待验证</span><p>草稿建设资金超过可用净资本 <b>${number(future.fundingGapB)}B</b>。支出已扣减价值，融资安排和新增股份路径仍待验证；当前结果为条件情景。</p></div>}
      <nav className="tabs" aria-label="工作台视图">{[["workbench", "01  分歧与假设"], ["memory", "02  研究规则与版本"], ["audit", "03  计算与证据"]].map(([id, label]) =>
        <button type="button" key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</nav>
      {tab === "workbench" && <>
        <section className="panel thesis-panel"><div className="section-heading"><div><p className="eyebrow">YOUR INVESTMENT THESIS</p><h2>先表达你看到的业务变化。</h2></div><span className="pill">观点 → 变量 → 反证</span></div>
          <textarea aria-label="我的经营观点" className="thesis-text" value={thesis} maxLength={6000} placeholder="例如：我认为 Robotaxi 将成为核心平台业务。重点应该看每车运营收入、平台获取比例和可运营车队，不能只用汽车销量预测公司价值。"
            onChange={(e) => { setThesis(e.target.value); setDirty(true); setAnalysisStale(Boolean(analysis)); }} />
          <div className="action-row"><button className="button primary" type="button" onClick={analyze} disabled={analyzing || thesis.trim().length < 5 || !configured?.configured}>{analyzing ? "AI 正在拆解…" : "让 AI 拆解我的观点 ↗"}</button>
            <button className="button secondary" type="button" onClick={loadExample}>载入演示经营假设</button><span className="ai-status" role="status">{aiMessage}</span></div>
          {configured && !configured.configured && <p className="muted">本地未配置 AI 凭据，当前可手动校准。没有用计算结果冒充 AI 分析。</p>}
          {analysis && <div className={`analysis ${analysisStale ? "stale" : ""}`}><p className="eyebrow">{analysisStale ? "输入已改变 · 以下为上一轮分析" : "AI 已完成 · 待你审阅"}</p><h3>{analysis.proposal.summary}</h3>
            <div className="focus-grid">{analysis.proposal.focus.map((f, i) => <article key={i}><span className="pill">{scenario.businesses.find((b) => b.id === f.businessId)?.name}</span><h4>{f.belief}</h4>
              <p><b>需要校准：</b>{f.fields.map((key) => fieldLabels[key]).join("、") || "业务证据"}</p><p>{f.question}</p><p className="falsifier"><b>反证：</b>{f.falsification}</p>
              <small>引用：{f.evidenceIds.map((id) => EVIDENCE.find((e) => e.id === id)?.label).join("；") || "待补充证据"}</small>
              <button type="button" className="text-button" onClick={() => { setSelected(f.businessId); document.getElementById("business-editor")?.scrollIntoView({ behavior: "smooth" }); }}>查看对应经营参数 →</button></article>)}</div>
            {analysis.proposal.disagreements.length > 0 && <div className="disagreements"><b>AI 保留的分歧</b>{analysis.proposal.disagreements.map((s, i) => <p key={i}>{s}</p>)}</div>}
            <p className="muted">AI 提出了研究重点和问题。所有数值仍由你在下方填写；财报引用不会把情景假设变成已披露事实。</p></div>}
        </section>
        <section className="panel" id="business-editor"><div className="section-heading"><div><p className="eyebrow">OPERATING ASSUMPTIONS</p><h2>六项业务，分别讲清楚。</h2></div><label className="inline-date">终值日<input aria-label="终值日期" type="date" value={scenario.maturityDate} onChange={(e) => update((s) => ({ ...s, maturityDate: e.target.value }))} /></label></div>
          <div className="business-tabs">{scenario.businesses.map((b) => <button type="button" key={b.id} className={selected === b.id ? "selected" : ""} onClick={() => setSelected(b.id)}>
            <span>{b.name}</span><small>{b.status === "unmodeled" ? "价值未知" : b.status === "excluded" ? "明确排除" : money(result.rows.find((r) => r.id === b.id)?.perShareUsd)}</small></button>)}</div>
          <div className="business-heading"><div><h3>{business.name}</h3><p className="muted">{business.provenance === "owner_assumption" ? "手动研究假设 · 待验证" : business.provenance === "legacy_assumption" ? "已有研究参数 + 明确的演示 FCFF 假设" : "演示假设 · 未经你的正式确认"}</p></div>
            <label className="status-select">处理方式<select aria-label="业务处理方式" value={business.status} onChange={(e) => updateBusiness({ status: e.target.value as BusinessCase["status"],
              ...(e.target.value === "excluded" && !business.rationale ? { rationale: "本地情景明确不计该业务的增量价值；该选择不代表业务实际价值为零。" } : {}) })}>
              <option value="unmodeled">未建模 · 价值未知</option><option value="included">纳入经营情景</option><option value="excluded">明确排除增量价值</option></select></label></div>
          {business.status === "unmodeled" ? <div className="empty-state"><span>?</span><div><h4>尚未给这项业务编造一个价格。</h4><p>选择“纳入经营情景”填写规模、单位经济、成功概率与资金需求，或明确记录排除理由。</p></div></div> : business.status === "included" && <>
            {business.driver === "growth" ? <div className="input-grid"><div className="anchor-field"><span>收入锚定（Q2 × 4 年化代理）</span><strong>${number(business.baseAnnualRevenueB, 3)}B</strong><small>季度收入为申报事实；年化不是实际全年收入。</small></div>{field("growth")}</div> : <>
              <div className="input-grid">{field("unitsM", business.id === "fsd" ? "百万付费授权" : business.id === "robotaxi" ? "百万活跃车" : "百万台 / 年")}
                <Numeric label={business.id === "robotaxi" ? "每车年订单额" : business.id === "optimus" ? "单台对外售价" : "每授权年付费"} value={business.annualRevenuePerUnitUsd} unit="USD" step="100" onChange={(value) => updateBusiness({ annualRevenuePerUnitUsd: value })} />
                {field("captureRate")}{field("launchYear", "年", "1")}{field("rampYears", "年", "1")}</div>
              <label className="checkbox-line"><input type="checkbox" checked={business.incrementalOnly} onChange={(e) => updateBusiness({ incrementalOnly: e.target.checked })} />
                仅计独立增量业务，已扣除与汽车、FSD 和 Robotaxi 内部交易的重复部分。</label></>}
            <div className="input-grid economics">{field("ebitdaMargin")}{field("depreciationRate")}{field("maintenanceCapexRate")}{field("workingCapitalRate")}{field("taxRate")}
              {field("discountRate")}{field("terminalMultiple", "×", "1")}{field("successProbability")}{field("investmentPvB", "USD B", "1")}{field("failureCostPvB", "USD B", "1")}</div>
            <p className="formula-note">FCFF = EBIT × (1 − 税率) + 折旧 − 持续 CapEx − 新增营运资本。额外建设资金按现值另计一次；失败额外损失只在失败情景计入。EV/EBITDA 仅用于终值。</p></>}
          {business.status !== "unmodeled" && <div className="reason-grid"><label><span>为什么采用这些假设</span><textarea aria-label="假设理由" value={business.rationale} maxLength={2000} onChange={(e) => updateBusiness({ rationale: e.target.value })} /></label>
            <label><span>什么证据会推翻判断</span><textarea aria-label="反证条件" value={business.falsification} maxLength={2000} onChange={(e) => updateBusiness({ falsification: e.target.value })} /></label></div>}
          {businessResult?.issues.length ? <div className="issues" role="status">{businessResult.issues.map((issue) => <p key={issue}>{issue}</p>)}</div> : null}
          <div className="capital-inputs"><h4>共同资本假设</h4><div className="input-grid"><Numeric label="新增完全稀释比例" value={scenario.additionalDilution} onChange={(v) => update((s) => ({ ...s, additionalDilution: v ?? NaN }))} />
            <Numeric label="经营现金保留" value={scenario.operatingCashReserveB} unit="USD B" step="1" onChange={(v) => update((s) => ({ ...s, operatingCashReserveB: v ?? NaN }))} />
            <div className="anchor-field"><span>已发行股本（固定申报锚定）</span><strong>{number(scenario.sharesB, 6)}B</strong><small>条件性限制股已包括；额外稀释仅计一次。</small></div></div></div>
          {result.issues.length > 0 && <div className="issues" role="alert">{result.issues.map((issue, i) => <p key={i}>{issue}</p>)}</div>}
        </section>
        <section className="two-column"><div className="panel reverse-panel"><p className="eyebrow">REVERSE THE TARGET</p><h2>{money(target, 0)}，需要什么条件？</h2>
          <p className="muted">在 {targetDate} 的条件价值达到目标，固定其他业务和全部单位经济，只反推一项成熟期规模。</p>
          <select aria-label="反推业务" value={reverseId} onChange={(e) => setReverseId(e.target.value as BusinessId)}>{["fsd", "robotaxi", "optimus"].map((id) => <option key={id} value={id}>{scenario.businesses.find((b) => b.id === id)?.name}</option>)}</select>
          <div className="reverse-result"><strong data-testid="reverse-units">{reverse.ready ? `${number(reverse.requiredUnitsM)}M` : "等待完整情景"}</strong><span>{reverseId === "fsd" ? "成熟年增量付费授权" : reverseId === "robotaxi" ? "成熟年平台活跃车" : "成熟年对外销售台数"}</span></div>
          <p>{reverse.message}</p><p className="muted">反推不修改你的假设。最终交易价格还受市场给出的倍数、情绪和估值收敛影响。</p>
          {future.complete && future.perShareUsd != null && future.perShareUsd > 0 && <div className="pricing-gap"><span>经营假设不变时，目标价隐含的市场定价</span><strong>{number(target / future.perShareUsd)}× 条件内在价值</strong><p>相当于 {number((target / future.perShareUsd - 1) * 100)}% 的溢价 / 折价。这是目标隐含的要求，尚未验证市场会给予它。</p></div>}
        </div><div className="panel"><p className="eyebrow">WHAT CHANGED</p><h2>每股价值的业务来源</h2><div className="comparison-table"><div className="table-row table-head"><span>业务</span><span>基准今日</span><span>情景今日</span></div>
          {comparison.rows.map((r) => <div className="table-row" key={r.id}><span>{r.name}</span><span>{r.before == null ? "未知" : money(r.before)}</span><b>{r.after == null ? "未知" : money(r.after)}</b></div>)}
          <div className="table-row"><span>净资本 / 股</span><span>{money(comparison.capitalBefore)}</span><b>{money(comparison.capitalAfter)}</b></div></div>
          <p className="muted">同一目标日的基准部分价值为 {money(baseFuture.perShareUsd)}。未知项没有变成零。基准终值为 2030；你的情景终值为 {scenario.maturityDate.slice(0, 4)}，差异包含预测期、经营和稀释变化。</p></div></section>
        <section className="panel"><div className="section-heading"><div><p className="eyebrow">TEST THE THESIS</p><h2>判断承受得住哪些变化？</h2></div><span className="pill">独立压力测试 · 不改草稿</span></div>
          <div className="stress-grid">{stresses.map((stress) => { const stressed = calculateHorizon(stress.change(structuredClone(scenario)), targetDate);
            return <article key={stress.name}><h4>{stress.name}</h4><strong>{money(stressed.perShareUsd)}</strong><span>{stressed.valid && future.valid ? `${signed(stressed.perShareUsd! - future.perShareUsd!)} / 股` : "情景参数不足"}</span><p>{stress.description}</p></article>; })}</div>
          {!future.complete && <p className="muted">当前压力结果只覆盖已建模业务。</p>}
        </section>
      </>}
      {tab === "memory" && <section className="two-column"><div className="panel"><p className="eyebrow">CONFIRMED RESEARCH RULES</p><h2>把纠正保存成下一次的规则。</h2><p className="muted">适用范围固定为 TSLA。有效规则随下次 AI 请求加载；不会训练模型权重，也不会自动写入全站政策。</p>
        <label className="stacked-label"><span>你希望 AI 以后如何判断</span><textarea aria-label="新的研究规则" maxLength={2000} value={ruleText} onChange={(e) => setRuleText(e.target.value)} placeholder="例如：Robotaxi 要从活跃车队与每车平台收入建立模型；不能用全公司营收乘一个系数代表自动驾驶价值。" /></label>
        <label className="inline-date">有效至<input aria-label="规则有效期" type="date" value={ruleExpiry} onChange={(e) => setRuleExpiry(e.target.value)} /></label>
        <button className="button primary" type="button" onClick={addRule}>确认加入研究规则</button>
        {analysis?.proposal.methodology.map((suggestion, i) => <div className="suggested-rule" key={i}><span>AI 提议 · 尚未采纳</span><p>{suggestion}</p><button className="text-button" type="button" onClick={() => setRuleText(suggestion)}>放入编辑框审阅 →</button></div>)}
        {rules.length === 0 ? <p className="empty-copy">还没有已确认的研究规则。</p> : rules.map((r) => <article className="saved-rule" key={r.id}><span>TSLA · 有效至 {r.expiresAt}{r.expiresAt < BASELINE.valuationDate ? " · 已过期" : ""}</span><p>{r.text}</p>
          <button className="text-button" type="button" onClick={() => { setRules(rules.filter((s) => s.id !== r.id)); setDirty(true); setAnalysisStale(Boolean(analysis)); }}>移出草稿</button></article>)}</div>
        <div className="panel"><p className="eyebrow">LOCAL REVISIONS</p><h2>观点、假设与输出，同版保存。</h2><p className="muted">本地浏览器保留最近 20 版。导出的 JSON 同时包含来源、公式结果和版本，可用于复盘。</p>
          <div className="action-row"><button className="button primary" type="button" onClick={save}>保存本地版本</button><button className="button secondary" type="button" onClick={exportCase}>导出完整 JSON</button></div>
          {snapshots.length === 0 ? <p className="empty-copy">尚未保存版本。</p> : [...snapshots].reverse().map((s) => <article className="revision" key={s.revision}><div><b>v{s.revision}</b><span>{new Date(s.savedAt).toLocaleString("zh-CN", { timeZone: "America/New_York" })}</span>
            <p>{money(calculateHorizon(s.scenario, s.targetDate).perShareUsd)} 条件价值 · {s.rules.length} 条规则</p></div><button className="button secondary" type="button" onClick={() => restore(s)}>恢复</button></article>)}
        </div></section>}
      {tab === "audit" && <>
        <section className="panel"><p className="eyebrow">CAPITAL ROLL-FORWARD</p><h2>12 个月价值，如何从经营预测算出来？</h2><div className="bridge-grid">
          {[["当前净资本（扣经营保留）", result.capitalBridgeB], ["初始建设与期望失败支出", future.initialInvestmentB], ["期间期望 FCFF 留存", future.earnedFcffB], ["目标日净资本桥", future.capitalBridgeB]].map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>${number(value as number | null)}B</strong></div>)}</div>
          <p className="formula-note">目标日股权价值 = 目标日剩余经营价值 + 当前净资本 − 初始建设及期望失败支出 + 期间留存 FCFF。期间现金流按预测区间均匀实现；无新增信息、分红、现金利息或新增融资。融资需求不能静默忽略。</p>
          {future.fundingGapB != null && future.fundingGapB > 0 && <div className="issues"><p>当前建设资金超过可用净资本 ${number(future.fundingGapB)}B。已计入价值扣减，但未来融资成本和股数路径仍需完善；该情景不能直接作为可发布研究。</p></div>}
        </section>
        <section className="panel"><p className="eyebrow">REPRODUCIBLE CALCULATIONS</p><h2>逐年经营与现金流</h2><div className="business-tabs">{scenario.businesses.map((b) => <button type="button" key={b.id} className={b.id === selected ? "selected" : ""} onClick={() => setSelected(b.id)}>{b.name}</button>)}</div>
          <div className="wide-table"><table><thead><tr><th>日期</th><th>年收入 B</th><th>EBITDA B</th><th>税 B</th><th>持续 CapEx B</th><th>ΔNWC B</th><th>期间 FCFF B</th><th>FCFF 现值 B</th></tr></thead>
          <tbody>{businessResult?.forecast.map((r) => <tr key={r.date}><td>{r.date}</td><td>{number(r.revenueB)}</td><td>{number(r.ebitdaB)}</td><td>{number(r.taxB)}</td><td>{number(r.capexB)}</td><td>{number(r.workingCapitalB)}</td><td>{number(r.fcffB)}</td><td>{number(r.pvFcffB)}</td></tr>)}</tbody></table></div>
          {!businessResult?.ready && <p className="empty-copy">该业务尚未形成可计算路径。</p>}
          {businessResult?.status === "included" && businessResult.ready && <p className="formula-note">成功情景经营现值 ${number(businessResult.successEvPvB)}B × {number((businessResult.probability ?? 0) * 100)}% − 建设资金 ${number(businessResult.investmentPvB)}B − 失败概率 × 额外损失 ${number(businessResult.failureCostPvB)}B = 期望经营现值 ${number(businessResult.expectedEvPvB)}B。</p>}
        </section>
        <section className="panel"><p className="eyebrow">SOURCE REGISTRY</p><h2>已核验事实与尚待验证的判断。</h2><p className="muted">本地核验日：2026-09-30。固定证据快照；没有在浏览时声称自动刷新。</p>
          <div className="evidence-list">{EVIDENCE.map((e) => <article key={e.id}><span>{e.id}</span><h4>{e.label}</h4><p>{e.detail}</p><small>原文定位：{e.locator}</small><a href={SOURCE_URL} target="_blank" rel="noreferrer">查看申报 ↗</a></article>)}</div>
          <p className="formula-note">模型：完整 FCFF 预测 + EV/EBITDA 终值。Q2 年化代理、未来规模、利润率、现金转换、倍数、概率和资本需求均为研究 / 演示假设。概率尚未经验校准；本地可复算不等于已具备生产研究质量。</p>
        </section>
      </>}
      <footer className="workspace-footer"><div><b>{dirty ? "有未保存修改" : latest ? `本地已保存 v${latest.revision}` : "本地草稿"}</b><span>固定事实 · 独立基准 · 条件情景 · 可恢复版本</span></div>
        <div className="action-row"><button className="button secondary" type="button" onClick={() => { setScenario(structuredClone(BASELINE)); setDirty(true); setAnalysisStale(Boolean(analysis)); setMessage("已恢复基准经营参数；已保存的本地版本仍可恢复。"); }}>重置经营参数</button>
          <button className="button secondary" type="button" onClick={() => importRef.current?.click()}>导入</button><button className="button secondary" type="button" onClick={exportCase}>导出</button><button className="button primary" type="button" onClick={save}>保存本地版本</button></div>
        <input type="file" accept="application/json,.json" hidden ref={importRef} onChange={(e) => void importCase(e.target.files?.[0])} /></footer>
      {message && <p className="message" role="status">{message}</p>}
      <p className="demo-footer">Signal Ledger · Private research demo · {CALIBRATION_VERSION}<br />本地工作台尚未上线。研究判断和计算各自保留来源；当前不自动发布或修改正式页面。</p>
    </main>
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
