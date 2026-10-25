import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { getConfig } from "../src/config.js";
import { closePayrollChain, formatMist, getPayrollBalance } from "../src/payroll-chain.js";
import { UPGRADE_CATALOG } from "../src/review-config.js";

const config = getConfig();
const baseUrl = process.env.SMOKE_BASE_URL?.trim() || `http://127.0.0.1:${config.PORT}`;
const secrets = [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN, config.WALLET_ENC_KEY].filter(Boolean);
const db = new Database(resolve(config.DB_PATH));
db.pragma("busy_timeout = 5000");

const ALLOWANCE_MIST = 50_000_000n; // 0.05 SUI
const RESERVE_PCT = 40n;
const IMPROVEMENT_CAP = (ALLOWANCE_MIST * RESERVE_PCT) / 100n; // 0.02 SUI
const SALARY_SUI = 0.05;
const SALARY_MIST = 50_000_000n;
const MIN_TREASURY_MIST = 150_000_000n; // 0.15 SUI
const PRICES = Object.fromEntries(UPGRADE_CATALOG.map((item) => [item.capability_key, BigInt(item.price_mist)]));
const random = randomBytes(3).toString("hex");

const state = { agents: [], treasuryBefore: null, treasuryAfter: null };
let passed = 0;
let failed = 0;

function safeMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  return message.replace(/\b(?:plk_[a-f0-9]{64}|suiprivkey1[0-9a-z]+|(?:0x)?[a-f0-9]{64})\b/gi, "[REDACTED]");
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
    const detail = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
    throw new Error(`${description} returned HTTP ${result.status}: ${detail}`);
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
    console.log(`FAIL ${name} (${Date.now() - started} ms): ${safeMessage(error)}`);
    throw new StepFailure(safeMessage(error));
  }
}

const treasury = db.prepare("SELECT address FROM wallets WHERE owner_type='treasury' AND owner_id='treasury'").get();
const vendorAddress = (vendorId) => db.prepare("SELECT address FROM vendors WHERE id=?").get(vendorId)?.address ?? null;

async function createAgent(label, { autonomy, autoLimitMist = "0" }) {
  const name = `smoke-upgrade-${label}-${random}`;
  const registered = requireStatus(await request("/v1/agents/register", {
    token: config.ADMIN_TOKEN,
    method: "POST",
    body: { name, kind: "smoke", description: `Block 3b upgrade smoke agent ${label}` },
  }), 201, "Register agent");
  const agent = { id: registered.agent_id, apiKey: registered.api_key, name, label, wallet: null, window: null };
  state.agents.push(agent);

  const wallet = requireStatus(await request(`/v1/agents/${encodeURIComponent(agent.id)}/wallet`, {
    token: config.ADMIN_TOKEN,
    method: "POST",
  }), 201, "Create agent wallet");
  agent.wallet = wallet.address;

  requireStatus(await request(`/v1/agents/${encodeURIComponent(agent.id)}/policy`, {
    token: config.ADMIN_TOKEN,
    method: "PUT",
    body: { salary_sui: SALARY_SUI, per_tx_cap_sui: 0.03, period_cap_sui: 0.06, allowed_vendor_ids: [] },
  }), 200, "Set policy");

  const settings = requireStatus(await request(`/v1/agents/${encodeURIComponent(agent.id)}/settings`, {
    token: config.ADMIN_TOKEN,
    method: "PUT",
    body: {
      period: "weekly",
      period_minutes: 10080,
      allowance_mist: ALLOWANCE_MIST.toString(),
      improvement_reserve_pct: Number(RESERVE_PCT),
      autonomy,
      auto_limit_mist: autoLimitMist,
      rollover: 0,
    },
  }), 200, "Set settings");
  assert(settings.autonomy === autonomy && settings.allowance_mist === ALLOWANCE_MIST.toString(), `Settings did not store: ${JSON.stringify(settings)}`);
  return agent;
}

