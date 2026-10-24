import { getConfig } from "../src/config.js";
import { getDatabase, initDatabase } from "../src/db.js";
import { getWallet } from "../src/wallets.js";
import { formatMist, getPayrollBalance } from "../src/payroll-chain.js";

const config = getConfig();
const baseUrl = `http://127.0.0.1:${config.PORT}`;
const secrets = [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN, config.WALLET_ENC_KEY].filter(Boolean);
const state = { agents: [], keys: [], walletAddresses: [], queuedCostEvents: [] };
let passed = 0;
let failed = 0;

function safeMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  return message.replace(/\b(?:plk_[a-f0-9]{64}|suiprivkey1[0-9a-z]+|(?:0x)?[a-f0-9]{64})\b/gi, "[REDACTED]");
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

async function step(name, action) {
  const started = Date.now();
  try {
    const detail = await action();
    passed += 1;
    console.log(`PASS ${name} (${Date.now() - started} ms)${detail ? `: ${detail}` : ""}`);
    return true;
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name} (${Date.now() - started} ms): ${safeMessage(error)}`);
    return false;
  }
}

function ensureStatus(response, expected, label) {
  if (response.status !== expected) throw new Error(`${label} returned HTTP ${response.status}${response.data?.error ? `: ${response.data.error}` : ""}`);
  return response.data;
}

function parseResponseMist(data) {
  return BigInt(data.balance_mist);
}

initDatabase();
const treasury = getWallet("treasury", "treasury");
let funded = false;

funded = await step("Treasury testnet balance", async () => {
  if (!treasury) throw new Error("Treasury wallet is missing; run npm run treasury:create first");
  const balance = await getPayrollBalance(treasury.address);
  if (balance < 1_000_000_000n) {
    throw new Error(`Treasury balance is ${formatMist(balance)} SUI at ${treasury.address}; use the Sui testnet faucet to fund it with at least 1 SUI`);
  }
  return `at least 1 SUI available (${treasury.address})`;
});

if (funded) {
  await step("Register agents, create wallets, and set policies", async () => {
    for (const name of ["payroll-smoke-a", "payroll-smoke-b"]) {
      const registered = ensureStatus(await request("/v1/agents/register", {
        token: config.ADMIN_TOKEN,
        method: "POST",
        body: { name, kind: "payroll-smoke", description: "Block 2 live testnet payroll smoke agent" },
      }), 201, "Register agent");
      state.agents.push(registered.agent_id);
      state.keys.push(registered.api_key);
      const wallet = ensureStatus(await request(`/v1/agents/${encodeURIComponent(registered.agent_id)}/wallet`, {
        token: config.ADMIN_TOKEN,
        method: "POST",
      }), 201, "Create agent wallet");
      state.walletAddresses.push(wallet.address);
      ensureStatus(await request(`/v1/agents/${encodeURIComponent(registered.agent_id)}/policy`, {
        token: config.ADMIN_TOKEN,
        method: "PUT",
        body: { salary_sui: 0.3, per_tx_cap_sui: 0.05, period_cap_sui: 0.12, allowed_vendor_ids: ["premium-data-source"] },
      }), 200, "Set policy");
    }
    return "two agent keys retained in memory only";
  });

  let beforeBalances = [];
  let payrollResult;
  await step("Run payroll, verify both digests, and confirm salary balances", async () => {
    if (state.agents.length !== 2) throw new Error("Both agent wallets and policies are required");
    beforeBalances = await Promise.all(state.walletAddresses.map((address) => getPayrollBalance(address)));
    const payroll = ensureStatus(await request("/v1/payroll/run", {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: { period_label: `smoke-${new Date().toISOString().slice(0, 10)}`, agent_id: undefined },
    }), 200, "Run payroll");
    payrollResult = payroll;
    const results = state.agents.map((id) => payroll.paid.find((item) => item.agent_id === id));
    if (results.some((item) => !item || item.status !== "success" || !item.digest)) throw new Error("Payroll did not return two confirmed salary transfers");
    for (let i = 0; i < results.length; i += 1) {
      const verification = ensureStatus(await request(`/v1/transactions/${encodeURIComponent(results[i].digest)}/verify`, { token: config.ADMIN_TOKEN }), 200, "Verify salary digest");
      if (verification.status !== "success" || verification.sender !== treasury.address) throw new Error(`Salary digest verification failed for ${state.agents[i]}`);
      const after = await getPayrollBalance(state.walletAddresses[i]);
      if (after < beforeBalances[i] + 300_000_000n) throw new Error(`Agent ${state.agents[i]} balance did not increase by 0.3 SUI`);
    }
    return "two real 0.3 SUI transfers confirmed by Tatum; balances increased";
  });

  let firstSpendDone = false;
  await step("Spend 0.04 SUI at the allowed vendor", async () => {
    if (!payrollResult) throw new Error("Payroll step did not complete");
    const vendor = getDatabase().prepare("SELECT * FROM vendors WHERE id='premium-data-source'").get();
    if (!vendor) throw new Error("premium-data-source vendor is missing; run npm run vendors:seed");
    const before = await getPayrollBalance(vendor.address);
    const result = ensureStatus(await request("/v1/spend", {
      token: state.keys[0], method: "POST",
      body: { vendor_id: vendor.id, amount_sui: 0.04, reason: "Approved premium dataset for the current task", category: "data" },
    }), 201, "Allowed vendor spend");
    if (result.status !== "executed" || !result.digest) throw new Error("Allowed spend was not executed");
    const after = await getPayrollBalance(vendor.address);
    if (after < before + 40_000_000n) throw new Error("Vendor balance did not increase by 0.04 SUI");
    firstSpendDone = true;
    return "transfer confirmed and vendor balance increased by at least 0.04 SUI";
  });

  await step("Block spend above the per-transaction cap", async () => {
    if (!state.keys[0]) throw new Error("Agent A is unavailable");
    const response = await request("/v1/spend", {
      token: state.keys[0], method: "POST",
      body: { vendor_id: "premium-data-source", amount_sui: 0.08, reason: "Request dataset", category: "data" },
    });
    if (response.status !== 403 || response.data?.rule !== "per_tx_cap_exceeded") throw new Error(`Expected per_tx_cap_exceeded HTTP 403, received HTTP ${response.status}`);
    const records = ensureStatus(await request(`/v1/agents/${encodeURIComponent(state.agents[0])}/transactions`, { token: config.ADMIN_TOKEN }), 200, "List spend transactions");
    if (!records.some((row) => row.id === response.data.transaction_id && row.status === "blocked" && row.digest === null)) throw new Error("Blocked transaction was not recorded without a digest");
    return "blocked; no transaction digest was sent";
  });

  await step("Block spend at a disallowed vendor", async () => {
    const response = await request("/v1/spend", {
      token: state.keys[0], method: "POST",
      body: { vendor_id: "vision-api", amount_sui: 0.01, reason: "Request vision processing", category: "model" },
    });
    if (response.status !== 403 || response.data?.rule !== "vendor_not_allowed") throw new Error(`Expected vendor_not_allowed HTTP 403, received HTTP ${response.status}`);
    return "vision-api spend blocked by vendor rule";
  });

  let periodCapBlocked = false;
  await step("Exercise period cap at the 0.12 SUI boundary", async () => {
    if (!firstSpendDone) throw new Error("Initial allowed spend did not execute");
    for (let n = 0; n < 2; n += 1) {
      const next = await request("/v1/spend", {
        token: state.keys[0], method: "POST",
        body: { vendor_id: "premium-data-source", amount_sui: 0.04, reason: "Approved additional dataset", category: "data" },
      });
      ensureStatus(next, 201, "Spend up to the period cap");
    }
    const blocked = await request("/v1/spend", {
      token: state.keys[0], method: "POST",
      body: { vendor_id: "premium-data-source", amount_sui: 0.04, reason: "Request dataset beyond period allocation", category: "data" },
    });
    if (blocked.status !== 403 || blocked.data?.rule !== "period_cap_exceeded") throw new Error(`Expected period_cap_exceeded HTTP 403 after reaching 0.12 SUI; got HTTP ${blocked.status}`);
    periodCapBlocked = true;
    return "three 0.04 SUI spends reached 0.12; the next spend was blocked";
  });

  await step("Queue cost-incurred memories for Walrus", async () => {
    if (!periodCapBlocked) throw new Error("Spend sequence did not reach period cap");
    const rows = ensureStatus(await request(`/v1/agents/${encodeURIComponent(state.agents[0])}/events?type=cost_incurred&limit=20`, { token: state.keys[0] }), 200, "List cost events");
    if (rows.length !== 3) throw new Error(`Expected 3 cost_incurred events, found ${rows.length}`);
    if (rows.some((row) => !["pending", "stored"].includes(row.memory_status))) throw new Error("One or more cost events were not queued for Walrus");
    state.queuedCostEvents = rows.map((row) => row.id);
    return `${rows.length} executed spends have Walrus memory records`;
  });

  await step("Verify payslip spent and saved amounts", async () => {
    for (let i = 0; i < state.agents.length; i += 1) {
      const slips = ensureStatus(await request(`/v1/agents/${encodeURIComponent(state.agents[i])}/payslips`, { token: state.keys[i] }), 200, "List payslips");
      const slip = slips[0];
      if (!slip || slip.salary_mist !== "300000000") throw new Error(`Missing 0.3 SUI payslip for ${state.agents[i]}`);
      const expectedSpent = i === 0 ? "120000000" : "0";
      const expectedSaved = i === 0 ? "180000000" : "300000000";
      if (slip.spent_mist !== expectedSpent || slip.saved_mist !== expectedSaved) throw new Error(`Unexpected payslip totals for ${state.agents[i]}`);
    }
    return "agent A spent 0.12/saved 0.18 SUI; agent B spent 0/saved 0.3 SUI";
  });
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
