import "./project-profile.css";

export default function ProjectProfile() {
  return (
    <section className="project-profile" aria-labelledby="project-profile-title">
      <div className="project-profile-lead">
        <span className="project-kicker">SIGNAL LEDGER RESEARCH</span>
        <h1 id="project-profile-title">Independent equity research, valuation and forecast accountability.</h1>
        <p>
          Fundamental research translated into fair value, target prices and actionable investment conclusions—with
          every published view preserved over time.
        </p>
        <div className="project-actions">
          <a className="button button-dark" href="#amd-case-study">View the AMD case study</a>
          <a className="button button-quiet" href="/reports/signal-ledger-amd-case-study.pdf" download>
            Download the research note ↓
          </a>
        </div>
      </div>
      <div className="project-profile-grid">
        <div>
          <span>Research ownership</span>
          <strong>Question framing, model rules, evidence review and forecast post-mortems</strong>
        </div>
        <div>
          <span>Product &amp; implementation</span>
          <strong>Source pipeline, research interface, automated monitoring and audit trail</strong>
        </div>
        <div>
          <span>How AI is used</span>
          <strong>Implementation, document extraction, translation and first-pass news triage</strong>
        </div>
        <div>
          <span>Human control</span>
          <strong>Definitions, exclusions and investment conclusions remain explicit and reviewable</strong>
        </div>
      </div>
    </section>
  );
}
