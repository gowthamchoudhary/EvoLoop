import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LineChart, Line } from "recharts";
import {
  fetchAgent,
  fetchTimeline,
  fetchScores,
  fetchSuggestions,
  fetchReviews,
  fetchRequests,
  fetchVerdicts,
  fetchTransactions,
  fetchLessons,
  usePoll,
  parseMemory,
  memoryBadge,
  gateReasonSentence,
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
  demoAction,
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
  return memoryBadge(parseMemory(item.text));
}

const FILTERS = ["all", "events", "memories", "issues"];

const REQUEST_BADGES = {
  pending_approval: ["pending approval", "warn"],
  approved: ["approved", "ok"],
  auto_approved: ["auto approved", "ok"],
  needs_raise: ["needs a raise", "warn"],
  rejected: ["rejected", "bad"],
  executed: ["executed", "ok"],
};

function approveCodeMessage(code) {
  const messages = {
    demo_actions_disabled: "Demo actions are globally disabled on this server — nothing was changed.",
    agent_not_actionable: "This agent is published but marked not actionable in the demo — nothing was changed.",
    mainnet_not_allowed: "Demo actions are restricted to testnet — nothing was changed.",
    request_not_pending: "This request is no longer pending.",
    demo_action_rate_limited: "Too many demo actions from this viewer, try again later (HTTP 429).",
    demo_action_failed: "The server could not complete the demo action.",
  };
  return messages[code] ?? code;
}

