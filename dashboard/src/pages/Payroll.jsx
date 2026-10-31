import { fetchAgents, fetchTransactions, usePoll, sui, fmtWhen, explorerTx } from "../api.js";
import { Pill, TypeBadge, CopyChip, EmptyBox } from "../components.jsx";

export default function Payroll({ system }) {
  const agents = usePoll(fetchAgents);
  const agentsData = agents.data ?? [];
  const ids = agentsData.map((agent) => agent.id).sort().join("|");
  const agentsById = new Map(agentsData.map((agent) => [agent.id, agent]));

  const batch = usePoll(
    async () => {
      const idList = ids.split("|");
      const results = await Promise.all(idList.map((id) => fetchTransactions(id)));
      return { ok: true, data: results.map((result, i) => ({ id: idList[i], rows: result.ok ? result.data : [] })) };
    },
    { enabled: Boolean(ids) },
    [ids]
  );

  const rows = (batch.data ?? []).flatMap((entry) => entry.rows.map((row) => ({ ...row, agent: agentsById.get(entry.id)?.name ?? entry.id })))
    .sort((a, b) => String(b.confirmed_at ?? "").localeCompare(String(a.confirmed_at ?? "")));

  const sumKind = (kind) => rows.filter((row) => row.status === "executed" && row.kind === kind).reduce((sum, row) => sum + Number(row.amount_sui ?? 0), 0);
  const paid = sumKind("salary");
  const spent = sumKind("spend") + sumKind("topup");

  return (
    <section className="page-section">
      <div className="section-head">
        <h2>Payroll</h2>
        <span className="muted small-text">every salary, spend and top-up across the published agents</span>
      </div>

      <dl className="kpi-strip card" style={{ padding: 16 }}>
        <div className="kpi"><dt>salary paid (executed)</dt><dd>{batch.ready ? paid.toFixed(3) : "…"} <sub>SUI</sub></dd></div>
        <div className="kpi"><dt>spent on upgrades</dt><dd>{batch.ready ? spent.toFixed(3) : "…"} <sub>SUI</sub></dd></div>
        <div className="kpi"><dt>transactions</dt><dd>{batch.ready ? rows.length : "…"} <sub>all statuses</sub></dd></div>
      </dl>

      {(!batch.data && batch.loading) || (!agents.data && agents.loading) ? (
        <div>
          {[0, 1, 2, 3].map((idx) => (
            <div className="skel skel-bar" key={idx} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyBox title="No payroll transactions yet.">Salary payments, upgrade spends and treasury top-ups land here as they execute.</EmptyBox>
      ) : (
        <table className="row-table">
          <thead>
            <tr><th>agent</th><th>time</th><th>kind</th><th>amount</th><th>status</th><th>rule</th><th>digest</th></tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td><Pill tone="default">{row.agent}</Pill></td>
                <td className="muted num small-text">{fmtWhen(row.confirmed_at ?? row.created_at)}</td>
                <td><TypeBadge tone={row.kind === "salary" ? "ok" : row.kind === "spend" ? "accent" : "warn"}>{row.kind}</TypeBadge></td>
                <td className="num">{row.amount_sui}</td>
                <td>{row.status}</td>
                <td className="muted small-text">{row.rule_result}{row.reason ? ` · ${row.reason}` : ""}</td>
                <td><CopyChip value={row.digest} explorer={row.explorer_url ?? (system?.data ? explorerTx(system.data, row.digest) : null)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