async function payAgent(agent) {
  const payroll = requireStatus(await request("/v1/payroll/run", {
    token: config.ADMIN_TOKEN,
    method: "POST",
    body: { period_label: "smoke-block3b", agent_ids: [agent.id] },
  }), 200, "Run payroll");
  const paid = payroll.paid.find((item) => item.agent_id === agent.id);
  assert(paid && paid.digest && ["success", "unconfirmed"].includes(paid.status), `Payroll did not return a submitted salary: ${JSON.stringify(payroll)}`);
  const verification = requireStatus(await request(`/v1/transactions/${encodeURIComponent(paid.digest)}/verify`, {
    token: config.ADMIN_TOKEN,
  }), 200, "Verify salary digest");
  assert(["success", "unconfirmed"].includes(verification.status), `Salary verification was ${verification.status}`);
  const balance = await getPayrollBalance(agent.wallet, { bypassCache: true });
  assert(balance >= SALARY_MIST, `Agent balance ${formatMist(balance)} SUI is below the ${formatMist(SALARY_MIST)} SUI salary`);
  return { paid, balance };
}

function financeScenario(prefix) {
  return [
    { type: "task_completed", task_category: "finance_qa", session_id: `${prefix}-fin-1`, summary: "Answered a VAT question from the ledger." },
    { type: "user_corrected", task_category: "finance_qa", session_id: `${prefix}-fin-1`, summary: "Used the old VAT rate.", correction: "the 2026 rate is 21 percent", details: { gap_hint: "knowledge" } },
    { type: "user_corrected", task_category: "finance_qa", session_id: `${prefix}-fin-1`, summary: "Mixed up two vendor invoices.", correction: "invoice 118 is Acme, not Globex", details: { gap_hint: "knowledge" } },
    { type: "task_completed", task_category: "finance_qa", session_id: `${prefix}-fin-2`, summary: "Reconciled the weekly expenses." },
    { type: "task_completed", task_category: "finance_qa", session_id: `${prefix}-fin-2`, summary: "Explained a cash-flow line item." },
    { type: "user_corrected", task_category: "finance_qa", session_id: `${prefix}-fin-2`, summary: "Reported the wrong fiscal quarter.", correction: "we are in Q4 2026", details: { gap_hint: "knowledge" } },
    { type: "task_completed", task_category: "finance_qa", session_id: `${prefix}-fin-3`, summary: "Summarised the receivable ageing." },
    { type: "user_corrected", task_category: "finance_qa", session_id: `${prefix}-fin-3`, summary: "Guessed the FX rate instead of looking it up.", correction: "use the rate from the daily feed", details: { gap_hint: "knowledge" } },
    { type: "capability_missing", task_category: "finance_qa", session_id: `${prefix}-fin-3`, summary: "Could not open the accounting export format.", details: { missing: "accounting export parser" } },
  ];
}

function pdfScenario(prefix) {
  return [
    { type: "task_failed", task_category: "pdf_summary", session_id: `${prefix}-pdf-1`, summary: "Skipped the appendix tables.", details: { gap_hint: "perception" } },
    { type: "task_completed", task_category: "pdf_summary", session_id: `${prefix}-pdf-1`, summary: "Summarised the main report sections." },
    { type: "task_failed", task_category: "pdf_summary", session_id: `${prefix}-pdf-2`, summary: "Dropped the chart captions.", details: { gap_hint: "perception" } },
    { type: "task_completed", task_category: "pdf_summary", session_id: `${prefix}-pdf-2`, summary: "Extracted the executive summary." },
    { type: "task_failed", task_category: "pdf_summary", session_id: `${prefix}-pdf-3`, summary: "Misread a scanned table.", details: { gap_hint: "perception" } },
    { type: "task_failed", task_category: "pdf_summary", session_id: `${prefix}-pdf-3`, summary: "Returned an empty summary.", details: { gap_hint: "perception" } },
  ];
}

