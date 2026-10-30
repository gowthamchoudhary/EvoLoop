import { Link } from "react-router-dom";

/* Each step links to the real page or tab where it is visible for a published agent. */
const STEPS = [
  {
    title: "1 · Salary",
    body: "An agent gets a wallet and a policy; the payroll run transfers Sui from the treasury to the agent's wallet on Sui testnet. A payslip records what was paid, spent and saved.",
    to: null, at: "the agent's Payroll tab",
  },
  {
    title: "2 · Work and events",
    body: "The agent works and posts events (completed, failed, user corrected, abandoned, cost, capability_missing) with its own API key. Important events are queued as memory texts written into Walrus Memory.",
    to: null, at: "the agent's Timeline tab",
  },
  {
    title: "3 · Review with an evidence gate",
    body: "A review scores every task category from real events. Only categories whose numbers pass an evidence gate turn into gaps — rejected categories stay visible with their reasons.",
    to: null, at: "the agent's Reviews & gaps tab",
  },
  {
    title: "4 · Upgrade request",
    body: "A gap matching an upgrade catalog entry becomes a request with a budget plan (allowance, improvement reserve, cost). Lessons recalled from Walrus Memory and database state decide what is proposed and what is skipped.",
    to: null, at: "the agent's Requests tab",
  },
  {
    title: "5 · Approval and on-chain payment",
    body: "The manager (or the demo manager when demo actions are enabled) approves or rejects. Approval executes a real transfer to the vendor, whose digest is then verified through Tatum.",
    to: null, at: "the agent's Requests tab (payment digest)",
  },
  {
    title: "6 · Measurement",
    body: "Snapshots compute a 0-100 score by code from observed events and real spend — the agent never reports its own score. Salary suggestions follow, but are never applied automatically.",
    to: null, at: "the agent's Score tab",
  },
  {
    title: "7 · Verdict",
    body: "After an upgrade, the same category's issue rate is compared before and after. The rule (at least 5 outcomes, ≥20 points drop = worth it, ≤5 points = not) produces a verdict stored in Walrus Memory.",
    to: null, at: "the agent's Verdicts tab",
  },
  {
    title: "8 · The next decision uses Walrus",
    body: "Future proposals consult recalled lessons (purchased upgrades, verdicts, rejections, dismissals) together with the database, so a capability that failed once is not bought again within its cooldown.",
    to: null, at: "the agent's Memory tab",
  },
];

export default function HowItWorks() {
  return (
    <section className="page-section">
      <h2>How EvoLoop works</h2>
      <p className="muted small-text">
        The loop below is exactly what the published demo agents run — every number you see elsewhere in this dashboard comes from one of these steps.
      </p>
      <ol className="steps">
        {STEPS.map((step) => (
          <li className="card step" key={step.title}>
            <strong>{step.title}</strong>
            <p className="small-text">{step.body}</p>
            <span className="muted small-text">see: {step.at} on the agent page → open <Link to="/">Overview</Link>, then pick the agent and the tab</span>
          </li>
        ))}
      </ol>
      <div className="card honest-notes">
        <h4>Honest notes</h4>
        <ul>
          <li>The grader is automated feedback standing in for a user: it checks answers against real Tatum rates and balances and posts task_completed / user_corrected events.</li>
          <li>The live-data questions are designed so a model without live data fails — they ask for current prices and balances no offline model can know.</li>
          <li>Price data is served through Tatum's Data API, which sources it from CoinGecko.</li>
          <li>Time in the demos is compressed: a "period" can be minutes instead of a month, so upgrades and verdicts finish in one run.</li>
          <li>This demo runs on Sui testnet. Walrus Memory writes go to mainnet storage; for test runs a dev namespace prefix is used.</li>
        </ul>
      </div>
    </section>
  );
}
