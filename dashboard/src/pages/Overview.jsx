import { Link } from "react-router-dom";
import { fetchAgents, fetchTransactions, usePoll, sui, autonomyLabel, periodLabel, short, explorerAccount, explorerTx, mistSui } from "../api.js";
import { Gauge, Pill, Avatar, SegBar, EmptyBox } from "../components.jsx";
import { REQUEST_TONE } from "../components.jsx";

export function useKpis() {
  const agents = usePoll(fetchAgents);
  const agentsData = agents.data ?? [];
  const ids = agentsData.map((agent) => agent.id).sort().join("|");

  const tx = usePoll(
    async () => {
      const idList = ids.split("|");
      const results = await Promise.all(idList.map((id) => fetchTransactions(id)));
      if (results.some((r) => !r.ok)) return { ok: false, statusCode: 500, error: "transactions unavailable" };
      return { ok: true, data: results.map((r, i) => ({ id: idList[i], rows: r.data })) };
    },
    { enabled: Boolean(ids) },
    [ids]
  );

  const totals = {
    agents: agentsData.length,
    allowance: agentsData.reduce((sum, agent) => sum + Number(agent.allowance_sui ?? 0), 0),
    spent: (tx.data ?? []).reduce((sum, entry) => sum + entry.rows.filter((row) => row.kind === "spend" && row.status === "executed").reduce((s, row) => s + Number(row.amount_sui ?? 0), 0), 0),
    memories: null, // filled by caller from system
    avgScore: (() => {
      const scored = agentsData.filter((agent) => Number.isFinite(Number(agent.latest_score?.score)));
      if (!scored.length) return null;
      return scored.reduce((sum, agent) => sum + Number(agent.latest_score.score), 0) / scored.length;
    })(),
  };
  return { agents, agentsData, tx, totals };
}

/* ------------------------------------------------------------------ */

function AgentCard({ agent, system }) {
  const score = agent.latest_score ?? null;
  const balance = agent.balance;
  const explorer = explorerAccount(system?.data, agent.wallet_address);
  return (
    <Link to={`/agent/${agent.id}`} className="agent-card">
      <div className="agent-card-head">
        <div className="agent-card-title">
          <Avatar name={agent.name} large />
          <h3>{agent.name}</h3>
          <Pill tone="default">{agent.kind}</Pill>
        </div>
        <Gauge value={score?.score} status={score?.status} />
      </div>
      {agent.description && <p className="agent-card-desc">{agent.description}</p>}
      <dl className="card-stats">
        <div><dt>balance</dt><dd>{sui(balance?.total)}</dd></div>
        <div><dt>allowance / {periodLabel(agent.period)}</dt><dd>{sui(agent.allowance_sui)}</dd></div>
        <div><dt>autonomy</dt><dd>{autonomyLabel(agent.autonomy)}</dd></div>
      </dl>
      <div className="chips">
        {(agent.capabilities ?? []).map((cap) => (
          <span className="chip cap" key={cap.capability_key} title={`unlock cost ${sui(cap.price_sui)} · since ${(cap.unlocked_at ?? "").slice(0, 10)}`}>
            {cap.capability_key}
          </span>
        ))}
        {(agent.capabilities ?? []).length === 0 && <span className="chip muted">no capabilities unlocked</span>}
      </div>
      <div className="card-foot">
        {agent.pending_request_count > 0 ? (
          <Pill tone="warn" title="Upgrade requests waiting for a decision">
            {agent.pending_request_count} pending upgrade{agent.pending_request_count > 1 ? "s" : ""}
          </Pill>
        ) : (
          <Pill tone="default">no pending upgrades</Pill>
        )}
        {agent.wallet_address && <code className="muted" title={agent.wallet_address}>{short(agent.wallet_address)}</code>}
        {agent.wallet_address && explorer && (
          <a className="icon-btn" href={explorer} target="_blank" rel="noreferrer" aria-label="open wallet in explorer" onClick={(e) => e.stopPropagation()}>
            ↗
          </a>
        )}
      </div>
    </Link>
  );
}