async function postScenario(agent, { includePdf }) {
  const base = Date.now() - 120_000;
  const events = includePdf ? [...financeScenario(agent.label), ...pdfScenario(agent.label)] : financeScenario(agent.label);
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    requireStatus(await request("/v1/events", {
      token: agent.apiKey,
      method: "POST",
      body: {
        type: event.type,
        task_category: event.task_category,
        summary: event.summary,
        session_id: event.session_id,
        ...(event.correction ? { correction: event.correction } : {}),
        ...(event.details ? { details: event.details } : {}),
        ts: new Date(base + i * 1_000).toISOString(),
      },
    }), 201, `Post ${event.type} for ${event.task_category}`);
  }
  agent.window = { start: new Date(base - 60_000).toISOString(), end: new Date(base + 300_000).toISOString() };
  return events.length;
}

async function runReview(agent, label) {
  const data = requireStatus(await request(`/v1/agents/${encodeURIComponent(agent.id)}/review/run`, {
    token: config.ADMIN_TOKEN,
    method: "POST",
    body: { period_label: label, window_start: agent.window.start, window_end: agent.window.end },
  }), 201, "Run review");
  return data;
}

async function createProposals(reviewId) {
  return requireStatus(await request(`/v1/reviews/${encodeURIComponent(reviewId)}/proposals`, {
    token: config.ADMIN_TOKEN,
    method: "POST",
  }), 201, "Create proposals");
}

function gapsByCategory(review) {
  return Object.fromEntries(review.gaps.map((gap) => [gap.task_category, gap]));
}

async function memoriesFor(agentId) {
  const rows = requireStatus(await request("/v1/memories", { token: config.ADMIN_TOKEN }), 200, "List memories");
  return rows.filter((row) => row.agent_id === agentId);
}

async function transactionsFor(agentId) {
  return requireStatus(await request(`/v1/agents/${encodeURIComponent(agentId)}/transactions`, { token: config.ADMIN_TOKEN }), 200, "List transactions");
}

async function guidanceFor(agentId) {
  return requireStatus(await request(`/v1/agents/${encodeURIComponent(agentId)}/guidance`, { token: config.ADMIN_TOKEN }), 200, "Get guidance");
}

