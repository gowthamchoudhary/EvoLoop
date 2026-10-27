/**
 * Walrus-driven lessons.
 *
 * Every upgrade-decision memory has the structured shape "Agent <agent_id> | <kind> | ...".
 * parseMemoryText extracts the decision-relevant fields; recallLessons queries the agent's
 * own Walrus namespace, parses every hit and upserts it into the `lessons` table. Nothing
 * is inserted by hand anywhere — every lesson row exists because a real memory blob was
 * recalled once through the per-agent Walrus namespace.
 */

import { randomUUID } from "node:crypto";
import { getDatabase } from "./db.js";
import { recallForAgent } from "./memory-queue.js";
import {
  REJECT_COOLDOWN_DAYS,
  PROPOSAL_COOLDOWN_MINUTES,
  VERDICT_COOLDOWN_DAYS,
  VERDICT_COOLDOWN_MINUTES_COMPRESSED,
} from "./review-config.js";
import { safeText } from "./events.js";

export const LESSON_KINDS = ["upgrade_purchased", "upgrade_rejected", "upgrade_verdict", "gap_dismissed", "review"];

const RECALL_QUERIES = [
  "upgrade verdict worth it or not worth it",
  "upgrade rejected",
  "upgrade purchased",
  "gap dismissed",
  "review outcome",
];
const RECALL_LIMIT = 10;
const RECALL_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 60_000;

const cache = new Map();

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const excerpt = (value, max = 120) => String(value ?? "").slice(0, max);
const num = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * Parse one structured memory text against an expected agent id. Returns null for a
 * foreign agent id, an unknown kind and anything outside the known memory shapes.
 * Legacy dismissal memories ("gap dismissed by user: <task_category>", without an agent
 * prefix) are still parsed; they simply cannot be attributed to an agent id.
 */
export function parseMemoryText(text, expectedAgentId) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const agentMatch = /^Agent\s+(\S+)\s*\|\s*(.+)$/.exec(raw);
  if (agentMatch) {
    const agentId = agentMatch[1];
    if (expectedAgentId && agentId !== expectedAgentId) return null;
    const parts = agentMatch[2].split("|").map((part) => part.trim());

    const result = { agent_id: agentId, kind: parts[0], detail: raw };
    switch (parts[0]) {
      case "upgrade_purchased": {
        // Agent <id> | upgrade_purchased | <capability_key> | cost <x> SUI | reason <...> | digest <...>
        if (parts.length < 3) return null;
        result.capability_key = parts[1] || null;
        const cost = /\bcost\s+([\d.]+)\s+SUI\b/i.exec(raw);
        const digest = /\bdigest\s+([A-Za-z0-9]+)/.exec(raw);
        result.cost_sui = cost ? num(cost[1]) : null;
        result.digest = digest?.[1] ?? null;
        const reason = parts.find((part) => /^reason /.test(part));
        if (reason) result.reason = excerpt(reason.slice("reason ".length));
        return result;
      }
      case "upgrade_rejected": {
        // Agent <id> | upgrade_rejected | <capability_key> | <note>
        if (parts.length < 3) return null;
        result.capability_key = parts[1] || null;
        result.note = parts.slice(2).join(" ") || null;
        return result;
      }
      case "upgrade_verdict": {
        // Agent <id> | upgrade_verdict | <capability_key> | <verdict> | issue rate <b>% -> <a>% over <n> tasks | cost <x> SUI
        if (parts.length < 4) return null;
        const verdict = parts[2];
        if (!["worth_it", "not_worth_it", "inconclusive"].includes(verdict)) return null;
        result.capability_key = parts[1] || null;
        result.verdict = verdict;
        const rates = /issue rate\s+([\d.]+)%\s*->\s*([\d.]+)%\s+over\s+(\d+)\s+task/i.exec(raw);
        if (rates) {
          result.baseline_rate = num(rates[1]) / 100;
          result.after_rate = num(rates[2]) / 100;
          result.outcomes = num(rates[3]);
        }
        const cost = /\bcost\s+([\d.]+)\s+SUI\b/i.exec(raw);
        result.cost_sui = cost ? num(cost[1]) : null;
        return result;
      }
      case "gap_dismissed": {
        // Agent <id> | gap_dismissed | <task_category>
        if (parts.length < 2) return null;
        result.task_category = parts[1] || null;
        return result;
      }
      case "review": {
        // Agent <id> | review | <period_label> | outcome: <x> | <summary...>
        if (parts.length < 3) return null;
        result.period_label = parts[1] || null;
        const outcome = /^outcome:\s*(\S+)$/.exec(parts[2] ?? "");
        if (!outcome || !["gaps_found", "no_gaps", "insufficient_data"].includes(outcome[1])) return null;
        result.outcome = outcome[1];
        return result;
      }
      default:
        return null;
    }
  }

  // Legacy dismissal memories predate the agent prefix; parse them as unattributed dismissals.
  const legacy = /^gap dismissed by user:\s*(.+)$/.exec(raw);
  if (legacy) {
    return {
      agent_id: null,
      kind: "gap_dismissed",
      task_category: legacy[1].trim() || null,
      detail: raw,
    };
  }
  return null;
}

