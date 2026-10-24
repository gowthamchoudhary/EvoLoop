import Fastify from "fastify";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getConfig } from "./config.js";
import { closeDatabase, getDatabase, initDatabase } from "./db.js";
import { buildMemoryText, enqueueMemory, newMemoryId, recallForAgent, resumePendingMemories } from "./memory-queue.js";
import { formatMist, getPayrollBalance, suiToMist, transferSui, verifyTransaction } from "./payroll-chain.js";
import { createWallet, getWallet } from "./wallets.js";
import { getTatumActivity } from "./tatum.js";

export const eventTypes = z.enum([
  "task_completed",
  "task_failed",
  "user_corrected",
  "task_abandoned",
  "cost_incurred",
  "capability_missing",
]);

const eventSchema = z.object({
  type: eventTypes,
  task_category: z.string().trim().min(1).max(100),
  summary: z.string().max(500),
  details: z.record(z.string(), z.unknown()).optional(),
  score: z.number().min(0).max(1).optional(),
  cost_usd: z.number().min(0).optional(),
  correction: z.string().max(500).optional(),
  ts: z.string().datetime({ offset: true }).optional().default(() => new Date().toISOString()),
});

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
});

const eventQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  type: eventTypes.optional(),
});
const recallQuerySchema = z.object({
  q: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(5),
});
const memoryQuerySchema = z.object({ status: z.enum(["pending", "stored", "failed"]).optional() });
const walletPolicySchema = z.object({
  salary_sui: z.number().positive(),
  per_tx_cap_sui: z.number().positive(),
  period_cap_sui: z.number().positive(),
  allowed_vendor_ids: z.array(z.string().min(1)),
});
const payrollSchema = z.object({ agent_id: z.string().optional(), period_label: z.string().trim().min(1).max(100) });
const spendSchema = z.object({
  vendor_id: z.string().min(1),
  amount_sui: z.number().positive(),
  reason: z.string().trim().min(1).max(500),
  category: z.string().trim().min(1).max(100),
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const equalHash = (left, right) => {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};
const agentSpendLocks = new Map();

async function withAgentSpendLock(agentId, callback) {
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

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "");
  return match?.[1] ?? null;
}

function isAdminToken(token) {
  return Boolean(token) && equalHash(sha256(token), sha256(getConfig().ADMIN_TOKEN));
}

function agentForToken(token) {
  if (!token) return null;
  const tokenHash = sha256(token);
  const agents = getDatabase().prepare("SELECT * FROM agents WHERE status='active'").all();
  return agents.find((agent) => equalHash(agent.api_key_hash, tokenHash)) ?? null;
}

function authError(reply) {
  return reply.code(401).send({ error: "unauthorized" });
}

function safeText(value) {
  let text = String(value);
  try {
    const config = getConfig();
    for (const secret of [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN, config.WALLET_ENC_KEY]) text = text.split(secret).join("[REDACTED]");
  } catch {}
  return text
    .replace(/\b(?:plk_[a-f0-9]{64}|suiprivkey1[0-9a-z]+|(?:0x)?[a-f0-9]{64})\b/gi, "[REDACTED]");
}

function reportTransferFailure(error) {
  const details = {
    stage: error.stage ?? "unknown",
    errorClass: error?.originalErrorClass ?? error?.constructor?.name ?? "Error",
    message: safeText(error?.message ?? error),
  };
  if (error?.code !== undefined) details.grpcStatusCode = safeText(error.code);
  if (error?.details !== undefined) details.grpcDetails = safeText(error.details);
  console.error("Sui transfer failed", JSON.stringify(details));
  return details;
}

function parseEventRows(rows) {
  return rows.map(({ details_json, ...row }) => ({ ...row, details: details_json ? JSON.parse(details_json) : null }));
}

function insertEvent(agentId, event) {
  const agent = getDatabase().prepare("SELECT name FROM agents WHERE id=?").get(agentId);
  const eventId = `evt_${randomUUID()}`;
  const memoryId = newMemoryId();
  const text = buildMemoryText({ agentName: agent.name, event, eventId });
  const now = new Date().toISOString();
  const db = getDatabase();
  const insert = db.transaction(() => {
    db.prepare(`INSERT INTO events(id,agent_id,type,task_category,summary,details_json,score,cost_usd,correction,ts,memory_status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      eventId, agentId, event.type, event.task_category, event.summary,
      event.details === undefined ? null : JSON.stringify(event.details), event.score ?? null,
      event.cost_usd ?? null, event.correction ?? null, event.ts ?? now, "pending",
    );
    db.prepare("INSERT INTO memories(id,event_id,agent_id,text,status,created_at) VALUES(?,?,?,?,?,?)")
      .run(memoryId, eventId, agentId, text, "pending", now);
  });
  insert();
  enqueueMemory(memoryId);
  return eventId;
}

function isMissingCapability(reason) {
  return /\b(?:missing|lack(?:ing)?|without)\s+(?:the\s+)?capabilit(?:y|ies)\b|\bcapabilit(?:y|ies)\s+(?:is\s+)?missing\b/i.test(reason);
}

function periodStart(agentId) {
  const payslip = getDatabase().prepare("SELECT created_at FROM payslips WHERE agent_id=? ORDER BY created_at DESC LIMIT 1").get(agentId);
  if (payslip) return payslip.created_at;
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function spentSince(agentId, start) {
  const rows = getDatabase().prepare("SELECT amount_mist FROM transactions WHERE agent_id=? AND kind='spend' AND status='executed' AND created_at>=?").all(agentId, start);
  return rows.reduce((total, row) => total + BigInt(row.amount_mist), 0n);
}

function publicTransaction(row) {
  return { ...row, amount_sui: formatMist(row.amount_mist) };
}

export async function buildServer() {
  initDatabase();
  resumePendingMemories();
  const app = Fastify({ logger: false });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "<unmatched>";
    console.log(safeText(`${request.method} ${route} ${reply.statusCode} ${reply.elapsedTime.toFixed(1)}ms`));
  });

  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(status).send({ error: status === 500 ? "internal server error" : safeText(error.message) });
  });

  app.get("/health", async (_request, reply) => {
    try {
      getDatabase().prepare("SELECT 1").get();
      return { status: "ok", db: "ok" };
    } catch {
      return reply.code(503).send({ status: "error", db: "error" });
    }
  });

  app.post("/v1/agents/register", async (request, reply) => {
    const token = bearerToken(request);
    if (!isAdminToken(token)) return authError(reply);
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });

    const db = getDatabase();
    const baseSlug = parsed.data.name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    let id;
    for (let i = 0; i < 5; i += 1) {
      id = `${baseSlug}-${randomBytes(2).toString("hex")}`;
      if (!db.prepare("SELECT 1 FROM agents WHERE id=?").get(id)) break;
    }
    const apiKey = `plk_${randomBytes(32).toString("hex")}`;
    db.prepare("INSERT INTO agents(id,name,kind,description,api_key_hash,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, parsed.data.name, parsed.data.kind, parsed.data.description, sha256(apiKey), new Date().toISOString());
    return reply.code(201).send({ agent_id: id, api_key: apiKey });
  });

  app.post("/v1/events", async (request, reply) => {
    const agent = agentForToken(bearerToken(request));
    if (!agent) return authError(reply);
    const parsed = eventSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });

    const event = parsed.data;
    const alwaysMemoryWorthy = ["user_corrected", "task_failed", "task_abandoned", "capability_missing", "cost_incurred"].includes(event.type);
    const memoryWorthy = alwaysMemoryWorthy || (event.type === "task_completed" && event.score !== undefined && event.score < 0.5);
    const db = getDatabase();
    const eventId = `evt_${randomUUID()}`;
    if (memoryWorthy) {
      const memoryId = newMemoryId();
      const text = buildMemoryText({ agentName: agent.name, event, eventId });
      const insert = db.transaction(() => {
        db.prepare(`INSERT INTO events(id,agent_id,type,task_category,summary,details_json,score,cost_usd,correction,ts,memory_status)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, agent.id, event.type, event.task_category, event.summary,
          event.details === undefined ? null : JSON.stringify(event.details), event.score ?? null,
          event.cost_usd ?? null, event.correction ?? null, event.ts, "pending");
        db.prepare("INSERT INTO memories(id,event_id,agent_id,text,status,created_at) VALUES(?,?,?,?,?,?)")
          .run(memoryId, eventId, agent.id, text, "pending", new Date().toISOString());
      });
      insert();
      enqueueMemory(memoryId);
    } else {
      db.prepare(`INSERT INTO events(id,agent_id,type,task_category,summary,details_json,score,cost_usd,correction,ts,memory_status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, agent.id, event.type, event.task_category, event.summary,
        event.details === undefined ? null : JSON.stringify(event.details), event.score ?? null,
        event.cost_usd ?? null, event.correction ?? null, event.ts, "none");
    }
    return reply.code(201).send({ event_id: eventId, memory: memoryWorthy ? "queued" : "skipped" });
  });

  app.get("/v1/agents/:id/events", async (request, reply) => {
    const token = bearerToken(request);
    const admin = isAdminToken(token);
    const agent = admin ? null : agentForToken(token);
    if (!admin && !agent) return authError(reply);
    if (!admin && agent.id !== request.params.id) return reply.code(403).send({ error: "forbidden" });
    const parsed = eventQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid query", issues: parsed.error.issues });
    const { limit, type } = parsed.data;
    const rows = type
      ? getDatabase().prepare("SELECT * FROM events WHERE agent_id=? AND type=? ORDER BY ts DESC LIMIT ?").all(request.params.id, type, limit)
      : getDatabase().prepare("SELECT * FROM events WHERE agent_id=? ORDER BY ts DESC LIMIT ?").all(request.params.id, limit);
    return parseEventRows(rows);
  });

  app.get("/v1/agents/:id/recall", async (request, reply) => {
    const token = bearerToken(request);
    const admin = isAdminToken(token);
    const agent = admin ? null : agentForToken(token);
    if (!admin && !agent) return authError(reply);
    if (!admin && agent.id !== request.params.id) return reply.code(403).send({ error: "forbidden" });
    const parsed = recallQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid query", issues: parsed.error.issues });
    if (!getDatabase().prepare("SELECT 1 FROM agents WHERE id=?").get(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    return recallForAgent(request.params.id, parsed.data.q, parsed.data.limit);
  });

  app.get("/v1/agents", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const agents = getDatabase().prepare(`
      SELECT a.id,a.name,a.kind,a.description,a.created_at,a.status,
        (SELECT COUNT(*) FROM events e WHERE e.agent_id=a.id) AS event_count
      FROM agents a ORDER BY a.created_at DESC
    `).all();
    const memoryCounts = getDatabase().prepare("SELECT agent_id,status,COUNT(*) AS count FROM memories GROUP BY agent_id,status").all();
    const countsByAgent = new Map();
    for (const { agent_id, status, count } of memoryCounts) {
      if (!countsByAgent.has(agent_id)) countsByAgent.set(agent_id, { pending: 0, stored: 0, failed: 0 });
      countsByAgent.get(agent_id)[status] = count;
    }
    return agents.map((agent) => ({ ...agent, memory_counts: countsByAgent.get(agent.id) ?? { pending: 0, stored: 0, failed: 0 } }));
  });

  app.get("/v1/memories", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const parsed = memoryQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid query", issues: parsed.error.issues });
    const rows = parsed.data.status
      ? getDatabase().prepare("SELECT * FROM memories WHERE status=? ORDER BY created_at DESC").all(parsed.data.status)
      : getDatabase().prepare("SELECT * FROM memories ORDER BY created_at DESC").all();
    return rows;
  });

  app.get("/v1/tatum/activity", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    return getTatumActivity();
  });

  app.post("/v1/agents/:id/wallet", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const agent = getDatabase().prepare("SELECT id FROM agents WHERE id=?").get(request.params.id);
    if (!agent) return reply.code(404).send({ error: "agent not found" });
    const wallet = createWallet("agent", agent.id);
    return reply.code(201).send({ address: wallet.address });
  });

  app.put("/v1/agents/:id/policy", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    if (!getDatabase().prepare("SELECT 1 FROM agents WHERE id=?").get(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    const parsed = walletPolicySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });
    let salaryMist;
    let perTxMist;
    let periodMist;
    try {
      salaryMist = suiToMist(parsed.data.salary_sui);
      perTxMist = suiToMist(parsed.data.per_tx_cap_sui);
      periodMist = suiToMist(parsed.data.period_cap_sui);
    } catch (error) {
      return reply.code(400).send({ error: safeText(error.message) });
    }
    const allowed = [...new Set(parsed.data.allowed_vendor_ids)];
    if (allowed.length) {
      const placeholders = allowed.map(() => "?").join(",");
      const found = getDatabase().prepare(`SELECT id FROM vendors WHERE id IN (${placeholders})`).all(...allowed).map((row) => row.id);
      if (found.length !== allowed.length) return reply.code(400).send({ error: "allowed_vendor_ids contains an unknown vendor" });
    }
    getDatabase().prepare(`INSERT INTO policies(agent_id,salary_mist,per_tx_cap_mist,period_cap_mist,allowed_vendor_ids_json,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET salary_mist=excluded.salary_mist,
      per_tx_cap_mist=excluded.per_tx_cap_mist,period_cap_mist=excluded.period_cap_mist,
      allowed_vendor_ids_json=excluded.allowed_vendor_ids_json,updated_at=excluded.updated_at`)
      .run(request.params.id, salaryMist.toString(), perTxMist.toString(), periodMist.toString(), JSON.stringify(allowed), new Date().toISOString());
    return { agent_id: request.params.id, salary_sui: formatMist(salaryMist), per_tx_cap_sui: formatMist(perTxMist), period_cap_sui: formatMist(periodMist), allowed_vendor_ids: allowed };
  });

  app.get("/v1/agents/:id/balance", async (request, reply) => {
    const token = bearerToken(request);
    const admin = isAdminToken(token);
    const agent = admin ? null : agentForToken(token);
    if (!admin && !agent) return authError(reply);
    if (!admin && agent.id !== request.params.id) return reply.code(403).send({ error: "forbidden" });
    const wallet = getWallet("agent", request.params.id);
    if (!wallet) return reply.code(404).send({ error: "agent wallet not found" });
    const balance = await getPayrollBalance(wallet.address);
    return { address: wallet.address, balance_mist: balance.toString(), balance_sui: formatMist(balance), transport: "tatum-grpc" };
  });

  app.post("/v1/payroll/run", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const parsed = payrollSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });
    const db = getDatabase();
    if (parsed.data.agent_id && !db.prepare("SELECT 1 FROM agents WHERE id=?").get(parsed.data.agent_id)) return reply.code(404).send({ error: "agent not found" });
    const agents = parsed.data.agent_id
      ? db.prepare("SELECT id,name FROM agents WHERE id=? AND status='active'").all(parsed.data.agent_id)
      : db.prepare("SELECT id,name FROM agents WHERE status='active' ORDER BY created_at").all();
    const eligible = agents.map((agent) => ({
      agent,
      wallet: getWallet("agent", agent.id),
      policy: db.prepare("SELECT * FROM policies WHERE agent_id=?").get(agent.id),
    })).filter((item) => item.wallet && item.policy);
    if (agents.length && !eligible.length) return reply.code(409).send({ error: "no active agents have both a wallet and payroll policy" });
    const treasury = getWallet("treasury", "treasury");
    if (!treasury) return reply.code(409).send({ error: "treasury wallet has not been created" });
    if (!eligible.length) return { period_label: parsed.data.period_label, paid: [], skipped: agents.length };

    const required = eligible.reduce((sum, item) => sum + BigInt(item.policy.salary_mist), 0n) + BigInt(eligible.length) * 50_000_000n;
    const treasuryBalance = await getPayrollBalance(treasury.address);
    if (treasuryBalance < required) {
      return reply.code(402).send({
        error: "insufficient treasury balance for payroll and transaction gas",
        treasury_address: treasury.address,
        balance_sui: formatMist(treasuryBalance),
        required_sui: formatMist(required),
      });
    }

    const paid = [];
    for (const item of eligible) {
      const amount = BigInt(item.policy.salary_mist);
      const txId = `pay_${randomUUID()}`;
      try {
        const confirmation = await transferSui(treasury, item.wallet.address, amount);
        const createdAt = new Date().toISOString();
        const start = periodStart(item.agent.id);
        const spent = spentSince(item.agent.id, start);
        const saved = amount - spent;
        const payslipId = `slip_${randomUUID()}`;
        const transaction = db.transaction(() => {
          db.prepare(`INSERT INTO transactions(id,agent_id,kind,to_address,amount_mist,rule_result,status,digest,confirmed_at,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(txId, item.agent.id, "salary", item.wallet.address, amount.toString(), "salary_paid", "executed", confirmation.digest, createdAt, createdAt);
          db.prepare(`INSERT INTO payslips(id,agent_id,period_label,salary_mist,spent_mist,saved_mist,salary_digest,created_at)
            VALUES(?,?,?,?,?,?,?,?)`).run(payslipId, item.agent.id, parsed.data.period_label, amount.toString(), spent.toString(), saved.toString(), confirmation.digest, createdAt);
        });
        transaction();
        paid.push({ agent_id: item.agent.id, salary_sui: formatMist(amount), digest: confirmation.digest, status: confirmation.status, payslip_id: payslipId });
      } catch (error) {
          const failure = reportTransferFailure(error);
        db.prepare(`INSERT INTO transactions(id,agent_id,kind,to_address,amount_mist,rule_result,status,digest,confirmed_at,created_at)
            VALUES(?,?,?,?,?,?, 'failed',?,?,?)`).run(txId, item.agent.id, "salary", item.wallet.address, amount.toString(), `${failure.stage}: ${failure.message}`, error.digest ?? null, error.confirmedAt ?? null, new Date().toISOString());
          return reply.code(502).send({ error: "payroll transfer failed", stage: failure.stage, message: failure.message, paid, failed_agent_id: item.agent.id });
      }
    }
    return { period_label: parsed.data.period_label, paid, skipped: agents.length - eligible.length };
  });

  app.post("/v1/spend", async (request, reply) => {
    const agent = agentForToken(bearerToken(request));
    if (!agent) return authError(reply);
    const parsed = spendSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });
    let amount;
    try { amount = suiToMist(parsed.data.amount_sui); }
    catch (error) { return reply.code(400).send({ error: safeText(error.message) }); }

    return withAgentSpendLock(agent.id, async () => {
      const db = getDatabase();
      const policy = db.prepare("SELECT * FROM policies WHERE agent_id=?").get(agent.id);
      const wallet = getWallet("agent", agent.id);
      const vendor = db.prepare("SELECT * FROM vendors WHERE id=?").get(parsed.data.vendor_id);
      if (!policy || !wallet) return reply.code(409).send({ error: "agent wallet and policy are required" });
      const allowedVendors = JSON.parse(policy.allowed_vendor_ids_json);
      let failedRule = null;
      if (!vendor || !allowedVendors.includes(parsed.data.vendor_id)) failedRule = "vendor_not_allowed";
      else if (amount > BigInt(policy.per_tx_cap_mist)) failedRule = "per_tx_cap_exceeded";
      else if (spentSince(agent.id, periodStart(agent.id)) + amount > BigInt(policy.period_cap_mist)) failedRule = "period_cap_exceeded";

      let balance;
      if (!failedRule) {
        balance = await getPayrollBalance(wallet.address);
        const reserve = suiToMist(getConfig().GAS_RESERVE_SUI);
        if (balance - amount < reserve) failedRule = "gas_reserve_would_be_breached";
      }

      const txId = `spend_${randomUUID()}`;
      const createdAt = new Date().toISOString();
      if (failedRule) {
        db.prepare(`INSERT INTO transactions(id,agent_id,kind,to_address,amount_mist,reason,category,vendor_id,rule_result,status,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,'blocked',?)`).run(txId, agent.id, "spend", vendor?.address ?? "", amount.toString(), parsed.data.reason, parsed.data.category, vendor?.id ?? null, failedRule, createdAt);
        if (isMissingCapability(parsed.data.reason)) {
          const label = vendor?.label ?? parsed.data.vendor_id;
          insertEvent(agent.id, {
            type: "capability_missing",
            task_category: parsed.data.category,
            summary: `Spend request for ${label} was blocked because a capability is missing: ${parsed.data.reason}`,
            details: { vendor_id: parsed.data.vendor_id, rule: failedRule, amount_sui: parsed.data.amount_sui },
            ts: createdAt,
          });
        }
        return reply.code(403).send({ error: "spend blocked by policy", rule: failedRule, transaction_id: txId });
      }

      try {
        const confirmation = await transferSui(wallet, vendor.address, amount);
        const confirmedAt = new Date().toISOString();
        db.prepare(`INSERT INTO transactions(id,agent_id,kind,to_address,amount_mist,reason,category,vendor_id,rule_result,status,digest,confirmed_at,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,'executed',?,?,?)`).run(txId, agent.id, "spend", vendor.address, amount.toString(), parsed.data.reason, parsed.data.category, vendor.id, "allowed", confirmation.digest, confirmedAt, createdAt);

        const payslip = db.prepare("SELECT * FROM payslips WHERE agent_id=? ORDER BY created_at DESC LIMIT 1").get(agent.id);
        if (payslip) {
          const spent = spentSince(agent.id, payslip.created_at);
          const saved = BigInt(payslip.salary_mist) - spent;
          db.prepare("UPDATE payslips SET spent_mist=?,saved_mist=? WHERE id=?").run(spent.toString(), saved.toString(), payslip.id);
        }

        insertEvent(agent.id, {
          type: "cost_incurred",
          task_category: parsed.data.category,
          summary: `Spent ${formatMist(amount)} SUI at ${vendor.label}: ${parsed.data.reason}`,
          details: { vendor_id: vendor.id, vendor_label: vendor.label, amount_mist: amount.toString(), amount_sui: formatMist(amount), reason: parsed.data.reason, digest: confirmation.digest },
          ts: confirmedAt,
        });
        return reply.code(201).send({ transaction_id: txId, status: "executed", digest: confirmation.digest, amount_mist: amount.toString(), amount_sui: formatMist(amount), vendor_id: vendor.id });
      } catch (error) {
          const failure = reportTransferFailure(error);
        db.prepare(`INSERT INTO transactions(id,agent_id,kind,to_address,amount_mist,reason,category,vendor_id,rule_result,status,digest,confirmed_at,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,'failed',?,?,?)`).run(txId, agent.id, "spend", vendor.address, amount.toString(), parsed.data.reason, parsed.data.category, vendor.id, `${failure.stage}: ${failure.message}`, error.digest ?? null, error.confirmedAt ?? null, new Date().toISOString());
          return reply.code(502).send({ error: "Sui transfer failed", stage: failure.stage, message: failure.message, transaction_id: txId });
      }
    });
  });

  app.get("/v1/agents/:id/transactions", async (request, reply) => {
    const token = bearerToken(request);
    const admin = isAdminToken(token);
    const agent = admin ? null : agentForToken(token);
    if (!admin && !agent) return authError(reply);
    if (!admin && agent.id !== request.params.id) return reply.code(403).send({ error: "forbidden" });
    const rows = getDatabase().prepare("SELECT * FROM transactions WHERE agent_id=? ORDER BY created_at DESC").all(request.params.id);
    return rows.map(publicTransaction);
  });

  app.get("/v1/agents/:id/payslips", async (request, reply) => {
    const token = bearerToken(request);
    const admin = isAdminToken(token);
    const agent = admin ? null : agentForToken(token);
    if (!admin && !agent) return authError(reply);
    if (!admin && agent.id !== request.params.id) return reply.code(403).send({ error: "forbidden" });
    return getDatabase().prepare("SELECT * FROM payslips WHERE agent_id=? ORDER BY created_at DESC").all(request.params.id).map((row) => ({
      ...row,
      salary_sui: formatMist(row.salary_mist),
      spent_sui: formatMist(row.spent_mist),
      saved_sui: formatMist(row.saved_mist),
    }));
  });

  app.get("/v1/transactions/:digest/verify", async (request, reply) => {
    const token = bearerToken(request);
    const admin = isAdminToken(token);
    const agent = admin ? null : agentForToken(token);
    if (!admin && !agent) return authError(reply);
    const record = getDatabase().prepare("SELECT * FROM transactions WHERE digest=?").get(request.params.digest);
    if (!record) return reply.code(404).send({ error: "transaction not found" });
    if (!admin && record.agent_id !== agent.id) return reply.code(403).send({ error: "forbidden" });
    const verified = await verifyTransaction(request.params.digest);
    return { ...verified, kind: record.kind, amount_mist: record.amount_mist, amount_sui: formatMist(record.amount_mist) };
  });

  app.addHook("onClose", async () => { closePayrollChain(); closeDatabase(); });
  return app;
}

export async function startServer() {
  const config = getConfig();
  const app = await buildServer();
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error) => {
    console.error(safeText(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
