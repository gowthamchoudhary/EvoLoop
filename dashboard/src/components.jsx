import { useEffect, useState } from "react";
import { NavLink, Link } from "react-router-dom";
import { fetchAgents, short, fmtClock, explorerTx, explorerAccount, POLL_INTERVAL, usePoll } from "./api.js";

/* ------------------------------------------------------------------ */
/* small primitives                                                    */
/* ------------------------------------------------------------------ */

export function Pill({ tone = "default", title, children }) {
  return (
    <span className={`pill ${tone}`} title={title || undefined}>
      {children}
    </span>
  );
}

export function TypeBadge({ tone, children }) {
  return <span className={`badge ${tone ?? "info"}`}>{children}</span>;
}

/** Initials avatar circle (agent names -> two letters). */
export function Avatar({ name, large }) {
  const initials = String(name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <span className={`avatar ${large ? "lg" : ""}`} aria-hidden="true">
      {initials || "·"}
    </span>
  );
}

/** Copyable hash/address chip with an optional explorer link. */
export function CopyChip({ value, explorer, note }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="chip hash-chip muted">—</span>;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="chip hash-chip" title={value}>
      <code>{short(value)}</code>
      <button type="button" className="icon-btn" onClick={copy} aria-label="copy value">
        {copied ? "✓" : "⧉"}
      </button>
      {explorer && (
        <a className="icon-btn" href={explorer} target="_blank" rel="noreferrer" aria-label="open in explorer">
          ↗
        </a>
      )}
      {note && <span className="chip-note">{note}</span>}
    </span>
  );
}

export function Skeleton({ wide }) {
  return <div className={wide ? "skel skel-block" : "skel skel-bar"} aria-hidden="true" />;
}

export function LastUpdated({ state, label = "Public API" }) {
  if (!state?.updatedAt) return null;
  return (
    <span className={`last-updated ${state?.stale ? "warn" : ""}`} title={state?.stale ? "last manual refresh failed" : undefined}>
      {label} updated {fmtClock(state.updatedAt)}
      {state?.stale ? " · refresh failed, showing last good data" : ""}
    </span>
  );
}

/** Loading / empty / rate-limited / error box with a retry button. */
export function LoadState({ state, what, onRetry, children }) {
  if (state?.data) return <>{children}</>;
  if (state?.loading || state?.status === "loading") {
    return (
      <div className="state-box">
        <Skeleton wide />
        <Skeleton wide />
        <p className="small-text">Loading {what}…</p>
      </div>
    );
  }
  const message = state?.rateLimited
    ? "The public API is rate limiting right now — it recovers by itself in under a minute."
    : state?.notFound
      ? `${what}: not found here. It may be private or unpublished.`
      : `Could not load ${what}`;
  return (
    <div className="state-box error">
      <p>{message}{state?.error && !state?.notFound ? `: ${state.error}` : ""}</p>
      <button type="button" className="btn" onClick={onRetry || (() => state?.retry?.())}>
        Retry
      </button>
    </div>
  );
}

/**
 * Segmented progress bar: e.g. "0.015 / 0.020 SUI".
 * segments: array of { pct, tone, title }; label rendered on the right.
 */
export function SegBar({ segments, label }) {
  return (
    <div className="segbar">
      <div className="segbar-track">
        {segments.map((seg, index) => (
          <span
            key={index}
            className={`segbar-seg ${seg.tone ?? ""}`}
            style={{ width: `${Math.max(0, Math.min(100, seg.pct))}%` }}
            title={seg.title}
          />
        ))}
      </div>
      {label && <span className="segbar-label" dangerouslySetInnerHTML={{ __html: label }} />}
    </div>
  );
}

