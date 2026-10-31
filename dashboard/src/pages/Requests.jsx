import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchAgents, fetchRequests, fetchVerdicts, usePoll, sui, mistSui, fmtWhen, demoAction, explorerTx } from "../api.js";
import { Pill, Avatar, SegBar, CopyChip, EmptyBox, REQUEST_TONE } from "../components.jsx";
import { relTime } from "../workspace.js";

/* Kanban columns derived from REAL statuses. */
const COLUMNS = [
  { key: "proposed", mark: "c-proposed", label: "Proposed", statuses: ["needs_raise", "note_only"] },
  { key: "approval", mark: "c-approval", label: "Needs approval", statuses: ["pending_approval"] },
  { key: "approved", mark: "c-approved", label: "Approved / Paid", statuses: ["approved", "auto_approved"] },
  { key: "measuring", mark: "c-measuring", label: "Measuring", statuses: [] }, // executed without verdict
  { key: "verdict", mark: "c-verdict", label: "Verdict", statuses: [] }, // executed with verdict
  { key: "rejected", mark: "c-rejected", label: "Rejected", statuses: ["rejected"] },
];

/* Board card */
function Card({ entry, onOpen }) {
  const { request, agentName } = entry;
  const priority = request?.baseline?.priority_label ?? null;
  const prioClass = priority === "high" ? "prio-high" : priority === "medium" ? "prio-medium" : "prio-low";
  const [label, tone] = REQUEST_TONE[request.status] ?? [request.status, "info"];
  const cap = Number(request.budget?.improvement_cap_mist ?? 0);
  const cost = Number(request.budget?.cost_mist ?? 0);
  return (
    <button type="button" className="board-card" onClick={() => onOpen(entry)}>
      <div className="board-card-chips">
        <span className={`chip priority-chip ${prioClass}`}>
          {priority ? `${priority} prio` : "no priority"}
        </span>
        <span className="chip">{request.capability}</span>
      </div>
      <span className="board-card-title">Unlock {request.capability}</span>
      <span className="muted small-text">
        <Avatar name={agentName ?? "agent"} /> {agentName ?? "agent"} · {request.cost_sui}
      </span>
      {cap > 0 && (
        <SegBar
          segments={[{ pct: Math.min(100, (cost / cap) * 100), tone: request.status === "executed" ? "done" : "cost", title: `cost ${mistSui(cost)} of improvement cap ${mistSui(cap)}` }]}
          label={`${sui(cost / 1e9)} / ${sui(cap / 1e9)}`}
        />
      )}
      <div className="board-card-foot">
        <Pill tone={tone}>{label}</Pill>
        <span className="board-card-when">{relTime(request.created_at)}</span>
      </div>
    </button>
  );
}

/* Board view */
function Board({ entries, agentsById, onOpen }) {
  const columns = useMemo(
    () =>
      COLUMNS.map((col) => ({
        ...col,
        items: entries.filter((entry) => {
          const r = entry.request;
          if (col.statuses.length) return col.statuses.includes(r.status);
          if (col.key === "measuring") return r.status === "executed" && !entry.verdict;
          if (col.key === "verdict") return r.status === "executed" && Boolean(entry.verdict);
          return false;
        }),
      })),
    [entries]
  );
  return (
    <div className="board">
      {columns.map((col) => (
        <div className={`board-col ${col.mark}`} key={col.key}>
          <div className="board-col-head">
            <span className="board-col-mark" aria-hidden="true" />
            {col.label}
            <span className="board-col-count">{col.items.length}</span>
          </div>
          {col.items.map((entry) => (
            <Card key={entry.request.id} entry={entry} onOpen={onOpen} />
          ))}
          {col.items.length === 0 && <p className="muted small-text">empty</p>}
        </div>
      ))}
    </div>
  );
}

