import { usePoll, fetchAgents, fetchAgent } from "./api.js";

/**
 * Workspace data plumbing: poll the published agents list, then run per-agent
 * fetchers in parallel and zip results with agent metadata. Everything comes
 * from /public/v1/* only. Polling respects the shared 20s interval and pauses
 * on hidden tabs via usePoll.
 */

/** Build the per-agent batch from a list of fetch functions (id) => request. */
export function useWorkspace({ want = [] } = {}) {
  const agentsState = usePoll(fetchAgents);
  const agents = agentsState.data ?? [];
  const ids = agents.map((agent) => agent.id).sort().join("|");

  const batchState = usePoll(
    async () => {
      if (!want.length || !ids) return { ok: true, data: [] };
      const idList = ids.split("|");
      const results = await Promise.all(
        idList.map(async (id) => {
          const values = {};
          const failures = [];
          await Promise.all(want.map(async ({ key, fetch }) => {
            const result = await fetch(id);
            if (result.ok) values[key] = result.data;
            else failures.push({ id, key, error: result.error, statusCode: result.statusCode, notFound: result.statusCode === 404, rateLimited: Boolean(result.rateLimited) });
          }));
          return { id, values, failures };
        })
      );
      const blocking = results.find((r) => r.failures.length > 0);
      if (blocking) {
        const f = blocking.failures[0];
        return { ok: false, statusCode: f.statusCode ?? 0, error: f.error ?? "request failed", rateLimited: Boolean(f.rateLimited), notFound: Boolean(f.notFound) };
      }
      return { ok: true, data: results };
    },
    { enabled: Boolean(ids) && want.length > 0 },
    [ids, want.map((w) => w.key).join("|")]
  );

  // zip: agent metadata + its per-key values
  const agentMeta = new Map(agents.map((agent) => [agent.id, agent]));
  const rows = (batchState.data ?? []).map((entry) => ({ agent: agentMeta.get(entry.id) ?? null, ...entry }));
  if (!batchState.data && agents.length === 0) return { agentsState, batchState, rows: [], agents: [] };
  if (batchState.data) return { agentsState, batchState, rows, agents };
  // agents loaded but batch in flight: no rows yet
  return { agentsState, batchState, rows: [], agents };
}

/** Fetch a single agent detail for all ids in one poll (for demo-actionable flags). */
export function useAgentDetails(idsList) {
  const ids = (idsList ?? []).join("|");
  return usePoll(
    async () => {
      const idList = ids.split("|").filter(Boolean);
      const results = await Promise.all(idList.map((id) => fetchAgent(id)));
      const failed = results.find((r) => !r.ok);
      if (failed) return { ok: false, statusCode: failed.statusCode, error: failed.error, rateLimited: Boolean(failed.rateLimited) };
      return { ok: true, data: results.filter((r) => r.ok).map((r, i) => ({ id: idList[i], data: r.data })) };
    },
    { enabled: idList.length > 0 },
    [ids]
  );
}

/** Relative time: "5 min ago" for feeds and board cards. */
export function relTime(iso) {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = Math.max(0, Date.now() - then);
  const minute = 60_000, hour = 3_600_000, day = 86_400_000;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)} min ago`;
  if (diff < day) return `${Math.floor(diff / hour)} h ago`;
  return `${Math.floor(diff / day)} d ago`;
}

/** Sort feed items newest first using the right timestamp field. */
export function feedSort(items) {
  return [...items].sort((a, b) => String(b.when ?? "").localeCompare(String(a.when ?? "")));
}