function TimelineTab({ agentId, system, highlightIds }) {
  const first = usePoll(() => fetchTimeline(agentId, { limit: 50 }), {}, [agentId]);
  const [extraPages, setExtraPages] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(null);
  const [filter, setFilter] = useState("all");
  const rowRefs = useRef(new Map());

  useEffect(() => {
    setExtraPages([]);
    setMoreError(null);
  }, [agentId]);

  useEffect(() => {
    if (!highlightIds?.length || !first.data) return;
    const node = rowRefs.current.get(highlightIds[0]);
    if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [first.data, highlightIds]);

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
              const highlighted = highlightIds?.includes(item.id);
              const memory = item.type === "memory" ? parseMemory(item.text) : null;
              const memBadge = item.type === "memory" ? memoryBadge(memory) : null;
              return (
                <li
                  key={item.id}
                  className={`tl-row ${item.type} ${highlighted ? "highlight" : ""}`}
                  ref={(node) => { if (node) rowRefs.current.set(item.id, node); else rowRefs.current.delete(item.id); }}
                >
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
                        {memory.known ? (
                          <span className="tl-summary">{memory.sentence}</span>
                        ) : (
                          <span className="tl-summary">{item.text}</span>
                        )}
                        <span className="tl-memory-meta">
                          <TypeBadge tone={memBadge.tone}>{memBadge.label}</TypeBadge>
                          {item.blob_id && <CopyChip value={item.blob_id} note="stored in Walrus Memory" />}
                        </span>
                        <details className="raw-memory">
                          <summary>show raw memory text</summary>
                          <pre>{item.text}</pre>
                          <span className="muted small-text">
                            {item.blob_id ? (
                              <>blob {" "}
                                <code>{short(item.blob_id)}</code>
                              </>
                            ) : (
                              "not stored yet"
                            )}
                            {item.stored_at ? ` · stored ${fmtWhen(item.stored_at)}` : ` · created ${fmtWhen(item.created_at)}`}
                          </span>
                        </details>
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

  const rows = [...(scores.data ?? [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const points = rows.map((row) => ({
    label: row.period_label ?? fmtClock(row.created_at),
    score: row.score,
    status: row.status,
    window_start: row.window_start,
    window_end: row.window_end,
  }));
  const latest = rows.length ? rows[rows.length - 1] : null;
  const suggestionRows = [...(suggestions.data ?? [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const suggestion = suggestionRows.find((row) => row.status !== "superseded") ?? null;
  const onlySuperseded = !suggestion && suggestionRows.length > 0;
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
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: "var(--muted)", fontSize: 11 }} />
                  <YAxis domain={[0, 100]} tick={{ fill: "var(--muted)", fontSize: 11 }} width={28} />
                  <Tooltip
                    contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)" }}
                    formatter={(value, name, item) => [value, name]}
                    labelFormatter={(label, payload) => {
                      const row = payload?.[0]?.payload;
                      if (!row) return label;
                      return `${label} · ${row.status} · window ${fmtClock(row.window_start)} → ${fmtClock(row.window_end)}`;
                    }}
                  />
                  <Line dataKey="score" stroke="var(--accent)" dot={{ r: 3 }} strokeWidth={2} isAnimationActive={false} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
              {rows.length === 1 && (
                <p className="muted small-text">Only one snapshot so far — it is drawn as a single point; the x-axis is the review period label.</p>
              )}
            </div>
            {latest && (
              <div className="card">
                <h4>
                  Latest snapshot {latest.period_label} <Pill tone={latest.status === "scored" ? "ok" : "warn"}>{latest.status}</Pill>{" "}
                  <span className="muted small-text" title={fmtWhen(latest.created_at)}>from {fmtWhen(latest.created_at)}</span>
                </h4>
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
            <h4>
              Latest salary suggestion <Pill tone={suggestion.kind === "probation" ? "warn" : "accent"}>{SUGGESTION_LABELS[suggestion.kind] ?? suggestion.kind}</Pill>{" "}
              <Pill tone="default">{suggestion.status}</Pill>
            </h4>
            <p>
              {suggestion.current_allowance_sui} → <strong>{sui(suggestion.suggested_allowance_sui)}</strong>
              <span className="muted small-text"> · from {fmtWhen(suggestion.created_at)}</span>
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
        ) : onlySuperseded ? (
          <div className="state-box"><p>All stored salary suggestions for this agent were superseded by newer ones; nothing active to show.</p></div>
        ) : (
          <div className="state-box"><p>No salary suggestions yet.</p></div>
        )}
      </LoadState>
    </div>
  );
}

/* ---------------- Reviews & gaps ---------------- */

const OUTCOME_LABELS = { gaps_found: ["gaps found", "warn"], no_gaps: ["no gaps", "ok"], insufficient_data: ["insufficient data", "info"] };
const GAP_STATUS_LABELS = { passed_gate: ["passed the gate", "ok"], rejected_gate: ["rejected", "warn"], dismissed: ["dismissed", "info"], recorded: ["recorded", "info"] };

function ReviewsTab({ agentId, onJumpToEvent }) {
  const reviews = usePoll(() => fetchReviews(agentId), {}, [agentId]);
  const list = reviews.data ?? [];
  return (
    <div className="tab-body">
      <p className="tab-note muted">A problem becomes a gap only if the data passes an evidence gate. Rejected categories are shown on purpose.</p>
      <LastUpdated state={reviews} label="Reviews" />
      <LoadState state={reviews} what="reviews">
        {list.length === 0 ? (
          <div className="state-box"><p>No reviews yet. Reviews run on a window of the agent's own event history.</p></div>
        ) : (
          list.map((review) => {
            const [outcomeLabel, outcomeTone] = OUTCOME_LABELS[review.outcome] ?? [review.outcome, "info"];
            return (
              <div className="card" key={review.id}>
                <div className="review-head">
                  <h4>{review.period_label}</h4>
                  <Pill tone={outcomeTone}>{outcomeLabel}</Pill>
                  <span className="muted small-text">{fmtWhen(review.created_at)} · window {fmtWhen(review.window_start)} → {fmtWhen(review.window_end)}</span>
                </div>
                {review.summary && <p className="small-text">{review.summary}</p>}
                <table className="component-table">
                  <thead>
                    <tr><th>category</th><th>outcomes</th><th>issues</th><th>issue rate</th><th>sessions w/ issues</th><th>gate status</th></tr>
                  </thead>
                  <tbody>
                    {review.gaps.map((gap) => {
                      const [gapLabel, gapTone] = GAP_STATUS_LABELS[gap.status] ?? [gap.status, "info"];
                      return (
                        <tr key={gap.id}>
                          <td>{gap.task_category}{gap.taxonomy ? ` (${gap.taxonomy})` : ""}</td>
                          <td>{gap.metrics?.outcomes ?? 0}</td>
                          <td>{gap.metrics?.issues ?? 0}</td>
                          <td>{fmtPct(gap.metrics?.issue_rate)}</td>
                          <td>{gap.metrics?.sessions_with_issues ?? 0}</td>
                          <td>
                            <Pill tone={gapTone}>{gapLabel}</Pill>
                            <ul className="reasons">
                              {(gap.gate_reasons ?? []).map((code, index) => (
                                <li key={index} className="muted small-text">{gateReasonSentence(code, gap.metrics ?? {})}</li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="gaps-of-review">
                  {review.gaps.filter((gap) => gap.status === "passed_gate").map((gap) => (
                    <div className="passed-gap" key={gap.id}>
                      <div className="passed-gap-head">
                        <strong>{gap.task_category}</strong>
                        <TypeBadge tone="category">{gap.taxonomy}</TypeBadge>
                        {gap.fix_type && <TypeBadge tone="info">fix: {gap.fix_type}</TypeBadge>}
                        <Pill tone={gap.priority_label === "high" ? "warn" : "default"}>{gap.priority_label} priority</Pill>
                        <span className="muted small-text">
                          severity {gap.severity} · impact {gap.impact}
                        </span>
                      </div>
                      <p className="small-text">
                        {gap.description}
                        <TypeBadge tone={gap.description_source === "llm" ? "accent" : "category"}>
                          {gap.description_source === "llm" ? "written by AI, numbers computed by code" : "template"}
                        </TypeBadge>
                      </p>
                      {(gap.evidence_event_ids ?? []).length > 0 && (
                        <p className="small-text">
                          evidence:{" "}
                          {gap.evidence_event_ids.map((eventId, index) => (
                            <button key={index} type="button" className="icon-btn" onClick={() => onJumpToEvent(eventId)} title="jump to this event in the timeline">
                              <code>{short(eventId)}</code>
                            </button>
                          ))}
                        </p>
                      )}
                    </div>
                  ))}
                  {review.gaps.every((gap) => gap.status !== "passed_gate") && (
                    <p className="muted small-text">No category passed the evidence gate in this review.</p>
                  )}
                </div>
              </div>
            );
          })
        )}
      </LoadState>
    </div>
  );
}

/* ---------------- Requests ---------------- */

function BudgetBar({ budget, costSui }) {
  if (!budget) return null;
  const cap = Number(budget.improvement_cap_mist ?? 0);
  const spent = Number(budget.improvement_spent_mist ?? 0);
  const allowance = Number(budget.allowance_mist ?? 0);
  const cost = Number(budget.cost_mist ?? 0);
  const pct = (value) => (cap > 0 ? Math.min(100, (value / cap) * 100) : 0);
  return (
    <div className="budget-bar-wrap">
      <div className="budget-bar">
        <span className="budget-spent" style={{ width: `${pct(spent)}%` }} title={`spent ${mistSui(spent)}`} />
        <span className="budget-cost" style={{ width: `${Math.min(100, pct(cost))}%` }} title={`this request ${mistSui(cost)}`} />
      </div>
      <div className="budget-legend muted small-text">
        allowance {mistSui(allowance)} · improvement cap {mistSui(cap)} · spent {mistSui(spent)} · this request {costSui}
        {budget.within_budget === false && ` · shortfall ${mistSui(budget.shortfall_mist)}`}
      </div>
    </div>
  );
}

function RequestsTab({ agentId, agentState, system }) {
  const requests = usePoll(() => fetchRequests(agentId), {}, [agentId]);
  const [results, setResults] = useState({});
  const [busyId, setBusyId] = useState(null);
  const demoEnabled = system?.data?.demo_actions_enabled === true;

  const run = async (requestId, action) => {
    setBusyId(`${requestId}:${action}`);
    const result = await demoAction(requestId, action);
    setBusyId(null);
    if (result.ok) {
      setResults((prev) => ({
        ...prev,
        [requestId]: {
          ok: true,
          message: `Decision recorded: ${action === "approve" ? "approved" : "rejected"} by demo-manager. Only the decision was recorded — no payment ran from this button.`,
        },
      }));
    } else {
      setResults((prev) => ({ ...prev, [requestId]: { ok: false, message: `Action failed (HTTP ${result.statusCode}${result.code ? `, ${result.code}` : ""}): ${approveCodeMessage(result.code) ?? result.error}` } }));
    }
  };

  const rows = requests.data ?? [];
  return (
    <div className="tab-body">
      <LastUpdated state={requests} label="Requests" />
      <LoadState state={requests} what="upgrade requests">
        {rows.length === 0 ? (
          <div className="state-box"><p>No upgrade requests yet. Requests appear when a review gap is turned into a proposal.</p></div>
        ) : (
          rows.map((row) => {
            const [label, tone] = REQUEST_BADGES[row.status] ?? [row.status, "info"];
            const pending = row.status === "pending_approval" || row.status === "needs_raise";
            const result = results[row.id];
            return (
              <div className="card request-card" key={row.id}>
                <div className="review-head">
                  <h4>{row.capability}</h4>
                  <Pill tone={tone}>{label}</Pill>
                  <span className="muted small-text">cost {row.cost_sui} · from {fmtWhen(row.created_at)}</span>
                </div>
                {row.expected_benefit && <p className="small-text">{row.expected_benefit}</p>}
                {row.baseline && (
                  <p className="muted small-text">
                    baseline: {row.baseline.task_category} · outcomes {row.baseline.outcomes} · issues {row.baseline.issues} · issue rate {fmtPct(row.baseline.issue_rate)}
                    {row.baseline.priority_label ? ` · ${row.baseline.priority_label} priority` : ""}
                  </p>
                )}
                <BudgetBar budget={row.budget} costSui={row.cost_sui} />
                {(row.budget?.decision_basis ?? []).length > 0 && (
                  <div className="decision-basis">
                    <span className="muted small-text">Why this decision:</span>
                    <ul className="reasons">
                      {row.budget.decision_basis.map((item, index) => (
                        <li key={index}>
                          <TypeBadge tone={item.source === "walrus" ? "accent" : "category"}>{item.source}</TypeBadge>{" "}
                          {item.kind}
                          {item.capability_key ? ` · ${item.capability_key}` : ""}
                          {item.text_excerpt ? ` — "${item.text_excerpt}"` : ""}
                          {(item.blob_ids ?? []).map((blob) => <CopyChip key={blob} value={blob} note="from Walrus" />)}
                        </li>
                      ))}
                    </ul>
                    {row.budget?.decision_basis_note && <p className="muted small-text">{row.budget.decision_basis_note}</p>}
                  </div>
                )}
                {row.tx_digest && (
                  <p className="small-text">
                    Paid on Sui <CopyChip value={row.tx_digest} explorer={row.explorer_url ?? explorerTx(system?.data, row.tx_digest)} note="confirmed via Tatum" />
                  </p>
                )}
                <p className="muted small-text">
                  decided by {row.decided_by ?? "—"}{row.decision_note ? ` · note: ${row.decision_note}` : ""}
                  {row.decided_at ? ` · ${fmtWhen(row.decided_at)}` : ""}
                </p>
                {row.status === "executed" && <p className="muted small-text">payment executed {fmtWhen(row.executed_at)}</p>}
                {pending && demoEnabled && agentState?.data && (
                  <div className="demo-actions-row">
                    <button type="button" className="btn" disabled={Boolean(busyId)} onClick={() => run(row.id, "approve")}>
                      {busyId === `${row.id}:approve` ? "Approving…" : "Approve (demo manager)"}
                    </button>
                    <button type="button" className="btn ghost" disabled={Boolean(busyId)} onClick={() => run(row.id, "reject")}>
                      {busyId === `${row.id}:reject` ? "Rejecting…" : "Reject (demo manager)"}
                    </button>
                    <span className="muted small-text">Calls the public demo endpoints; the server enforces every guard.</span>
                  </div>
                )}
                {pending && !demoEnabled && <p className="muted small-text">Approvals are performed by the agent's manager.</p>}
                {result && <p className={`demo-result ${result.ok ? "ok" : "warn"}`}>{result.message}</p>}
              </div>
            );
          })
        )}
      </LoadState>
    </div>
  );
}

/* ---------------- Verdicts ---------------- */

const VERDICT_BADGES = { worth_it: ["worth it", "ok"], not_worth_it: ["not worth it", "warn"], inconclusive: ["inconclusive", "info"] };

function VerdictsTab({ agentId }) {
  const verdicts = usePoll(() => fetchVerdicts(agentId), {}, [agentId]);
  const rows = verdicts.data ?? [];
  return (
    <div className="tab-body">
      <LastUpdated state={verdicts} label="Verdicts" />
      <LoadState state={verdicts} what="verdicts">
        {rows.length === 0 ? (
          <div className="state-box"><p>No verdicts yet. A verdict is evaluated from events after an upgrade was unlocked.</p></div>
        ) : (
          rows.map((row) => {
            const [label, tone] = VERDICT_BADGES[row.verdict] ?? [row.verdict, "info"];
            const chart = [
              { phase: "before", rate: Math.round((row.baseline_rate ?? 0) * 1000) / 10 },
              { phase: "after", rate: Math.round((row.after_rate ?? 0) * 1000) / 10 },
            ];
            return (
              <div className="card" key={row.id}>
                <div className="review-head">
                  <h4>{row.capability}</h4>
                  <Pill tone={tone}>{label}</Pill>
                  <span className="muted small-text">
                    {row.baseline_outcomes} → {row.after_outcomes} outcomes · cost {row.cost_sui} · {fmtWhen(row.evaluated_at)}
                  </span>
                </div>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={chart} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="phase" tick={{ fill: "var(--muted)", fontSize: 11 }} />
                    <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fill: "var(--muted)", fontSize: 11 }} width={40} />
                    <Tooltip
                      cursor={{ fill: "var(--panel-2)" }}
                      contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", color: "var(--text)" }}
                      formatter={(value) => [`${value}% issue rate`, "issue rate"]}
                    />
                    <Bar dataKey="rate" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <p className="small-text">
                  before/after: {fmtPct(row.baseline_rate)} ({row.baseline_outcomes} outcomes) → {fmtPct(row.after_rate)} ({row.after_outcomes} outcomes) · change {(row.delta >= 0 ? "+" : "")}{Math.round(row.delta * 1000) / 10} points
                </p>
                {row.summary && <p className="muted small-text">{row.summary}</p>}
                <p className="muted small-text">
                  Rule: with at least 5 outcomes after the upgrade, a drop of 20 points or more is worth it, a drop of 5 points or less is not, anything else is inconclusive.
                </p>
              </div>
            );
          })
        )}
      </LoadState>
    </div>
  );
}

/* ---------------- Payroll ---------------- */

function PayrollTab({ agentId, system }) {
  const transactions = usePoll(() => fetchTransactions(agentId), {}, [agentId]);
  const rows = transactions.data ?? [];
  const executed = rows.filter((row) => row.status === "executed");
  const sumKind = (kind) => executed.filter((row) => row.kind === kind).reduce((total, row) => total + Number(row.amount_sui), 0);
  const received = sumKind("salary");
  const spent = sumKind("spend") + sumKind("topup");
  return (
    <div className="tab-body">
      <LastUpdated state={transactions} label="Transactions" />
      <div className="card summary-strip">
        <div><dt>salary received</dt><dd>{sui(received)}</dd></div>
        <div><dt>spent on upgrades</dt><dd>{sui(spent)}</dd></div>
        <div><dt>saved</dt><dd>{sui(Math.max(0, received - spent))}</dd></div>
      </div>
      <LoadState state={transactions} what="transactions">
        {rows.length === 0 ? (
          <div className="state-box"><p>No payroll transactions yet. Salary payments, upgrade spends and treasury top-ups land here.</p></div>
        ) : (
          <table className="component-table card">
            <thead>
              <tr><th>time</th><th>kind</th><th>amount</th><th>status</th><th>rule</th><th>digest</th><th>confirmed</th></tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  <td>{fmtWhen(row.confirmed_at ?? row.created_at)}</td>
                  <td><TypeBadge tone={row.kind === "salary" ? "ok" : row.kind === "spend" ? "accent" : "warn"}>{row.kind}</TypeBadge></td>
                  <td>{row.amount_sui}</td>
                  <td>{row.status}</td>
                  <td>{row.rule_result}{row.reason ? ` · ${row.reason}` : ""}</td>
                  <td><CopyChip value={row.digest} explorer={row.explorer_url ?? explorerTx(system?.data, row.digest)} /></td>
                  <td>{row.confirmed_at ? fmtWhen(row.confirmed_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </LoadState>
      <p className="muted small-text">Balances and confirmations are read through Tatum's Sui gRPC gateway.</p>
    </div>
  );
}

/* ---------------- Memory (lessons) ---------------- */

function MemoryTab({ agentId }) {
  const lessons = usePoll(() => fetchLessons(agentId), {}, [agentId]);
  const list = lessons.data?.lessons ?? [];
  return (
    <div className="tab-body">
      <p className="tab-note muted">These lessons were recalled from Walrus Memory and are used to decide what to propose next.</p>
      <LastUpdated state={lessons} label="Lessons" />
      <LoadState state={lessons} what="recalled lessons">
        {list.length === 0 && !lessons.data?.recall_ok && (
          <p className="muted small-text">Recall failed against the agent's Walrus namespace: {lessons.data?.recall_error ?? "unavailable"}.</p>
        )}
        {list.length === 0 ? (
          <div className="state-box"><p>No lessons recalled yet for this agent.</p></div>
        ) : (
          <table className="component-table card">
            <thead>
              <tr><th>kind</th><th>capability</th><th>verdict / category</th><th>detail</th><th>blob</th></tr>
            </thead>
            <tbody>
              {list.map((lesson, index) => (
                <tr key={index}>
                  <td><TypeBadge tone={lesson.kind === "upgrade_purchased" ? "accent" : "info"}>{lesson.kind}</TypeBadge></td>
                  <td>{lesson.capability_key ?? "—"}</td>
                  <td>{lesson.verdict ?? lesson.task_category ?? "—"}</td>
                  <td>{lesson.detail ?? "—"}</td>
                  <td><CopyChip value={lesson.blob_id} note="" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </LoadState>
    </div>
  );
}

/* ---------------- Agent page shell ---------------- */

const TABS = ["timeline", "reviews", "requests", "verdicts", "payroll", "memory", "score"];

export default function Agent({ system }) {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.includes(params.get("tab")) ? params.get("tab") : "timeline";
  const highlight = (params.get("highlight") ?? "").split(",").filter(Boolean);
  const agent = usePoll(() => fetchAgent(id), {}, [id]);
  const data = agent.data;
  const pass = data?.pass_status;
  const balance = data?.balance;
  const explorerWallet = explorerAccount(system?.data, data?.wallet_address);

  const switchTab = (name, extra = {}) => {
    setParams({ tab: name, ...extra }, { replace: false });
  };

  return (
    <section className="page-section">
      <Link to="/dashboard" className="back-link">← All agents</Link>
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
              <button type="button" className={`tab-btn ${tab === "timeline" ? "active" : ""}`} onClick={() => switchTab("timeline")} role="tab" aria-selected={tab === "timeline"}>
                Timeline
              </button>
              <button type="button" className={`tab-btn ${tab === "reviews" ? "active" : ""}`} onClick={() => switchTab("reviews")} role="tab" aria-selected={tab === "reviews"}>
                Reviews &amp; gaps
              </button>
              <button type="button" className={`tab-btn ${tab === "requests" ? "active" : ""}`} onClick={() => switchTab("requests")} role="tab" aria-selected={tab === "requests"}>
                Requests
              </button>
              <button type="button" className={`tab-btn ${tab === "verdicts" ? "active" : ""}`} onClick={() => switchTab("verdicts")} role="tab" aria-selected={tab === "verdicts"}>
                Verdicts
              </button>
              <button type="button" className={`tab-btn ${tab === "payroll" ? "active" : ""}`} onClick={() => switchTab("payroll")} role="tab" aria-selected={tab === "payroll"}>
                Payroll
              </button>
              <button type="button" className={`tab-btn ${tab === "memory" ? "active" : ""}`} onClick={() => switchTab("memory")} role="tab" aria-selected={tab === "memory"}>
                Memory
              </button>
              <button type="button" className={`tab-btn ${tab === "score" ? "active" : ""}`} onClick={() => switchTab("score")} role="tab" aria-selected={tab === "score"}>
                Score
              </button>
            </div>
            {tab === "timeline" && <TimelineTab agentId={id} system={system} highlightIds={highlight} />}
            {tab === "reviews" && (
              <ReviewsTab agentId={id} onJumpToEvent={(eventId) => { switchTab("timeline", { highlight: eventId }); }} />
            )}
            {tab === "requests" && <RequestsTab agentId={id} agentState={agent} system={system} />}
            {tab === "verdicts" && <VerdictsTab agentId={id} />}
            {tab === "payroll" && <PayrollTab agentId={id} system={system} />}
            {tab === "memory" && <MemoryTab agentId={id} />}
            {tab === "score" && <ScoreTab agentId={id} agentState={agent} />}
          </>
        )}
      </LoadState>
    </section>
  );
}
