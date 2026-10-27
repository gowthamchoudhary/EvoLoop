import { randomUUID } from "node:crypto";
import { getDatabase } from "./db.js";
import { lessonDismissalFor, lessonsForAgent, recallLessons } from "./lessons.js";
import { enqueueMemory, newMemoryId } from "./memory-queue.js";
import { formatMist } from "./payroll-chain.js";
import {
  CAPABILITY_MISSING_TAXONOMY,
  DEFAULT_TAXONOMY,
  FIX_TYPES,
  HIGH_PRIORITY,
  IMPACT_SATURATION,
  ISSUE_TYPES,
  MEDIUM_PRIORITY,
  MIN_ISSUE_RATE,
  MIN_OUTCOMES,
  MIN_SESSIONS_WITH_ISSUES,
  OUTCOME_TYPES,
  TAXONOMY,
} from "./review-config.js";

const MAX_EVIDENCE = 20;
const MAX_DESCRIPTION_CHARS = 300;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";
const GROQ_TIMEOUT_MS = 20_000;

const round3 = (value) => Math.round(value * 1000) / 1000;
const isIssue = (event) => ISSUE_TYPES.includes(event.type);
const isOutcome = (event) => OUTCOME_TYPES.includes(event.type);

function parseDetails(detailsJson) {
  if (!detailsJson) return null;
  try {
    const parsed = JSON.parse(detailsJson);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function dismissalKey(taskCategory, taxonomy) {
  return `${taskCategory}\u0000${taxonomy}`;
}

/** details.gap_hint when it is a known taxonomy value, else capability_missing -> tools, else reliability. */
export function taxonomyForEvent(event) {
  const hint = parseDetails(event.details_json)?.gap_hint;
  if (typeof hint === "string" && TAXONOMY.includes(hint)) return hint;
  if (event.type === "capability_missing") return CAPABILITY_MISSING_TAXONOMY;
  return DEFAULT_TAXONOMY;
}

/** Most frequent mapped value among the category's issue events and capability_missing events. */
export function taxonomyForCategory(events) {
  const counts = new Map();
  for (const event of events) {
    const taxonomy = taxonomyForEvent(event);
    counts.set(taxonomy, (counts.get(taxonomy) ?? 0) + 1);
  }
  let best = DEFAULT_TAXONOMY;
  let bestCount = 0;
  for (const [taxonomy, count] of counts) {
    if (count > bestCount) {
      best = taxonomy;
      bestCount = count;
    }
  }
  return best;
}

export function priorityLabelFor(priority) {
  if (priority >= HIGH_PRIORITY) return "high";
  if (priority >= MEDIUM_PRIORITY) return "medium";
  return "low";
}

/** Deterministic numbers for one task_category inside the review window. */
export function computeCategoryMetrics(events) {
  const outcomes = events.filter(isOutcome);
  const issues = events.filter(isIssue);
  const capabilities = events.filter((event) => event.type === "capability_missing");
  const issueRate = outcomes.length ? round3(issues.length / outcomes.length) : 0;
  const sessions = new Set(issues.map((event) => event.session_id ?? "unknown-session"));
  const cost = events.reduce((sum, event) => sum + (typeof event.cost_usd === "number" ? event.cost_usd : 0), 0);
  return {
    outcomes: outcomes.length,
    issues: issues.length,
    issue_rate: issueRate,
    issues_by_type: Object.fromEntries(ISSUE_TYPES.map((type) => [type, issues.filter((event) => event.type === type).length])),
    sessions_with_issues: sessions.size,
    capability_missing: capabilities.length,
    total_cost_usd: cost > 0 ? round3(cost) : null,
  };
}

/** Issue + capability_missing events, newest first, capped at MAX_EVIDENCE. */
export function evidenceEventsFor(events) {
  return events
    .filter((event) => isIssue(event) || event.type === "capability_missing")
    .sort((left, right) => (left.ts === right.ts ? right.id.localeCompare(left.id) : right.ts.localeCompare(left.ts)))
    .slice(0, MAX_EVIDENCE);
}

function windowFor(agent, windowStart, windowEnd) {
  const end = windowEnd ?? new Date().toISOString();
  if (windowStart) return { start: windowStart, end };
  const last = getDatabase()
    .prepare("SELECT window_end FROM reviews WHERE agent_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(agent.id);
  return { start: last?.window_end ?? agent.created_at, end };
}

function existingEventIds(ids) {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  return new Set(getDatabase().prepare(`SELECT id FROM events WHERE id IN (${placeholders})`).all(...ids).map((row) => row.id));
}

export function templateDescription({ taskCategory, taxonomy, metrics }) {
  const percent = Math.round(metrics.issue_rate * 100);
  const parts = [
    `${taskCategory} needs work: ${metrics.issues} of ${metrics.outcomes} outcomes were issues (${percent}%) across ${metrics.sessions_with_issues} session(s), mostly ${taxonomy}.`,
  ];
  if (metrics.capability_missing > 0) parts.push(`${metrics.capability_missing} request(s) were blocked by a missing capability.`);
  if (metrics.total_cost_usd !== null) parts.push(`Cost so far: $${metrics.total_cost_usd.toFixed(2)}.`);
  parts.push(`Check the cited events and address ${taxonomy} before relying on this kind of task.`);
  return parts.join(" ");
}

function rejectedDescription({ taskCategory, reasons }) {
  const details = reasons.map((reason) => reason.detail).join("; ");
  return `No gap proposed for ${taskCategory}: it did not pass the evidence gate (${details}).`;
}

function parseJsonObject(content) {
  if (typeof content !== "string") return null;
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Ask Groq for a description. Returns null on missing key, failed call or invalid output so the
 * caller falls back to the template. Only computed numbers and event facts are sent.
 */
async function describeWithGroq({ agentId, taskCategory, taxonomy, metrics, evidence }) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) return null;
  const model = process.env.GROQ_MODEL?.trim() || GROQ_DEFAULT_MODEL;

  const facts = {
    agent_id: agentId,
    task_category: taskCategory,
    taxonomy,
    metrics,
    evidence_event_ids: evidence.map((event) => event.id),
    events: evidence.map((event) => ({ id: event.id, type: event.type, summary: String(event.summary ?? "").slice(0, 500) })),
  };

  let payload;
  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You explain recurring failures of an AI agent to its operator.",
              "Reply with JSON only: one object with keys description and fix_type.",
              `description: at most ${MAX_DESCRIPTION_CHARS} characters, plain language, no markdown.`,
              `fix_type: exactly one of ${FIX_TYPES.join(", ")}.`,
              "Use only the numbers, categories and event ids in the user message. Never invent event ids or facts.",
            ].join(" "),
          },
          { role: "user", content: JSON.stringify(facts) },
        ],
      }),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    return null;
  }

  const parsed = parseJsonObject(payload?.choices?.[0]?.message?.content);
  if (!parsed) return null;
  if (typeof parsed.description !== "string") return null;
  const description = parsed.description.trim();
  if (!description || description.length > MAX_DESCRIPTION_CHARS) return null;
  if (!FIX_TYPES.includes(parsed.fix_type)) return null;

  const evidenceIds = new Set(evidence.map((event) => event.id));
  const referenced = description.match(/\bevt_[A-Za-z0-9-]+/g) ?? [];
  if (referenced.some((id) => !evidenceIds.has(id))) return null;

  return { description, fix_type: parsed.fix_type, model };
}