/** Rows for one agent (lessons are only ever written from that agent's own namespace). */
export function lessonsForAgent(agentId) {
  return getDatabase().prepare(`
    SELECT id, kind, capability_key, task_category, verdict, detail, source_text, blob_id, recalled_at
    FROM lessons WHERE agent_id=? ORDER BY recalled_at DESC, rowid DESC
  `).all(agentId);
}

function upsertLesson(db, parsed, sourceText, blobId) {
  if (!parsed.agent_id) return;
  db.prepare(`
    INSERT INTO lessons(id, agent_id, kind, capability_key, task_category, verdict, detail, source_text, blob_id, recalled_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent_id, source_text) DO UPDATE SET
      kind = excluded.kind,
      capability_key = excluded.capability_key,
      task_category = excluded.task_category,
      verdict = excluded.verdict,
      detail = excluded.detail,
      blob_id = COALESCE(excluded.blob_id, lessons.blob_id),
      recalled_at = excluded.recalled_at
  `).run(
    `les_${randomUUID()}`,
    parsed.agent_id,
    parsed.kind,
    parsed.capability_key ?? null,
    parsed.task_category ?? null,
    parsed.verdict ?? null,
    parsed.detail ?? null,
    sourceText,
    blobId ?? null,
    new Date().toISOString(),
  );
}

/**
 * Recall the agent's namespace, parse every hit and upsert the lessons.
 * The result is cached per agent for CACHE_TTL_MS unless forced. Any failure or timeout
 * resolves to { ok: false, error } — callers fall back to database state, never crash.
 */
export async function recallLessons(agentId, { force = false } = {}) {
  const cached = cache.get(agentId);
  if (!force && cached && Date.now() < cached.expiresAt) return { ...cached.value, cached: true, forced: false };

  const work = (async () => {
    const counts = {};
    let recalled = 0;
    for (const query of RECALL_QUERIES) {
      const results = await recallForAgent(agentId, query, RECALL_LIMIT);
      for (const entry of results) {
        const text = String(entry.text ?? "");
        const parsed = parseMemoryText(text, agentId);
        if (!parsed) continue;
        // Legacy texts (no agent prefix) are recalled from this agent's namespace, so they belong here.
        parsed.agent_id ??= agentId;
        upsertLesson(getDatabase(), parsed, text, entry.blob_id);
        recalled += 1;
        counts[parsed.kind] = (counts[parsed.kind] ?? 0) + 1;
      }
    }
    return {
      ok: true,
      recalled,
      counts,
      blob_ids: lessonsForAgent(agentId).map((lesson) => lesson.blob_id).filter(Boolean).slice(0, 20),
    };
  })();

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`walrus recall timed out after ${RECALL_TIMEOUT_MS} ms`)), RECALL_TIMEOUT_MS));

  try {
    const result = await Promise.race([work, timeout]);
    cache.set(agentId, { expiresAt: Date.now() + CACHE_TTL_MS, value: result });
    return { ...result, cached: false, forced: Boolean(force) };
  } catch (error) {
    const failed = { ok: false, error: safeText(error) };
    // Cache a short-lived failure as well so a broken namespace is not hammered on every call.
    cache.set(agentId, { expiresAt: Date.now() + 5_000, value: failed });
    return failed;
  }
}

