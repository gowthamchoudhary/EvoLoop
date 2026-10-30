import { fetchSystem, fetchTatumActivity, usePoll, median, fmtWhen } from "../api.js";
import { LoadState, LastUpdated, TypeBadge } from "../components.jsx";

function TatumPage() {
  const system = usePoll(fetchSystem);
  const activity = usePoll(() => fetchTatumActivity(100), {}, []);

  const rows = activity.data ?? [];
  const latencies = rows.map((row) => row.latency_ms);
  const success = rows.filter((row) => row.outcome === "success").length;
  const successRate = latencies.length ? Math.round((success / latencies.length) * 1000) / 10 : null;
  const medianLatency = median(latencies);
  const byMethod = {};
  for (const row of rows) byMethod[row.method] = (byMethod[row.method] ?? 0) + 1;
  const chart = Object.entries(byMethod)
    .sort((a, b) => b[1] - a[1])
    .map(([method, count]) => ({ method: method.split("/").at(-2) ? `${method.split("/").at(-2)}.${method.split("/").at(-1)}` : method, count, full: method }));

  const data = system.data;
  return (
    <section className="page-section">
      <h2>Tatum activity</h2>
      <p className="muted small-text">
        How the EvoLoop server calls Tatum: the Sui gRPC gateway for balances, payment execution and confirmation, and the Data API for exchange rates. The middleware
        also stores every call in SQLite. See the{" "}
        <a href="https://docs.tatum.io/reference/sui-grpc" target="_blank" rel="noreferrer">Sui gRPC reference</a>.
      </p>
      <div className="card summary-strip">
        <div><dt>total calls (persisted)</dt><dd>{typeof data?.tatum?.calls_logged === "number" ? data.tatum.calls_logged : "…"}</dd></div>
        <div><dt>last 24h</dt><dd>{typeof data?.tatum?.calls_last_24h === "number" ? data.tatum.calls_last_24h : "…"}</dd></div>
        <div><dt>success rate (last 100)</dt><dd>{successRate === null ? "—" : `${successRate}%`}</dd></div>
        <div><dt>median latency (last 100)</dt><dd>{medianLatency === null ? "—" : `${medianLatency} ms`}</dd></div>
      </div>
      <LastUpdated state={activity} label="Activity" />
      <div className="card">
        <h4>By method (last 100 calls)</h4>
        {chart.length === 0 ? (
          <p className="muted small-text">No calls recorded yet.</p>
        ) : (
          <ul className="method-bars">
            {chart.map((row) => (
              <li key={row.full}>
                <code className="small-text" title={row.full}>{row.method}</code>
                <span className="method-bar"><span style={{ width: `${(row.count / chart[0].count) * 100}%` }} />
                  <em>{row.count}</em>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <LoadState state={activity} what="Tatum calls">
        {rows.length === 0 ? (
          <div className="state-box"><p>No calls recorded yet — activity appears as soon as the server balances or pays on Sui.</p></div>
        ) : (
          <table className="component-table card">
            <thead>
              <tr><th>time</th><th>method</th><th>transport</th><th>latency</th><th>outcome</th><th>retries</th></tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  <td>{fmtWhen(row.at)}</td>
                  <td><code className="small-text" title={row.method}>{row.method.split("/").at(-1)}</code></td>
                  <td><TypeBadge tone={row.transport === "grpc" ? "accent" : "info"}>{row.transport}</TypeBadge></td>
                  <td>{row.latency_ms} ms</td>
                  <td><TypeBadge tone={row.outcome === "success" ? "ok" : "warn"}>{row.outcome}</TypeBadge></td>
                  <td>{row.retry_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </LoadState>
    </section>
  );
}

export default TatumPage;
