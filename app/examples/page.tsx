import Link from "next/link";
import SiteNav from "../site-nav";
import { ResearchGuide } from "../research-guide";
import { resolveMember } from "@/lib/member-session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Free sample analyses", description: "Two complete public examples of a Signal Ledger analysis — AMD and SPCX — with the scenarios, assumptions and evidence left in." };

export default async function ExamplesPage() {
  const member = await resolveMember();
  return <><SiteNav member={member} current="/examples" /><main className="pricing-shell examples-page">
    <header className="pricing-hero"><span className="free-sample-label"><b>FREE SAMPLE</b><small>Complete public analysis</small></span><h1>See a full analysis before you subscribe.</h1><p>AMD and SPCX are complete free examples — the same structure a Signal Ledger PRO analysis uses, with nothing removed. Open either one and read every section end to end.</p></header>
    <nav className="example-jump" aria-label="Choose a sample"><Link href="#amd">AMD · AI silicon into cash</Link><Link href="#spcx">SPCX · Separating today's value from tomorrow</Link></nav>
    <article id="amd" className="research-walkthrough"><span className="free-sample-label"><b>FREE SAMPLE · AMD</b><small>Complete public analysis</small></span><h2>Advanced Micro Devices: AI demand only creates value if it turns into cash.</h2>
      <h3>The question</h3><p>AI accelerators can grow quickly while requiring heavy investment in design, manufacturing and software. The key question is how much cash remains for shareholders after those costs, and how long the advantage lasts.</p>
      <h3>What to examine</h3><p>Read data-center segment revenue against research and development, capital spending and operating margin. Customer concentration matters, as does the difference between hyperscaler demand today and the durability of that demand across a product cycle.</p>
      <h3>How the valuation works</h3><p>A cash-flow model projects revenue, operating cost and reinvestment, then discounts future cash flows to today. An earnings multiple and a reverse DCF provide cross-checks. Bear, base and bull cases re-price the same drivers rather than asserting new numbers.</p>
      <div className="example-scenarios"><div><h4>Bear</h4><p>AI accelerator demand normalizes faster than expected and margins compress as competition responds.</p></div><div><h4>Base</h4><p>Data-center share gains convert into durable cash generation as the platform matures.</p></div><div><h4>Bull</h4><p>Sustained demand and improving mix justify higher revenue, margin and multiple.</p></div></div>
      <h3>What would change the conclusion?</h3><p>Look for sustained free cash flow after investment, evidence that data-center wins are converting into cash, and how the competitive set changes. Faster revenue growth alone does not settle the valuation.</p>
      <p><a href="https://ir.amd.com/" target="_blank" rel="noreferrer">Read AMD's company reports ↗</a></p><Link className="button button-dark" href="/fair-value?ticker=AMD">Open AMD complete free analysis →</Link>
    </article>
    <article id="spcx" className="research-walkthrough"><span className="free-sample-label"><b>FREE SAMPLE · SPCX</b><small>Complete public analysis</small></span><h2>Space Exploration Technologies: separate today's businesses from future possibilities.</h2>
      <h3>The question</h3><p>How much value comes from launch, Starlink connectivity and the AI compute build-out today, and how much depends on Starship and other businesses that may develop later? Combining them into one growth assumption hides the biggest uncertainties.</p>
      <h3>What to examine</h3><p>Review reported segment revenue, adjusted EBITDA and capital spending across Space, Connectivity and AI. For newer businesses, look for technical progress, commercial demand, regulatory standing and a plausible path to profit.</p>
      <h3>How the valuation works</h3><p>A sum-of-the-parts model values each business separately. Reported segments use financial anchors; uncertain future businesses use explicit scenario trees with probabilities. Cash, debt and diluted shares connect the parts to a value per share.</p>
      <div className="example-scenarios"><div><h4>Bear</h4><p>Capital intensity stays high and newer businesses take longer to commercialize.</p></div><div><h4>Base</h4><p>Reported segments support value while future businesses receive limited, evidence-based value.</p></div><div><h4>Bull</h4><p>Profitable new services scale, backed by commercial and operating evidence.</p></div></div>
      <h3>What would change the conclusion?</h3><p>Track durable operating profit and cash generation, then test whether future-business milestones arrive on schedule. A higher share price is not evidence that an operating assumption has been achieved.</p>
      <p><a href="https://www.spacex.com/" target="_blank" rel="noreferrer">Read SpaceX company information ↗</a></p><Link className="button button-dark" href="/fair-value?ticker=SPCX">Open SPCX complete free analysis →</Link>
    </article>
    <ResearchGuide /><section className="plan-boundary"><div><strong>Ready to inspect every company?</strong><p>AMD and SPCX are complete free examples. Pro opens the same depth across the supported universe — scenarios, assumptions, evidence and model detail.</p></div><Link href="/pricing">Compare Free &amp; Pro →</Link></section>
  </main></>;
}
