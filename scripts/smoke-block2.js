import { getConfig } from "../src/config.js";
import { getDatabase, initDatabase } from "../src/db.js";
import { getWallet } from "../src/wallets.js";
import { formatMist, getPayrollBalance } from "../src/payroll-chain.js";

const SMOKE = Object.freeze({
  treasuryMinimumSui: 0.5,
  salarySui: 0.1,
  perTxCapSui: 0.02,
  periodCapSui: 0.04,
  allowedSpendSui: 0.015,
  overPerTxSpendSui: 0.03,
  disallowedVendorSpendSui: 0.01,
});
const toMist = (sui) => BigInt(Math.round(sui * 1_000_000_000));
const salaryMist = toMist(SMOKE.salarySui);
const allowedSpendMist = toMist(SMOKE.allowedSpendSui);
const minimumTreasuryMist = toMist(SMOKE.treasuryMinimumSui);

const config = getConfig();
const baseUrl = `http://127.0.0.1:${config.PORT}`;
const secrets = [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN, config.WALLET_ENC_KEY].filter(Boolean);
const state = { agents: [], keys: [], walletAddresses: [], queuedCostEvents: [] };
let passed = 0;
let failed = 0;
let stopped = false;

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
  if (stopped) return false;
  const started = Date.now();
  try {
    const detail = await action();
    passed += 1;
    console.log(`PASS ${name} (${Date.now() - started} ms)${detail ? `: ${detail}` : ""}`);
    return true;
  } catch (error) {
    failed += 1;
    stopped = true;
    console.log(`FAIL ${name} (${Date.now() - started} ms): ${safeMessage(error)}`);
    return false;
  }
}

