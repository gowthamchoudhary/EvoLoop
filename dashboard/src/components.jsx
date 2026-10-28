import { useState } from "react";
import { Link } from "react-router-dom";
import { short, fmtClock, explorerTx, explorerAccount } from "./api.js";

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

export function TopBar({ system }) {
  const data = system?.data;
  const network = data?.network;
  const netTone = network === "mainnet" ? "ok" : network === "testnet" ? "warn" : "default";
  const walrusStored = data?.walrus?.total?.memories_stored;
  const tatumCalls = data?.tatum?.calls_logged;
  return (
    <header className="topbar">
      <Link to="/" className="brand" title="Overview">
        <span className="brand-name">EvoLoop</span>
        <span className="brand-tag">Payroll and growth layer for AI agents</span>
      </Link>
      <div className="topbar-pills">
        <Pill tone={netTone} title={network ? `Sui ${network}` : "loading network"}>
          {network ? network.toUpperCase() : "…"}
        </Pill>
        <Pill tone="default" title="These memory texts were written to Walrus Memory. On mainnet they are paid stored blobs; this testnet demo writes to the dev namespace.">
          Walrus memories stored: {typeof walrusStored === "number" ? walrusStored : "…"}
        </Pill>
        <Pill tone="default" title={`Calls logged by the Tatum client (transport: ${data?.tatum?.transport ?? "…"})`}>
          Tatum calls: {typeof tatumCalls === "number" ? tatumCalls : "…"}
        </Pill>
        <Pill tone={data?.demo_actions_enabled ? "ok" : "default"} title="Whether public visitors may exercise demo approve/reject actions">
          demo actions: {data ? (data.demo_actions_enabled ? "on" : "off") : "…"}
        </Pill>
      </div>
      <LastUpdated state={system} />
    </header>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-row">
        <span>EvoLoop — payroll and growth layer for AI agents</span>
        <a href="https://github.com/gowthamchoudhary/EvoLoop" target="_blank" rel="noreferrer">
          github.com/gowthamchoudhary/EvoLoop
        </a>
      </div>
      <div className="footer-row muted">
        <span>Memories written via Walrus · rates and payments via Tatum</span>
        <span>build {__BUILD_TIME__}</span>
      </div>
    </footer>
  );
}

export function TypeBadge({ tone, children }) {
  return <span className={`badge ${tone ?? "info"}`}>{children}</span>;
}
