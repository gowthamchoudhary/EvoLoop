import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { getConfig } from "../src/config.js";
import { HIGH_PRIORITY, IMPACT_SATURATION, MEDIUM_PRIORITY } from "../src/review-config.js";

const config = getConfig();
const baseUrl = process.env.SMOKE_BASE_URL?.trim() || `http://127.0.0.1:${config.PORT}`;
const secrets = [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN, config.WALLET_ENC_KEY].filter(Boolean);
const state = { agentId: null, apiKey: null, events: {}, eventIds: [], reviewIds: [], dismissedGapId: null };
let passed = 0;
let failed = 0;
let stopping = false;

function safeMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  return message.replace(/\b(?:plk_[a-f0-9]{64}|(?:0x)?[a-f0-9]{64})\b/gi, "[REDACTED]");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

function requireStatus(result, expected, description) {
  if (result.status !== expected) {
    throw new Error(`${description} returned HTTP ${result.status}: ${typeof result.data === "string" ? result.data : JSON.stringify(result.data)}`);
  }
  return result.data;
}

class StepFailure extends Error {}

async function step(name, action) {
  const started = Date.now();
  try {
    const detail = await action();
    passed += 1;
    console.log(`PASS ${name} (${Date.now() - started} ms)${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    failed += 1;
    stopping = true;
    console.log(`FAIL ${name} (${Date.now() - started} ms): ${safeMessage(error)}`);
    throw new StepFailure(safeMessage(error));
  }
}

function codes(gap) {
  return (gap.gate_reasons ?? []).map((reason) => reason.code);
}

function evidenceIds(gaps) {
  return gaps.flatMap((gap) => gap.evidence_event_ids);
}

const random = randomBytes(3).toString("hex");
const agentName = `smoke-review-${random}`;
const now = Date.now();
const base = now - 120_000;
let eventClock = 0;
const windowStart = new Date(base - 60_000).toISOString();
const windowEnd = new Date(now + 60_000).toISOString();

const scenario = [
  // finance_qa: 8 outcomes across 3 sessions, 4 user_corrected with gap_hint knowledge, plus one capability_missing.
  { key: "fin1", type: "task_completed", task_category: "finance_qa", session_id: "s1-finance", summary: "Answered a VAT question from the ledger." },
  { key: "fin2", type: "user_corrected", task_category: "finance_qa", session_id: "s1-finance", summary: "Used the old VAT rate.", correction: "the 2026 rate is 21 percent", details: { gap_hint: "knowledge" } },
  { key: "fin3", type: "user_corrected", task_category: "finance_qa", session_id: "s1-finance", summary: "Mixed up two vendor invoices.", correction: "invoice 118 is Acme, not Globex", details: { gap_hint: "knowledge" } },
  { key: "fin4", type: "task_completed", task_category: "finance_qa", session_id: "s2-finance", summary: "Reconciled the weekly expenses." },
  { key: "fin5", type: "task_completed", task_category: "finance_qa", session_id: "s2-finance", summary: "Explained a cash-flow line item." },
  { key: "fin6", type: "user_corrected", task_category: "finance_qa", session_id: "s2-finance", summary: "Reported the wrong fiscal quarter.", correction: "we are in Q4 2026", details: { gap_hint: "knowledge" } },
  { key: "fin7", type: "task_completed", task_category: "finance_qa", session_id: "s3-finance", summary: "Summarised the receivable ageing." },
  { key: "fin8", type: "user_corrected", task_category: "finance_qa", session_id: "s3-finance", summary: "Guessed the FX rate instead of looking it up.", correction: "use the rate from the daily feed", details: { gap_hint: "knowledge" } },
  { key: "fin9", type: "capability_missing", task_category: "finance_qa", summary: "Could not open the accounting export format.", details: { missing: "accounting export parser" } },
  // scheduling: 6 outcomes in 2 sessions with one failure.
  { key: "sch1", type: "task_completed", task_category: "scheduling", session_id: "s1-scheduling", summary: "Booked a 30 minute sync." },
  { key: "sch2", type: "task_completed", task_category: "scheduling", session_id: "s1-scheduling", summary: "Moved a meeting to Thursday." },
  { key: "sch3", type: "task_failed", task_category: "scheduling", session_id: "s1-scheduling", summary: "Double-booked the 14:00 slot." },
  { key: "sch4", type: "task_completed", task_category: "scheduling", session_id: "s2-scheduling", summary: "Found an open slot for the review." },
  { key: "sch5", type: "task_completed", task_category: "scheduling", session_id: "s2-scheduling", summary: "Declined a conflicting invite." },
  { key: "sch6", type: "task_completed", task_category: "scheduling", session_id: "s2-scheduling", summary: "Sent the weekly agenda." },
  // pdf_summary: 3 outcomes, all failures - too few outcomes.
  { key: "pdf1", type: "task_failed", task_category: "pdf_summary", session_id: "s1-pdf", summary: "Skipped the appendix tables." },
  { key: "pdf2", type: "task_failed", task_category: "pdf_summary", session_id: "s1-pdf", summary: "Dropped the chart captions." },
  { key: "pdf3", type: "task_failed", task_category: "pdf_summary", session_id: "s2-pdf", summary: "Returned an empty summary." },
  // email_draft: 7 outcomes, 4 failures, all in one session - fails recurrence.
  { key: "mail1", type: "task_failed", task_category: "email_draft", session_id: "s1-email", summary: "Used the wrong greeting." },
  { key: "mail2", type: "task_failed", task_category: "email_draft", session_id: "s1-email", summary: "Left a placeholder name in the body." },
  { key: "mail3", type: "task_completed", task_category: "email_draft", session_id: "s1-email", summary: "Drafted a renewal reminder." },
  { key: "mail4", type: "task_failed", task_category: "email_draft", session_id: "s1-email", summary: "Attached nothing while promising an invoice." },
  { key: "mail5", type: "task_completed", task_category: "email_draft", session_id: "s1-email", summary: "Drafted a short follow-up." },
  { key: "mail6", type: "task_failed", task_category: "email_draft", session_id: "s1-email", summary: "Wrote an apology that promises a refund." },
  { key: "mail7", type: "task_completed", task_category: "email_draft", session_id: "s1-email", summary: "Drafted a scheduling confirmation." },
];

async function postEvent(event) {
  const response = await request("/v1/events", {
    token: state.apiKey,
    method: "POST",
    body: {
      type: event.type,
      task_category: event.task_category,
      summary: event.summary,
      ...(event.correction ? { correction: event.correction } : {}),
      ...(event.details ? { details: event.details } : {}),
      ...(event.session_id ? { session_id: event.session_id } : {}),
      ts: new Date(base + eventClock++ * 1_000).toISOString(),
    },
  });
  const data = requireStatus(response, 201, `Post ${event.type} for ${event.task_category}`);
  assert(data.event_id, `Missing event id for ${event.type}`);
  state.events[event.key] = data.event_id;
  state.eventIds.push(data.event_id);
  return data.event_id;
}

async function runReviewStep(label, body, expectedStatus = 201) {
  const response = await request(`/v1/agents/${encodeURIComponent(state.agentId)}/review/run`, {
    token: config.ADMIN_TOKEN,
    method: "POST",
    body,
  });
  const data = requireStatus(response, expectedStatus, label);
  state.reviewIds.push(data.review.id);
  return data;
}

async function reviewMemories() {
  const rows = requireStatus(await request("/v1/memories", { token: config.ADMIN_TOKEN }), 200, "List memories");
  return rows.filter((row) => row.agent_id === state.agentId && row.event_id === null && String(row.text).includes(`Agent ${state.agentId} | review |`));
}

function assertLinked(memories, reviewId, label) {
  assert(memories.some((row) => row.review_id === reviewId), `${label}: no memory row is linked to review ${reviewId}`);
}

try {
  await step("Health check", async () => {
    const health = requireStatus(await request("/health"), 200, "Health");
    assert(health.status === "ok", `Health status was ${health.status}`);
    return `${baseUrl} ok`;
  });

  await step(`Register fresh agent ${agentName}`, async () => {
    const data = requireStatus(await request("/v1/agents/register", {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: { name: agentName, kind: "smoke", description: "Block 3 review engine smoke agent" },
    }), 201, "Register agent");
    state.agentId = data.agent_id;
    state.apiKey = data.api_key;
    assert(state.agentId && state.apiKey, "Registration response was incomplete");
    return `${state.agentId}; API key withheld`;
  });

  await step("PUT/GET agent settings", async () => {
    const put = await request(`/v1/agents/${encodeURIComponent(state.agentId)}/settings`, {
      token: config.ADMIN_TOKEN,
      method: "PUT",
      body: {
        period: "weekly",
        period_minutes: 10080,
        allowance_mist: "500000000",
        improvement_reserve_pct: 25,
        autonomy: "auto_small",
        auto_limit_mist: "10000000",
        rollover: true,
      },
    });
    const saved = requireStatus(put, 200, "PUT settings");
    assert(saved.period === "weekly" && saved.improvement_reserve_pct === 25 && saved.autonomy === "auto_small" && saved.rollover === 1,
      `Settings were not stored as sent: ${JSON.stringify(saved)}`);
    const fetched = requireStatus(await request(`/v1/agents/${encodeURIComponent(state.agentId)}/settings`, { token: config.ADMIN_TOKEN }), 200, "GET settings");
    assert(fetched.period_minutes === 10080 && fetched.auto_limit_mist === "10000000", "Stored settings did not round-trip");
    const invalid = await request(`/v1/agents/${encodeURIComponent(state.agentId)}/settings`, {
      token: config.ADMIN_TOKEN,
      method: "PUT",
      body: { improvement_reserve_pct: 150 },
    });
    assert(invalid.status === 400, `improvement_reserve_pct 150 should be rejected, got HTTP ${invalid.status}`);
    return "weekly settings stored; pct 150 rejected with 400";
  });

  await step("Post scenario events", async () => {
    for (const event of scenario) await postEvent(event);
    assert(state.eventIds.length === 25, `Expected 25 events, posted ${state.eventIds.length}`);
    return "25 events across finance_qa, scheduling, pdf_summary, email_draft";
  });

  await step("Event session_id defaults to UTC date", async () => {
    const events = requireStatus(
      await request(`/v1/agents/${encodeURIComponent(state.agentId)}/events?limit=100`, { token: config.ADMIN_TOKEN }),
      200,
      "List events",
    );
    const capability = events.find((event) => event.id === state.events.fin9);
    assert(capability, "capability_missing event was not returned by the API");
    const expected = new Date(new Date(capability.ts).toISOString().slice(0, 10)).toISOString().slice(0, 10);
    assert(capability.session_id === expected, `session_id defaulted to ${capability.session_id}, expected ${expected}`);
    const explicit = events.find((event) => event.id === state.events.fin1);
    assert(explicit.session_id === "s1-finance", "Explicit session_id was not stored");
    return `default ${capability.session_id}, explicit s1-finance`;
  });

  await step("Run review 1 and read the gate results", async () => {
      const { review, gaps } = await runReviewStep("Run review", { period_label: "smoke-block3-1", window_start: windowStart, window_end: windowEnd });
      assert(review.outcome === "gaps_found", `Review outcome was ${review.outcome}`);
      assert(gaps.length === 4, `Expected 4 category gaps, got ${gaps.length}`);
      const byCategory = Object.fromEntries(gaps.map((gap) => [gap.task_category, gap]));

      const finance = byCategory.finance_qa;
      assert(finance, "finance_qa gap is missing");
      assert(finance.status === "passed_gate", `finance_qa status was ${finance.status}`);
      assert(finance.taxonomy === "knowledge", `finance_qa taxonomy was ${finance.taxonomy}`);
      assert(finance.metrics.outcomes === 8 && finance.metrics.issues === 4, `finance_qa metrics were ${JSON.stringify(finance.metrics)}`);
      assert(finance.metrics.sessions_with_issues === 3, `finance_qa sessions_with_issues was ${finance.metrics.sessions_with_issues}`);

      const expectedSeverity = Math.round((4 / 8) * 1000) / 1000;
      const expectedImpact = Math.min(1, 4 / IMPACT_SATURATION);
      const expectedPriority = Math.round(expectedSeverity * expectedImpact * 1000) / 1000;
      const expectedLabel = expectedPriority >= HIGH_PRIORITY ? "high" : expectedPriority >= MEDIUM_PRIORITY ? "medium" : "low";
      assert(finance.severity === expectedSeverity, `severity ${finance.severity} != ${expectedSeverity}`);
      assert(Math.abs(finance.impact - expectedImpact) < 1e-9, `impact ${finance.impact} != ${expectedImpact}`);
      assert(finance.priority === expectedPriority, `priority ${finance.priority} != ${expectedPriority}`);
      assert(finance.priority_label === expectedLabel, `priority_label ${finance.priority_label} != ${expectedLabel}`);

      assert(finance.evidence_event_ids.length === 5, `finance_qa evidence count was ${finance.evidence_event_ids.length}`);
      assert(finance.evidence_event_ids.includes(state.events.fin9), "finance_qa evidence is missing the capability_missing event");
      assert(finance.description && finance.description.length > 0, "finance_qa has no description");
      assert(finance.description.length <= 300, `description is ${finance.description.length} chars (max 300)`);

      const scheduling = byCategory.scheduling;
      assert(scheduling.status === "rejected_gate", `scheduling status was ${scheduling.status}`);
      assert(codes(scheduling).includes("issue_rate_below_min"), `scheduling reasons: ${codes(scheduling).join(",")}`);
      assert(codes(scheduling).includes("insufficient_recurrence"), `scheduling reasons: ${codes(scheduling).join(",")}`);
      assert(!codes(scheduling).includes("outcomes_below_min"), "scheduling should have enough outcomes");

      const pdf = byCategory.pdf_summary;
      assert(pdf.status === "rejected_gate", `pdf_summary status was ${pdf.status}`);
      assert(JSON.stringify(codes(pdf)) === JSON.stringify(["outcomes_below_min"]), `pdf_summary reasons: ${codes(pdf).join(",")}`);
      assert(pdf.description_source === "template", "gate-rejected gap must not use the LLM description");

      const email = byCategory.email_draft;
      assert(email.status === "rejected_gate", `email_draft status was ${email.status}`);
      assert(JSON.stringify(codes(email)) === JSON.stringify(["insufficient_recurrence"]), `email_draft reasons: ${codes(email).join(",")}`);

      const allEvidence = evidenceIds(gaps);
      assert(allEvidence.length > 0, "No evidence ids were cited");
      const known = new Set((requireStatus(
        await request(`/v1/agents/${encodeURIComponent(state.agentId)}/events?limit=100`, { token: config.ADMIN_TOKEN }),
        200,
        "List events for evidence check",
      )).map((event) => event.id));
      const missing = allEvidence.filter((id) => !known.has(id));
      assert(missing.length === 0, `Evidence ids missing from the database: ${missing.join(", ")}`);
      for (const gap of gaps) assert(gap.evidence_event_ids.length <= 20, `${gap.task_category} cited ${gap.evidence_event_ids.length} evidence ids (max 20)`);

      state.dismissedGapId = finance.id;
      const sources = gaps.reduce((counts, gap) => ({ ...counts, [gap.description_source]: (counts[gap.description_source] ?? 0) + 1 }), {});
      return `outcome ${review.outcome}; passed finance_qa (knowledge, ${finance.priority_label}, priority ${finance.priority}); rejected ${gaps.length - 1}; description sources ${JSON.stringify(sources)}`;
  });

  await step("Review memory queued for review 1", async () => {
    const memories = await reviewMemories();
    const match = memories.find((row) => String(row.text).includes("outcome: gaps_found"));
    assert(match, `No review memory queued: ${JSON.stringify(memories.map((row) => row.text))}`);
    assertLinked(memories, state.reviewIds[0], "Review 1 memory link");
    return `${match.status}; linked to ${state.reviewIds[0]}; "${match.text.slice(0, 90)}..."`;
  });

  await step("Dismiss the finance_qa gap", async () => {
    assert(state.dismissedGapId, "No finance_qa gap id was captured");
    const data = requireStatus(await request(`/v1/gaps/${encodeURIComponent(state.dismissedGapId)}/dismiss`, {
      token: config.ADMIN_TOKEN,
      method: "POST",
    }), 200, "Dismiss gap");
    assert(data.status === "dismissed", `Dismiss returned status ${data.status}`);
    assert(data.gap.status === "dismissed", "Gap row was not marked dismissed");
    const memories = requireStatus(await request("/v1/memories", { token: config.ADMIN_TOKEN }), 200, "List memories");
    const dismissal = memories.find((row) => row.agent_id === state.agentId && String(row.text) === "gap dismissed by user: finance_qa");
    assert(dismissal, "No dismissal memory was queued");
    return `gap dismissed; memory ${dismissal.status}`;
  });

  await step("Second review with the same window keeps the dismissal", async () => {
    const data = await runReviewStep("Run review again", { period_label: "smoke-block3-2", window_start: windowStart, window_end: windowEnd });
    const { review, gaps } = data;
    assert(review.outcome === "no_gaps", `Second review outcome was ${review.outcome}`);
    assert(gaps.length === 4, `Second review had ${gaps.length} gaps`);
    const finance = gaps.find((gap) => gap.task_category === "finance_qa");
    assert(finance, "Second review is missing the finance_qa row");
    assert(finance.status === "dismissed", `finance_qa status was ${finance.status}`);
    assert(codes(finance).includes("dismissed_by_user"), `finance_qa reasons: ${codes(finance).join(",")}`);
    assert(!gaps.some((gap) => gap.status === "passed_gate"), "A dismissed gap was proposed again");
    const memories = await reviewMemories();
    assert(memories.some((row) => String(row.text).includes("outcome: no_gaps")), "No no_gaps review memory was queued");
    assertLinked(memories, state.reviewIds[1], "Review 2 memory link");
    return `outcome ${review.outcome}; finance_qa dismissed by user`;
  });

  await step("Review of an empty window returns insufficient_data", async () => {
    const data = await runReviewStep("Run empty review", {
      period_label: "smoke-block3-empty",
      window_start: "2000-01-01T00:00:00.000Z",
      window_end: "2000-01-02T00:00:00.000Z",
    });
    assert(data.review.outcome === "insufficient_data", `Empty review outcome was ${data.review.outcome}`);
    assert(data.gaps.length === 0, `Empty review produced ${data.gaps.length} gaps`);
    assert(data.review.summary.toLowerCase().includes("insufficient data"), `Summary was: ${data.review.summary}`);
    const memories = await reviewMemories();
    assert(memories.some((row) => String(row.text).includes("outcome: insufficient_data")), "No insufficient_data review memory was queued");
    assertLinked(memories, state.reviewIds[2], "Empty review memory link");
    return `${data.review.outcome}; ${data.review.window_start} -> ${data.review.window_end}`;
  });

  await step("Read review detail and agent review list", async () => {
    assert(state.reviewIds.length === 3, `Expected 3 reviews, tracked ${state.reviewIds.length}`);
    const detail = requireStatus(await request(`/v1/reviews/${encodeURIComponent(state.reviewIds[0])}`, { token: config.ADMIN_TOKEN }), 200, "GET /v1/reviews/:id");
    assert(detail.gaps.length === 4, `Review detail returned ${detail.gaps.length} gaps`);
    const list = requireStatus(await request(`/v1/agents/${encodeURIComponent(state.agentId)}/reviews`, { token: config.ADMIN_TOKEN }), 200, "GET reviews");
    assert(list.length === 3, `Agent review list returned ${list.length} reviews`);
    const memories = await reviewMemories();
    assert(memories.length === 3, `Expected 3 review memories, found ${memories.length}`);
    assert(memories.every((row) => row.review_id && state.reviewIds.includes(row.review_id)), "Every review memory must be linked to a review id");
    return `3 reviews listed; 3 review memories queued (${memories.map((row) => row.status).join(", ")})`;
  });
} catch (error) {
  if (!(error instanceof StepFailure)) {
    failed += 1;
    console.log(`FAIL unexpected error: ${safeMessage(error)}`);
  }
} finally {
  if (state.agentId) {
    try {
      const db = new Database(resolve(config.DB_PATH));
      db.prepare("UPDATE agents SET status='inactive' WHERE id=?").run(state.agentId);
      db.close();
      console.log(`CLEANUP agent ${state.agentId} deactivated`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL cleanup could not deactivate agent ${state.agentId}: ${safeMessage(error)}`);
    }
  }
}

console.log(`Summary: ${passed} passed, ${failed} failed${stopping ? " (stopped at first failure)" : ""}`);
process.exitCode = failed === 0 ? 0 : 1;
export {};
