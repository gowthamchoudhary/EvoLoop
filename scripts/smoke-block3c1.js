import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { toBase58 } from "@mysten/sui/utils";
import { getConfig } from "../src/config.js";
import { closePayrollChain, formatMist, getPayrollBalance } from "../src/payroll-chain.js";

const config = getConfig();
const baseUrl = process.env.SMOKE_BASE_URL?.trim() || `http://127.0.0.1:${config.PORT}`;
const secrets = [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN, config.WALLET_ENC_KEY].filter(Boolean);
const db = new Database(resolve(config.DB_PATH));
db.pragma("busy_timeout = 5000");

const MIN_TREASURY_MIST = 120_000_000n; // 0.12 SUI
const SALARY_SUI = 0.05;
const SMALL_SPEND_SUI = 0.005;
const PASS_PRICE_SUI = 0.015;
const EXPECTED_PASS_CALLS = process.env.PREMIUM_PASS_CALLS?.trim() ? Number(process.env.PREMIUM_PASS_CALLS) : null;
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
const vendor = db.prepare("SELECT * FROM vendors WHERE id='premium-data-source'").get();

async function createAgent(label) {
  const name = `smoke-premium-${label}-${random}`;
  const registered = requireStatus(await request("/v1/agents/register", {
    token: config.ADMIN_TOKEN,
    method: "POST",
    body: { name, kind: "smoke", description: `Block 3c-1 premium data smoke agent ${label}` },
  }), 201, "Register agent");
  const agent = { id: registered.agent_id, apiKey: registered.api_key, name, label, wallet: null };
  state.agents.push(agent);
  const wallet = requireStatus(await request(`/v1/agents/${encodeURIComponent(agent.id)}/wallet`, {
    token: config.ADMIN_TOKEN,
    method: "POST",
  }), 201, "Create agent wallet");
  agent.wallet = wallet.address;
  requireStatus(await request(`/v1/agents/${encodeURIComponent(agent.id)}/policy`, {
    token: config.ADMIN_TOKEN,
    method: "PUT",
    body: { salary_sui: SALARY_SUI, per_tx_cap_sui: 0.03, period_cap_sui: 0.08, allowed_vendor_ids: ["premium-data-source"] },
  }), 200, "Set policy");
  return agent;
}

async function payAgents(agents) {
  const payroll = requireStatus(await request("/v1/payroll/run", {
    token: config.ADMIN_TOKEN,
    method: "POST",
    body: { period_label: "smoke-block3c1", agent_ids: agents.map((agent) => agent.id) },
  }), 200, "Run payroll");
  for (const agent of agents) {
    const paid = payroll.paid.find((item) => item.agent_id === agent.id);
    assert(paid && paid.digest, `Payroll did not pay ${agent.id}: ${JSON.stringify(payroll)}`);
    const verification = requireStatus(await request(`/v1/transactions/${encodeURIComponent(paid.digest)}/verify`, {
      token: config.ADMIN_TOKEN,
    }), 200, "Verify salary digest");
    assert(verification.status === "success" || verification.status === "unconfirmed", `Salary status was ${verification.status}`);
  }
}

async function spend(agent, amountSui, reason) {
  return requireStatus(await request("/v1/spend", {
    token: agent.apiKey,
    method: "POST",
    body: { vendor_id: "premium-data-source", amount_sui: amountSui, reason, category: "upgrade" },
  }), 201, `Spend ${amountSui} SUI`);
}

async function claim(agent, digest, pollTimeoutMs) {
  return request("/v1/premium/claim", {
    token: agent.apiKey,
    method: "POST",
    body: { digest, poll_timeout_ms: pollTimeoutMs },
  });
}

async function premiumStatus(agent) {
  return requireStatus(await request(`/v1/agents/${encodeURIComponent(agent.id)}/premium`, { token: agent.apiKey }), 200, "Premium status");
}