function verdictClause(verdicts) {
  if (!verdicts.length) return "";
  const parts = verdicts.map((row) =>
    ` ${row.capability_key} on ${row.task_category}: issue rate ${Math.round(row.baseline_rate * 100)}% -> ${Math.round(row.after_rate * 100)}% over ${row.after_outcomes} task(s), verdict ${row.verdict} (cost ${formatMist(row.cost_mist)} SUI).`);
  return ` Upgrade verdicts:${parts.join("")}`;
}

function summarize({ outcome, categoryCount, totalOutcomes, categoryNames, passed, rejected, dismissed, verdicts = [] }) {
  const verdictsText = verdictClause(verdicts);
  if (outcome === "insufficient_data") {
    return `Insufficient data: ${totalOutcomes} outcome(s) across ${categoryCount} category(ies); each category needs at least ${MIN_OUTCOMES} outcomes before gaps can be reported.${verdictsText}`;
  }
  if (outcome === "no_gaps") {
    return `No gaps this period: reviewed ${totalOutcomes} outcomes across ${categoryCount} categories; ${categoryNames} had enough data but none passed the evidence gate.${verdictsText}`;
  }
  const passedList = passed.map((gap) => `${gap.task_category ?? gap.taskCategory} (${gap.taxonomy}, ${gap.priority_label ?? gap.priorityLabel} priority)`).join(", ");
  const extra = rejected + dismissed > 0 ? ` ${rejected} categor${rejected === 1 ? "y" : "ies"} rejected by the gate and ${dismissed} dismissed by the user.` : "";
  return `Found ${passed.length} gap(s) in ${totalOutcomes} outcomes across ${categoryCount} categories: ${passedList}.${extra}${verdictsText}`;
}

/**
 * Run one deterministic review for an agent: window -> metrics -> gate -> (Groq for passed gaps) -> rows.
 * Returns the stored review with its gaps. Money is never touched.
 */
