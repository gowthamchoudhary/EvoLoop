import { fetchTatumActivity, usePoll, median, fmtWhen } from "../api.js";
import { TypeBadge, EmptyBox, LastUpdated } from "../components.jsx";

export default function Activity({ system }) {
  const activity = usePoll(() => fetchTatumActivity(100), {}, []);
  const rows = activity.data ?? [];
  const data = system?.data;
  const latencies = rows.map((row) => row.latency_ms);
  const success = rows.filter((row) => row.outcome === "success").length;
  const successRate = latencies.length ? Math.round((success / latencies.length) * 1000) / 10 : null;
  const medianLatency = median(latencies);
  const byMethod = {};
  for (const row of rows) byMethod[row.method] = (byMethod[row.method] ?? 0) + 1;
  const chart = Object.entries(byMethod)
    .sort((a, b) => b[1] - a[1])
    .map(([method, count]) => ({ method, short: method.split("/").at(-1), count }));
  const maxCount = chart[0]?.count ?? 1;

  return (
    <section className="page-section">
      <div className="section-head">
        <h2>Tatum activity</h2>
        <LastUpdated state={activity} label="Activity" />
      </div>
      <p className="muted small-text">
        How the EvoLoop server calls Tatum: the Sui gRPC gateway for balances, payment execution and confirmation, and the Data API for exchange rates. Every call is
        persisted server-side — this page is that log, nothing else.
      </p>

      <dl className="kpi-strip card" style={{ padding: 16 }}>
        <div className="kpi"><dt>total calls (persisted)</dt><dd className="num">{typeof data?.tatum?.calls_logged === "number" ? data.tatum.calls_logged : "…"}</dd></div>
        <div className="kpi"><dt>last 24 h</dt><dd className="num">{typeof data?.tatum?.calls_last_24h === "number" ? data.tatum.calls_last_24h : "…"}</dd></div>
        <div className="kpi"><dt>success rate (last 100)</dt><dd className="num">{successRate === null ? "—" : `${successRate}%`}</dd></div>
        <div className="kpi"><dt>median latency (last 100)</dt><dd className="num">{medianLatency === null ? "—" : `${medianLatency} ms`}</dd></div>
      </dl>

      {chart.length > 0 && (
        <div className="card">
          <h4>By method (last 100 calls)</h4>
          <ul className="method-bars">
            {chart.slice(0, 6).map((entry) => (
              <li key={entry.method}>
                <code className="small-text" title={entry.method}>{entry.short}</code>
                <span className="method-bar">
                  <span style={{ width: `${(entry.count / maxCount) * 100}%` }} />
                  <em className="num">{entry.count}</em>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(!activity.data && activity.loading) ? (
        <div>
          {[0, 1, 2].map((idx) => (
            <div className="skel skel-bar" key={idx} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyBox title="No calls recorded yet.">Activity appears as soon as the server balances or pays on Sui.</EmptyBox>
      ) : (
        <table className="row-table">
          <thead>
            <tr><th>time</th><th>method</th><th>transport</th><th>latency</th><th>outcome</th><th>retries</th></tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td className="muted num small-text">{fmtWhen(row.at)}</td>
                <td><code className="small-text" title={row.method}>{row.method.split("/").at(-1)}</code></td>
                <td><TypeBadge tone={row.transport === "grpc" ? "accent" : "info"}>{row.transport}</TypeBadge></td>
                <td className="num">{row.latency_ms} ms</td>
                <td><TypeBadge tone={row.outcome === "success" ? "ok" : "warn"}>{row.outcome}</TypeBadge></td>
                <td className="num">{row.retry_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
