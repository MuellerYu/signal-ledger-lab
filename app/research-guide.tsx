import Link from "next/link";
export const FREE_RESEARCH_EXAMPLES = [
  { ticker: "AMD", company: "Advanced Micro Devices", question: "Can AI silicon convert demand into cash?" },
  { ticker: "SPCX", company: "Space Exploration Technologies", question: "How much of the value is already real?" },
] as const;

export function FreeExamples() {
  return <section className="research-examples" aria-label="Two complete free sample analyses">
    <div><span className="research-label">TRY FREE · AMD & SPCX</span><h2>Two complete analyses, free to read.</h2><p>AMD and SPCX are published as full FREE SAMPLE reports — the same structure a Signal Ledger PRO analysis uses, with the scenarios, assumptions and evidence left in. No account required.</p></div>
    <div className="research-example-links">{FREE_RESEARCH_EXAMPLES.map(({ ticker, company, question }) => <Link key={ticker} href={`/fair-value?ticker=${ticker}`}><strong>{ticker} <small>{company}</small></strong><span>{question}</span><b>Open complete free analysis →</b></Link>)}</div>
  </section>;
}

export function ResearchGuide() {
  return <details className="research-guide"><summary>New to valuation? Start here</summary><dl>
    <div><dt>Current price</dt><dd>What the stock recently traded at. Check the quote time before using it.</dd></div>
    <div><dt>Fair value</dt><dd>The model's estimate of what a share is worth, based on business assumptions. It is not a promised future price.</dd></div>
    <div><dt>Upside / downside</dt><dd>The gap between fair value and current price. A large positive gap needs strong evidence; it does not guarantee a gain.</dd></div>
    <div><dt>Bear / Base / Bull</dt><dd>A weaker, central and stronger modeled outcome. The range shows how much the answer can change.</dd></div>
    <div><dt>Rating</dt><dd>The research view after considering value and uncertainty. WATCH means there is not enough conviction for a stronger view.</dd></div>
    <div><dt>Confidence</dt><dd>How well the evidence and models support the estimate. It is not the probability of making money.</dd></div>
  </dl></details>;
}

export default function PlanBoundary({ tier = "FREE" }: { tier?: "FREE" | "PRO" }) {
  // A member who already pays must never be shown the comparison boundary —
  // it reads as if the subscription had not registered.
  if (tier === "PRO") return null;
  return <section className="plan-boundary" aria-label="Free and Pro access">
    <div><strong>Free · Get your bearings</strong><p>Prices, fair-value summaries and ratings, a basic options chain, and two complete FREE SAMPLE analyses (AMD and SPCX).</p></div>
    <div><strong>Pro · Explore the full research</strong><p>Full analyses across supported stocks, options strategy rankings, portfolio holdings and the complete Daily Brief.</p></div>
    <Link href="/pricing">Compare Free &amp; Pro →</Link>
  </section>;
}
