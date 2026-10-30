import { Link } from "react-router-dom";
import { fetchAgents, usePoll, sui, autonomyLabel, periodLabel, short, explorerAccount } from "../api.js";
import { Gauge, LoadState, LastUpdated, Pill } from "../components.jsx";

function AgentCard({ agent, system }) {
  const score = agent.latest_score ?? null;
  const balance = agent.balance;
  const balanceTooltip = balance
    ? `total ${sui(balance.total)} = coin objects ${sui(balance.coin_objects)} + address ${sui(balance.address_balance)}`
    : "balance unavailable";
  const explorer = explorerAccount(system?.data, agent.wallet_address);
  return (
    <Link to={`/agent/${agent.id}`} className="card agent-card">
      <div className="agent-card-head">
        <div className="agent-card-title">
          <h3>{agent.name}</h3>
          <Pill tone="default">{agent.kind}</Pill>
        </div>
        <Gauge value={score?.score} status={score?.status} />
      </div>
      {agent.description && <p className="agent-card-desc">{agent.description}</p>}
      <dl className="card-stats">
        <div>
          <dt>balance</dt>
          <dd title={balanceTooltip}>{sui(balance?.total)}</dd>
        </div>
        <div>
          <dt>allowance / {periodLabel(agent.period)}</dt>
          <dd>{sui(agent.allowance_sui)}</dd>
        </div>
        <div>
          <dt>autonomy</dt>
          <dd>{autonomyLabel(agent.autonomy)}</dd>
        </div>
      </dl>
      <div className="chips">
        {(agent.capabilities ?? []).map((cap) => (
          <span className="chip cap" key={cap.capability_key} title={`unlock cost ${sui(cap.price_sui)} · since ${cap.unlocked_at?.slice(0, 10)}`}>
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

export default function Overview({ system }) {
  const agents = usePoll(fetchAgents);
  const rows = agents.data ?? [];
  return (
    <section className="page-section">
      <div className="section-head">
        <h2>Published agents</h2>
        <LastUpdated state={agents} label="Agent list" />
      </div>
      <LoadState state={agents} what="the agent list">
        {rows.length === 0 ? (
          <div className="state-box">
            <p>
              No public agents yet. Agents appear here only after an admin publishes them (demo actions pipeline or the visibility API), so this page is intentionally
              quiet until then. The landing page explains the loop meanwhile.
            </p>
            <Link to="/" className="btn ghost">← Read how it works</Link>
            <LastUpdated state={agents} label="Agent list" />
          </div>
        ) : (
          <div className="agent-grid">
            {rows.map((agent) => (
              <AgentCard key={agent.id} agent={agent} system={system} />
            ))}
          </div>
        )}
      </LoadState>
    </section>
  );
}
