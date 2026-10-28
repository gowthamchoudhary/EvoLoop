import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import {
  fetchAgent,
  fetchTimeline,
  fetchScores,
  fetchSuggestions,
  usePoll,
  sui,
  mistSui,
  short,
  explorerTx,
  explorerAccount,
  autonomyLabel,
  periodLabel,
  fmtWhen,
  fmtClock,
  fmtPct,
} from "../api.js";
import { CopyChip, Gauge, LoadState, LastUpdated, Pill, TypeBadge } from "../components.jsx";

const ISSUE_EVENTS = new Set(["task_failed", "user_corrected", "task_abandoned", "capability_missing"]);

function badgeFor(item) {
  if (item.type === "event") {
    switch (item.event_type) {
      case "task_completed": return ["completed", "ok"];
      case "task_failed": return ["failed", "warn"];
      case "user_corrected": return ["corrected", "warn"];
      case "task_abandoned": return ["abandoned", "warn"];
      case "cost_incurred": return ["cost", "info"];
      case "capability_missing": return ["capability_missing", "warn"];
      default: return [item.event_type ?? "event", "info"];
    }
  }
  const kind = item.kind ?? "";
  if (kind.startsWith("upgrade_verdict")) return ["verdict", "accent"];
  if (kind.startsWith("upgrade")) return ["upgrade", "accent"];
  if (kind.includes("review")) return ["review", "accent"];
  return ["memory", "info"];
}

const FILTERS = ["all", "events", "memories", "issues"];