/* List view */
function List({ entries, onOpen }) {
  return (
    <table className="row-table">
      <thead>
        <tr><th>agent</th><th>capability</th><th>priority</th><th>cost</th><th>status</th><th>created</th><th /></tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const [label, tone] = REQUEST_TONE[entry.request.status] ?? [entry.request.status, "info"];
          return (
            <tr key={entry.request.id}>
              <td><Pill tone="default">{entry.agentName ?? "agent"}</Pill></td>
              <td>{entry.request.capability}</td>
              <td><span className={`chip priority-chip ${entry.request?.baseline?.priority_label === "high" ? "prio-high" : entry.request?.baseline?.priority_label === "medium" ? "prio-medium" : "prio-low"}`}>
                {entry.request?.baseline?.priority_label ?? "—"}
              </span></td>
              <td>{entry.request.cost_sui}</td>
              <td><Pill tone={tone}>{label}</Pill></td>
              <td className="muted small-text">{relTime(entry.request.created_at)}</td>
              <td><button type="button" className="btn ghost small" onClick={() => onOpen(entry)}>Open</button></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* Timeline view */
function Timeline({ entries }) {
  const sorted = [...entries].sort((a, b) => String(b.request.created_at).localeCompare(String(a.request.created_at)));
  return (
    <ul className="tl-list">
      {sorted.map((entry) => {
        const [label, tone] = REQUEST_TONE[entry.request.status] ?? [entry.request.status, "info"];
        return (
          <li className="tl-row memory" key={entry.request.id}>
            <span className="tl-time">{fmtWhen(entry.request.created_at)}</span>
            <span className="tl-badges"><Pill tone={tone}>{label}</Pill><span className="chip">{entry.agentName ?? "agent"}</span></span>
            <span className="tl-body">
              <span className="tl-summary">Unlock {entry.request.capability} for {entry.request.cost_sui}</span>
              {entry.request.tx_digest && <span className="muted small-text">paid digest {entry.request.tx_digest.slice(0, 10)}…</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* Table view = dense re-use of List */
function Table({ entries, onOpen }) {
  return <List entries={entries} onOpen={onOpen} />;
}

/* Right-side drawer: full detail of one request */
function Drawer({ entry, system, onClose }) {
  const { request, agentName, verdict } = entry;
  const demoEnabled = system?.data?.demo_actions_enabled === true;
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);

  const pending = ["pending_approval", "needs_raise"].includes(request.status);
  const canAct = pending && demoEnabled; // agent_actionable is enforced server-side; its 403 message is surfaced verbatim

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (action) => {
    setBusy(action);
    const outcome = await demoAction(request.id, action);
    setBusy(null);
    setResult(outcome.ok ? { ok: true, message: `Decision recorded: ${action === "approve" ? "approved" : "rejected"} by demo-manager. Only the decision was recorded — no payment ran from this button.` } : { ok: false, message: `Not allowed (HTTP ${outcome.statusCode}): ${outcome.error}` });
  };

  const budget = request.budget;
  return (
    <div className="drawer-root" role="dialog" aria-modal="true" aria-label="Request detail">
      <button type="button" className="drawer-scrim" onClick={onClose} aria-label="close drawer" />
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <span className="muted small-text">{agentName} · {relTime(request.created_at)}</span>
            <h3>Unlock {request.capability}</h3>
          </div>
          <button type="button" className="icon-btn drawer-close" onClick={onClose} aria-label="close">✕</button>
        </div>

        <div className="drawer-section">
          <span className="drawer-section-title">Why (evidence)</span>
          <p className="small-text">{request.expected_benefit ?? "—"}</p>
          {request.baseline && (
            <span className="muted small-text">
              {request.baseline.task_category} · {request.baseline.outcomes} outcomes · {request.baseline.issues} issues · issue rate{" "}
              {Math.round(Number(request.baseline.issue_rate ?? 0) * 1000) / 10}% · {request.baseline.priority_label ?? "—"} priority
            </span>
          )}
        </div>

        <div className="drawer-section">
          <span className="drawer-section-title">Budget math</span>
          {budget ? (
            <>
              <BudgetBar budget={budget} cost={request.cost_sui} />
            </>
          ) : (
            <p className="muted small-text">No budget plan attached.</p>
          )}
        </div>

        <div className="drawer-section">
          <span className="drawer-section-title">Decision basis (Walrus)</span>
          {(budget?.decision_basis ?? []).length ? (
            <ul className="basis-list">
              {budget.decision_basis.map((item, index) => (
                <li key={index}>
                  <Pill tone={item.source === "walrus" ? "accent" : "info"}>{item.source}</Pill>
                  <span>{item.kind}{item.capability_key ? ` · ${item.capability_key}` : ""}</span>
                  <span className="muted">{item.text_excerpt ? `“${item.text_excerpt}”` : ""}</span>
                  {(item.blob_ids ?? []).map((blob) => (
                    <CopyChip key={blob} value={blob} note="from Walrus" />
                  ))}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small-text">No decision basis recorded.</p>
          )}
          {budget?.decision_basis_note && <p className="muted small-text">{budget.decision_basis_note}</p>}
        </div>

        <div className="drawer-section">
          <span className="drawer-section-title">Decision + payment</span>
          <p className="small-text">
            decided by {request.decided_by ?? "—"}
            {request.decision_note ? ` · ${request.decision_note}` : ""}
          </p>
          {request.tx_digest && (
            <p>
              <span className="muted small-text">Sui payment:</span>{" "}
              <CopyChip value={request.tx_digest} explorer={request.explorer_url ?? (system?.data ? explorerTx(system.data, request.tx_digest) : null)} note="confirmed via Tatum" />
            </p>
          )}
          {verdict && (
            <p className="small-text">
              Verdict <Pill tone={verdict.verdict === "worth_it" ? "ok" : verdict.verdict === "not_worth_it" ? "warn" : "info"}>{verdict.verdict}</Pill>{" "}
              <span className="muted num">
                {verdict.task_category}: {Math.round(Number(verdict.baseline_rate ?? 0) * 1000) / 10}% → {Math.round(Number(verdict.after_rate ?? 0) * 1000) / 10}%
              </span>
            </p>
          )}
        </div>

        {canAct ? (
          <div className="demo-actions-row">
            <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => run("approve")}>
              {busy === "approve" ? "Approving…" : "Approve (demo manager)"}
            </button>
            <button type="button" className="btn ghost" disabled={Boolean(busy)} onClick={() => run("reject")}>
              {busy === "reject" ? "Rejecting…" : "Reject (demo manager)"}
            </button>
            <span className="muted small-text">The server enforces every guard (agent actionable, testnet, hourly caps).</span>
          </div>
        ) : (
          <p className="muted small-text">Decided by the agent's manager.{pending && !demoEnabled ? " (Demo actions are disabled on this server.)" : ""}</p>
        )}
        {result && <p className={`demo-result ${result.ok ? "ok" : "warn"}`}>{result.message}</p>}
      </div>
    </div>
  );
}

function BudgetBar({ budget, cost }) {
  const cap = Number(budget.improvement_cap_mist ?? 0);
  const spent = Number(budget.improvement_spent_mist ?? 0);
  const pct = (value) => (cap > 0 ? Math.min(100, (value / cap) * 100) : 0);
  return (
    <div className="budget-bar-wrap">
      <div className="segbar">
        <div className="segbar-track">
          <span className="segbar-seg spent" style={{ width: `${pct(spent)}%` }} title={`spent ${mistSui(spent)}`} />
          <span className="segbar-seg cost" style={{ width: `${cost ? Math.min(100, Number(budget.cost_mist ?? 0) / cap * 100) : 0}%` }} title={`this request ${cost}`} />
        </div>
        <span className="segbar-label">
          <strong>{cost}</strong> / {mistSui(cap)}
        </span>
      </div>
      <span className="muted small-text">
        allowance {mistSui(budget.allowance_mist)} · improvement cap {mistSui(cap)} · spent {mistSui(spent)}
        {budget.within_budget === false ? ` · shortfall ${mistSui(budget.shortfall_mist)}` : ""}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function Requests({ system }) {
  const agents = usePoll(fetchAgents);
  const agentsData = agents.data ?? [];
  const ids = agentsData.map((agent) => agent.id).sort().join("|");

  const batch = usePoll(
    async () => {
      const idList = ids.split("|");
      const results = await Promise.all(idList.map((id) => Promise.all([fetchRequests(id), fetchVerdicts(id)])));
      return { ok: true, data: results.map((pair, i) => ({ id: idList[i], requests: pair[0], verdicts: pair[1] })) };
    },
    { enabled: Boolean(ids) },
    [ids]
  );

  const [view, setView] = useState("board");
  const [open, setOpen] = useState(null);

  const entries = useMemo(() => {
    const agentsById = new Map(agentsData.map((agent) => [agent.id, agent]));
    return (batch.data ?? []).flatMap((entry) => {
      const verdicts = entry.verdicts.ok ? entry.verdicts.data : [];
      const verdictByRequest = new Map(verdicts.map((verdict) => [verdict.request_id, verdict]));
      return (entry.requests.ok ? entry.requests.data : []).map((request) => ({
        request,
        agentId: entry.id,
        agentName: agentsById.get(entry.id)?.name ?? null,
        verdict: verdictByRequest.get(String(request.id)) ?? null,
      }));
    });
  }, [batch.data, agentsData]);

  const pendingCount = entries.filter((entry) => ["pending_approval", "needs_raise"].includes(entry.request.status)).length;

  return (
    <section className="page-section">
      <div className="section-head">
        <h2>Upgrade requests</h2>
        <span className="muted small-text">{entries.length} request{entries.length === 1 ? "" : "s"} · {pendingCount} pending</span>
      </div>

      <div className="view-tabs" role="tablist" aria-label="View">
        {["board", "list", "timeline", "table"].map((name) => (
          <button key={name} type="button" role="tab" aria-selected={view === name} className={`view-tab ${view === name ? "active" : ""}`} onClick={() => setView(name)}>
            {name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>

      {(!batch.data && batch.loading) || (!agents.data && agents.loading) ? (
        <div className="board">
          {[0, 1, 2, 3].map((idx) => (
            <div className="skel skel-block" key={idx} />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyBox
          title="No upgrade requests yet."
          action={<Link to="/app/agents" className="btn ghost">Look at the agents</Link>}
        >
          Requests appear when a passed review gap is turned into a priced proposal.
        </EmptyBox>
      ) : view === "board" ? (
        <Board entries={entries} onOpen={setOpen} />
      ) : view === "list" ? (
        <List entries={entries} onOpen={setOpen} />
      ) : view === "timeline" ? (
        <Timeline entries={entries} />
      ) : (
        <Table entries={entries} onOpen={setOpen} />
      )}

      {open && <Drawer entry={open} system={system} onClose={() => setOpen(null)} />}
    </section>
  );
}
