import "./equity-forward.css";

const research = [
  {
    symbol: "ORCL", name: "Oracle", event: "Sep 10 · Q1 FY2027 earnings", timing: "After market close · call 5:00 p.m. ET · company-confirmed",
    title: "Backlog growth is not enough. Watch conversion and financing.",
    judgment: "The operating setup is strong, but not an unconditional bullish earnings call. Cloud delivery and funding needs matter more than another large backlog headline. A revenue beat accompanied by greater dilution or cash burn can still produce a negative stock reaction.",
    metrics: [["Revenue growth · company guide", "27–29%"], ["Cloud growth · company guide", "58–64%"], ["Non-GAAP EPS · company guide", "$1.72–1.76"], ["Last FY free cash flow", "−$23.7B"]],
    bull: "Revenue and cloud growth exceed the upper guide, capacity comes online on schedule, and funding needs do not increase.",
    bear: "Revenue growth misses 27%, non-GAAP EPS misses $1.72, or backlog conversion slows while capital needs rise.",
    watch: "$638B of remaining performance obligations are future contracted obligations—not current sales. Management expects approximately $40B of FY2027 debt/equity financing; inspect the mix and dilution, not just demand.",
    sources: [["Results & guidance · Jun 10", "https://www.oracle.com/news/announcement/q4fy26-earnings-release-2026-06-10/"], ["Confirmed earnings date · Sep 2", "https://investor.oracle.com/investor-news/news-details/2026/Oracle-Sets-the-Date-for-its-First-Quarter-Fiscal-Year-2027-Earnings-Announcement/default.aspx"]],
  },
  {
    symbol: "AMD", name: "Advanced Micro Devices", event: "Sep 8 · Citi TMT conference", timing: "9:30 a.m. ET · not an earnings release; Q3 earnings date not confirmed in this research",
    title: "AI demand is growing. The next test is shipping the ramp profitably.",
    judgment: "Constructive on the operating trajectory: Q2 Data Center revenue rose 107% to $6.7B. However, strong growth alone does not establish an undervalued stock. The next earnings call needs to demonstrate shipment readiness and margins—not merely a larger AI opportunity.",
    metrics: [["Q3 revenue · company guide", "$12.7–13.3B"], ["Q3 non-GAAP gross margin guide", "~56%"], ["Q2 reported revenue", "$11.536B"], ["Q2 EPS · GAAP / non-GAAP", "$1.38 / $1.66"]],
    bull: "Q3 revenue exceeds $13.3B with gross margin at least around 56%, supported by credible EPYC/Instinct shipments and Helios deployment progress.",
    bear: "Q3 revenue misses $12.7B, margin falls below the guided level, or customer infrastructure and supply delays push shipments out.",
    watch: "Q2 GAAP earnings included $483M of net long-term investment gains. Separate recurring operating earnings from investment gains; do not extrapolate headline EPS directly into a price target.",
    sources: [["Q2 results & Q3 guide · Aug 4", "https://ir.amd.com/news-events/press-releases/detail/1295/amd-reports-second-quarter-2026-financial-results"], ["Official event calendar", "https://ir.amd.com/news-events/ir-calendar"]],
  },
  {
    symbol: "TSLA", name: "Tesla", event: "Next delivery and earnings update", timing: "Future release date not confirmed in the official calendar reviewed",
    title: "Sales recovered. The earnings test is margin and cash, not volume alone.",
    judgment: "Cautious on earnings quality until delivery growth improves operating profitability. Q2 revenue exceeded Tesla's pre-release compiled consensus, while non-GAAP EPS and operating margin fell short. More deliveries without better unit economics would not resolve the core concern.",
    metrics: [["Q2 reported revenue", "$28.236B"], ["Q2 operating margin", "1.4%"], ["Q2 free cash flow", "−$1.092B"], ["2026 company capex outlook", ">$25B"]],
    bull: "Delivery strength produces operating-margin recovery and less cash burn; new production ramps have commercial evidence behind their timelines.",
    bear: "Volumes grow but the 1.4% operating margin fails to recover, cash burn worsens, or production ramps slip.",
    watch: "Q2 energy gross margin fell to 20.4% from 30.3% as mix and warranty adjustments weighed. Track margin and cash conversion alongside storage deployments. FSD subscriptions are not the same as monthly recurring paid subscribers.",
    sources: [["Official Q2 shareholder update · Jul 22", "https://ir.tesla.com/_flysystem/s3/sec/000162828026049213/tsla-20260722-gen.pdf"], ["Q2 SEC filing", "https://www.sec.gov/Archives/edgar/data/1318605/000162828026049270/tsla-20260630.htm"], ["Pre-release Q2 consensus · Jul 17", "https://ir.tesla.com/press-release/earnings-consensus-second-quarter-2026"]],
  },
];
export default function EquityForward() {
  return <section className="forward-research" aria-labelledby="forward-title"><div className="forward-heading"><div><span>FORWARD RESEARCH</span><h2 id="forward-title">The next test for each company</h2></div><p>Research snapshot · Sep 7, 2026<br />Company facts and analyst interpretation shown separately.</p></div>
    <div className="forward-grid">{research.map(r => <article key={r.symbol}><header><strong>{r.name} <small>{r.symbol}</small></strong><p>{r.event}</p><small>{r.timing}</small></header><div className="forward-body"><h3>{r.title}</h3><p>{r.judgment}</p><dl>{r.metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><div className="forward-tests"><div><h4>Evidence that strengthens the thesis</h4><p>{r.bull}</p></div><div><h4>Evidence that weakens the thesis</h4><p>{r.bear}</p></div></div><h4>What to read past the headline</h4><p>{r.watch}</p><footer>{r.sources.map(([label, url]) => <a key={url} href={url} target="_blank" rel="noreferrer">{label} ↗</a>)}</footer></div></article>)}</div>
    <p className="forward-method">This is a dated fundamental assessment, not a live price forecast. Guidance is management's outlook—not our estimate or current analyst consensus. Current valuation, consensus revisions and an options-implied move have not been established for these notes; no numerical stock target or earnings-direction forecast is inferred from guidance alone. Historical forecasts below retain their original inputs and results.</p>
  </section>;
}