try {
  await step("Health check", async () => {
    const health = requireStatus(await request("/health"), 200, "Health");
    assert(health.status === "ok", `Health status was ${health.status}`);
    return `${baseUrl} ok`;
  });

  await step("Treasury testnet balance", async () => {
    assert(treasury, "Treasury wallet is missing; run npm run treasury:create and fund it");
    const balance = await getPayrollBalance(treasury.address, { bypassCache: true });
    state.treasuryBefore = balance;
    if (balance < MIN_TREASURY_MIST) {
      throw new Error(`Treasury ${treasury.address} holds ${formatMist(balance)} SUI; fund it from the Sui testnet faucet with at least ${formatMist(MIN_TREASURY_MIST)} SUI (0.15). No transfers were sent.`);
    }
    return `${formatMist(balance)} SUI available at ${treasury.address}`;
  });

  await step("Catalog seeded with both capabilities", async () => {
    const catalog = requireStatus(await request("/v1/catalog", { token: config.ADMIN_TOKEN }), 200, "Get catalog");
    assert(catalog.length === UPGRADE_CATALOG.length, `Expected ${UPGRADE_CATALOG.length} catalog items, got ${catalog.length}`);
    for (const item of UPGRADE_CATALOG) {
      const row = catalog.find((entry) => entry.capability_key === item.capability_key);
      assert(row, `Catalog is missing ${item.capability_key}`);
      assert(row.price_mist === item.price_mist, `${item.capability_key} price is ${row.price_mist}, expected ${item.price_mist}`);
      assert(row.taxonomy === item.taxonomy && row.fix_type === item.fix_type, `${item.capability_key} metadata was not seeded from config`);
      assert(row.active === 1 && row.vendor_label, `${item.capability_key} is not active or has no vendor`);
    }
    return catalog.map((row) => `${row.capability_key}=${row.price_sui} SUI (${row.vendor_label})`).join(", ");
  });

  await step("Agent A (autonomy ask): register, wallet, policy, settings", async () => {
    const agent = await createAgent("a", { autonomy: "ask" });
    return `${agent.id}; wallet created; per-tx 0.03 / period 0.06 SUI; allowance 0.05 SUI, reserve 40%`;
  });
  const agentA = state.agents.find((agent) => agent.label === "a");

  await step("Agent A payroll 0.05 SUI confirmed", async () => {
    assert(agentA, "Agent A was not created");
    const { paid, balance } = await payAgent(agentA);
    return `salary ${SALARY_SUI} SUI, digest shown, verified; balance ${formatMist(balance)} SUI`;
  });

  await step("Agent A: post finance_qa and pdf_summary scenario", async () => {
    assert(agentA, "Agent A was not created");
    const count = await postScenario(agentA, { includePdf: true });
    return `${count} events; finance_qa 8 outcomes in 3 sessions, pdf_summary 6 outcomes (4 failures) in 3 sessions`;
  });

  await step("Agent A review passes both gaps", async () => {
    assert(agentA, "Agent A was not created");
    const review = await runReview(agentA, "smoke-block3b-a-1");
    assert(review.review.outcome === "gaps_found", `Review outcome was ${review.review.outcome}`);
    const gaps = gapsByCategory(review);
    assert(gaps.finance_qa?.status === "passed_gate", `finance_qa status was ${gaps.finance_qa?.status}`);
    assert(gaps.finance_qa.taxonomy === "knowledge", `finance_qa taxonomy was ${gaps.finance_qa.taxonomy}`);
    assert(gaps.pdf_summary?.status === "passed_gate", `pdf_summary status was ${gaps.pdf_summary?.status}`);
    assert(gaps.pdf_summary.taxonomy === "perception", `pdf_summary taxonomy was ${gaps.pdf_summary.taxonomy}`);
    assert(review.gaps.length === 2, `Expected 2 gaps, got ${review.gaps.length}`);
    agentA.reviewId = review.review.id;
    return `outcome ${review.review.outcome}; finance_qa knowledge medium, pdf_summary perception medium`;
  });

  await step("Agent A proposals: premium_data within budget, vision needs a raise", async () => {
    assert(agentA?.reviewId, "Agent A review is missing");
    const result = await createProposals(agentA.reviewId);
    assert(result.requests.length === 2, `Expected 2 requests, got ${result.requests.length}`);
    const premium = result.requests.find((row) => row.capability_key === "premium_data");
    const vision = result.requests.find((row) => row.capability_key === "vision");
    assert(premium && vision, "Proposals did not include premium_data and vision");
    assert(result.requests[0].capability_key === "premium_data", `Proposal order was ${result.requests.map((row) => row.capability_key).join(",")}`);

    assert(premium.status === "pending_approval", `premium_data status was ${premium.status}`);
    assert(premium.cost_mist === PRICES.premium_data.toString(), `premium_data cost was ${premium.cost_mist}`);
    assert(premium.budget.within_budget === true, `premium_data budget was ${JSON.stringify(premium.budget)}`);
    assert(premium.budget.improvement_cap_mist === IMPROVEMENT_CAP.toString(), `improvement cap was ${premium.budget.improvement_cap_mist}`);
    assert(premium.budget.improvement_remaining_mist === IMPROVEMENT_CAP.toString(), `premium_data remaining was ${premium.budget.improvement_remaining_mist}`);
    assert(premium.budget.topup_needed === false, "premium_data should not need a treasury top-up");
    assert(premium.expected_benefit === "Issue rate on finance_qa is 50% over 8 outcomes; target: below 30%.", `expected_benefit was "${premium.expected_benefit}"`);

    const expectedShortfall = PRICES.vision - (IMPROVEMENT_CAP - PRICES.premium_data);
    assert(vision.status === "needs_raise", `vision status was ${vision.status}`);
    assert(vision.cost_mist === PRICES.vision.toString(), `vision cost was ${vision.cost_mist}`);
    assert(vision.budget.within_budget === false, `vision budget was ${JSON.stringify(vision.budget)}`);
    assert(vision.budget.improvement_spent_mist === PRICES.premium_data.toString(), `vision saw ${vision.budget.improvement_spent_mist} already reserved`);
    assert(vision.budget.improvement_remaining_mist === (IMPROVEMENT_CAP - PRICES.premium_data).toString(), `vision remaining was ${vision.budget.improvement_remaining_mist}`);
    assert(vision.budget.shortfall_mist === expectedShortfall.toString(), `vision shortfall was ${vision.budget.shortfall_mist}, expected ${expectedShortfall}`);

    agentA.premiumRequestId = premium.id;
    agentA.visionRequestId = vision.id;
    return `2 requests; premium_data ${premium.status} ${premium.cost_sui} SUI; vision ${vision.status}, short by ${formatMist(expectedShortfall)} SUI`;
  });

  let premiumDigest = null;
  await step("Approve premium_data: real spend, capability and memory", async () => {
    assert(agentA?.premiumRequestId, "premium_data request is missing");
    const vendorBefore = await getPayrollBalance(vendorAddress("premium-data-source"), { bypassCache: true });
    const approved = requireStatus(await request(`/v1/requests/${encodeURIComponent(agentA.premiumRequestId)}/approve`, {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: { note: "approved for the finance QA gap" },
    }), 200, "Approve premium_data");
    assert(approved.status === "executed", `premium_data status was ${approved.status} (${approved.decision_note ?? "no note"})`);
    assert(approved.spend_tx_id, "premium_data has no spend transaction id");
    assert(approved.topup_tx_id === null || approved.topup_tx_id === undefined, `premium_data needed an unexpected top-up: ${approved.topup_tx_id}`);

    const rows = await transactionsFor(agentA.id);
    const spend = rows.find((row) => row.id === approved.spend_tx_id);
    assert(spend && spend.kind === "spend" && spend.status === "executed", `spend transaction was ${JSON.stringify(spend)}`);
    assert(spend.amount_mist === PRICES.premium_data.toString(), `spend amount was ${spend.amount_mist}`);
    assert(spend.category === "upgrade" && spend.vendor_id === "premium-data-source", `spend was ${spend.category}/${spend.vendor_id}`);
    premiumDigest = spend.digest;
    const verification = requireStatus(await request(`/v1/transactions/${encodeURIComponent(spend.digest)}/verify`, { token: config.ADMIN_TOKEN }), 200, "Verify upgrade digest");
    assert(verification.status === "success", `Upgrade transfer status was ${verification.status}`);

    const vendorAfter = await getPayrollBalance(vendorAddress("premium-data-source"), { bypassCache: true });
    assert(vendorAfter >= vendorBefore + PRICES.premium_data, `Vendor balance did not increase by ${formatMist(PRICES.premium_data)} SUI (${formatMist(vendorBefore)} -> ${formatMist(vendorAfter)})`);

    const capability = db.prepare("SELECT * FROM agent_capabilities WHERE agent_id=? AND capability_key='premium_data' AND active=1").get(agentA.id);
    assert(capability && capability.spend_digest === spend.digest, "premium_data was not recorded as an active capability with the spend digest");
    const policy = db.prepare("SELECT allowed_vendor_ids_json FROM policies WHERE agent_id=?").get(agentA.id);
    assert(JSON.parse(policy.allowed_vendor_ids_json).includes("premium-data-source"), "Execution did not add the vendor to the agent allowlist");

    const costEvents = requireStatus(await request(`/v1/agents/${encodeURIComponent(agentA.id)}/events?type=cost_incurred&limit=20`, { token: config.ADMIN_TOKEN }), 200, "List cost events");
    assert(costEvents.some((event) => event.details?.digest === spend.digest && event.task_category === "upgrade"), "No cost_incurred event was recorded for the upgrade spend");

    const memories = await memoriesFor(agentA.id);
    const purchased = memories.find((row) => String(row.text).includes(" | upgrade_purchased | premium_data | ") && String(row.text).includes(`digest ${spend.digest}`));
    assert(purchased, "No upgrade_purchased memory was queued");
    assert(["pending", "stored"].includes(purchased.status), `upgrade_purchased memory status was ${purchased.status}`);

    return `transfer ${spend.digest.slice(0, 10)}… confirmed; vendor +${formatMist(PRICES.premium_data)} SUI; capability active; cost event and memory queued (${purchased.status})`;
  });

  await step("Approving premium_data again returns 409 and sends nothing", async () => {
    assert(agentA?.premiumRequestId, "premium_data request is missing");
    const before = await transactionsFor(agentA.id);
    const costsBefore = requireStatus(await request(`/v1/agents/${encodeURIComponent(agentA.id)}/events?type=cost_incurred&limit=20`, { token: config.ADMIN_TOKEN }), 200, "List cost events");
    const response = await request(`/v1/requests/${encodeURIComponent(agentA.premiumRequestId)}/approve`, {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: {},
    });
    assert(response.status === 409, `Second approval returned HTTP ${response.status}`);
    const after = await transactionsFor(agentA.id);
    const costsAfter = requireStatus(await request(`/v1/agents/${encodeURIComponent(agentA.id)}/events?type=cost_incurred&limit=20`, { token: config.ADMIN_TOKEN }), 200, "List cost events");
    assert(after.length === before.length, `Second approval added ${after.length - before.length} transaction(s)`);
    assert(costsAfter.length === costsBefore.length, "Second approval added a cost event");
    const row = requireStatus(await request(`/v1/requests/${encodeURIComponent(agentA.premiumRequestId)}`, { token: config.ADMIN_TOKEN }), 200, "Get request");
    assert(row.status === "executed" && row.spend_tx_id, `Request is now ${row.status}`);
    return "409 conflict; transaction and cost-event counts unchanged";
  });

  await step("Reject vision with a note and queue the rejection memory", async () => {
    assert(agentA?.visionRequestId, "vision request is missing");
    const rejected = requireStatus(await request(`/v1/requests/${encodeURIComponent(agentA.visionRequestId)}/reject`, {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: { note: "not needed now" },
    }), 200, "Reject vision");
    assert(rejected.status === "rejected", `vision status was ${rejected.status}`);
    assert(rejected.decision_note === "not needed now", `vision note was ${rejected.decision_note}`);
    const memories = await memoriesFor(agentA.id);
    const row = memories.find((memory) => String(memory.text) === `Agent ${agentA.id} | upgrade_rejected | vision | not needed now`);
    assert(row, "No upgrade_rejected memory was queued");
    assert(["pending", "stored"].includes(row.status), `upgrade_rejected memory status was ${row.status}`);
    return `rejected; memory ${row.status}`;
  });

  await step("Second review and proposals keep vision in cooldown", async () => {
    assert(agentA, "Agent A was not created");
    const review = await runReview(agentA, "smoke-block3b-a-2");
    assert(review.review.outcome === "gaps_found", `Second review outcome was ${review.review.outcome}`);
    const result = await createProposals(review.review.id);
    assert(result.requests.length === 0, `Second proposal pass created ${result.requests.length} request(s): ${JSON.stringify(result.requests)}`);
    const visionSkip = result.skipped.find((item) => item.capability_key === "vision");
    assert(visionSkip?.reason === "rejected_cooldown", `vision skip was ${JSON.stringify(visionSkip)}`);
    const premiumSkip = result.skipped.find((item) => item.capability_key === "premium_data");
    assert(premiumSkip?.reason === "capability_already_active", `premium_data skip was ${JSON.stringify(premiumSkip)}`);
    const rows = requireStatus(await request(`/v1/requests?agent_id=${encodeURIComponent(agentA.id)}`, { token: config.ADMIN_TOKEN }), 200, "List requests");
    assert(rows.length === 2, `Agent A now has ${rows.length} requests`);
    return `0 new requests; vision skipped by rejection cooldown; premium_data already active`;
  });

  await step("Guidance shows premium_data and the budget position", async () => {
    assert(agentA, "Agent A was not created");
    const guidance = await guidanceFor(agentA.id);
    assert(guidance.capabilities.length === 1, `Guidance listed ${guidance.capabilities.length} capabilities`);
    const capability = guidance.capabilities[0];
    assert(capability.capability_key === "premium_data", `Guidance capability was ${capability.capability_key}`);
    assert(capability.spend_digest === premiumDigest, `Guidance digest ${capability.spend_digest} != ${premiumDigest}`);
    assert(guidance.budget.period === "weekly", `Guidance period was ${guidance.budget.period}`);
    assert(guidance.budget.allowance_mist === ALLOWANCE_MIST.toString(), `Guidance allowance was ${guidance.budget.allowance_mist}`);
    assert(guidance.budget.improvement_cap_mist === IMPROVEMENT_CAP.toString(), `Guidance cap was ${guidance.budget.improvement_cap_mist}`);
    assert(guidance.budget.improvement_spent_mist === PRICES.premium_data.toString(), `Guidance improvement spent was ${guidance.budget.improvement_spent_mist}`);
    assert(guidance.budget.improvement_remaining_mist === (IMPROVEMENT_CAP - PRICES.premium_data).toString(), `Guidance remaining was ${guidance.budget.improvement_remaining_mist}`);
    assert(guidance.budget.spent_mist === PRICES.premium_data.toString(), `Guidance period spent was ${guidance.budget.spent_mist}`);
    assert(guidance.budget.window_start && guidance.budget.window_end, "Guidance did not return the budget window");
    assert(guidance.pending_requests === 0, `Guidance reported ${guidance.pending_requests} pending requests`);
    assert(Array.isArray(guidance.lessons) && guidance.lessons.length <= 5, `Guidance lessons was ${JSON.stringify(guidance.lessons)}`);
    const live = requireStatus(await request(`/v1/agents/${encodeURIComponent(agentA.id)}/balance`, { token: config.ADMIN_TOKEN }), 200, "Live balance");
    assert(guidance.budget.balance_mist === live.balance_mist, `Guidance balance ${guidance.budget.balance_mist} != live ${live.balance_mist}`);
    return `premium_data unlocked; cap ${formatMist(IMPROVEMENT_CAP)} spent ${formatMist(PRICES.premium_data)} remaining ${formatMist(IMPROVEMENT_CAP - PRICES.premium_data)} SUI; balance ${formatMist(live.balance_mist)} SUI; ${guidance.lessons.length} lesson(s) recalled`;
  });

  await step("Agent B (autonomy never): note_only and no money moved", async () => {
    const treasuryBefore = await getPayrollBalance(treasury.address, { bypassCache: true });
    const agentB = await createAgent("b", { autonomy: "never" });
    await postScenario(agentB, { includePdf: false });
    const review = await runReview(agentB, "smoke-block3b-b-1");
    const gaps = gapsByCategory(review);
    assert(gaps.finance_qa?.status === "passed_gate", `Agent B finance_qa status was ${gaps.finance_qa?.status}`);
    const result = await createProposals(review.review.id);
    assert(result.requests.length === 1, `Agent B got ${result.requests.length} requests`);
    const created = result.requests[0];
    assert(created.capability_key === "premium_data", `Agent B request was ${created.capability_key}`);
    assert(created.status === "note_only", `Agent B request status was ${created.status}`);
    assert(created.budget.within_budget === true, `Agent B budget was ${JSON.stringify(created.budget)}`);
    const rows = await transactionsFor(agentB.id);
    assert(rows.length === 0, `Agent B has ${rows.length} transaction(s)`);
    const capabilities = db.prepare("SELECT COUNT(*) AS count FROM agent_capabilities WHERE agent_id=?").get(agentB.id).count;
    assert(capabilities === 0, `Agent B unlocked ${capabilities} capability(ies)`);
    const treasuryAfter = await getPayrollBalance(treasury.address, { bypassCache: true });
    assert(treasuryAfter === treasuryBefore, `Treasury changed from ${formatMist(treasuryBefore)} to ${formatMist(treasuryAfter)} SUI`);
    return `note_only ${created.cost_sui} SUI request; 0 transactions; treasury unchanged at ${formatMist(treasuryAfter)} SUI`;
  });

  await step("Agent C (autonomy auto_small): auto-approved, executed and confirmed", async () => {
    const agentC = await createAgent("c", { autonomy: "auto_small", autoLimitMist: "20000000" });
    const { balance } = await payAgent(agentC);
    assert(balance >= SALARY_MIST, `Agent C balance ${formatMist(balance)} SUI is too low`);
    await postScenario(agentC, { includePdf: false });
    const review = await runReview(agentC, "smoke-block3b-c-1");
    const gaps = gapsByCategory(review);
    assert(gaps.finance_qa?.status === "passed_gate", `Agent C finance_qa status was ${gaps.finance_qa?.status}`);
    const vendorBefore = await getPayrollBalance(vendorAddress("premium-data-source"), { bypassCache: true });
    const result = await createProposals(review.review.id);
    assert(result.requests.length === 1, `Agent C got ${result.requests.length} requests`);
    const created = result.requests[0];
    assert(created.capability_key === "premium_data", `Agent C request was ${created.capability_key}`);
    assert(created.status === "executed", `Agent C request status was ${created.status} (${created.decision_note ?? "no note"})`);
    assert(created.decided_by === "autonomy:auto_small", `Agent C decided_by was ${created.decided_by}`);
    assert(created.executed_at, "Agent C request has no executed_at");
    const rows = await transactionsFor(agentC.id);
    const spend = rows.find((row) => row.id === created.spend_tx_id);
    assert(spend && spend.kind === "spend" && spend.status === "executed", `Agent C spend was ${JSON.stringify(spend)}`);
    const verification = requireStatus(await request(`/v1/transactions/${encodeURIComponent(spend.digest)}/verify`, { token: config.ADMIN_TOKEN }), 200, "Verify agent C upgrade");
    assert(verification.status === "success", `Agent C upgrade status was ${verification.status}`);
    const vendorAfter = await getPayrollBalance(vendorAddress("premium-data-source"), { bypassCache: true });
    assert(vendorAfter >= vendorBefore + PRICES.premium_data, `Agent C vendor balance did not increase (${formatMist(vendorBefore)} -> ${formatMist(vendorAfter)})`);
    const capability = db.prepare("SELECT * FROM agent_capabilities WHERE agent_id=? AND capability_key='premium_data' AND active=1").get(agentC.id);
    assert(capability && capability.spend_digest === spend.digest, "Agent C did not unlock premium_data");
    const memories = await memoriesFor(agentC.id);
    assert(memories.some((row) => String(row.text).includes(" | upgrade_purchased | premium_data | ")), "Agent C has no upgrade_purchased memory");
    const guidance = await guidanceFor(agentC.id);
    assert(guidance.capabilities.some((row) => row.capability_key === "premium_data"), "Agent C guidance does not list premium_data");
    return `auto_approved and executed without an admin call; transfer confirmed; vendor +${formatMist(PRICES.premium_data)} SUI; capability unlocked`;
  });

  await step("Treasury balance after the run", async () => {
    const balance = await getPayrollBalance(treasury.address, { bypassCache: true });
    state.treasuryAfter = balance;
    assert(state.treasuryBefore !== null && balance < state.treasuryBefore, `Treasury did not decrease (${formatMist(state.treasuryBefore)} -> ${formatMist(balance)} SUI)`);
    return `${formatMist(state.treasuryBefore)} -> ${formatMist(balance)} SUI`;
  });
} catch (error) {
  if (!(error instanceof StepFailure)) {
    failed += 1;
    console.log(`FAIL unexpected error: ${safeMessage(error)}`);
  }
} finally {
  if (state.agents.length > 0) {
    const started = Date.now();
    try {
      const ids = state.agents.map((agent) => agent.id);
      const placeholders = ids.map(() => "?").join(",");
      const result = db.prepare(`UPDATE agents SET status='inactive' WHERE id IN (${placeholders}) AND status!='inactive'`).run(...ids);
      console.log(`CLEANUP deactivated ${result.changes} smoke agent(s): ${ids.join(", ")} (${Date.now() - started} ms)`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL cleanup could not deactivate smoke agents: ${safeMessage(error)}`);
    }
  }
  db.close();
  closePayrollChain();
}

if (state.treasuryBefore !== null && state.treasuryAfter !== null) {
  console.log(`Treasury: ${formatMist(state.treasuryBefore)} SUI before -> ${formatMist(state.treasuryAfter)} SUI after`);
}
console.log(`Summary: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
export {};