export async function runReview({ agentId, periodLabel, windowStart, windowEnd }) {
  const db = getDatabase();
  const agent = db.prepare("SELECT id,name,created_at FROM agents WHERE id=?").get(agentId);
  if (!agent) {
    const error = new Error("agent not found");
    error.statusCode = 404;
    throw error;
  }

  const window = windowFor(agent, windowStart, windowEnd);
  const events = db.prepare(`
    SELECT id,type,task_category,summary,details_json,cost_usd,session_id,ts
    FROM events WHERE agent_id=? AND ts>=? AND ts<=? ORDER BY ts ASC, id ASC
  `).all(agentId, window.start, window.end);

  const dismissals = new Set(
    db.prepare("SELECT task_category,taxonomy FROM gap_dismissals WHERE agent_id=?").all(agentId)
      .map((row) => dismissalKey(row.task_category, row.taxonomy)),
  );

  // Walrus lessons are consulted together with the database: a recalled gap_dismissed lesson for
  // the same task_category blocks that category in the gate even when this database has no row.
  const lessonResult = await recallLessons(agentId, { force: false });
  const lessons = lessonResult.ok ? lessonsForAgent(agentId) : [];

  const byCategory = new Map();
  for (const event of events) {
    if (!byCategory.has(event.task_category)) byCategory.set(event.task_category, []);
    byCategory.get(event.task_category).push(event);
  }

  const reviewId = `rev_${randomUUID()}`;
  const period = periodLabel ?? `review-${window.end.slice(0, 10)}`;
  const createdAt = new Date().toISOString();
  const categoryMetrics = {};
  const pending = [];

  for (const [taskCategory, categoryEvents] of byCategory) {
    const metrics = computeCategoryMetrics(categoryEvents);
    categoryMetrics[taskCategory] = metrics;
    const evidence = evidenceEventsFor(categoryEvents);
    const evidenceIds = evidence.map((event) => event.id);
    const taxonomy = taxonomyForCategory(categoryEvents.filter((event) => isIssue(event) || event.type === "capability_missing"));

    const reasons = [];
    if (metrics.outcomes < MIN_OUTCOMES) {
      reasons.push({ code: "outcomes_below_min", detail: `${metrics.outcomes} outcome(s) in the window; at least ${MIN_OUTCOMES} required` });
    }
    if (metrics.issue_rate < MIN_ISSUE_RATE) {
      reasons.push({ code: "issue_rate_below_min", detail: `issue rate ${metrics.issue_rate} is below ${MIN_ISSUE_RATE}` });
    }
    if (metrics.sessions_with_issues < MIN_SESSIONS_WITH_ISSUES) {
      reasons.push({ code: "insufficient_recurrence", detail: `${metrics.sessions_with_issues} session(s) with issues; at least ${MIN_SESSIONS_WITH_ISSUES} required` });
    }
    const known = existingEventIds(evidenceIds);
    const missing = evidenceIds.filter((id) => !known.has(id));
    if (missing.length > 0) {
      reasons.push({ code: "evidence_not_found", detail: `evidence event id(s) not found: ${missing.join(", ")}` });
    }
    if (dismissals.has(dismissalKey(taskCategory, taxonomy))) {
      reasons.push({ code: "dismissed_by_user", detail: `${taskCategory}/${taxonomy} was dismissed by the user` });
    }
    // Either state dismisses; the walrus lesson dominates even when this database is fresh.
    const dismissalLesson = lessons.length ? lessonDismissalFor(lessons, taskCategory) : null;
    if (dismissalLesson) {
      reasons.push({
        code: "dismissed_by_user",
        detail: `${taskCategory} was dismissed by the user${dismissalLesson.blob_id ? ` (walrus lesson ${dismissalLesson.blob_id})` : " (walrus lesson)"}`,
        ...(dismissalLesson.blob_id ? { blob_id: dismissalLesson.blob_id } : {}),
      });
    }

    const status = reasons.some((reason) => reason.code === "dismissed_by_user")
      ? "dismissed"
      : reasons.length > 0
        ? "rejected_gate"
        : "passed_gate";

    const severity = metrics.issue_rate;
    const impact = round3(Math.min(1, metrics.issues / IMPACT_SATURATION));
    const priority = round3(severity * impact);
    const priorityLabel = priorityLabelFor(priority);

    pending.push({
      id: `gap_${randomUUID()}`,
      taskCategory,
      taxonomy,
      metrics,
      evidence,
      evidenceIds,
      severity,
      impact,
      priority,
      priorityLabel,
      status,
      reasons,
      description: status === "passed_gate" ? null : rejectedDescription({ taskCategory, reasons }),
      descriptionSource: "template",
      fixType: null,
    });
  }

  const passed = pending.filter((gap) => gap.status === "passed_gate");
  const gatesWithData = Object.values(categoryMetrics).filter((metrics) => metrics.outcomes >= MIN_OUTCOMES).length;
  const outcome = gatesWithData === 0 ? "insufficient_data" : passed.length > 0 ? "gaps_found" : "no_gaps";

  await Promise.all(passed.map(async (gap) => {
    const described = await describeWithGroq({
      agentId,
      taskCategory: gap.taskCategory,
      taxonomy: gap.taxonomy,
      metrics: gap.metrics,
      evidence: gap.evidence,
    });
    if (described) {
      gap.description = described.description;
      gap.descriptionSource = "llm";
      gap.fixType = described.fix_type;
    } else {
      gap.description = templateDescription({ taskCategory: gap.taskCategory, taxonomy: gap.taxonomy, metrics: gap.metrics });
      gap.descriptionSource = "template";
      gap.fixType = null;
    }
  }));

  // Verdicts already recorded for categories in this window are folded into the summary text.
  const categories = Object.keys(categoryMetrics);
  const verdicts = categories.length
    ? db.prepare(`SELECT * FROM upgrade_verdicts WHERE agent_id=? AND task_category IN (${categories.map(() => "?").join(",")}) ORDER BY evaluated_at DESC, rowid DESC LIMIT 3`)
      .all(agentId, ...categories)
    : [];

  const summary = summarize({
    outcome,
    categoryCount: byCategory.size,
    totalOutcomes: Object.values(categoryMetrics).reduce((sum, metrics) => sum + metrics.outcomes, 0),
    categoryNames: Object.keys(categoryMetrics).join(", ") || "no category",
    passed,
    rejected: pending.filter((gap) => gap.status === "rejected_gate").length,
    dismissed: pending.filter((gap) => gap.status === "dismissed").length,
    verdicts,
  });

  const metricsJson = {
    window,
    walrus_lessons: lessonResult.ok ? { ok: true, used: lessons.length } : { ok: false, error: lessonResult.error ?? "recall failed" },
    categories: categoryMetrics,
    thresholds: {
      min_outcomes: MIN_OUTCOMES,
      min_issue_rate: MIN_ISSUE_RATE,
      min_sessions_with_issues: MIN_SESSIONS_WITH_ISSUES,
      impact_saturation: IMPACT_SATURATION,
      high_priority: HIGH_PRIORITY,
      medium_priority: MEDIUM_PRIORITY,
    },
    description_sources: {
      llm: passed.filter((gap) => gap.descriptionSource === "llm").length,
      template: pending.filter((gap) => gap.descriptionSource === "template").length,
    },
  };

  const memoryId = newMemoryId();
  const memoryText = `Agent ${agentId} | review | ${period} | outcome: ${outcome} | ${summary}`;

  const write = db.transaction(() => {
    db.prepare(`INSERT INTO reviews(id,agent_id,period_label,window_start,window_end,metrics_json,outcome,summary,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      reviewId, agentId, period, window.start, window.end, JSON.stringify(metricsJson), outcome, summary, createdAt,
    );
    const insertGap = db.prepare(`INSERT INTO gaps(id,review_id,agent_id,task_category,taxonomy,metrics_json,evidence_event_ids_json,
      severity,impact,priority,priority_label,status,gate_reasons_json,description,description_source,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const gap of pending) {
      insertGap.run(
        gap.id, reviewId, agentId, gap.taskCategory, gap.taxonomy,
        JSON.stringify({ ...gap.metrics, fix_type: gap.fixType }),
        JSON.stringify(gap.evidenceIds), gap.severity, gap.impact, gap.priority, gap.priorityLabel,
        gap.status, JSON.stringify(gap.reasons), gap.description, gap.descriptionSource, createdAt,
      );
    }
    db.prepare("INSERT INTO memories(id,event_id,review_id,agent_id,text,status,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(memoryId, null, reviewId, agentId, memoryText, "pending", createdAt);
  });
  write();
  enqueueMemory(memoryId);

  return {
    review: publicReview(db.prepare("SELECT * FROM reviews WHERE id=?").get(reviewId)),
    gaps: db.prepare("SELECT * FROM gaps WHERE review_id=? ORDER BY priority DESC, task_category").all(reviewId).map(publicGap),
    memory_id: memoryId,
  };
}

export function publicReview(row) {
  if (!row) return null;
  const { metrics_json, ...rest } = row;
  return { ...rest, metrics: metrics_json ? JSON.parse(metrics_json) : null };
}

export function publicGap(row) {
  if (!row) return null;
  const { metrics_json, evidence_event_ids_json, gate_reasons_json, ...rest } = row;
  return {
    ...rest,
    metrics: metrics_json ? JSON.parse(metrics_json) : null,
    evidence_event_ids: evidence_event_ids_json ? JSON.parse(evidence_event_ids_json) : [],
    gate_reasons: gate_reasons_json ? JSON.parse(gate_reasons_json) : [],
  };
}
