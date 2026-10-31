import { Link } from "react-router-dom";
import { fetchAgents, fetchLessons, usePoll, fmtWhen } from "../api.js";
import { TypeBadge, CopyChip, EmptyBox } from "../components.jsx";

export default function Memory({ system }) {
  const agents = usePoll(fetchAgents);
  const agentsData = agents.data ?? [];
  const ids = agentsData.map((agent) => agent.id).sort().join("|");
  const agentsById = new Map(agentsData.map((agent) => [agent.id, agent]));

  const batch = usePoll(
    async () => {
      const idList = ids.split("|");
      const results = await Promise.all(idList.map((id) => fetchLessons(id)));
      return { ok: true, data: results.map((result, i) => ({ id: idList[i], rows: result.ok ? result.data : [] })) };
    },
    { enabled: Boolean(ids) },
    [ids]
  );

  const rows = (batch.data ?? []).flatMap((entry) => entry.rows.map((row) => ({ ...row, agent: agentsById.get(entry.id)?.name ?? entry.id })))
    .sort((a, b) => String(b.recalled_at ?? "").localeCompare(String(a.recalled_at ?? "")));

  const walrus = system?.data?.walrus;
  const stats = [
    { label: "memories stored", value: typeof walrus?.total?.memories_stored === "number" ? walrus.total.memories_stored : "…" },
    { label: "pending write", value: typeof walrus?.total?.memories_pending === "number" ? walrus.total.memories_pending : "…" },
    { label: "failed write", value: typeof walrus?.total?.memories_failed === "number" ? walrus.total.memories_failed : "…" },
    { label: "namespace prefix", value: walrus?.namespace_prefix ?? "…" },
  ];

  return (
    <section className="page-section">
      <div className="section-head">
        <h2>Memory</h2>
        <span className="muted small-text">recalled lessons and raw storage counters; namespace {walrus?.namespace_prefix ? <code>{walrus.namespace_prefix}…</code> : "…"}</span>
      </div>

      <dl className="kpi-strip card" style={{ padding: 16 }}>
        {stats.map((stat) => (
          <div className="kpi" key={stat.label}>
            <dt>{stat.label}</dt>
            <dd className="num">{stat.value}</dd>
          </div>
        ))}
      </dl>

      {(!batch.data && batch.loading) || (!agents.data && agents.loading) ? (
        <div>
          {[0, 1, 2, 3].map((idx) => (
            <div className="skel skel-bar" key={idx} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyBox title="No lessons recalled yet.">
          Lessons appear here after upgrades are bought, rejected or measured on a published agent. <Link to="/" className="small-text">Read why Walrus is the loop's memory →</Link>
        </EmptyBox>
      ) : (
        <table className="row-table">
          <thead>
            <tr><th>agent</th><th>kind</th><th>capability</th><th>verdict / category</th><th>detail</th><th>recall time</th><th>blob</th></tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td>{row.agent}</td>
                <td><TypeBadge tone={row.kind === "upgrade_purchased" ? "accent" : "info"}>{row.kind}</TypeBadge></td>
                <td>{row.capability ?? "—"}</td>
                <td>{row.verdict ?? row.task_category ?? "—"}</td>
                <td className="small-text">{row.detail ?? "—"}</td>
                <td className="muted small-text num">{fmtWhen(row.recalled_at)}</td>
                <td><CopyChip value={row.blob_id} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
