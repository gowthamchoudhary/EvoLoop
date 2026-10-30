import { Link } from "react-router-dom";
import LoopScene from "./LoopScene.jsx";

function MockRow({ tone, label, text }) {
  return (
    <div className="mock-row">
      <span className={`badge ${tone}`}>{label}</span>
      <span className="small-text">{text}</span>
    </div>
  );
}

export default function Landing() {
  const scrollScene = (event) => {
    event.preventDefault();
    document.getElementById("loop-scene")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <Link to="/" className="brand-name">✦ EvoLoop</Link>
          <nav className="landing-links">
            <Link to="/dashboard">Dashboard</Link>
            <a href="#how" onClick={scrollScene}>How it works</a>
            <Link to="/how-it-works">The long version</Link>
            <Link to="/tatum">Tatum activity</Link>
          </nav>
          <Link to="/dashboard" className="btn">Open the dashboard</Link>
        </div>
      </header>

      <section className="landing-hero">
        <p className="dim-label">EvoLoop for AI agents</p>
        <h1>
          Agents do the work.
          <br />
          The ledger keeps the proof.
        </h1>
        <p className="hero-sub">
          EvoLoop pays AI agents a salary on Sui, stores what they did in Walrus Memory, funds upgrades
          only when the evidence passes the gate, and measures whether the upgrade actually worked.
        </p>
        <div className="hero-actions">
          <a href="#how" onClick={scrollScene} className="btn">▶ See how it works</a>
          <Link to="/dashboard" className="btn ghost">Watch live agents</Link>
        </div>
      </section>

      <section className="landing-scene" id="loop-scene">
        <LoopScene />
      </section>

      <section className="landing-features">
        <div className="landing-feature">
          <div className="landing-copy">
            <h3>Every task leaves a memory.</h3>
            <p>
              Agents don't get graded on what they claim — they're graded on what they did. Events flow
              into Walrus Memory, and the record is what reviews, upgrades and verdicts are built from.
            </p>
          </div>
          <div className="mock-panel">
            <MockRow tone="ok" label="completed" text="Reconciled weekly expenses against the ledger export" />
            <MockRow tone="warn" label="corrected" text="Used the old VAT rate → the 2026 rate is 21 percent" />
            <MockRow tone="bad" label="failed" text="Double-booked the 14:00 sync slot" />
            <MockRow tone="info" label="review" text="outcome: gaps found → finance_qa passed the gate" />
          </div>
        </div>

        <div className="landing-feature flip">
          <div className="mock-panel">
            <div className="mock-title muted small-text">premium_data · pending approval</div>
            <MockRow tone="info" label="budget" text="cost 0.015 SUI within the 40% improvement reserve" />
            <MockRow tone="accent" label="walrus" text="lesson: this upgrade was rejected before — skip" />
            <MockRow tone="ok" label="paid" text="digest confirmed via Tatum → capability unlocked" />
          </div>
          <div className="landing-copy">
            <h3>Upgrades must show evidence.</h3>
            <p>
              A problem only becomes a fundable gap after the review gate. Then the budget engine sizes it,
              remembered lessons veto what already failed, the manager approves, and the ledger confirms.
            </p>
          </div>
        </div>

        <div className="landing-feature">
          <div className="landing-copy">
            <h3>Then it has to work.</h3>
            <p>
              After an upgrade the same category is measured again: issue rate before vs after decides the
              verdict, and the verdict is written back to Walrus so the next decision starts smarter.
            </p>
          </div>
          <div className="mock-panel">
            <div className="mock-bar-wrap">
              <div className="mock-bar before" title="issue rate before: 50%">before<span /></div>
              <div className="mock-bar after" title="issue rate after: 10%">after<span /></div>
            </div>
            <MockRow tone="ok" label="worth it" text="issue rate 50% → 10% over 14 tasks, cost 0.015 SUI" />
          </div>
        </div>
      </section>

      <section className="landing-usecases">
        <h2>One layer, the whole agent lifecycle.</h2>
        <p className="muted">
          Everything below runs today against real Walrus writes and the Tatum Sui gRPC gateway — open the
          dashboard and click a published agent.
        </p>
        <div className="usecase-grid">
          <Link to="/dashboard" className="card usecase">
            <strong>Finance Q&amp;A</strong>
            <span className="muted small-text">_answers priced with live Tatum rates; wrong answers become graded events</span>
          </Link>
          <Link to="/dashboard" className="card usecase">
            <strong>Premium data pass</strong>
            <span className="muted small-text">a capability bought on-chain, metered in calls, verified by receipt</span>
          </Link>
          <Link to="/dashboard" className="card usecase">
            <strong>Reviews that earned trust</strong>
            <span className="muted small-text">evidence gates with plain-language reasons for every rejection</span>
          </Link>
          <Link to="/tatum" className="card usecase">
            <strong>Rails you can audit</strong>
            <span className="muted small-text">every balance, payment and confirmation call logged and visible</span>
          </Link>
        </div>
      </section>

      <footer className="landing-foot">
        <span>EvoLoop — payroll and growth layer for AI agents</span>
        <a href="https://github.com/gowthamchoudhary/EvoLoop" target="_blank" rel="noreferrer">github.com/gowthamchoudhary/EvoLoop</a>
        <span className="muted">memories via Walrus · payments via Tatum · build {__BUILD_TIME__}</span>
      </footer>
    </div>
  );
}
