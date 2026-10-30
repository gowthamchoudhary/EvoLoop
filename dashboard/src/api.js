import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/* Fetch helpers                                                       */
/* ------------------------------------------------------------------ */

const POLL_INTERVAL_MS = 20_000;
export const POLL_INTERVAL = POLL_INTERVAL_MS;

async function request(path) {
  let response;
  try {
    response = await fetch(path);
  } catch {
    return { ok: false, statusCode: 0, error: "network error" };
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (response.status === 429) {
    return { ok: false, statusCode: 429, rateLimited: true, error: "rate limited" };
  }
  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      error: typeof data?.error === "string" ? data.error : `HTTP ${response.status}`,
      code: typeof data?.code === "string" ? data.code : null,
    };
  }
  return { ok: true, statusCode: response.status, data };
}

export function fetchSystem() {
  return request("/public/v1/system");
}
export function fetchAgents() {
  return request("/public/v1/agents");
}
export function fetchAgent(id) {
  return request(`/public/v1/agents/${encodeURIComponent(id)}`);
}
export function fetchTimeline(id, { limit = 50, before = null } = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before) query.set("before", before);
  return request(`/public/v1/agents/${encodeURIComponent(id)}/timeline?${query}`);
}
export function fetchScores(id) {
  return request(`/public/v1/agents/${encodeURIComponent(id)}/scores`);
}
export function fetchSuggestions(id) {
  return request(`/public/v1/agents/${encodeURIComponent(id)}/suggestions`);
}
export function fetchTransactions(id) {
  return request(`/public/v1/agents/${encodeURIComponent(id)}/transactions`);
}
export function fetchVerdicts(id) {
  return request(`/public/v1/agents/${encodeURIComponent(id)}/verdicts`);
}
export function fetchReviews(id) {
  return request(`/public/v1/agents/${encodeURIComponent(id)}/reviews`);
}
export function fetchRequests(id) {
  return request(`/public/v1/agents/${encodeURIComponent(id)}/requests`);
}
export function fetchLessons(id) {
  return request(`/public/v1/agents/${encodeURIComponent(id)}/lessons`);
}
export function fetchTatumActivity(limit = 100) {
  return request(`/public/v1/tatum/activity?limit=${limit}`);
}