/* upgrade board preview: pending-request cards across agents, compact */
function PreviewCard({ request, agentName, system }) {
  const cap = Number(request.budget?.improvement_cap_mist ?? 0);
  const cost = Number(request.budget?.cost_mist ?? 0);
  const [label, tone] = REQUEST_TONE[request.status] ?? [request.status, "info"];
  return (
    <Link to="/app/requests" className="board-card" style={{ cursor: "pointer" }}>
      <div className="board-card-chips">
        <span className={`chip priority-chip ${(request?.baseline?.priority_label ?? "low") === "high" ? "prio-high" : (request?.baseline?.priority_label ?? "") === "medium" ? "prio-medium" : "prio-low"}`}>
          {request?.baseline?.priority_label ?? "—"}
        </span>
        <span className="chip">{agentName ?? "agent"}</span>
      </div>
      <span className="board-card-title">Unlock {request.capability}</span>
      {cap > 0 && (
        <SegBar
          segments={[{ pct: Math.min(100, (cost / cap) * 100), tone: request.status === "executed" ? "done" : "cost", title: `cost ${mistSui(cost)} of cap ${mistSui(cap)}` }]}
          label={`${sui(Number(cost) / 1e9)} / ${sui(Number(cap) / 1e9)}`}
        />
      )}
      <div className="board-card-foot">
        <Pill tone={tone}>{label}</Pill>
        {request.tx_digest && system?.data && (
          <a className="icon-btn" href={explorerTx(system.data, request.tx_digest)} target="_blank" rel="noreferrer" aria-label="open payment in explorer" onClick={(e) => e.stopPropagation()}>
            ↗
          </a>
        )}
      </div>
    </Link>
  );
}

export default function Overview({ system }) {
  const { agents, agentsData, tx, totals } = useKpis();
  const memoStored = system?.data?.walrus?.total?.memories_stored ?? null;
  const agentsById = new Map(agentsData.map((agent) => [agent.id, agent]));

  // Preview uses pending statuses straight from the agents list (pending_request_count) if tx-based preview is empty
  const kpis = [
    { label: "agents", value: agents.ready ? (totals.agents || "0") : "…", sub: "published" },
    { label: "total allowance", value: agents.ready ? `≈ ${totals.allowance.toFixed(3)}` : "…", sub: "SUI / period" },
    { label: "spent on upgrades", value: tx.ready ? totals.spent.toFixed(3) : "…", sub: "SUI, executed" },
    { label: "memories stored", value: typeof memoStored === "number" ? memoStored : "…", sub: "Walrus, all agents" },
    { label: "latest avg score", value: totals.avgScore !== null ? String(Math.round(totals.avgScore * 10) / 10) : "—", sub: "of scored agents" },
  ];

  return (
    <section className="page-section">
      <div className="section-head">
        <h2>Workspace overview</h2>
      </div>

      <dl className="kpi-strip">
        {kpis.map((kpi) => (
          <div className="kpi" key={kpi.label}>
            <dt>{kpi.label}</dt>
            <dd>{kpi.value} <sub>{kpi.sub}</sub></dd>
          </div>
        ))}
      </dl>

      <div className="section-head">
        <h3>Agents</h3>
      </div>
      {agents.ready && agentsData.length === 0 ? (
        <EmptyBox
          title="No published agents yet."
          action={<Link to="/" className="btn ghost">Read how it works</Link>}
        >
          Agents appear here only after an admin publishes them. The landing page explains the loop meanwhile.
        </EmptyBox>
      ) : (
        <div className="agent-grid">
          {agentsData.map((agent) => (
            <AgentCard key={agent.id} agent={agent} system={system} />
          ))}
        </div>
      )}

      <div className="section-head">
        <h3>Upgrade board preview</h3>
        <Link to="/app/requests" className="small-text muted" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>
          Open the full inbox →
        </Link>
      </div>
      {tx.ready ? (
        tx.data.length === 0 ? (
          <EmptyBox title="No requests yet.">When a review gap turns into a priced upgrade request, its card lands here.</EmptyBox>
        ) : (
          <div className="board" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
            {tx.data
              .flatMap((entry) => entry.rows.filter((row) => row.status === "pending_approval").map((row) => ({ row, agent: agentsById.get(entry.id)?.name ?? "agent" })))
              .slice(0, 4)
              .map((card, index) => (
                <PreviewCard key={index} request={card.row} agentName={card.agent} system={system} />
              ))}
            {tx.data.flatMap((entry) => entry.rows.filter((row) => row.status === "pending_approval")).length === 0 && (
              <EmptyBox title="Nothing waiting for approval.">Requests that are pending approval will appear as cards here.</EmptyBox>
            )}
          </div>
        )
      ) : (
        <div className="board">
          {[0, 1, 2].map((idx) => (
            <div className="skel skel-block" key={idx} />
          ))}
        </div>
      )}
    </section>
  );
}
