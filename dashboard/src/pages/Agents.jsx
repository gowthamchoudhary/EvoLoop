import { Link } from "react-router-dom";
import { fetchAgents, fetchScores, usePoll, sui, explorerAccount, short } from "../api.js";
import { Pill, Avatar, Sparkline, EmptyBox } from "../components.jsx";

function Row({ agent, scoresFor, system }) {
  const points = (scoresFor ?? []).slice(0, 12).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const latest = points[points.length - 1] ?? null;
  return (
    <tr>
      <td>
        <Link to={`/agent/${agent.id}`} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Avatar name={agent.name} />
          <strong>{agent.name}</strong>
        </Link>
        <span className="muted small-text" style={{ display: "block" }}>{agent.kind}</span>
      </td>
      <td><Pill tone={agent.status === "active" ? "ok" : "info"}>{agent.status}</Pill></td>
      <td>
        {latest?.status === "insufficient_data" ? (
          <span className="muted small-text">not enough data</span>
        ) : points.length ? (
          <Sparkline points={points.map((row) => row.score)} />
        ) : (
          <span className="muted small-text">no scores yet</span>
        )}
        {latest?.status === "scored" && <span className="num muted small-text" style={{ display: "block" }}>{latest.score}/100</span>}
      </td>
      <td className="num">{sui(agent.balance?.total)}</td>
      <td className="num">{sui(agent.allowance_sui)}</td>
      <td>
        <div className="chips">
          {(agent.capabilities ?? []).map((cap) => (
            <span className="chip cap" key={cap.capability_key}>{cap.capability_key}</span>
          ))}
          {(agent.capabilities ?? []).length === 0 && <span className="chip muted">none unlocked</span>}
        </div>
      </td>
      <td className="muted small-text num">—</td>
      <td>
        {agent.wallet_address && system?.data?.explorer && (
          <a className="icon-btn" href={`${system.data.explorer.account}${encodeURIComponent(agent.wallet_address)}`} target="_blank" rel="noreferrer" aria-label="open wallet in explorer">
            <code title={agent.wallet_address}>{short(agent.wallet_address)}</code>
          </a>
        )}
      </td>
    </tr>
  );
}

export default function AgentsList({ system }) {
  const agents = usePoll(fetchAgents);
  const agentsData = agents.data ?? [];
  const ids = agentsData.map((agent) => agent.id).sort().join("|");

  const scores = usePoll(
    async () => {
      const idList = ids.split("|");
      const results = await Promise.all(idList.map((id) => fetchScores(id)));
      return { ok: true, data: results.map((result, i) => ({ id: idList[i], rows: result.ok ? result.data : [] })) };
    },
    { enabled: Boolean(ids) },
    [ids]
  );

  const scoresById = new Map((scores.data ?? []).map((entry) => [entry.id, entry.rows]));
  return (
    <section className="page-section">
      <div className="section-head">
        <h2>Agents</h2>
        <span className="muted small-text">{agents.ready ? `${agentsData.length} published` : "…"}</span>
      </div>
      <AgentsListLoaded agents={agents} agentsData={agentsData} scoresById={scoresById} system={system} />
      <PeriodPicker />
    </section>
  );
}

function PeriodPicker() {
  return (
    <p className="muted small-text">
      Score sparklines are drawn from real score snapshots only — no smoothing, no invented points.
    </p>
  );
}

function AgentsListLoaded({ agents, agentsData, scoresById, system }) {
  if (agents.loading) {
    return (
      <div>
        {[0, 1, 2].map((idx) => (
          <div className="skel skel-bar" key={idx} />
        ))}
      </div>
    );
  }
  if (agentsData.length === 0) {
    return (
      <EmptyBox
        title="No published agents yet."
        action={<Link to="/" className="btn ghost">Read how it works</Link>}
      >
        Published agents appear as rows here with their real score history.
      </EmptyBox>
    );
  }
  return (
    <table className="row-table">
      <thead>
        <tr><th>agent</th><th>status</th><th>score</th><th>balance</th><th>allowance</th><th>capabilities</th><th>last event</th><th>wallet</th></tr>
      </thead>
      <tbody>
        {agentsData.map((agent) => (
          <Row key={agent.id} agent={agent} scoresFor={scoresById.get(agent.id) ?? null} system={system} />
        ))}
      </tbody>
    </table>
  );
}