function ensureStatus(response, expected, label) {
  if (response.status !== expected) {
    const detail = [response.data?.error, response.data?.stage, response.data?.message].filter(Boolean).join(" ");
    throw new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
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
  if (balance < minimumTreasuryMist) {
    throw new Error(`Treasury balance is ${formatMist(balance)} SUI at ${treasury.address}; use the Sui testnet faucet to fund it with at least ${SMOKE.treasuryMinimumSui} SUI`);
  }
  return `at least ${SMOKE.treasuryMinimumSui} SUI available (${treasury.address})`;
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
        body: { salary_sui: SMOKE.salarySui, per_tx_cap_sui: SMOKE.perTxCapSui, period_cap_sui: SMOKE.periodCapSui, allowed_vendor_ids: ["premium-data-source"] },
      }), 200, "Set policy");
    }
    return "two agent keys retained in memory only";
  });

  let beforeBalances = [];
  let payrollResult;
  await step("Run payroll, verify both digests, and confirm salary balances", async () => {
    if (state.agents.length !== 2) throw new Error("Both agent wallets and policies are required");
    beforeBalances = await Promise.all(state.walletAddresses.map((address) => getPayrollBalance(address, { bypassCache: true })));
    const payroll = ensureStatus(await request("/v1/payroll/run", {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: { period_label: `smoke-${new Date().toISOString().slice(0, 10)}`, agent_ids: state.agents },
    }), 200, "Run payroll");
    payrollResult = payroll;
    const results = state.agents.map((id) => payroll.paid.find((item) => item.agent_id === id));
    if (results.some((item) => !item || !["success", "unconfirmed"].includes(item.status) || !item.digest)) throw new Error("Payroll did not return two submitted salary transfers");
    let pendingSalaries = 0;
    for (let i = 0; i < results.length; i += 1) {
      const verification = ensureStatus(await request(`/v1/transactions/${encodeURIComponent(results[i].digest)}/verify`, { token: config.ADMIN_TOKEN }), 200, "Verify salary digest");
      if (verification.status === "unconfirmed") {
        pendingSalaries += 1;
        continue;
      }
      if (verification.status !== "success" || verification.sender !== treasury.address) throw new Error(`Salary digest verification failed for ${state.agents[i]}`);
      const after = await getPayrollBalance(state.walletAddresses[i], { bypassCache: true });
      if (after < beforeBalances[i] + salaryMist) throw new Error(`Agent ${state.agents[i]} balance did not increase by ${SMOKE.salarySui} SUI`);
    }
    return pendingSalaries ? `two ${SMOKE.salarySui} SUI salary transfers submitted; ${pendingSalaries} still pending after polling` : `two real ${SMOKE.salarySui} SUI transfers confirmed by Tatum; balances increased`;
  });

  let firstSpendDone = false;
  await step(`Spend ${SMOKE.allowedSpendSui} SUI at the allowed vendor`, async () => {
    if (!payrollResult) throw new Error("Payroll step did not complete");
    const vendor = getDatabase().prepare("SELECT * FROM vendors WHERE id='premium-data-source'").get();
    if (!vendor) throw new Error("premium-data-source vendor is missing; run npm run vendors:seed");
    const before = await getPayrollBalance(vendor.address, { bypassCache: true });
    const result = ensureStatus(await request("/v1/spend", {
      token: state.keys[0], method: "POST",
      body: { vendor_id: vendor.id, amount_sui: SMOKE.allowedSpendSui, reason: "Approved premium dataset for the current task", category: "data" },
    }), 201, "Allowed vendor spend");
    if (!["success", "executed", "unconfirmed"].includes(result.status) || !result.digest) throw new Error("Allowed spend was not submitted");
    if (result.status !== "unconfirmed") {
      const after = await getPayrollBalance(vendor.address, { bypassCache: true });
      if (after < before + allowedSpendMist) throw new Error(`Vendor balance did not increase by ${SMOKE.allowedSpendSui} SUI`);
    }
    firstSpendDone = true;
    return result.status === "unconfirmed" ? "transfer submitted; still pending after confirmation polling" : `transfer confirmed and vendor balance increased by at least ${SMOKE.allowedSpendSui} SUI`;
  });

  await step("Block spend above the per-transaction cap", async () => {
    if (!state.keys[0]) throw new Error("Agent A is unavailable");
    const response = await request("/v1/spend", {
      token: state.keys[0], method: "POST",
      body: { vendor_id: "premium-data-source", amount_sui: SMOKE.overPerTxSpendSui, reason: "Request dataset", category: "data" },
    });
    if (response.status !== 403 || response.data?.rule !== "per_tx_cap_exceeded") throw new Error(`Expected per_tx_cap_exceeded HTTP 403, received HTTP ${response.status}`);
    const records = ensureStatus(await request(`/v1/agents/${encodeURIComponent(state.agents[0])}/transactions`, { token: config.ADMIN_TOKEN }), 200, "List spend transactions");
    if (!records.some((row) => row.id === response.data.transaction_id && row.status === "blocked" && row.digest === null)) throw new Error("Blocked transaction was not recorded without a digest");
    return "blocked; no transaction digest was sent";
  });

  await step("Block spend at a disallowed vendor", async () => {
    const response = await request("/v1/spend", {
      token: state.keys[0], method: "POST",
      body: { vendor_id: "vision-api", amount_sui: SMOKE.disallowedVendorSpendSui, reason: "Request vision processing", category: "model" },
    });
    if (response.status !== 403 || response.data?.rule !== "vendor_not_allowed") throw new Error(`Expected vendor_not_allowed HTTP 403, received HTTP ${response.status}`);
    return "vision-api spend blocked by vendor rule";
  });

  let periodCapBlocked = false;
  await step(`Exercise period cap at the ${SMOKE.periodCapSui} SUI boundary`, async () => {
    if (!firstSpendDone) throw new Error("Initial allowed spend did not execute");
    const next = ensureStatus(await request("/v1/spend", {
      token: state.keys[0], method: "POST",
      body: { vendor_id: "premium-data-source", amount_sui: SMOKE.allowedSpendSui, reason: "Approved additional dataset", category: "data" },
    }), 201, "Second allowed spend");
    if (!["success", "executed", "unconfirmed"].includes(next.status) || !next.digest) throw new Error("Second allowed spend was not submitted");
    const blocked = await request("/v1/spend", {
      token: state.keys[0], method: "POST",
      body: { vendor_id: "premium-data-source", amount_sui: SMOKE.allowedSpendSui, reason: "Request dataset beyond period allocation", category: "data" },
    });
    if (blocked.status !== 403 || blocked.data?.rule !== "period_cap_exceeded") throw new Error(`Expected period_cap_exceeded HTTP 403 after reaching ${SMOKE.periodCapSui} SUI; got HTTP ${blocked.status}`);
    periodCapBlocked = true;
    return `two ${SMOKE.allowedSpendSui} SUI spends reached ${SMOKE.allowedSpendSui * 2}; the third was blocked at the ${SMOKE.periodCapSui} SUI period cap`;
  });

  await step("Queue cost-incurred memories for Walrus", async () => {
    if (!periodCapBlocked) throw new Error("Spend sequence did not reach period cap");
    const rows = ensureStatus(await request(`/v1/agents/${encodeURIComponent(state.agents[0])}/events?type=cost_incurred&limit=20`, { token: state.keys[0] }), 200, "List cost events");
    const executedSpends = getDatabase().prepare("SELECT digest FROM transactions WHERE agent_id=? AND kind='spend' AND status='executed'").all(state.agents[0]);
    const executedDigests = new Set(executedSpends.map((row) => row.digest));
    const memoryRows = getDatabase().prepare(`
      SELECT m.id,m.event_id,m.status,m.blob_id,e.details_json
      FROM memories m JOIN events e ON e.id=m.event_id
      WHERE m.agent_id=? AND e.type='cost_incurred'
    `).all(state.agents[0]);
    const eventDigests = rows.map((row) => row.details?.digest ?? null);
    if (rows.length !== executedSpends.length || memoryRows.length !== rows.length) {
      throw new Error(`Expected cost event and memory counts to match ${executedSpends.length} executed spends; found ${rows.length} events and ${memoryRows.length} memory rows`);
    }
    if (eventDigests.some((digest) => !executedDigests.has(digest))) throw new Error("A cost_incurred event does not match an executed spend; blocked spends must not create cost events");
    if (memoryRows.some((row) => !["queued", "pending", "stored"].includes(row.status))) throw new Error("One or more cost events have no queued, pending, or stored memory row");
    state.queuedCostEvents = rows.map((row) => row.id);
    return `${executedSpends.length} executed spends, ${rows.length} cost events, and ${memoryRows.length} queued/pending/stored memory rows`;
  });

  await step("Verify payslip spent and saved amounts", async () => {
    for (let i = 0; i < state.agents.length; i += 1) {
      const slips = ensureStatus(await request(`/v1/agents/${encodeURIComponent(state.agents[i])}/payslips`, { token: state.keys[i] }), 200, "List payslips");
      const slip = slips[0];
      if (!slip || slip.salary_mist !== salaryMist.toString()) throw new Error(`Missing ${SMOKE.salarySui} SUI payslip for ${state.agents[i]}`);
      const expectedSpent = i === 0 ? (allowedSpendMist * 2n).toString() : "0";
      const expectedSaved = i === 0 ? (salaryMist - allowedSpendMist * 2n).toString() : salaryMist.toString();
      if (slip.spent_mist !== expectedSpent || slip.saved_mist !== expectedSaved) throw new Error(`Unexpected payslip totals for ${state.agents[i]}`);
    }
    return `agent A spent ${SMOKE.allowedSpendSui * 2} / saved ${SMOKE.salarySui - SMOKE.allowedSpendSui * 2} SUI; agent B spent 0 / saved ${SMOKE.salarySui} SUI`;
  });
}

if (state.agents.length) {
  const cleanupStarted = Date.now();
  try {
    const placeholders = state.agents.map(() => "?").join(",");
    const result = getDatabase().prepare(`UPDATE agents SET status='inactive' WHERE id IN (${placeholders}) AND status!='inactive'`).run(...state.agents);
    console.log(`PASS Deactivate smoke agents (${Date.now() - cleanupStarted} ms): deactivated ${result.changes}; ids=${state.agents.join(",")}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL Deactivate smoke agents (${Date.now() - cleanupStarted} ms): ${safeMessage(error)}`);
  }
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
