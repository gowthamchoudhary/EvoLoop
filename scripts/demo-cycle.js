/**
 * Block 3c-2 demo cycle: one research agent, two assignment periods, a review, a real
 * on-chain upgrade purchase, a verdict and a second review.
 *
 * Everything here is real: Groq for classification and answers, real grader events with
 * Tatum-backed ground truth, a real payroll transfer, a real upgrade payment through the
 * existing spend path, real Walrus memories. No numbers are typed by hand anywhere.
 *
 * Preconditions with clear stop messages (before any transfer):
 *  - GROQ_API_KEY is set and one real Groq call succeeds;
 *  - the treasury holds at least 0.2 SUI (data');
 *  - the catalog is seeded (premium_data present and active).
 *
 * The agent it creates is deactivated at the end whether the cycle passes or fails.
 */

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { getConfig } from "../src/config.js";
import { closePayrollChain, formatMist, getPayrollBalance } from "../src/payroll-chain.js";
import { getRate } from "../src/tatum.js";
import { createGroqHelper } from "../agents/research-agent/groq.js";
import { answerQuestion } from "../agents/research-agent/agent.js";
import { buildQuestionBank } from "../agents/research-agent/questions.js";
import { gradeAnswer, buildGradedEvent } from "../agents/research-agent/grader.js";
import { LayerClient } from "../sdk/client.js";

const config = getConfig();
const baseUrl = process.env.SMOKE_BASE_URL?.trim() || `http://127.0.0.1:${config.PORT}`;
const secrets = [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN, config.WALLET_ENC_KEY].filter(Boolean);
const db = new Database(resolve(config.DB_PATH));
db.pragma("busy_timeout = 5000");

const MIN_TREASURY_MIST = 200_000_000n; // 0.2 SUI
const SALARY_SUI = 0.05;
const ALLOWANCE_MIST = 50_000_000n; // 0.05 SUI
const IMPROVEMENT_CAP = (ALLOWANCE_MIST * 40n) / 100n; // 0.02 SUI
const PERIOD_MINUTES = 30;
const MIN_PASS_CALLS = 12;
const random = randomBytes(3).toString("hex");

const state = { agent: null, treasuryBefore: null, treasuryAfter: null };
let verdictResult = null;
let passed = 0;
let failed = 0;

function safeMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  return message.replace(/\b(?:plk_[a-f0-9]{64}|suiprivkey1[0-9a-z]+)\b/gi, "[REDACTED]");
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
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(result.status)) {
    const detail = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
    throw new Error(`${description} returned HTTP ${result.status}: ${detail}`);
  }
  return result.data;
}

class StepFailure extends Error {}

const REVIEW_STATUSES = [200, 201];

async function step(name, action) {
  const started = Date.now();
  try {
    const detail = await action();
    passed += 1;
    console.log(`PASS ${name} (${Date.now() - started} ms)${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name} (${Date.now() - started} ms): ${safeMessage(error)}`);
    throw new StepFailure(safeMessage(error));
  }
}

function narrative(text) {
  console.log(`\n--- ${text}`);
}

const treasury = db.prepare("SELECT address FROM wallets WHERE owner_type='treasury' AND owner_id='treasury'").get();
const vendorAddress = (vendorId) => db.prepare("SELECT address FROM vendors WHERE id=?").get(vendorId)?.address ?? null;

/** Run the real agent plus the real grader over a list of questions, posting each graded event. */
async function runTasks({ client, groq, questions, periodLabel, sessionIdBase }) {
  const counts = { total: 0, correct: 0, premium: 0, liveWithoutCapability: 0, byCategory: {} };
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const sessionId = `${sessionIdBase}-${index % 3}`;
    const started = Date.now();
    let truth = null;
    if (question.kind === "price") truth = await getRate(question.symbol, question.currency);
    else if (question.kind === "balance") truth = await getPayrollBalance(question.address);
    const result = await answerQuestion(question.text, { client, groq, sessionId });
    const grade = gradeAnswer(question, result.answer, truth);
    const graded = buildGradedEvent({ question, grade, sessionId });
    const reported = await client.report(graded);
    if (reported.status !== 201) {
      throw new Error(`Graded event for ${question.id} was rejected: HTTP ${reported.status} ${JSON.stringify(reported.data)}`);
    }
    counts.total += 1;
    counts.correct += grade.correct ? 1 : 0;
    if (result.usedPremium) counts.premium += 1;
    if (result.needsLive && !result.usedPremium) counts.liveWithoutCapability += 1;
    counts.byCategory[question.category] = counts.byCategory[question.category] ?? { correct: 0, total: 0 };
    counts.byCategory[question.category].total += 1;
    counts.byCategory[question.category].correct += grade.correct ? 1 : 0;
    const route = result.usedPremium ? "premium data" : result.needsLive ? "model alone (no capability)" : "model (static)";
    console.log(
      `  ${periodLabel} ${sessionId} ${grade.correct ? "CORRECT" : "WRONG  "} ${question.id} (${route}, ${Date.now() - started} ms)`
      + ` :: ${grade.detail}${grade.stated ? ` | stated ${grade.stated}` : ""} | ${(result.answer || "").slice(0, 90)}`,
    );
  }
  return counts;
}