/** Force a recall and report per-kind counts plus the returned lessons. */
export async function restoreLessons(agentId) {
  const result = await recallLessons(agentId, { force: true });
  if (!result.ok) return { ...result, counts: {} };
  const lessons = lessonsForAgent(agentId);
  const dbCounts = {};
  for (const lesson of lessons) dbCounts[lesson.kind] = (dbCounts[lesson.kind] ?? 0) + 1;
  return {
    ok: true,
    counts: dbCounts,
    total: lessons.length,
    lessons: lessons.slice(0, 20).map((lesson) => ({
      kind: lesson.kind,
      capability_key: lesson.capability_key,
      task_category: lesson.task_category,
      verdict: lesson.verdict,
      blob_id: lesson.blob_id,
      text_excerpt: excerpt(lesson.source_text),
    })),
  };
}

/** Lessons consulted for one capability/category decision, as decision_basis entries. */
export function decisionBasisForWalrus(lessons, { capabilityKey = null, taskCategory = null, max = 8 } = {}) {
  const relevant = lessons.filter((lesson) => {
    if (lesson.kind === "gap_dismissed") return taskCategory !== null && lesson.task_category === taskCategory;
    if (lesson.capability_key == null) return false;
    return capabilityKey !== null && lesson.capability_key === capabilityKey;
  }).slice(0, max);
  return relevant.map((lesson) => ({
    source: "walrus",
    kind: lesson.kind,
    capability_key: lesson.capability_key,
    ...(lesson.blob_id ? { blob_id: lesson.blob_id } : {}),
    text_excerpt: excerpt(lesson.detail ?? lesson.source_text),
  }));
}

/** Cooldown window for not_worth_it verdicts / rejections, based on the agent's settings. */
function cooldownMs(kind, settings) {
  const compressed = settings?.period === "compressed";
  if (kind === "upgrade_verdict") {
    return (compressed ? VERDICT_COOLDOWN_MINUTES_COMPRESSED : VERDICT_COOLDOWN_DAYS) *
      (compressed ? MINUTE_MS : DAY_MS);
  }
  return (compressed ? PROPOSAL_COOLDOWN_MINUTES : REJECT_COOLDOWN_DAYS) *
    (compressed ? MINUTE_MS : DAY_MS);
}

/**
 * Skip reason a lesson gives for proposing `capabilityKey` again, or null.
 * A purchased lesson always blocks (the capability was bought); a not_worth_it verdict
 * or a rejection blocks while it is inside its cooldown.
 */
export function lessonSkipReason(lessons, capabilityKey, settings) {
  const purchased = lessons.find((lesson) => lesson.kind === "upgrade_purchased" && lesson.capability_key === capabilityKey);
  if (purchased) {
    return { reason: "lesson_capability_purchased", kind: purchased.kind, blob_id: purchased.blob_id };
  }
  const verdict = lessons.find((lesson) =>
    lesson.kind === "upgrade_verdict" && lesson.capability_key === capabilityKey && lesson.verdict === "not_worth_it");
  if (verdict) {
    const at = Date.parse(verdict.recalled_at);
    if (!Number.isFinite(at) || Date.now() - at < cooldownMs("upgrade_verdict", settings)) {
      return { reason: "lesson_verdict_not_worth_it", kind: verdict.kind, blob_id: verdict.blob_id };
    }
  }
  const rejected = lessons.find((lesson) => lesson.kind === "upgrade_rejected" && lesson.capability_key === capabilityKey);
  if (rejected) {
    const at = Date.parse(rejected.recalled_at);
    if (!Number.isFinite(at) || Date.now() - at < cooldownMs("upgrade_rejected", settings)) {
      return { reason: "lesson_rejected_cooldown", kind: rejected.kind, blob_id: rejected.blob_id };
    }
  }
  return null;
}

/** The dismissal lesson for a task_category, if one was recalled. */
export function lessonDismissalFor(lessons, taskCategory) {
  return lessons.find((lesson) => lesson.kind === "gap_dismissed" && lesson.task_category === taskCategory) ?? null;
}
