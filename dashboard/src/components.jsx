import { useState } from "react";
import { NavLink, Link } from "react-router-dom";
import { short, fmtClock, explorerTx, explorerAccount, POLL_INTERVAL } from "./api.js";

const NAV_ITEMS = [
  { to: "/dashboard", label: "Overview", icon: "◧" },
  { to: "/how-it-works", label: "How it works", icon: "↻" },
  { to: "/tatum", label: "Tatum activity", icon: "⌁" },
];

export function Pill({ tone = "default", title, children }) {
  return (
    <span className={`pill ${tone}`} title={title || undefined}>
      {children}
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

/** Score gauge: 0-100 as a ring; "not enough data" when the snapshot lacks data. */
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

/** Loading / empty / rate-limited / error box with a retry button. */
export function LoadState({ state, what, onRetry, children }) {
  if (state?.data) return <>{children}</>;
  if (state?.loading || state?.status === "loading") {
    return (
      <div className="state-box">
        <p>Loading {what}…</p>
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

export function LastUpdated({ state, label = "Public API" }) {
  if (!state?.updatedAt) return null;
  return (
    <span className={`last-updated ${state?.stale ? "warn" : ""}`} title={state?.stale ? "last manual refresh failed" : undefined}>
      {label} updated {fmtClock(state.updatedAt)}
      {state?.stale ? " · refresh failed, showing last good data" : ""}
    </span>
  );
}

/**
 * App shell sidebar (reference style: fixed dark app column with icon nav and a status card).
 * The live system pills/last-updated live in the bottom status card.
 */
export function Sidebar({ system }) {
  const data = system?.data;
  const network = data?.network;
  return (
    <aside className="sidebar">
      <Link to="/dashboard" className="brand" title="EvoLoop overview">
        <span className="brand-name">✦ EvoLoop</span>
        <span className="brand-tag">Payroll and growth layer for AI agents</span>
      </Link>
      <nav className="side-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => `side-link ${isActive ? "active" : ""}`}>
            <span className="side-icon" aria-hidden="true">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="side-card">
        <div className="side-card-row">
          <span className="muted small-text">network</span>
          <Pill tone={network === "mainnet" ? "ok" : "warn"}>{network ? network.toUpperCase() : "…"}</Pill>
        </div>
        <div className="side-card-row">
          <span className="muted small-text" title="These memory texts were written to Walrus Memory. On mainnet they are paid stored blobs; this testnet demo writes to the dev namespace.">
            Walrus memories
          </span>
          <strong>{typeof data?.walrus?.total?.memories_stored === "number" ? data.walrus.total.memories_stored : "…"}</strong>
        </div>
        <div className="side-card-row">
          <span className="muted small-text" title={`Calls logged by the Tatum client (transport: ${data?.tatum?.transport ?? "…"}), persisted server-side`}>
            Tatum calls
          </span>
          <strong>{typeof data?.tatum?.calls_logged === "number" ? data.tatum.calls_logged : "…"}</strong>
        </div>
        <div className="side-card-row">
          <span className="muted small-text">demo actions</span>
          <Pill tone={data?.demo_actions_enabled ? "ok" : "default"}>{data ? (data.demo_actions_enabled ? "on" : "off") : "…"}</Pill>
        </div>
        <LastUpdated state={system} label="Public API" />
      </div>
      <div className="side-foot muted small-text">
        <a href="https://github.com/gowthamchoudhary/EvoLoop" target="_blank" rel="noreferrer">github.com/gowthamchoudhary/EvoLoop</a>
        <span>memories via Walrus · payments via Tatum · build {__BUILD_TIME__}</span>
      </div>
    </aside>
  );
}

export function Footer() {
  return null;
}

export function TypeBadge({ tone, children }) {
  return <span className={`badge ${tone ?? "info"}`}>{children}</span>;
}