/** Tiny inline SVG sparkline for score history. */
export function Sparkline({ points, width = 92, height = 26 }) {
  if (!points || points.length === 0) return <span className="muted small-text">—</span>;
  const values = points.map((p) => Number(p)).filter((v) => Number.isFinite(v));
  if (!values.length) return <span className="muted small-text">—</span>;
  const usable = values.map((v) => Math.max(0, Math.min(100, v)));
  const step = usable.length > 1 ? width / (usable.length - 1) : 0;
  const dotX = usable.length > 1 ? width : width / 2;
  const dotY = height - 2 - (usable[usable.length - 1] / 100) * (height - 4);
  const path = usable
    .map((v, i) => {
      const x = usable.length > 1 ? i * step : width / 2;
      const y = height - 2 - (v / 100) * (height - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="score history sparkline">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={dotX} cy={dotY} r="2.4" fill="currentColor" />
    </svg>
  );
}

/* Score gauge: 0-100 as a ring; "not enough data" when the snapshot lacks data. */
export function Gauge({ value, status, caption }) {
  const usable = value !== null && value !== undefined && Number.isFinite(Number(value)) && status !== "insufficient_data";
  const pct = usable ? Math.max(0, Math.min(100, Number(value))) : 0;
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const strokeColor = !usable ? "var(--muted)" : pct >= 80 ? "var(--ok)" : pct >= 50 ? "var(--accent)" : pct > 0 ? "var(--warn)" : "var(--danger)";
  return (
    <div className="gauge" role="img" aria-label={usable ? `score ${pct}` : "score not available yet"}>
      <svg viewBox="0 0 72 72" width="72" height="72">
        <circle className="gauge-track" cx="36" cy="36" r={radius} fill="none" strokeWidth="6" />
        {usable && (
          <circle
            className="gauge-arc"
            cx="36" cy="36" r={radius} fill="none" strokeWidth="6" strokeLinecap="round"
            stroke={strokeColor}
            strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
            transform="rotate(-90 36 36)"
          />
        )}
        <text x="36" y="41" textAnchor="middle" className="gauge-value">
          {usable ? String(pct).replace(/\.0$/, "") : "—"}
        </text>
      </svg>
      <span className="gauge-caption">{usable ? (caption ?? "score") : "not enough data"}</span>
    </div>
  );
}

/** Honest empty state: wireframe-cube illustration + one sentence + optional action. */
export function EmptyBox({ title, children, action }) {
  return (
    <div className="state-box empty">
      <svg width="64" height="52" viewBox="0 0 64 52" aria-hidden="true" style={{ opacity: 0.75 }}>
        <g fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" strokeLinejoin="round">
          <polygon points="32,4 52,14 32,24 12,14" />
          <polyline points="12,14 12,34 32,44 52,34 52,14" />
          <line x1="32" y1="24" x2="32" y2="44" />
          <line x1="52" y1="24" x2="32" y2="34" strokeDasharray="2 3" stroke="rgba(255,255,255,0.16)" />
        </g>
        <polygon points="44,10 52,14 44,18 36,14" fill="rgba(255,74,46,0.25)" stroke="#ff4a2e" strokeWidth="1" />
      </svg>
      <p style={{ margin: 0 }}>
        <strong style={{ color: "var(--text)" }}>{title}</strong>
        {children && (
          <>
            <br />
            <span className="small-text">{children}</span>
          </>
        )}
      </p>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* integration snippets (real API, placeholder keys only)              */
/* ------------------------------------------------------------------ */

export const INTEGRATIONS = [
  {
    key: "http",
    title: "HTTP API",
    blurb: "Post events with the agent's own key; each important event is queued into Walrus Memory automatically.",
    snippet: `curl ${"{BASE}"} /v1/events \\
  -H "Authorization: Bearer YOUR_AGENT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"task_completed","task_category":"finance_qa",\n      "summary":"Reconciled Q3 expenses","score":0.92}'`,
  },
  {
    key: "sdk",
    title: "JS SDK",
    blurb: "sdk/client.js in this repo: a plain client for the agent-key routes, no framework required.",
    snippet: `import { LayerClient } from "./sdk/client.js";
const loop = new LayerClient({
  apiKey: "YOUR_AGENT_KEY", agentId: "YOUR_AGENT_ID",
});
await loop.report({ type: "task_completed", /* … */ });
const guidance = await loop.guidance();`,
  },
  {
    key: "mcp",
    title: "MCP",
    blurb: "An MCP server is not shipped yet. The same loop is exposed over the agent HTTP API today.",
    snippet: `# real API today (MCP wrapper: planned)
curl /v1/agents/:id/guidance \\
  -H "Authorization: Bearer YOUR_AGENT_KEY"
# -> capabilities, budget position, pending requests`,
  },
  {
    key: "templates",
    title: "Templates",
    blurb: "Register a wallet-and-policy shell, then publish it from the settings route when it is ready to be public.",
    snippet: `POST /v1/agents/register
{ "name": "YOUR_AGENT_NAME",
  "wallet": { "address": "0x…" } }
# then per agent: PUT /v1/agents/:id/policy`,
  },
];

export function IntegrationCard({ integration, compact }) {
  return (
    <div className="integ-card">
      <h3>{integration.title}</h3>
      <p>{integration.blurb}</p>
      <pre className="integ-snippet">{integration.snippet}</pre>
      {!compact && (
        <a href="https://github.com/gowthamchoudhary/EvoLoop" target="_blank" rel="noreferrer" className="small-text muted" style={{ textDecoration: "underline", textUnderlineOffset: "3px" }}>
          See the source in this repo ↗
        </a>
      )}
    </div>
  );
}

/** "Connect an agent" modal — lists the real integration paths with placeholder keys. */
export function ConnectModal({ onClose }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-root" role="dialog" aria-modal="true" aria-label="Connect an agent">
      <button type="button" className="modal-scrim" onClick={onClose} aria-label="close" />
      <div className="modal">
        <div className="modal-head">
          <h3 style={{ fontSize: "1.2rem" }}>Connect an agent</h3>
          <span className="muted small-text">every path uses a key that lives server-side; nothing here is a real key</span>
          <button type="button" className="icon-btn modal-close" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        <div className="integ-list">
          {INTEGRATIONS.map((integ) => (
            <IntegrationCard key={integ.key} integration={integ} compact />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* app shell                                                           */
/* ------------------------------------------------------------------ */

export function NavIcon({ name }) {
  const icons = {
    overview: "◧",
    inbox: "☰",
    agents: "◉",
    payroll: "≡",
    memory: "▦",
    activity: "⌁",
    reports: "▤",
    docs: "↻",
    help: "ⓘ",
    settings: "⚙",
  };
  return (
    <span className="sb-icon" aria-hidden="true">
      {icons[name] ?? "•"}
    </span>
  );
}

export function Sidebar({ system, pendingCount = 0, scoresAgentId = null, onOpenConnect }) {
  const data = system?.data;
  const network = data?.network;
  const hasAgents = Boolean(scoresAgentId);
  return (
    <aside className="app-sidebar">
      <Link to="/app" className="sb-brand" title="EvoLoop demo workspace">
        <span className="sb-mark" aria-hidden="true">◆</span>
        <span className="sb-brand-name">EvoLoop</span>
      </Link>
      <span className="sb-ws-tag">Demo workspace (read-only)</span>

      <div className="sb-search" role="presentation" title="Search arrives with accounts">
        <span aria-hidden="true">⌕</span>
        <span>Search</span>
        <kbd>/</kbd>
      </div>

      <nav className="sb-group" aria-label="Workspace">
        <span className="sb-group-label">Workspace</span>
        <NavLink to="/app" className={({ isActive }) => `sb-link ${isActive ? "active" : ""}`} end>
          <NavIcon name="overview" /> Overview
        </NavLink>
        <NavLink to="/app/requests" className={({ isActive }) => `sb-link ${isActive ? "active" : ""}`}>
          <NavIcon name="inbox" /> Inbox
          {pendingCount > 0 && <span className="sb-badge">{pendingCount}</span>}
        </NavLink>
        <NavLink to="/app/agents" className={({ isActive }) => `sb-link ${isActive ? "active" : ""}`}>
          <NavIcon name="agents" /> Agents
        </NavLink>
        <NavLink to="/app/payroll" className={({ isActive }) => `sb-link ${isActive ? "active" : ""}`}>
          <NavIcon name="payroll" /> Payroll
        </NavLink>
        <NavLink to="/app/memory" className={({ isActive }) => `sb-link ${isActive ? "active" : ""}`}>
          <NavIcon name="memory" /> Memory
        </NavLink>
        <NavLink to="/app/activity" className={({ isActive }) => `sb-link ${isActive ? "active" : ""}`}>
          <NavIcon name="activity" /> Activity
        </NavLink>
      </nav>

      <nav className="sb-group" aria-label="More">
        <span className="sb-group-label">More</span>
        {hasAgents ? (
          <>
            <NavLink to={`/agent/${scoresAgentId}?tab=score`} className="sb-link">
              <NavIcon name="reports" /> Scores
            </NavLink>
            <NavLink to={`/agent/${scoresAgentId}?tab=verdicts`} className="sb-link">
              <NavIcon name="reports" /> Verdicts
            </NavLink>
          </>
        ) : (
          <span className="sb-link disabled" aria-disabled="true" title="No published agent yet">
            <NavIcon name="reports" /> Reports
          </span>
        )}
        <NavLink to="/how-it-works" className="sb-link">
          <NavIcon name="docs" /> Help &amp; docs
        </NavLink>
        <span className="sb-link disabled" aria-disabled="true" title="Settings are coming soon">
          <NavIcon name="settings" /> Settings
        </span>
      </nav>

      <div className="sb-card">
        <strong>Connect an agent</strong>
        <p>Wallet, budget, memory. Any agent that can call an HTTP endpoint can join the loop.</p>
        <button type="button" className="btn small" onClick={onOpenConnect}>
          Open connect options
        </button>
      </div>

      <div className="sb-foot">
        <a href="https://github.com/gowthamchoudhary/EvoLoop" target="_blank" rel="noreferrer">
          github.com/gowthamchoudhary/EvoLoop
        </a>
        <span>memories via Walrus · payments via Tatum · build {__BUILD_TIME__}</span>
      </div>
    </aside>
  );
}

export function AppHeader({ system, crumb }) {
  const data = system?.data;
  const network = data?.network;
  const mainnet = network === "mainnet";
  return (
    <header className="app-header">
      <nav className="crumb" aria-label="Breadcrumb">
        <Link to="/app" className="muted">Demo workspace</Link>
        <span aria-hidden="true" className="muted">/</span>
        <span className="crumb-current">{crumb}</span>
      </nav>
      <div className="header-pills">
        <span className={`net-badge ${mainnet ? "mainnet" : ""}`}>{network ? network.toUpperCase() : "…"}</span>
        <Pill tone="info" title="Memory texts written to Walrus Memory across all agents">
          Walrus <strong className="num">{typeof data?.walrus?.total?.memories_stored === "number" ? data.walrus.total.memories_stored : "…"}</strong>
        </Pill>
        <Pill tone="info" title={`Calls logged by the Tatum client (transport: ${data?.tatum?.transport ?? "…"})`}>
          Tatum <strong className="num">{typeof data?.tatum?.calls_logged === "number" ? data.tatum.calls_logged : "…"}</strong>
        </Pill>
        <span className="guest-menu">
          <span className="guest-face">
            <Avatar name="Guest" />
            Guest
          </span>
        </span>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-row">
        <span>EvoLoop — payroll and growth layer for AI agents</span>
        <span>Polling every {Math.round(POLL_INTERVAL / 1000)}s while the tab is visible · data from /public/v1 only</span>
      </div>
    </footer>
  );
}

export function FullShell({ system, crumb, children }) {
  const [connectOpen, setConnectOpen] = useState(false);
  const agents = usePoll(fetchAgents);
  const agentsData = agents.data ?? [];
  const pendingCount = agentsData.reduce((sum, agent) => sum + Number(agent.pending_request_count ?? 0), 0);
  const scoresAgentId = agentsData[0]?.id ?? null;
  return (
    <div className="shell">
      <Sidebar system={system} pendingCount={pendingCount} scoresAgentId={scoresAgentId} onOpenConnect={() => setConnectOpen(true)} />
      <main className="app-main">
        <AppHeader system={system} crumb={crumb} />
        <div className="app-content">
          <div className="page">{children}</div>
          <Footer />
        </div>
      </main>
      {connectOpen && <ConnectModal onClose={() => setConnectOpen(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* request board helpers (shared by Inbox board + Overview preview)     */
/* ------------------------------------------------------------------ */

export const REQUEST_TONE = {
  pending_approval: ["pending approval", "warn"],
  approved: ["approved", "ok"],
  auto_approved: ["auto approved", "ok"],
  needs_raise: ["needs a raise", "warn"],
  note_only: ["note", "info"],
  rejected: ["rejected", "bad"],
  executed: ["executed", "ok"],
};

/** Map a real request row + agent context to a board card view model. */
export function requestCardModel({ request, agentName, verdict }) {
  const priority = request?.baseline?.priority_label ?? null;
  const cost = request?.cost_sui ?? null;
  const budget = request?.budget ?? null;
  return { request, agentName, priority, cost, budget, verdict };
}
