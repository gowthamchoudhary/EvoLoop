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