/** Public demo approve/reject; returns the parsed server response so callers can render what really happened. */
export async function demoAction(requestId, action) {
  let response;
  try {
    response = await fetch(`/public/v1/requests/${encodeURIComponent(requestId)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    return { ok: false, statusCode: 0, error: "network error" };
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    return { ok: false, statusCode: response.status, error: typeof data?.error === "string" ? data.error : `HTTP ${response.status}`, code: typeof data?.code === "string" ? data.code : null };
  }
  return { ok: true, statusCode: response.status, data };
}

/**
 * Polling hook. Polls every `intervalMs` while the tab is visible and pauses while it
 * is hidden. Transient failures keep the previously loaded data visible as `stale`
 * state (with the fetch error) instead of blanking the page; `retry` re-runs now.
 */
export function usePoll(fetcher, { intervalMs = POLL_INTERVAL_MS, enabled = true } = {}, deps = []) {
  const [state, setState] = useState({
    status: "loading", // loading | ready | stale | error
    data: null,
    error: null,
    rateLimited: false,
    notFound: false,
    updatedAt: null,
  });
  const [attempt, setAttempt] = useState(0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer = null;

    const tick = async () => {
      // Pause while the tab is hidden instead of burning requests.
      if (document.visibilityState !== "visible") return true; // keep the timer alive
      const result = await fetchRef.current();
      if (!alive) return false;
      setState((prev) => {
        if (result.ok) {
          return {
            status: "ready",
            data: result.data,
            error: null,
            rateLimited: false,
            notFound: false,
            updatedAt: new Date(),
          };
        }
        return {
          ...prev,
          status: prev.data ? "stale" : "error",
          data: prev.data ?? null,
          error: result.error ?? "unknown error",
          rateLimited: Boolean(result.rateLimited),
          notFound: result.statusCode === 404,
        };
      });
      return false;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);

    void tick().then(() => {
      if (alive) timer = setInterval(() => void tick(), intervalMs);
    });

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, attempt, ...deps]);

  return {
    ...state,
    loading: state.status === "loading",
    stale: state.status === "stale",
    ready: state.status === "ready" || state.status === "stale",
    retry: () => setAttempt((n) => n + 1),
  };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** SUI amounts rendered as "12.345 SUI"; anything under 0.001 shows "<0.001". */
export function sui(amount) {
  if (amount === null || amount === undefined) return "—";
  const value = Number(amount);
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.001) return "<0.001";
  return `${value.toFixed(3)} SUI`;
}

/** MIST integers (raw ledger units) through the SUI display rule. */
export function mistSui(amountMist) {
  if (amountMist === null || amountMist === undefined) return "—";
  const asString = String(amountMist).replace(/\D/g, "");
  return sui(Number(asString) / 1e9);
}

/** Hash-style truncation: 0x1234…abcd. */
export function short(value) {
  const text = String(value ?? "");
  if (!text) return "—";
  return text.length <= 14 ? text : `${text.slice(0, 6)}…${text.slice(-4)}`;
}

export function fmtClock(date) {
  if (!date) return null;
  return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtWhen(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function fmtPct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return `${Math.round(Number(value) * 1000) / 10}%`;
}

export function explorerTx(system, digest) {
  if (!digest || !system?.explorer) return null;
  return `${system.explorer.tx}${encodeURIComponent(digest)}`;
}
export function explorerAccount(system, address) {
  if (!address || !system?.explorer) return null;
  return `${system.explorer.account}${encodeURIComponent(address)}`;
}

export function autonomyLabel(autonomy) {
  if (autonomy === "auto_small") return "auto-pays small";
  if (autonomy === "never") return "never self-pays";
  if (autonomy === "ask") return "asks before paying";
  return String(autonomy ?? "—");
}

export function periodLabel(period) {
  if (period === "compressed") return "compressed window";
  return period ?? "period";
}

/**
 * Parses the structured memory text "Agent <id> | <kind> | ..." into a friendly one-line
 * sentence. `known` is false when the shape does not match, and the safe fallback is the
 * exact raw text.
 */
export function parseMemory(text) {
  const raw = String(text ?? "");
  const parts = raw.split("|").map((part) => part.trim());
  if (parts.length < 2 || !/^Agent\s+\S+$/.test(parts[0])) return { known: false, kind: null, sentence: raw.slice(0, 240) };
  const kind = parts[1];
  const rest = parts.slice(2);
  const money = (value) => sui(Number(value));
  const cost = (part) => {
    const match = /cost\s+([0-9.]+)/i.exec(part ?? "");
    return match ? money(match[1]) : null;
  };
  switch (kind) {
    case "upgrade_purchased": {
      const costSui = cost(rest[1]);
      return { known: true, kind, sentence: `Upgrade purchased: ${rest[0]} for ${costSui ?? "an undisclosed amount"}` };
    }
    case "upgrade_rejected":
      return { known: true, kind, sentence: `Upgrade rejected: ${rest.slice(1).join(" ") || rest[0]}` };
    case "upgrade_verdict": {
      const rates = /issue\s+rate\s+([0-9.]+)%\s+->\s+([0-9.]+)%/i.exec(rest.find((part) => /issue\s+rate/i.test(part)) ?? "");
      const spans = rates ? ` (issue rate ${rates[1]}% to ${rates[2]}%)` : "";
      return { known: true, kind, sentence: `Verdict: ${rest[0]} was ${rest[1]}${spans}${cost(rest.find((part) => /cost/i.test(part))) ? ` for ${cost(rest.find((part) => /cost/i.test(part)))}` : ""}` };
    }
    case "review": {
      const outcome = /outcome:\s*([\w_]+)/i.exec(rest.find((part) => /outcome:/i.test(part)) ?? "");
      const labels = { gaps_found: "gaps found", no_gaps: "no gaps this period", insufficient_data: "not enough data" };
      return { known: true, kind, sentence: `Review ${rest[0] ?? ""}: ${outcome ? labels[outcome[1]] ?? outcome[1] : rest.join(" — ")}` };
    }
    case "gap_dismissed":
      return { known: true, kind, sentence: `Gap dismissed: ${rest.join(" ")}` };
    case "salary_change":
      return { known: true, kind, sentence: `Salary suggestion: ${rest.join(" · ").replace(/->/g, "→")}` };
    default:
      return { known: false, kind: null, sentence: raw.slice(0, 240) };
  }
}

/** Badge label and tone for a parsed memory signed "Agent <id> | <kind> | ...". */
export function memoryBadge(topic) {
  const kind = topic?.kind ?? null;
  if (kind === "upgrade_purchased") return { label: "upgrade", tone: "accent" };
  if (kind === "upgrade_rejected") return { label: "upgrade", tone: "warn" };
  if (kind === "upgrade_verdict") return { label: "verdict", tone: topic?.sentence?.includes("not worth it") ? "warn" : "ok" };
  if (kind === "review") return { label: "review", tone: "info" };
  if (kind === "salary_change") return { label: "salary", tone: "accent" };
  return { label: "memory", tone: "info" };
}

/** Plain-language sentences for the review gate reason codes, using the gap's own metrics. */
export function gateReasonSentence(code, metrics = {}) {
  switch (code) {
    case "outcomes_below_min":
      return `Needs at least 5 outcomes, had ${metrics.outcomes ?? 0}`;
    case "issue_rate_below_min":
      return `Issue rate ${fmtPct(metrics.issue_rate)} is below the 30% bar`;
    case "insufficient_recurrence":
      return "Problems do not repeat across at least 2 distinct sessions";
    case "dismissed_by_user":
      return "A human dismissed this category in an earlier review";
    case "recent_failure_below_min":
      return "No recent hard failure that qualifies as an automatic fix";
    default:
      return code;
  }
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
