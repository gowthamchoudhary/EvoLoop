import { randomUUID } from "node:crypto";
import { getDatabase } from "./db.js";
import { enqueueMemory, newMemoryId } from "./memory-queue.js";
import { formatMist } from "./payroll-chain.js";
import {
  ISSUE_TYPES,
  MIN_AFTER_OUTCOMES,
  NOT_WORTH_DROP,
  OUTCOME_TYPES,
  VERDICT_COOLDOWN_DAYS,
  VERDICT_COOLDOWN_MINUTES_COMPRESSED,
  WORTH_IT_DROP,
} from "./review-config.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const round3 = (value) => Math.round(value * 1000) / 1000;
const pct = (rate) => Math.round(rate * 100);

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function queueMemory(agentId, text) {
  const memoryId = newMemoryId();
  getDatabase().prepare("INSERT INTO memories(id,event_id,agent_id,text,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(memoryId, null, agentId, text, "pending", new Date().toISOString());
  enqueueMemory(memoryId);
  return memoryId;
}

export function publicVerdict(row) {
  if (!row) return null;
  return { ...row, cost_sui: formatMist(row.cost_mist) };
}

/** Rate drop achieved by an upgrade, judged only from stored rows: no numbers are typed by hand. */
function afterMetricsFor(agentId, taskCategory, since) {
  const rows = getDatabase().prepare(`
    SELECT type FROM events
    WHERE agent_id=? AND task_category=? AND ts>? AND type IN (${OUTCOME_TYPES.map(() => "?").join(",")})
  `).all(agentId, taskCategory, since, ...OUTCOME_TYPES);
  const outcomes = rows.length;
  const issues = rows.filter((row) => ISSUE_TYPES.includes(row.type)).length;
  return { outcomes, issues, rate: outcomes ? round3(issues / outcomes) : 0 };
}

/**
 * Evaluate one executed upgrade request against the outcomes recorded after its capability
 * was unlocked. The baseline comes from the request's own baseline_json, so both sides of
 * the comparison are stored numbers. Existing verdicts are returned unchanged: there is no
 * path that edits a verdict.
 */
export function evaluateVerdict({ requestId }) {
  const db = getDatabase();
  const request = db.prepare("SELECT * FROM upgrade_requests WHERE id=?").get(requestId);
  if (!request) throw httpError(404, "request not found");

  const existing = db.prepare("SELECT * FROM upgrade_verdicts WHERE request_id=?").get(requestId);
  if (existing) return { verdict: publicVerdict(existing), memory_id: null, already_evaluated: true };

  if (request.status !== "executed") throw httpError(409, `request is not executed (status ${request.status})`);
  const baseline = parseJson(request.baseline_json);
  if (!baseline || typeof baseline.issue_rate !== "number" || !baseline.task_category) {
    throw httpError(409, "request has no baseline to compare against");
  }
  const capability = db.prepare("SELECT * FROM agent_capabilities WHERE request_id=? AND active=1").get(requestId);
  if (!capability) throw httpError(409, "request has no unlocked capability to measure");

  const baselineRate = round3(Number(baseline.issue_rate));
  const baselineOutcomes = Number(baseline.outcomes ?? 0);
  const taskCategory = baseline.task_category;
  const after = afterMetricsFor(request.agent_id, taskCategory, capability.unlocked_at);
  const delta = round3(baselineRate - after.rate);

  let verdict = "inconclusive";
  if (after.outcomes >= MIN_AFTER_OUTCOMES) {
    if (delta >= WORTH_IT_DROP) verdict = "worth_it";
    else if (delta <= NOT_WORTH_DROP) verdict = "not_worth_it";
  }

  const costSui = formatMist(request.cost_mist);
  const summary = after.outcomes < MIN_AFTER_OUTCOMES
    ? `${request.capability_key} on ${taskCategory}: issue rate ${pct(baselineRate)}% -> ${pct(after.rate)}% over ${after.outcomes} task(s) after unlock; needs at least ${MIN_AFTER_OUTCOMES} outcomes, so ${verdict}.`
    : `${request.capability_key} on ${taskCategory}: issue rate ${pct(baselineRate)}% -> ${pct(after.rate)}% over ${after.outcomes} task(s) after unlock (delta ${delta}); cost ${costSui} SUI; verdict ${verdict}.`;

  const id = `verdict_${randomUUID()}`;
  const evaluatedAt = new Date().toISOString();
  db.prepare(`INSERT INTO upgrade_verdicts(id,request_id,agent_id,capability_key,task_category,
    baseline_rate,baseline_outcomes,after_rate,after_outcomes,delta,verdict,cost_mist,evaluated_at,summary)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, requestId, request.agent_id, request.capability_key ?? "none", taskCategory,
    baselineRate, baselineOutcomes, after.rate, after.outcomes, delta, verdict,
    request.cost_mist, evaluatedAt, summary,
  );

  const memoryId = queueMemory(
    request.agent_id,
    `Agent ${request.agent_id} | upgrade_verdict | ${request.capability_key ?? "none"} | ${verdict} | issue rate ${pct(baselineRate)}% -> ${pct(after.rate)}% over ${after.outcomes} tasks | cost ${costSui} SUI`,
  );

  return { verdict: publicVerdict(db.prepare("SELECT * FROM upgrade_verdicts WHERE id=?").get(id)), memory_id: memoryId };
}

export function listVerdicts(agentId) {
  return getDatabase().prepare("SELECT * FROM upgrade_verdicts WHERE agent_id=? ORDER BY evaluated_at DESC, rowid DESC")
    .all(agentId).map(publicVerdict);
}

/**
 * Latest not_worth_it verdict for a capability, if it is still inside its cooldown window.
 * Used by proposal creation so a capability judged unhelpful is not immediately re-proposed.
 */
export function verdictBlocking(agentId, capabilityKey, settings) {
  const row = getDatabase().prepare(`
    SELECT * FROM upgrade_verdicts
    WHERE agent_id=? AND capability_key=? AND verdict='not_worth_it'
    ORDER BY evaluated_at DESC, rowid DESC LIMIT 1
  `).get(agentId, capabilityKey);
  if (!row) return null;
  const cooldownMs = settings?.period === "compressed"
    ? VERDICT_COOLDOWN_MINUTES_COMPRESSED * MINUTE_MS
    : VERDICT_COOLDOWN_DAYS * DAY_MS;
  const evaluatedAt = Date.parse(row.evaluated_at);
  if (!Number.isFinite(evaluatedAt) || Date.now() - evaluatedAt >= cooldownMs) return null;
  return {
    reason: "verdict_cooldown",
    verdict_id: row.id,
    verdict: row.verdict,
    cooldown_hours: round3(cooldownMs / 3_600_000),
  };
}