function TimelineTab({ agentId, system }) {
  const first = usePoll(() => fetchTimeline(agentId, { limit: 50 }), {}, [agentId]);
  const [extraPages, setExtraPages] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(null);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    setExtraPages([]);
    setMoreError(null);
  }, [agentId]);

  const cursor = extraPages.length ? extraPages[extraPages.length - 1].next_before : first.data?.next_before ?? null;

  const loadMore = async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    const page = await fetchTimeline(agentId, { limit: 50, before: cursor });
    setLoadingMore(false);
    if (page.ok) setExtraPages((pages) => [...pages, page.data]);
    else setMoreError(page.error ?? "could not load more rows");
  };

  const items = [];
  if (first.data) for (const page of [first.data, ...extraPages]) for (const item of page.items) items.push(item);
  const seen = new Set();
  const deduped = items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));

  const filtered = deduped.filter((item) => {
    if (filter === "events") return item.type === "event";
    if (filter === "memories") return item.type === "memory";
    if (filter === "issues") return item.type === "event" && ISSUE_EVENTS.has(item.event_type);
    return true;
  });

  return (
    <div className="tab-body">
      <p className="tab-note muted">
        Rows tagged <span className="badge accent">automated feedback</span> were posted by the grader that checks answers against live price/balance data fetched over Tatum —
        they are machine verdicts, not a human correction.
      </p>
      <div className="filter-row" role="tablist" aria-label="timeline filters">
        {FILTERS.map((name) => (
          <button key={name} type="button" className={`btn ghost small ${filter === name ? "active" : ""}`} onClick={() => setFilter(name)}>
            {name}
          </button>
        ))}
        <LastUpdated state={first} label="Timeline" />
      </div>

      <LoadState state={first} what="the timeline">
        {filtered.length === 0 ? (
          <div className="state-box">
            <p>Nothing matches this filter yet.</p>
          </div>
        ) : (
          <ul className="tl-list">
            {filtered.map((item) => {
              const [label, tone] = badgeFor(item);
              const automated = item.type === "event" && item.details?.source === "automated_grader";
              const when = item.type === "event" ? item.ts : item.created_at;
              return (
                <li key={item.id} className={`tl-row ${item.type}`}>
                  <span className="tl-time">{fmtWhen(when)}</span>
                  <span className="tl-badges">
                    <TypeBadge tone={tone}>{label}</TypeBadge>
                    {item.type === "event" && item.task_category && <TypeBadge tone="category">{item.task_category}</TypeBadge>}
                    {automated && <TypeBadge tone="accent">automated feedback</TypeBadge>}
                    {item.type === "memory" && (
                      <TypeBadge tone={item.status === "stored" ? "ok" : item.status === "pending" ? "warn" : "bad"}>{item.status}</TypeBadge>
                    )}
                  </span>
                  <span className="tl-body">
                    {item.type === "event" && <span className="tl-summary">{item.summary}</span>}
                    {item.type === "event" && item.session_id && <span className="muted small-text">session {item.session_id}</span>}
                    {item.type === "event" && item.correction && <span className="tl-correction">correction: {item.correction}</span>}
                    {item.type === "memory" && (
                      <>
                        <span className="tl-summary">{item.text}</span>
                        <span className="tl-memory-meta">
                          <TypeBadge tone="category">{item.kind}</TypeBadge>
                          {item.blob_id && <CopyChip value={item.blob_id} note="stored in Walrus Memory" />}
                        </span>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {cursor && (
          <div className="load-more">
            <button type="button" className="btn ghost" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
        {moreError && (
          <p className="muted small-text">
            Could not load more rows: {moreError}. <button type="button" className="icon-btn" onClick={loadMore}>retry</button>
          </p>
        )}
      </LoadState>
      {!cursor && first.data && <p className="muted small-text">End of the timeline.</p>}
    </div>
  );
}

const SUGGESTION_LABELS = { raise: "Raise suggested", probation: "Probation suggested", hold: "Hold suggested" };

function ScoreTab({ agentId, agentState }) {
  const scores = usePoll(() => fetchScores(agentId), {}, [agentId]);
  const suggestions = usePoll(() => fetchSuggestions(agentId), {}, [agentId]);

  const rows = [ ...(scores.data ?? []) ].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const points = rows
    .filter((row) => row.score !== null && row.score !== undefined)
    .map((row) => ({ when: fmtClock(row.created_at) ?? row.period_label, score: row.score }));
  const latest = rows.length ? rows[rows.length - 1] : null;
  const suggestion = (suggestions.data ?? []).length ? [...(suggestions.data ?? [])][0] : agentState?.data?.latest_salary_suggestion ?? null;
  const weightOf = (component) => (component.configured_weight ? Math.round(component.configured_weight * 100) : 0);

  return (
    <div className="tab-body">
      <LastUpdated state={scores} label="Scores" />
      <LoadState state={scores} what="score history">
        {rows.length === 0 ? (
          <div className="state-box">
            <p>No score snapshots yet. Scores appear after a review runs with score snapshotting enabled.</p>
          </div>
        ) : (
          <>
            <div className="card">
              <h4>Score history</h4>
              {points.length > 1 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="when" tick={{ fill: "var(--muted)", fontSize: 11 }} />
                    <YAxis domain={[0, 100]} tick={{ fill: "var(--muted)", fontSize: 11 }} width={28} />
                    <Tooltip contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)" }} />
                    <Line dataKey="score" stroke="var(--accent)" dot={{ r: 2 }} strokeWidth={2} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <p className="muted small-text">One snapshot so far — the chart draws a line once there is a second point.</p>
              )}
            </div>
            {latest && (
              <div className="card">
                <h4>Latest snapshot {latest.period_label} <Pill tone={latest.status === "scored" ? "ok" : "warn"}>{latest.status}</Pill></h4>
                {latest.status === "insufficient_data" ? (
                  <p className="muted small-text">
                    Not enough data in this window to score (fewer than the minimum outcomes), so the snapshot has no number yet.
                  </p>
                ) : (
                  <p className="score-big">{latest.score}<span className="muted small-text"> / 100</span></p>
                )}
                <table className="component-table">
                  <thead>
                    <tr>
                      <th>component</th><th>value</th><th>configured weight</th><th>included</th><th>raw numbers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(latest.components ?? []).map((component) => (
                      <tr key={component.name}>
                        <td>{component.name}</td>
                        <td>{component.value === null ? "—" : Math.round(component.value * 1000) / 1000}</td>
                        <td>{weightOf(component)}%</td>
                        <td>{component.included ? "yes" : "no"}</td>
                        <td>
                          {Object.entries(component.raw ?? {})
                            .map(([key, value]) => (key.endsWith("_mist") ? `${key.slice(0, -5)} ${mistSui(value)}` : `${key} ${value}`))
                            .join(" · ")}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td>outcomes</td><td>{latest.outcomes}</td><td>—</td><td>—</td><td>issue rate {fmtPct(latest.issue_rate)}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="muted small-text">Scores are computed by code from observed events; the agent does not report its own score.</p>
              </div>
            )}
          </>
        )}
      </LoadState>
      <LoadState state={suggestions} what="salary suggestions">
        {suggestion ? (
          <div className="card">
            <h4>Latest salary suggestion <Pill tone={suggestion.kind === "probation" ? "warn" : "accent"}>{SUGGESTION_LABELS[suggestion.kind] ?? suggestion.kind}</Pill></h4>
            <p>
              {suggestion.current_allowance_sui} → <strong>{sui(suggestion.suggested_allowance_sui)}</strong>
              {suggestion.status && <span className="muted small-text"> · {suggestion.status} · {fmtWhen(suggestion.created_at)}</span>}
            </p>
            {(suggestion.reasons ?? []).length > 0 && (
              <ul className="reasons">
                {suggestion.reasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            )}
            <p className="muted small-text">Suggestions are never applied automatically — a human accepts or dismisses each one.</p>
          </div>
        ) : (
          <div className="state-box"><p>No salary suggestions yet.</p></div>
        )}
      </LoadState>
    </div>
  );
}

export default function Agent({ system }) {
  const { id } = useParams();
  const agent = usePoll(() => fetchAgent(id), {}, [id]);
  const [tab, setTab] = useState("timeline");
  const data = agent.data;
  const pass = data?.pass_status;
  const balance = data?.balance;
  const explorerWallet = explorerAccount(system?.data, data?.wallet_address);

  return (
    <section className="page-section">
      <Link to="/" className="back-link">← Overview</Link>
      <LoadState state={agent} what="the agent">
        {data && (
          <>
            <div className="card agent-header">
              <div className="agent-card-head">
                <div className="agent-card-title">
                  <h2>{data.name}</h2>
                  <Pill tone="default">{data.kind}</Pill>
                  <Gauge value={data.latest_score?.score} status={data.latest_score?.status} />
                </div>
              </div>
              {data.description && <p className="agent-card-desc">{data.description}</p>}
              <dl className="card-stats wide">
                <div>
                  <dt>wallet</dt>
                  <dd><CopyChip value={data.wallet_address} explorer={explorerWallet} /></dd>
                </div>
                <div>
                  <dt>balance</dt>
                  <dd title={balance ? `coin objects ${sui(balance.coin_objects)} + address ${sui(balance.address_balance)} = total ${sui(balance.total)}` : undefined}>
                    {sui(balance?.total)}
                  </dd>
                </div>
                <div>
                  <dt>allowance / {periodLabel(data.period)}</dt>
                  <dd>{sui(data.allowance_sui)}</dd>
                </div>
                <div>
                  <dt>autonomy</dt>
                  <dd>{autonomyLabel(data.autonomy)}</dd>
                </div>
              </dl>
              <div className="chips">
                {(data.capabilities ?? []).map((cap) => (
                  <span className="chip cap" key={cap.capability_key} title={`unlock cost ${sui(cap.price_sui)} · since ${fmtWhen(cap.unlocked_at)}`}>
                    {cap.capability_key}
                  </span>
                ))}
                {(data.capabilities ?? []).length === 0 && <span className="chip muted">no capabilities unlocked</span>}
              </div>
              {pass && pass.status !== "none" && (
                <div className="pass-row">
                  <Pill tone={pass.active ? "ok" : "warn"}>{pass.active ? "premium pass active" : `premium pass ${pass.status}`}</Pill>
                  <span className="muted small-text">
                    {pass.calls_remaining ?? "—"}/{pass.calls_granted} calls left{pass.expires_at ? ` · expires ${fmtWhen(pass.expires_at)}` : ""}
                  </span>
                  {pass.digest && <CopyChip value={pass.digest} explorer={explorerTx(system?.data, pass.digest)} note="purchase transfer" />}
                </div>
              )}
            </div>
            <div className="tabs" role="tablist">
              <button type="button" className={`tab-btn ${tab === "timeline" ? "active" : ""}`} onClick={() => setTab("timeline")} role="tab" aria-selected={tab === "timeline"}>
                Timeline
              </button>
              <button type="button" className={`tab-btn ${tab === "score" ? "active" : ""}`} onClick={() => setTab("score")} role="tab" aria-selected={tab === "score"}>
                Score
              </button>
            </div>
            {tab === "timeline" ? <TimelineTab agentId={id} system={system} /> : <ScoreTab agentId={id} agentState={agent} />}
          </>
        )}
      </LoadState>
    </section>
  );
}