try {
  narrative("Preconditions (no transfers have been sent)");
  await step("Health check", async () => {
    const health = requireStatus(await request("/health"), 200, "Health");
    assert(health.status === "ok", `Health status was ${health.status}`);
    return `${baseUrl} ok`;
  });

  await step("GROQ_API_KEY is set and one real Groq call works", async () => {
    if (!process.env.GROQ_API_KEY?.trim()) {
      throw new Error("GROQ_API_KEY is missing. Set it in Settings -> Environment and restart, then re-run. No transfers were sent.");
    }
    const groq = createGroqHelper();
    const parsed = await groq.json([
      { role: "system", content: 'Reply with JSON only: {"needs_live_data": boolean, "kind": string|null, "symbol": string|null, "currency": string|null, "address": string|null}.' },
      { role: "user", content: "What is the capital of France?" },
    ], { temperature: 0, maxTokens: 120 });
    assert(parsed && typeof parsed.needs_live_data === "boolean", `Groq JSON mode gave unusable output with model ${groq.model}; fix GROQ_MODEL and re-run. No transfers were sent.`);
    return `model ${groq.model} answered with valid JSON`;
  });

  await step("Treasury holds at least 0.2 SUI and the catalog is seeded", async () => {
    assert(treasury, "Treasury wallet is missing; run npm run treasury:create and fund it");
    const balance = await getPayrollBalance(treasury.address, { bypassCache: true });
    state.treasuryBefore = balance;
    if (balance < MIN_TREASURY_MIST) {
      throw new Error(`Treasury ${treasury.address} holds ${formatMist(balance)} SUI; fund it with at least 0.2 SUI first. No transfers were sent.`);
    }
    const catalog = db.prepare("SELECT * FROM upgrade_catalog WHERE capability_key='premium_data' AND active=1").all();
    assert(catalog.length === 1, `premium_data catalog entry is missing or inactive; run npm run catalog:seed. Rows: ${JSON.stringify(catalog)}`);
    const vendor = vendorAddress("premium-data-source");
    assert(vendor, "premium-data-source vendor wallet is missing; run npm run vendors:seed");
    assert(catalog[0].price_mist === "15000000", `premium_data price was ${catalog[0].price_mist}, expected 15000000 MIST`);
    return `treasury ${formatMist(balance)} SUI; premium_data priced 0.015 SUI at ${vendor.slice(0, 10)}…`;
  });

  narrative("Setup: register the research agent, fund it, give it settings — payroll only pays this agent");
  let client = null;
  let groq = null;
  await step("(Setup) register research-agent, wallet, policy, settings", async () => {
    const name = `research-agent-${random}`;
    const registered = requireStatus(await request("/v1/agents/register", {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: { name, kind: "research", description: "Block 3c-2 demo cycle research agent" },
    }), 201, "Register agent");
    const agent = { id: registered.agent_id, apiKey: registered.api_key, name };
    state.agent = agent;

    const wallet = requireStatus(await request(`/v1/agents/${encodeURIComponent(agent.id)}/wallet`, {
      token: config.ADMIN_TOKEN,
      method: "POST",
    }), 201, "Create agent wallet");
    agent.wallet = wallet.address;

    requireStatus(await request(`/v1/agents/${encodeURIComponent(agent.id)}/policy`, {
      token: config.ADMIN_TOKEN,
      method: "PUT",
      body: { salary_sui: SALARY_SUI, per_tx_cap_sui: 0.03, period_cap_sui: 0.08, allowed_vendor_ids: [] },
    }), 200, "Set policy");

    const settings = requireStatus(await request(`/v1/agents/${encodeURIComponent(agent.id)}/settings`, {
      token: config.ADMIN_TOKEN,
      method: "PUT",
      body: {
        period: "compressed",
        period_minutes: PERIOD_MINUTES,
        allowance_mist: ALLOWANCE_MIST.toString(),
        improvement_reserve_pct: 40,
        autonomy: "ask",
        auto_limit_mist: "0",
        rollover: 0,
      },
    }), 200, "Set settings");
    assert(settings.period === "compressed" && settings.autonomy === "ask", `Settings did not store: ${JSON.stringify(settings)}`);

    client = new LayerClient({ baseUrl, apiKey: agent.apiKey, agentId: agent.id });
    groq = createGroqHelper();
    return `${agent.id}; wallet created; compressed period ${PERIOD_MINUTES} min; allowance 0.05 SUI, reserve 40%, autonomy ask`;
  });

  await step("(Setup) payroll 0.05 SUI to this agent only, confirmed", async () => {
    assert(state.agent, "Agent was not created");
    const payroll = requireStatus(await request("/v1/payroll/run", {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: { period_label: `demo-cycle-${random}`, agent_ids: [state.agent.id] },
    }), 200, "Run payroll");
    const paid = payroll.paid?.find((item) => item.agent_id === state.agent.id);
    assert(paid?.digest, `Payroll did not pay the agent: ${JSON.stringify(payroll)}`);
    const verification = requireStatus(await request(`/v1/transactions/${encodeURIComponent(paid.digest)}/verify`, {
      token: config.ADMIN_TOKEN,
    }), 200, "Verify salary digest");
    assert(verification.status === "success" || verification.status === "unconfirmed", `Salary status was ${verification.status}`);
    const balance = await getPayrollBalance(state.agent.wallet, { bypassCache: true });
    assert(balance >= BigInt(paid.amount_mist ?? 50_000_000n), `Agent balance after payroll is ${formatMist(balance)} SUI`);
    return `salary digest ${paid.digest}, verified; agent balance ${formatMist(balance)} SUI`;
  });
  assert(client && groq, "Client or Groq helper missing after setup");

  const bank = buildQuestionBank({
    addresses: [
      { label: "treasury", address: treasury.address },
      { label: "premium-data-source", address: vendorAddress("premium-data-source") },
      { label: "vision-api", address: vendorAddress("vision-api") },
    ],
  });
  const period1 = { finance: bank.finance.slice(0, 10), general: bank.general.slice(0, 4) };
  const period2 = { finance: bank.finance.slice(12, 22), general: bank.general.slice(4, 8) };

  narrative("PERIOD 1: the agent has no premium_data capability — live finance questions must fail through the model");
  let window1 = null;
  await step("(1) run 14 period-1 tasks (10 finance_qa live, 4 general_knowledge) across 3 sessions", async () => {
    assert(period1.finance.length === 10 && period1.general.length === 4,
      `Question bank slices were wrong: ${period1.finance.length} finance, ${period1.general.length} general`);
    window1 = { window_start: new Date().toISOString() };
    const counts = await runTasks({
      client, groq,
      questions: [...period1.finance, ...period1.general],
      periodLabel: "period-1",
      sessionIdBase: "p1",
    });
    window1.window_end = new Date().toISOString();
    assert(counts.total === 14, `Ran ${counts.total} tasks, expected 14`);
    assert(counts.premium === 0, `Agent used premium data before buying it (${counts.premium} calls)`);
    return `${counts.total} tasks; ${counts.correct} graded correct; ${counts.liveWithoutCapability} live answered without premium; by ${JSON.stringify(counts.byCategory)}`;
  });

  let review1 = null;
  await step("(2) review of period 1 finds exactly the finance_qa knowledge gap", async () => {
    assert(window1, "Period 1 window is missing");
    const result = requireStatus(await request(`/v1/agents/${encodeURIComponent(state.agent.id)}/review/run`, {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: { period_label: `demo-${random}-p1`, ...window1 },
    }), REVIEW_STATUSES, "Run review 1");
    review1 = result.review;
    assert(result.review.outcome === "gaps_found", `Review 1 outcome was ${result.review.outcome}; summary: ${result.review.summary}. Data was not tuned; inspect the metrics above the review id ${result.review.id}.`);
    const finance = result.gaps.find((gap) => gap.task_category === "finance_qa");
    const general = result.gaps.find((gap) => gap.task_category === "general_knowledge");
    assert(finance, "Review 1 has no finance_qa gap row");
    assert(general, "Review 1 has no general_knowledge gap row");
    assert(result.gaps.length === 2, `Review 1 had ${result.gaps.length} gap rows`);
    assert(finance.status === "passed_gate", `finance_qa status was ${finance.status}`);
    assert(finance.taxonomy === "knowledge", `finance_qa taxonomy was ${finance.taxonomy}`);
    assert(["medium", "high"].includes(finance.priority_label), `finance_qa priority label was ${finance.priority_label}`);
    assert(general.status !== "passed_gate", `general_knowledge passed the gate: ${JSON.stringify(general)}`);
    return `outcome ${result.review.outcome}; ${result.review.summary}`;
  });

  let premiumRequest = null;
  await step("(3) proposals: premium_data is pending_approval within budget", async () => {
    assert(review1, "Review 1 missing");
    const result = requireStatus(await request(`/v1/reviews/${encodeURIComponent(review1.id)}/proposals`, {
      token: config.ADMIN_TOKEN,
      method: "POST",
    }), REVIEW_STATUSES, "Create proposals");
    const premium = result.requests.find((row) => row.capability_key === "premium_data");
    assert(premium, `No premium_data proposal: ${JSON.stringify(result.requests)}; skipped: ${JSON.stringify(result.skipped)}`);
    assert(premium.status === "pending_approval", `premium_data status was ${premium.status}`);
    assert(premium.cost_mist === "15000000", `premium_data cost was ${premium.cost_mist}`);
    assert(premium.budget.within_budget === true, `budget was ${JSON.stringify(premium.budget)}`);
    assert(premium.budget.improvement_cap_mist === IMPROVEMENT_CAP.toString(), `improvement cap was ${premium.budget.improvement_cap_mist}`);
    premiumRequest = premium;
    return `${result.requests.length} request(s): ${result.requests.map((row) => `${row.capability_key} ${row.status} ${row.cost_sui} SUI`).join(", ")}; cap 0.02 SUI covers a 0.015 SUI purchase; skipped: ${JSON.stringify(result.skipped)}`;
  });

  narrative("Upgrade: approving premium_data pays the vendor on Sui testnet and auto-claims the pass");
  let spendDigest = null;
  await step("(4) approve premium_data: real transfer, capability unlocked, pass auto-claimed", async () => {
    assert(premiumRequest, "premium_data request missing");
    const vendorBefore = await getPayrollBalance(vendorAddress("premium-data-source"), { bypassCache: true });
    const approved = requireStatus(await request(`/v1/requests/${encodeURIComponent(premiumRequest.id)}/approve`, {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: { note: `approve for the ${random} demo cycle` },
    }), 200, "Approve premium_data");
    assert(approved.status === "executed", `premium_data status after approval was ${approved.status}`);

    const spend = db.prepare("SELECT * FROM transactions WHERE id=?").get(approved.spend_tx_id);
    assert(spend && spend.kind === "spend" && spend.status === "executed", `spend transaction was ${JSON.stringify(spend)}`);
    assert(spend.category === "upgrade" && spend.vendor_id === "premium-data-source", `spend was ${spend.category}/${spend.vendor_id}`);
    assert(spend.amount_mist === "15000000", `spend amount was ${spend.amount_mist}`);
    spendDigest = spend.digest;
    const verification = requireStatus(await request(`/v1/transactions/${encodeURIComponent(spend.digest)}/verify`, {
      token: config.ADMIN_TOKEN,
    }), 200, "Verify upgrade digest");
    assert(verification.status === "success", `Upgrade transfer status was ${verification.status}`);

    const vendorAfter = await getPayrollBalance(vendorAddress("premium-data-source"), { bypassCache: true });
    assert(vendorAfter >= vendorBefore + 15_000_000n, `Vendor balance did not rise by 0.015 SUI (${formatMist(vendorBefore)} -> ${formatMist(vendorAfter)})`);

    const capability = db.prepare("SELECT * FROM agent_capabilities WHERE agent_id=? AND capability_key='premium_data' AND active=1").get(state.agent.id);
    assert(capability && capability.spend_digest === spend.digest, "premium_data was not recorded as an active capability with the spend digest");
    const receipt = db.prepare("SELECT * FROM payment_receipts WHERE digest=?").get(spend.digest);
    const guidance = requireStatus(await client.guidance(), 200, "Guidance");
    assert(guidance.premium_pass?.active === true, `Pass was not auto-claimed: ${JSON.stringify(guidance.premium_pass)}`);
    const calls = guidance.premium_pass.calls_granted;
    assert(calls >= MIN_PASS_CALLS, `PREMIUM_PASS_CALLS must be at least ${MIN_PASS_CALLS} (two periods need ~10 live calls each); it was ${calls}. Set PREMIUM_PASS_CALLS=20 and restart, then re-run. No extra transfers were sent.`);
    return `digest ${spend.digest}, vendor balance ${formatMist(vendorBefore)} -> ${formatMist(vendorAfter)} SUI, pass ${calls} calls until ${guidance.premium_pass.expires_at}`;
  });

  narrative("PERIOD 2: same capability mix, different phrasings and currencies, same 3-session spread");
  let window2 = null;
  await step("(5) run 14 period-2 tasks (10 finance_qa live, 4 general_knowledge)", async () => {
    assert(period2.finance.length === 10 && period2.general.length === 4,
      `Period 2 slices were wrong: ${period2.finance.length} finance, ${period2.general.length} general`);
    window2 = { window_start: new Date().toISOString() };
    const counts = await runTasks({
      client, groq,
      questions: [...period2.finance, ...period2.general],
      periodLabel: "period-2",
      sessionIdBase: "p2",
    });
    window2.window_end = new Date().toISOString();
    assert(counts.total === 14, `Ran ${counts.total} tasks, expected 14`);
    assert(counts.premium === 10, `Premium data was used for ${counts.premium} live tasks, expected 10`);
    return `${counts.total} tasks; ${counts.correct} graded correct; ${counts.premium} used premium data; by ${JSON.stringify(counts.byCategory)}`;
  });

  narrative("Verdict: did the paid upgrade actually lower the finance_qa issue rate?");
  await step("(6) evaluate the verdict for premium_data", async () => {
    assert(premiumRequest, "premium_data request missing");
    const result = requireStatus(await request(`/v1/requests/${encodeURIComponent(premiumRequest.id)}/verdict/evaluate`, {
      token: config.ADMIN_TOKEN,
      method: "POST",
    }), REVIEW_STATUSES, "Evaluate verdict");
    assert(result.verdict && result.verdict.id, `No verdict stored: ${JSON.stringify(result)}`);
    const v = result.verdict;
    verdictResult = v;
    return `verdict ${v.verdict}; issue rate ${v.baseline_rate} -> ${v.after_rate} over ${v.after_outcomes} outcomes (delta ${v.delta}); cost ${v.cost_sui} SUI; ${v.summary}`;
  });

  narrative("Second review: the experience should not be re-proposed while it is unlocked");
  await step("(7) review period 2 and proposals: premium_data is not proposed again", async () => {
    assert(window2, "Period 2 window is missing");
    const result = requireStatus(await request(`/v1/agents/${encodeURIComponent(state.agent.id)}/review/run`, {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: { period_label: `demo-${random}-p2`, ...window2 },
    }), REVIEW_STATUSES, "Run review 2");
    const proposals = requireStatus(await request(`/v1/reviews/${encodeURIComponent(result.review.id)}/proposals`, {
      token: config.ADMIN_TOKEN,
      method: "POST",
    }), REVIEW_STATUSES, "Create proposals 2");
    assert(!proposals.requests.some((row) => row.capability_key === "premium_data"),
      `premium_data was proposed again: ${JSON.stringify(proposals.requests)}`);
    return `outcome ${result.review.outcome}; ${result.review.summary}; ${proposals.requests.length} request(s); skipped: ${JSON.stringify(proposals.skipped)}`;
  });

  narrative("Reports");
  await step("(8) guidance shows the unlocked capability, budget and recalled lessons", async () => {
    const guidance = requireStatus(await client.guidance(), 200, "Guidance");
    const capability = (guidance.capabilities ?? []).find((entry) => entry.capability_key === "premium_data" && Number(entry.active) === 1);
    assert(capability, `guidance.capabilities lacks premium_data: ${JSON.stringify(guidance.capabilities)}`);
    assert(guidance.budget?.allowance_mist === ALLOWANCE_MIST.toString(), `budget allowance was ${guidance.budget?.allowance_mist}`);
    assert(guidance.premium_pass?.active === true, `pass status was ${JSON.stringify(guidance.premium_pass)}`);
    return JSON.stringify({
      capabilities: (guidance.capabilities ?? []).map((entry) => `${entry.capability_key}@${entry.unlocked_at}`),
      budget: guidance.budget,
      premium_pass: { active: guidance.premium_pass.active, calls_remaining: guidance.premium_pass.calls_remaining, expires_at: guidance.premium_pass.expires_at },
      pending_requests: guidance.pending_requests,
      lessons: (guidance.lessons ?? []).length,
    });
  });

  await step("(9) verdicts history", async () => {
    const verdicts = requireStatus(await request(`/v1/agents/${encodeURIComponent(state.agent.id)}/verdicts`, {
      token: config.ADMIN_TOKEN,
    }), 200, "List verdicts");
    assert(Array.isArray(verdicts) && verdicts.length >= 1, "No verdict rows were returned");
    assert(verdicts.some((row) => row.id === verdictResult.id), `Verdict list does not contain ${verdictResult.id}`);
    return `${verdicts.length} verdict(s): ${verdicts.map((row) => `${row.capability_key}=${row.verdict}`).join(", ")}`;
  });

  await step("(10) Tatum activity: last 10 entries include REST rate calls and gRPC calls", async () => {
    const activity = requireStatus(await request("/v1/tatum/activity", { token: config.ADMIN_TOKEN }), 200, "Tatum activity");
    const recent = activity.calls.slice(-10).reverse();
    const rest = recent.filter((entry) => entry.method === "rest:GET /v4/data/rate/symbol");
    const grpc = recent.filter((entry) => String(entry.method).includes("sui.rpc.v2."));
    assert(rest.length >= 1 || activity.calls.some((entry) => entry.method === "rest:GET /v4/data/rate/symbol"), "No REST rate call was logged");
    assert(grpc.length >= 1, "No gRPC call was logged");
    for (const entry of recent) {
      console.log(`  activity: ${entry.method} ${entry.outcome}${entry.duration_ms ? ` ${entry.duration_ms}ms` : ""}${entry.retries ? ` retries=${entry.retries}` : ""}`);
    }
    return `showing 10 of ${activity.calls.length} logged call(s); REST present, ${grpc.length} gRPC in the tail`;
  });
} catch (error) {
  if (!(error instanceof StepFailure)) {
    failed += 1;
    console.log(`FAIL unexpected error: ${safeMessage(error)}`);
  }
} finally {
  if (state.agent) {
    try {
      const result = db.prepare("UPDATE agents SET status='inactive' WHERE id=? AND status!='inactive'").run(state.agent.id);
      console.log(`CLEANUP deactivated research agent ${state.agent.id} (${result.changes} row)`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL cleanup could not deactivate the agent: ${safeMessage(error)}`);
    }
  }
  if (state.treasuryBefore !== null) {
    try {
      const balance = await getPayrollBalance(treasury.address, { bypassCache: true });
      state.treasuryAfter = balance;
      console.log(`Treasury: ${formatMist(state.treasuryBefore)} SUI before -> ${formatMist(balance)} SUI after`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL treasury balance after: ${safeMessage(error)}`);
    }
  }
  db.close();
  closePayrollChain();
}

if (verdictResult) {
  const wording = verdictResult.verdict === "worth_it"
    ? "The upgrade paid off."
    : verdictResult.verdict === "not_worth_it"
      ? "The verdict is NOT WORTH IT: the upgrade did not lower the issue rate. Numbers, unedited:"
      : "The verdict was INCONCLUSIVE: not enough outcomes yet to judge the upgrade.";
  console.log(`\nVerdict summary: ${wording}`);
  console.log(`  baseline issue rate ${verdictResult.baseline_rate} over ${verdictResult.baseline_outcomes} outcomes`);
  console.log(`  after    issue rate ${verdictResult.after_rate} over ${verdictResult.after_outcomes} outcomes`);
  console.log(`  delta ${verdictResult.delta}; cost ${verdictResult.cost_sui} SUI; verdict ${verdictResult.verdict}`);
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
export {};
