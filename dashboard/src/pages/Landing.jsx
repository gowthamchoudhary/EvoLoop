import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchSystem, fetchAgents, fetchRequests, fetchReviews, fetchTimeline, fetchVerdicts, usePoll, parseMemory, memoryBadge, gateReasonSentence, sui, autonomyLabel, periodLabel, explorerTx } from "../api.js";
import { Pill, Avatar, SegBar, INTEGRATIONS } from "../components.jsx";
import { relTime, feedSort } from "../workspace.js";
import LoopScene from "./LoopScene.jsx";

/* ------------------------------------------------------------------ */
/* landing data — real public API only, polled every 20s while visible  */
/* ------------------------------------------------------------------ */

function useLanding() {
  const system = usePoll(fetchSystem);
  const agents = usePoll(fetchAgents);
  const leadId = (agents.data ?? [])[0]?.id ?? null;

  const perAgent = usePoll(
    async () => {
      const list = (agents.data ?? []).map((agent) => agent.id);
      const all = await Promise.all(
        list.map(async (id) => ({
          id,
          timeline: await fetchTimeline(id, { limit: 40 }),
          requests: await fetchRequests(id),
          verdicts: await fetchVerdicts(id),
        }))
      );
      const reviews = await fetchReviews(leadId);
      if (all.some((row) => !row.timeline.ok || !row.requests.ok || !row.verdicts.ok) || !reviews.ok) {
        const bad = all.find((row) => !row.timeline.ok) ?? all.find((row) => !row.requests.ok) ?? all.find((row) => !row.verdicts.ok);
        return { ok: false, statusCode: bad?.timeline.statusCode ?? 0, error: bad?.timeline.error ?? reviews.error ?? "request failed", rateLimited: Boolean(bad?.timeline.rateLimited) };
      }
      return { ok: true, data: { all, reviews: reviews.data ?? [] } };
    },
    { enabled: Boolean((agents.data ?? []).length) },
    [leadId]
  );

  const agentsData = agents.data ?? [];
  const list = (perAgent.data?.all ?? []).map((entry) => {
    const meta = agentsData.find((agent) => agent.id === entry.id) ?? null;
    const feed = feedSort([
      ...((entry.timeline.data?.items ?? []).map((item) => ({
        when: item.ts ?? item.created_at,
        kind: item.type,
        event_type: item.event_type ?? null,
        mem: item.type === "memory" ? parseMemory(item.text) : null,
        badge: item.type === "memory" ? memoryBadge(parseMemory(item.text)) : null,
        label: item.type === "event" ? item.summary : null,
        status: item.status ?? null,
      }))),
      ...((entry.requests.data ?? [])
        .filter((row) => row.tx_digest)
        .map((row) => ({
          when: row.executed_at ?? row.decided_at ?? row.created_at,
          kind: "payment",
          label: `Paid ${row.capability} on Sui`,
          tx: row.tx_digest,
        }))),
    ]).slice(0, 14);
    return { meta, ...entry, feed };
  });

  const lead = list[0] ?? null;
  return {
    system,
    agents,
    lead,
    agentsData,
    reviews: perAgent.data?.reviews ?? null,
    loading: !agents.ready,
    reviewsLoading: !perAgent.data && perAgent.loading,
    perAgentErr: perAgent.error ?? null,
    rateLimited: Boolean(perAgent.rateLimited),
    stale: Boolean(perAgent.stale),
  };
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

function Nav({ onScene }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className={`land-nav ${scrolled ? "scrolled" : ""}`}>
      <div className="land-nav-inner">
        <Link to="/" className="land-logo">
          <span className="sb-mark" aria-hidden="true">◆</span>
          EvoLoop
        </Link>
        <nav className="land-links" aria-label="Main">
          <a href="#features">Product</a>
          <a href="#how-it-works" onClick={onScene}>How it works</a>
          <Link to="/app">Live demo</Link>
          <a href="https://github.com/gowthamchoudhary/EvoLoop" target="_blank" rel="noreferrer">GitHub</a>
        </nav>
        <div className="land-nav-cta">
          <span className="tooltip-wrap" aria-disabled="true">
            <button type="button" className="signin-disabled" aria-disabled="true">
              Sign in
            </button>
            <span className="tooltip" role="tooltip">Accounts arrive in the next release</span>
          </span>
          <Link to="/app" className="btn small">Open live demo</Link>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  const scroll = (event) => {
    event.preventDefault();
    document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <section className="land-hero">
      <p className="land-eyebrow">EvoLoop for agents</p>
      <h1>
        Artificial employees.
        <br />
        Real salaries.
      </h1>
      <p className="land-sub">Give any AI agent a wallet, a budget and a memory. It earns a salary, asks for upgrades with evidence, and proves they worked.</p>
      <div className="land-cta">
        <Link to="/app" className="btn">Open live demo</Link>
        <a href="#how-it-works" onClick={scroll} className="btn ghost">See how it works</a>
      </div>
    </section>
  );
}

function AgentStack({ agents, loading }) {
  const shown = agents.slice(0, 4);
  return (
    <div className="stack-scene">
      <div className="stack">
        <div className="stack-prompt">/Assign to…</div>
        {loading && (
          <>
            {[0, 1, 2].map((line) => (
              <div className="stack-row" key={line} style={{ opacity: 0.5 }}>
                <span className="skel skel-bar" style={{ width: "55%", margin: 0 }} />
              </div>
            ))}
          </>
        )}
        {!loading &&
          shown.map((agent, index) => (
            <div className={`stack-row ${index === 0 ? "lead" : ""}`} key={agent.id} style={{ opacity: 1 - index * 0.16 }}>
              <Avatar name={agent.name} />
              <span className="stack-name">{agent.name}</span>
              <span className="badge">App</span>
              {index === 0 && <span className="stack-check">✓</span>}
            </div>
          ))}
        {!loading && (
          <>
            <div className="stack-row slot" style={{ opacity: 0.5 }}>＋ Connect your agent — register it and publish</div>
            <div className="stack-row slot" style={{ opacity: 0.3 }}>＋ Connect your agent — bring your own policy</div>
          </>
        )}
      </div>
    </div>
  );
}

function FeatureBudget({ landing }) {
  const agent = landing.lead;
  const meta = agent?.meta;
  const budgetRow = ((agent?.requests.data ?? []).find((row) => row.budget)) ?? null;
  const reservePct = budgetRow?.budget?.improvement_reserve_pct ?? null;
  const cap = budgetRow?.budget?.improvement_cap_mist ?? null;
  const allowanceMist = budgetRow?.budget?.allowance_mist ?? null;
  return (
    <div className="feature-row" id="features">
      <div className="feature-copy">
        <h3>Agents with a budget, not a blank cheque.</h3>
        <p>An allowance with a period and an autonomy rule. Upgrades draw from a capped improvement reserve — never from the whole wallet.</p>
      </div>
      <div className="live-panel">
        <span className="live-panel-title">{meta ? meta.name : "resource state"}</span>
        {meta ? (
          <>
            <dl className="card-stats">
              <div><dt>allowance</dt><dd>{sui(meta.allowance_sui)}</dd></div>
              <div><dt>period</dt><dd>{periodLabel(meta.period)}</dd></div>
              <div><dt>autonomy</dt><dd>{autonomyLabel(meta.autonomy)}</dd></div>
            </dl>
            {budgetRow?.budget ? (
              <SegBar
                segments={[
                  { pct: cap && allowanceMist ? (Number(allowanceMist) / Math.max(Number(allowanceMist), Number(cap))) * 100 : 100, tone: "", title: `allowance ${sui(Number(allowanceMist) / 1e9)}` },
                  { pct: cap && allowanceMist ? Math.min(100, (Number(cap) / Math.max(Number(allowanceMist), Number(cap))) * 100) : 0, tone: "cost", title: `improvement cap ${sui(Number(cap) / 1e9)}` },
                ]}
                label={`improvement reserve <strong>${reservePct ?? "—"}%</strong> of allowance`}
              />
            ) : (
              <p className="muted small-text">Improvement reserve shows once the first upgrade request sizes itself.</p>
            )}
            <p className="muted small-text">Live from /public/v1/agents — demo periods are compressed.</p>
          </>
        ) : (
          <p className="muted small-text">No published agent yet. This panel shows a real agent's budget the moment one appears.</p>
        )}
      </div>
    </div>
  );
}

function FeatureFeed({ landing }) {
  const feed = landing.lead?.feed ?? [];
  return (
    <div className="feature-row flip">
      <div className="feature-copy">
        <h3>Stay in the loop, every step.</h3>
        <p>Reviews, upgrade purchases, verdicts and salary suggestions — the real record of the published agents, newest first, with explorer links on-chain.</p>
      </div>
      <div className="live-panel">
        <span className="live-panel-title">{landing.lead?.meta ? `${landing.lead.meta.name} · activity` : "activity feed"}</span>
        {feed.length > 0 ? (
          <ul className="feed-list">
            {feed.map((item, index) => (
              <li key={index}>
                <span className="feed-when">{relTime(item.when)}</span>
                <span className="feed-row-body">
                  {item.kind === "payment" ? (
                    <>
                      Unlocked a capability —{" "}
                      <a href={explorerTx(landing.system.data, item.tx)} target="_blank" rel="noreferrer" className="chip hash-chip">
                        <code>{`${item.tx.slice(0, 6)}…${item.tx.slice(-4)}`}</code> ↗
                      </a>
                    </>
                  ) : item.kind === "event" ? (
                    <>
                      <Pill tone={item.event_type === "task_completed" ? "ok" : item.event_type === "review" ? "info" : "warn"}>{item.event_type}</Pill> {item.label}
                    </>
                  ) : (
                    <>
                      <Pill tone={item.badge?.tone}>{item.badge?.label}</Pill> {item.mem?.sentence ?? item.label}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : landing.loading ? (
          <span className="skel skel-bar" style={{ width: "80%" }} />
        ) : (
          <p className="muted small-text">Nothing published to a feed yet. Connect an agent and its work shows up here — the same way it shows in the dashboard.</p>
        )}
      </div>
    </div>
  );
}

function FeatureGate({ landing }) {
  const reviews = landing.reviews ?? [];
  const review = reviews[0] ?? null;
  return (
    <div className="feature-row">
      <div className="feature-copy">
        <h3>Evidence before spending.</h3>
        <p>A problem only becomes a fundable gap when the numbers pass the evidence gate. Every rejection keeps its plain-language reason.</p>
      </div>
      <div className="live-panel">
        <span className="live-panel-title">latest review · {review?.period_label ?? "—"}</span>
        {review ? (
          <div className="gate-tiles">
            {review.gaps?.slice(0, 5).map((gap) => (
              <div key={gap.id} className={`gate-tile ${gap.status === "passed_gate" ? "pass" : "reject"}`}>
                <Pill tone={gap.status === "passed_gate" ? "ok" : "warn"}>{gap.status === "passed_gate" ? "passed" : "rejected"}</Pill>
                <span>{gap.task_category}</span>
                <span className="muted small-text" style={{ marginLeft: "auto" }}>
                  {gap.status === "passed_gate" ? `issue rate ${Math.round((gap.metrics?.issue_rate ?? 0) * 1000) / 10}%` : (gap.gate_reasons?.[0] ? gateReasonSentence(gap.gate_reasons[0], gap.metrics ?? {}) : "by the evidence gate")}
                </span>
              </div>
            ))}
          </div>
        ) : landing.reviewsLoading ? (
          <span className="skel skel-bar" style={{ width: "80%" }} />
        ) : (
          <p className="muted small-text">
            No review on record yet. When the first review runs, passed and rejected categories appear here with their gate reasons.
            <br />
            {landing.perAgentErr && !landing.rateLimited ? `Public API said: ${landing.perAgentErr}` : ""}
          </p>
        )}
      </div>
    </div>
  );
}

function FeatureMemory({ landing }) {
  const basis = (landing.lead?.requests.data ?? []).flatMap((row) => (Array.isArray(row.budget?.decision_basis) ? row.budget.decision_basis : []));
  const item = basis.find((entry) => entry.source === "walrus") ?? basis[0] ?? null;
  return (
    <div className="feature-row flip">
      <div className="feature-copy">
        <h3>Memory that changes decisions.</h3>
        <p>Lessons recalled from Walrus are cited inside the budget decision itself — blob id and all. Upgrades that failed before are skipped, not re-bought.</p>
      </div>
      <div className="live-panel">
        <span className="live-panel-title">decision basis · real item</span>
        {item ? (
          <div className="basis-list">
            <li>
              <Pill tone={item.source === "walrus" ? "accent" : "info"}>{item.source}</Pill>
              <span>{item.kind}{item.capability_key ? ` · ${item.capability_key}` : ""}</span>
            </li>
            {item.text_excerpt && <li className="muted small-text">“{item.text_excerpt}”</li>}
            {(item.blob_ids ?? []).map((blob) => (
              <li key={blob}>
                <span className="chip hash-chip"><code>{`${blob.slice(0, 10)}…${blob.slice(-6)}`}</code></span>
                <span className="chip-note">stored in Walrus Memory (mainnet)</span>
              </li>
            ))}
          </div>
        ) : (
          <p className="muted small-text">No decision recorded yet. Once an upgrade request is priced, the same evidence that decided it is listed here.</p>
        )}
      </div>
    </div>
  );
}

function BuiltOn({ system }) {
  const walrus = system.data?.walrus?.total?.memories_stored;
  const tatum = system.data?.tatum?.calls_logged;
  return (
    <section className="land-band">
      <h2>Built on rails that are actually running.</h2>
      <p className="band-sub">Not partners-in-a-badge: these three are what the live system calls today. The counters are real.</p>
      <div className="built-grid">
        <div className="built-card">
          <h3>Walrus Memory</h3>
          <span className="built-counter">{typeof walrus === "number" ? walrus : "…"}</span>
          <p>Every lesson, verdict and important event is stored as a Walrus blob; decisions cite the blob id, so nothing is asserted without a receipt.</p>
        </div>
        <div className="built-card">
          <h3>Tatum</h3>
          <span className="built-counter">{typeof tatum === "number" ? tatum : "…"}</span>
          <p>The Sui gateway for every balance read, salary transfer, payment execution and confirmation. Each call is logged and auditable in the dashboard.</p>
        </div>
        <div className="built-card">
          <h3>Sui</h3>
          <span className="built-counter mono">SUI</span>
          <p>-testnet for the demo: wallets, salaries and upgrade payments settle as real transactions with explorer links, not credits in a database.</p>
        </div>
      </div>
    </section>
  );
}

export default function Landing() {
  const landing = useLanding();
  const scrollScene = (event) => {
    event.preventDefault();
    document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const site = {
    data: {
      memoriesStored: landing.system.data?.walrus?.total?.memories_stored ?? null,
      digest: landing.lead?.feed?.find((item) => item.kind === "payment")?.tx ?? null,
      verdict: (landing.lead?.verdicts.data ?? [])[0] ?? null,
    },
  };
  return (
    <div className="landing">
      <Nav onScene={scrollScene} />
      <Hero />
      <AgentStack agents={landing.agentsData} loading={landing.loading} />

      <section className="land-features">
        <FeatureBudget landing={landing} />
        <FeatureFeed landing={landing} />
        <FeatureGate landing={landing} />
        <FeatureMemory landing={landing} />
      </section>

      <section className="land-band">
        <h2>Every use case plugs in the same way.</h2>
        <p className="band-sub">Four ways to put an agent into the loop. Snippets below match the real API in this repo — replace the placeholders with your own key.</p>
        <div className="integ-grid">
          {INTEGRATIONS.map((integ) => (
            <div className="integ-card" key={integ.key}>
              <h3>{integ.title}</h3>
              <p>{integ.blurb}</p>
              <pre className="integ-snippet">{integ.snippet}</pre>
            </div>
          ))}
        </div>
      </section>

      <BuiltOn system={landing.system} />

      <section className="land-band" id="how-it-works" style={{ scrollMarginTop: "80px" }}>
        <h2>How it works.</h2>
        <p className="band-sub">Scroll. The city below is the loop itself — manuals do not show evidence gates, so the scene does.</p>
      </section>
      <div className="how-page">
        <LoopScene site={site} />
      </div>
      <div className="land-band honest-notes card" style={{ marginTop: -40, marginBottom: 40 }}>
        <h3>Honest notes</h3>
        <ul>
          <li>The grader is automated feedback standing in for a user: it checks answers against real Tatum rates and balances.</li>
          <li>The live-data questions are designed so a model without live data fails — they ask for current prices and balances no offline model can know.</li>
          <li>Price data is served through Tatum's Data API, which sources it from CoinGecko.</li>
          <li>Demo periods are compressed: a "period" is minutes, not a month, so upgrades and verdicts finish in one run.</li>
          <li>The demo runs on Sui testnet. Walrus Memory writes go to mainnet storage; for test runs a dev namespace prefix is used.</li>
        </ul>
      </div>

      <section className="land-cta-band">
        <h2>Hire your first agent.</h2>
        <p className="land-sub">Open the demo, watch a real agent ask for an upgrade with evidence, and see the payment confirmed on-chain.</p>
        <div className="land-cta">
          <Link to="/app" className="btn">Open live demo</Link>
          <a href="#how-it-works" onClick={scrollScene} className="btn ghost">Read the loop first</a>
        </div>
      </section>

      <footer className="land-foot">
        <div className="land-foot-inner">
          <span>EvoLoop — payroll and growth layer for AI agents</span>
          <span>
            <a href="#honest" onClick={(e) => { e.preventDefault(); document.querySelector(".honest-notes")?.scrollIntoView({ behavior: "smooth" }); }}>Honest notes</a> ·{" "}
            <a href="https://github.com/gowthamchoudhary/EvoLoop" target="_blank" rel="noreferrer">repository</a>
          </span>
          <span className="muted">memories via Walrus · payments via Tatum · build {__BUILD_TIME__}</span>
        </div>
      </footer>
    </div>
  );
}