try {
  await step("Health check", async () => {
    const health = requireStatus(await request("/health"), 200, "Health");
    assert(health.status === "ok", `Health status was ${health.status}`);
    return `${baseUrl} ok`;
  });

  await step("Treasury testnet balance", async () => {
    assert(treasury, "Treasury wallet is missing; run npm run treasury:create and fund it");
    assert(vendor, "premium-data-source vendor is missing; run npm run vendors:seed");
    const balance = await getPayrollBalance(treasury.address, { bypassCache: true });
    state.treasuryBefore = balance;
    if (balance < MIN_TREASURY_MIST) {
      throw new Error(`Treasury ${treasury.address} holds ${formatMist(balance)} SUI; fund it with at least ${formatMist(MIN_TREASURY_MIST)} SUI first. No transfers were sent.`);
    }
    return `${formatMist(balance)} SUI available at ${treasury.address}`;
  });

  await step("Register agents A and B with wallets and policies", async () => {
    const a = await createAgent("a");
    await createAgent("b");
    return `${a.id}; vendor allowed; per-tx 0.03 / period 0.08 SUI`;
  });
  const agentA = state.agents.find((agent) => agent.label === "a");

  await step(`Payroll ${SALARY_SUI} SUI to A and B only`, async () => {
    assert(agentA, "Agent A was not created");
    await payAgents(state.agents);
    return `${state.agents.map((agent) => agent.label).join(" and ")} paid ${SALARY_SUI} SUI each; digest verified`;
  });

  await step("(1) data call without a pass returns 402 with payment requirements", async () => {
    assert(agentA, "Agent A was not created");
    const response = await request("/v1/premium/data?type=price&symbol=SUI&currency=INR", { token: agentA.apiKey });
    assert(response.status === 402, `Expected HTTP 402, got ${response.status}: ${JSON.stringify(response.data)}`);
    const body = response.data;
    assert(body.error === "payment_required", `error was ${body.error}`);
    assert(body.pay_to === vendor.address, `pay_to ${body.pay_to} is not the vendor address`);
    assert(body.amount_sui === "0.015", `amount_sui was ${body.amount_sui}`);
    assert(body.network === "sui-testnet" && body.asset === "SUI", `network/asset were ${body.network}/${body.asset}`);
    assert(String(body.how).includes("POST /v1/premium/claim"), `how was ${body.how}`);
    return `402 payment_required; pay ${body.amount_sui} SUI to ${body.pay_to.slice(0, 10)}… on ${body.network}`;
  });

  await step("(2) claim with a made-up well-formed digest fails fast", async () => {
    assert(agentA, "Agent A was not created");
    const digest = toBase58(randomBytes(32));
    const started = Date.now();
    const response = await claim(agentA, digest, 2_000);
    const elapsed = Date.now() - started;
    assert(response.status === 400, `Expected HTTP 400, got ${response.status}: ${JSON.stringify(response.data)}`);
    assert(response.data?.error === "receipt_not_found", `error was ${response.data?.error}`);
    assert(elapsed < 15_000, `poll took ${elapsed} ms, expected under 15 s`);
    return `receipt_not_found after ${elapsed} ms (2 s poll)`;
  });

  await step("(3) small spend is verified but rejected as insufficient_amount", async () => {
    assert(agentA, "Agent A was not created");
    const spendResult = await spend(agentA, SMALL_SPEND_SUI, "Block 3c-1 probe spend below the pass price");
    const response = await claim(agentA, spendResult.digest, 10_000);
    assert(response.status === 400, `Expected HTTP 400, got ${response.status}: ${JSON.stringify(response.data)}`);
    assert(response.data?.error === "insufficient_amount", `error was ${response.data?.error}`);
    assert(response.data?.required_sui === "0.015", `required_sui was ${response.data?.required_sui}`);
    return `${SMALL_SPEND_SUI} SUI received is below the ${PASS_PRICE_SUI} SUI price`;
  });

  let passCalls = 0;
  let callsUsed = 0;
  await step("(4) paying the price grants the pass", async () => {
    assert(agentA, "Agent A was not created");
    const vendorBefore = await getPayrollBalance(vendor.address, { bypassCache: true });
    const spendResult = await spend(agentA, PASS_PRICE_SUI, "Block 3c-1 premium pass purchase");
    const vendorAfter = await getPayrollBalance(vendor.address, { bypassCache: true });
    assert(vendorAfter >= vendorBefore + 15_000_000n, `Vendor balance did not rise by 0.015 SUI (${formatMist(vendorBefore)} -> ${formatMist(vendorAfter)})`);
    const response = await claim(agentA, spendResult.digest, 10_000);
    const data = requireStatus(response, 201, "Claim pass");
    if (EXPECTED_PASS_CALLS !== null) assert(data.calls_granted === EXPECTED_PASS_CALLS, `calls_granted was ${data.calls_granted}; server PREMIUM_PASS_CALLS should be ${EXPECTED_PASS_CALLS}`);
    assert(data.calls_granted >= 1, `calls_granted was ${data.calls_granted}`);
    assert(data.calls_remaining === data.calls_granted, `calls_remaining was ${data.calls_remaining}`);
    assert(Date.parse(data.expires_at) > Date.now(), `expires_at was ${data.expires_at}`);
    passCalls = data.calls_granted;
    const receipt = db.prepare("SELECT * FROM payment_receipts WHERE digest=?").get(spendResult.digest);
    assert(receipt && receipt.agent_id === agentA.id && receipt.status === "active", `receipt row was ${JSON.stringify(receipt)}`);
    return `pass granted: ${data.calls_granted} calls until ${data.expires_at}; vendor paid ${PASS_PRICE_SUI} SUI on chain`;
  });

  let firstRate = null;
  await step("(5) price for SUI in INR is a positive rate, stable within the cache", async () => {
    assert(agentA, "Agent A was not created");
    const first = requireStatus(await request("/v1/premium/data?type=price&symbol=SUI&currency=INR", { token: agentA.apiKey }), 200, "Price call 1");
    assert(first.value > 0, `value was ${first.value}`);
    assert(first.source === "tatum-rates", `source was ${first.source}`);
    assert(first.symbol === "SUI" && first.currency === "INR", `symbol/currency were ${first.symbol}/${first.currency}`);
    assert(Number.isInteger(first.calls_remaining) && first.calls_remaining === passCalls - 1, `calls_remaining was ${first.calls_remaining}`);
    firstRate = first;
    const second = requireStatus(await request("/v1/premium/data?type=price&symbol=SUI&currency=INR", { token: agentA.apiKey }), 200, "Price call 2");
    assert(second.calls_remaining === passCalls - 2, `second call remaining was ${second.calls_remaining}`);
    callsUsed = 2;
    const drift = Math.abs(second.value - first.value) / first.value;
    assert(drift <= 0.02, `second rate drifted ${(drift * 100).toFixed(2)}% (>2%)`);
    assert(second.timestamp === first.timestamp, `timestamps differed: ${first.timestamp} vs ${second.timestamp} (cache should hit)`);
    return `SUI/INR ${first.value} then ${second.value} (drift ${(drift * 100).toFixed(2)}%), remaining ${second.calls_remaining}`;
  });

  await step("(6) balance call matches the agent balance endpoint", async () => {
    assert(agentA, "Agent A was not created");
    const premium = requireStatus(await request(`/v1/premium/data?type=balance&address=${agentA.wallet}`, { token: agentA.apiKey }), 200, "Premium balance");
    assert(premium.source === "tatum-grpc", `source was ${premium.source}`);
    const live = requireStatus(await request(`/v1/agents/${encodeURIComponent(agentA.id)}/balance`, { token: config.ADMIN_TOKEN }), 200, "Agent balance");
    assert(premium.balance_sui === live.balance_sui, `premium ${premium.balance_sui} != live ${live.balance_sui}`);
    assert(typeof premium.coin_objects_sui === "string" && typeof premium.address_balance_sui === "string", `parts missing: ${JSON.stringify(premium)}`);
    assert(premium.calls_remaining === passCalls - callsUsed - 1, `calls_remaining was ${premium.calls_remaining}, expected ${passCalls - callsUsed - 1}`);
    callsUsed += 1;
    return `balance ${premium.balance_sui} SUI (coin objects ${premium.coin_objects_sui}, address ${premium.address_balance_sui}); remaining ${premium.calls_remaining}`;
  });

  await step("(7) agent B cannot claim agent A's digest", async () => {
    const agentB = state.agents.find((agent) => agent.label === "b");
    assert(agentA && agentB, "Both agents must exist");
    const receipt = db.prepare("SELECT digest FROM payment_receipts WHERE agent_id=?").get(agentA.id);
    assert(receipt, "Agent A has no receipt to replay");
    const response = await claim(agentB, receipt.digest, 10_000);
    assert(response.status === 409 || response.status === 400, `Expected 409/400, got ${response.status}`);
    assert(["claimed_by_other_agent", "wrong_sender"].includes(response.data?.error), `error was ${response.data?.error}`);
    const count = db.prepare("SELECT COUNT(*) AS count FROM payment_receipts WHERE digest=?").get(receipt.digest).count;
    assert(count === 1, `replay created ${count} receipts for one digest`);
    return `${response.data.error}; the single receipt is unchanged`;
  });

  await step("(8) agent A claiming its own digest again is rejected", async () => {
    assert(agentA, "Agent A was not created");
    const receipt = db.prepare("SELECT digest FROM payment_receipts WHERE agent_id=?").get(agentA.id);
    const response = await claim(agentA, receipt.digest, 10_000);
    assert(response.status === 409, `Expected HTTP 409, got ${response.status}: ${JSON.stringify(response.data)}`);
    assert(response.data?.error === "already_claimed", `error was ${response.data?.error}`);
    return "already_claimed; no second pass created";
  });

  await step("(9) calls drain the pass and the next call is 402", async () => {
    assert(agentA, "Agent A was not created");
    assert(passCalls > 0, "No pass was granted");
    let spent = 0;
    let blocked = null;
    for (let i = 0; i < passCalls + 2; i += 1) {
      const response = await request("/v1/premium/data?type=price&symbol=SUI&currency=USD", { token: agentA.apiKey });
      if (response.status === 402) { blocked = response.data; break; }
      requireStatus(response, 200, "Price call while draining");
      spent += 1;
    }
    assert(blocked, `Pass never exhausted after ${spent} calls`);
    assert(blocked.error === "payment_required" && blocked.pay_to === vendor.address, `402 body was ${JSON.stringify(blocked)}`);
    const status = await premiumStatus(agentA);
    assert(status.status === "exhausted", `pass status was ${status.status}`);
    assert(status.calls_used === passCalls, `calls_used was ${status.calls_used}, granted ${passCalls}`);
    assert(status.calls_remaining === 0, `calls_remaining was ${status.calls_remaining}`);
    assert(callsUsed === passCalls, `${callsUsed} of ${passCalls} calls were consumed before exhaustion`);
    return `${spent} further paid call(s) then 402; status ${status.status} (${status.calls_used}/${status.calls_granted})`;
  });

  await step("(10) Tatum activity shows the REST rate calls and gRPC calls", async () => {
    const activity = requireStatus(await request("/v1/tatum/activity", { token: config.ADMIN_TOKEN }), 200, "Tatum activity");
    const rest = activity.calls.filter((entry) => entry.method === "rest:GET /v4/data/rate/symbol");
    const grpc = activity.calls.filter((entry) => String(entry.method).includes("sui.rpc.v2."));
    assert(rest.length >= 1, `expected at least one REST rate call, saw ${rest.length}: ${JSON.stringify(activity.calls.slice(0, 8))}`);
    assert(rest.every((entry) => entry.outcome === "success"), `REST outcomes: ${JSON.stringify(rest)}`);
    assert(grpc.length >= 1, `expected gRPC calls, saw ${grpc.length}`);
    const ledger = grpc.filter((entry) => String(entry.method).includes("LedgerService/"));
    assert(ledger.length >= 1, `expected LedgerService GetTransaction calls: ${JSON.stringify(grpc.map((entry) => entry.method))}`);
    const logged = db.prepare("SELECT type,outcome,COUNT(*) AS count FROM premium_calls GROUP BY type,outcome").all();
    const okCount = db.prepare("SELECT COUNT(*) AS count FROM premium_calls WHERE outcome='ok'").get().count;
    const requiredCount = db.prepare("SELECT COUNT(*) AS count FROM premium_calls WHERE outcome='payment_required'").get().count;
    assert(okCount >= passCalls + 1 && requiredCount >= 1, `premium_calls rows: ${JSON.stringify(logged)}`);
    return `${rest.length} REST rate call(s) (the second price call was served by the 20 s cache), ${grpc.length} gRPC call(s) incl. ${ledger.length} LedgerService; ${okCount} ok + ${requiredCount} payment_required rows in premium_calls`;
  });
} catch (error) {
  if (!(error instanceof StepFailure)) {
    failed += 1;
    console.log(`FAIL unexpected error: ${safeMessage(error)}`);
  }
} finally {
  if (state.agents.length > 0) {
    try {
      const ids = state.agents.map((agent) => agent.id);
      const placeholders = ids.map(() => "?").join(",");
      const result = db.prepare(`UPDATE agents SET status='inactive' WHERE id IN (${placeholders}) AND status!='inactive'`).run(...ids);
      console.log(`CLEANUP deactivated ${result.changes} smoke agent(s): ${ids.join(", ")}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL cleanup could not deactivate smoke agents: ${safeMessage(error)}`);
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

console.log(`Summary: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
export {};