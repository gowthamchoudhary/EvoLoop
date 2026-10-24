import Database from "better-sqlite3";
import { resolve } from "node:path";
import { getConfig } from "../src/config.js";
import { closePayrollChain, formatMist, getPayrollBalanceBreakdown } from "../src/payroll-chain.js";

const config = getConfig();
const db = new Database(resolve(config.DB_PATH), { readonly: true, fileMustExist: true });
db.pragma("query_only = ON");
let exitCode = 0;

function safeMessage(value) {
  let message = String(value);
  for (const secret of [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN, config.WALLET_ENC_KEY]) {
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  return message.replace(/\b(?:plk_[a-f0-9]{64}|suiprivkey1[0-9a-z]+|(?:0x)?[a-f0-9]{64})\b/gi, "[REDACTED]");
}

try {
  const agent = db.prepare(`
    SELECT id,name,status,created_at FROM agents
    WHERE status='inactive' AND substr(name,1,?)=?
    ORDER BY created_at DESC LIMIT 1
  `).get("payroll-smoke-a".length, "payroll-smoke-a");

  if (!agent) {
    console.log("FAIL: no inactive payroll-smoke-a agent found");
    exitCode = 1;
  } else {
    console.log(`Agent: ${agent.id} (${agent.name}; ${agent.status})`);
    const spends = db.prepare(`
      SELECT id,digest,amount_mist,created_at FROM transactions
      WHERE agent_id=? AND kind='spend' AND status='executed'
      ORDER BY created_at
    `).all(agent.id);
    console.log(`Executed spend transactions (${spends.length}):`);
    for (const spend of spends) console.log(`- ${spend.id} | digest=${spend.digest ?? "none"} | amount=${formatMist(spend.amount_mist)} SUI`);

    const events = db.prepare(`
      SELECT e.id,e.summary,e.memory_status,m.id AS memory_id,m.status AS row_status,m.blob_id
      FROM events e LEFT JOIN memories m ON m.event_id=e.id
      WHERE e.agent_id=? AND e.type='cost_incurred'
      ORDER BY e.ts,e.id
    `).all(agent.id);
    const memoryCount = events.filter((event) => event.memory_id !== null).length;
    console.log(`cost_incurred events and memory rows (${events.length} events; ${memoryCount} memory rows):`);
    for (const event of events) {
      console.log(`- ${event.id} | ${event.summary} | event_memory_status=${event.memory_status} | memory_status=${event.row_status ?? "missing"} | blob_id=${event.blob_id ?? "none"}`);
    }

    const payslip = db.prepare(`SELECT * FROM payslips WHERE agent_id=? ORDER BY created_at DESC LIMIT 1`).get(agent.id);
    if (payslip) {
      console.log(`Payslip: period=${payslip.period_label} | salary=${formatMist(payslip.salary_mist)} SUI | spent=${formatMist(payslip.spent_mist)} SUI | saved=${formatMist(payslip.saved_mist)} SUI | salary_digest=${payslip.salary_digest ?? "none"}`);
    } else {
      console.log("Payslip: none");
    }

    const pass = spends.length === events.length && events.length === memoryCount;
    console.log(`${pass ? "PASS" : "FAIL"}: executed spends=${spends.length}, cost events=${events.length}, memory rows=${memoryCount}`);
    if (!pass) exitCode = 1;
  }

  const treasury = db.prepare("SELECT address FROM wallets WHERE owner_type='treasury' AND owner_id='treasury'").get();
  if (treasury) {
    const balance = await getPayrollBalanceBreakdown(treasury.address, { bypassCache: true });
    console.log(`Treasury balance: total=${formatMist(balance.totalBalance)} SUI (${balance.totalBalance} MIST); coin objects=${formatMist(balance.coinBalance)} SUI (${balance.coinBalance} MIST); address balance=${formatMist(balance.addressBalance)} SUI (${balance.addressBalance} MIST)`);
  } else {
    console.log("Treasury balance: unavailable (treasury wallet not found)");
    exitCode = 1;
  }
} catch (error) {
  console.error(`FAIL verify: ${safeMessage(error?.message ?? error)}`);
  exitCode = 1;
} finally {
  db.close();
  closePayrollChain();
}

process.exitCode = exitCode;
