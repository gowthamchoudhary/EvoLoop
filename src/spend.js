import { randomUUID } from "node:crypto";
import { getConfig } from "./config.js";
import { getDatabase } from "./db.js";
import { insertEvent, reportTransferFailure } from "./events.js";
import { formatMist, getPayrollBalance, suiToMist, transferSui } from "./payroll-chain.js";
import { getWallet } from "./wallets.js";

const agentSpendLocks = new Map();

/** Serializes spends and upgrade executions per agent so catches cannot race the same balance. */
export async function withAgentSpendLock(agentId, callback) {
  const previous = agentSpendLocks.get(agentId) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  agentSpendLocks.set(agentId, current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (agentSpendLocks.get(agentId) === current) agentSpendLocks.delete(agentId);
  }
}

export function periodStart(agentId) {
  const payslip = getDatabase().prepare("SELECT created_at FROM payslips WHERE agent_id=? ORDER BY created_at DESC LIMIT 1").get(agentId);
  if (payslip) return payslip.created_at;
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Sum of executed/unconfirmed spends since `start`; top-ups and salaries are not spends. */
export function spentSince(agentId, start) {
  const rows = getDatabase().prepare("SELECT amount_mist FROM transactions WHERE agent_id=? AND kind='spend' AND status IN ('executed','unconfirmed') AND created_at>=?").all(agentId, start);
  return rows.reduce((total, row) => total + BigInt(row.amount_mist), 0n);
}

function isMissingCapability(reason) {
  return /\b(?:missing|lack(?:ing)?|without)\s+(?:the\s+)?capabilit(?:y|ies)\b|\bcapabilit(?:y|ies)\s+(?:is\s+)?missing\b/i.test(reason);
}

/**
 * The single spend path used by POST /v1/spend and by upgrade execution.
 * Applies the existing vendor/per-tx/period/gas rules, records blocked attempts, and on success
 * records the cost_incurred event (and its Walrus memory) plus payslip totals.
 */
export async function spendForAgent({ agentId, vendorId, amountMist, reason, category, lock = true }) {
  const amount = BigInt(amountMist);
  const run = async () => {
    const db = getDatabase();
    const policy = db.prepare("SELECT * FROM policies WHERE agent_id=?").get(agentId);
    const wallet = getWallet("agent", agentId);
    const vendor = db.prepare("SELECT * FROM vendors WHERE id=?").get(vendorId);
    if (!policy || !wallet) return { ok: false, http_status: 409, error: "agent wallet and policy are required" };
    const allowedVendors = JSON.parse(policy.allowed_vendor_ids_json);
    let failedRule = null;
    if (!vendor || !allowedVendors.includes(vendorId)) failedRule = "vendor_not_allowed";
    else if (amount > BigInt(policy.per_tx_cap_mist)) failedRule = "per_tx_cap_exceeded";
    else if (spentSince(agentId, periodStart(agentId)) + amount > BigInt(policy.period_cap_mist)) failedRule = "period_cap_exceeded";

    if (!failedRule) {
      const balance = await getPayrollBalance(wallet.address);
      const reserve = suiToMist(getConfig().GAS_RESERVE_SUI);
      if (balance - amount < reserve) failedRule = "gas_reserve_would_be_breached";
    }

    const txId = `spend_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    if (failedRule) {
      db.prepare(`INSERT INTO transactions(id,agent_id,kind,to_address,amount_mist,reason,category,vendor_id,rule_result,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,'blocked',?)`).run(txId, agentId, "spend", vendor?.address ?? "", amount.toString(), reason, category, vendor?.id ?? null, failedRule, createdAt);
      if (isMissingCapability(reason)) {
        const label = vendor?.label ?? vendorId;
        insertEvent(agentId, {
          type: "capability_missing",
          task_category: category,
          summary: `Spend request for ${label} was blocked because a capability is missing: ${reason}`,
          details: { vendor_id: vendorId, rule: failedRule, amount_sui: formatMist(amount) },
          ts: createdAt,
        });
      }
      return { ok: false, http_status: 403, error: "spend blocked by policy", rule: failedRule, transaction_id: txId, amount_mist: amount.toString() };
    }

    try {
      const confirmation = await transferSui(wallet, vendor.address, amount, {
        onExecuted: (execution) => db.prepare(`INSERT INTO transactions(id,agent_id,kind,to_address,amount_mist,reason,category,vendor_id,rule_result,status,digest,confirmed_at,checkpoint,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(txId, agentId, "spend", vendor.address, amount.toString(), reason, category, vendor.id, execution.error ?? "execution_submitted", execution.status, execution.digest, execution.confirmedAt, execution.checkpoint, createdAt),
      });
      const confirmedAt = new Date().toISOString();
      db.prepare(`UPDATE transactions SET rule_result='allowed',status=?,digest=?,confirmed_at=?,checkpoint=? WHERE id=?`)
        .run(confirmation.status === "success" ? "executed" : confirmation.status, confirmation.digest, confirmation.confirmedAt ?? null, confirmation.checkpoint ?? null, txId);

      const payslip = db.prepare("SELECT * FROM payslips WHERE agent_id=? ORDER BY created_at DESC LIMIT 1").get(agentId);
      if (payslip) {
        const spent = spentSince(agentId, payslip.created_at);
        const saved = BigInt(payslip.salary_mist) - spent;
        db.prepare("UPDATE payslips SET spent_mist=?,saved_mist=? WHERE id=?").run(spent.toString(), saved.toString(), payslip.id);
      }

      insertEvent(agentId, {
        type: "cost_incurred",
        task_category: category,
        summary: `Spent ${formatMist(amount)} SUI at ${vendor.label}: ${reason}`,
        details: { vendor_id: vendor.id, vendor_label: vendor.label, amount_mist: amount.toString(), amount_sui: formatMist(amount), reason, digest: confirmation.digest },
        ts: confirmedAt,
      });
      return {
        ok: true,
        transaction_id: txId,
        status: confirmation.status,
        digest: confirmation.digest,
        amount_mist: amount.toString(),
        amount_sui: formatMist(amount),
        vendor_id: vendor.id,
      };
    } catch (error) {
      const failure = reportTransferFailure(error);
      const existing = db.prepare("SELECT id FROM transactions WHERE id=?").get(txId);
      if (existing) db.prepare("UPDATE transactions SET rule_result=?,status='failed',digest=COALESCE(?,digest),confirmed_at=?,checkpoint=? WHERE id=?")
        .run(`${failure.stage}: ${failure.message}`, error.digest ?? null, error.confirmedAt ?? null, error.checkpoint ?? null, txId);
      else db.prepare(`INSERT INTO transactions(id,agent_id,kind,to_address,amount_mist,reason,category,vendor_id,rule_result,status,digest,confirmed_at,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,'failed',?,?,?)`).run(txId, agentId, "spend", vendor.address, amount.toString(), reason, category, vendor.id, `${failure.stage}: ${failure.message}`, error.digest ?? null, error.confirmedAt ?? null, new Date().toISOString());
      return { ok: false, http_status: 502, error: "Sui transfer failed", stage: failure.stage, message: failure.message, transaction_id: txId };
    }
  };
  return lock ? withAgentSpendLock(agentId, run) : run();
}
