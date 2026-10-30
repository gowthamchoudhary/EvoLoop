import Fastify from "fastify";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getConfig } from "./config.js";
import { closeDatabase, getDatabase, initDatabase } from "./db.js";
import { buildMemoryText, enqueueMemory, newMemoryId, recallForAgent, resumePendingMemories } from "./memory-queue.js";
import { closePayrollChain, formatMist, getPayrollBalance, getPayrollBalanceBreakdown, suiToMist, transferSui, verifyTransaction } from "./payroll-chain.js";
import { createWallet, getWallet } from "./wallets.js";
import { publicGap, publicReview, runReview } from "./review.js";
import { reportTransferFailure, safeText } from "./events.js";
import { periodStart, spendForAgent, spentSince } from "./spend.js";
import { settingsFor } from "./settings.js";
import { approveRequest, createProposalsForReview, getRequest, guidanceForAgent, listCatalog, listRequests, proposeCheckForAgent, rejectRequest } from "./upgrades.js";
import { lessonsForAgent, recallLessons, restoreLessons } from "./lessons.js";
import { PREMIUM_VERIFY_POLL_MS } from "./premium-config.js";
import { consumeCall, paymentRequired, passStatus, publicPass, recordPremiumCall, verifyReceipt } from "./premium.js";
import { getRate, getTatumActivity, pruneTatumCalls } from "./tatum.js";
import { evaluateVerdict, listVerdicts } from "./verdicts.js";
import { computeScore, storeScore, publicScore } from "./score.js";
import { acceptSuggestion, createSuggestion, dismissSuggestion, listSuggestions, publicSuggestion } from "./suggestions.js";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { registerPublicRoutes } from "./public-routes.js";
import { PUBLIC_RATE_LIMIT_PER_MIN } from "./public-config.js";

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
  session_id: z.string().trim().min(1).max(64).optional(),
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
const settingsSchema = z.object({
  period: z.enum(["daily", "weekly", "monthly", "compressed"]).default("monthly"),
  period_minutes: z.number().int().positive().nullable().default(null),
  allowance_mist: z.string().trim().regex(/^\d{1,40}$/).default("0"),
  improvement_reserve_pct: z.number().int().min(0).max(100).default(40),
  autonomy: z.enum(["ask", "auto_small", "never"]).default("ask"),
  auto_limit_mist: z.string().trim().regex(/^\d{1,40}$/).default("0"),
  rollover: z.union([z.boolean(), z.number().int().min(0).max(1)]).default(false),
});
const visibilitySchema=z.object({public:z.boolean(),demo_actionable:z.boolean().default(false)});
const approveSchema = z.object({
  note: z.string().trim().max(500).optional(),
  extra_budget_sui: z.number().positive().optional(),
});
const rejectSchema = z.object({ note: z.string().trim().max(500).optional() });
const requestQuerySchema = z.object({
  agent_id: z.string().min(1).optional(),
  status: z.enum(["needs_raise", "pending_approval", "auto_approved", "approved", "rejected", "executed", "failed", "note_only"]).optional(),
});
const claimSchema = z.object({
  digest: z.string().trim().min(1).max(128),
  poll_timeout_ms: z.number().int().min(500).max(40_000).optional(),
});
const premiumQuerySchema = z.object({
  type: z.enum(["price", "balance"]),
  symbol: z.string().trim().regex(/^[A-Za-z0-9]{1,10}$/).default("SUI"),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).default("USD"),
  address: z.string().trim().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
}).refine((value) => value.type !== "balance" || Boolean(value.address), {
  message: "address (0x + 64 hex) is required for type=balance",
  path: ["address"],
});
const reviewRunSchema = z.object({
  period_label: z.string().trim().min(1).max(100).optional(),
  window_start: z.string().datetime({ offset: true }).optional(),
  window_end: z.string().datetime({ offset: true }).optional(),
  score_snapshot: z.boolean().default(true),
}).refine((value) => !value.window_start || !value.window_end || Date.parse(value.window_start) <= Date.parse(value.window_end), {
  message: "window_start must not be after window_end",
  path: ["window_start"],
});
const payrollSchema = z.object({
  agent_id: z.string().optional(),
  agent_ids: z.array(z.string().min(1)).min(1).optional(),
  period_label: z.string().trim().min(1).max(100),
});
const spendSchema = z.object({
  vendor_id: z.string().min(1),
  amount_sui: z.number().positive(),
  reason: z.string().trim().min(1).max(500),
  category: z.string().trim().min(1).max(100),
});
const importAgentSchema = z.object({
  agent_id: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,64}$/, "agent_id must be 1-64 url-safe characters"),
  name: z.string().trim().min(1).max(100),
  kind: z.string().trim().min(1).max(50),
  description: z.string().trim().max(500).default(""),
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const equalHash = (left, right) => {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};
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

function parseEventRows(rows) {
  return rows.map(({ details_json, ...row }) => ({ ...row, details: details_json ? JSON.parse(details_json) : null }));
}

function publicTransaction(row) {
  return { ...row, amount_sui: formatMist(row.amount_mist) };
}

export async function buildServer() {
  initDatabase();
  pruneTatumCalls();
  resumePendingMemories();
  const app = Fastify({ logger: false });

  await app.register(rateLimit,{global:true,max:PUBLIC_RATE_LIMIT_PER_MIN,timeWindow:60_000,allowList:(request)=>!request.url.startsWith("/public/v1/")});
  app.addHook("onSend",async(_request,reply,payload)=>{reply.header("X-Content-Type-Options","nosniff");reply.header("Referrer-Policy","no-referrer");reply.header("X-Frame-Options","DENY");return payload;});

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "<unmatched>";
    console.log(safeText(`${request.method} ${route} ${reply.statusCode} ${reply.elapsedTime.toFixed(1)}ms`));
  });

  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) console.error(safeText(error.stack ?? error.message));
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

  app.put("/v1/agents/:id/visibility",async(request,reply)=>{if(!isAdminToken(bearerToken(request)))return authError(reply);const parsed=visibilitySchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid request",issues:parsed.error.issues});const changed=getDatabase().prepare("UPDATE agents SET public=?,demo_actionable=? WHERE id=?").run(parsed.data.public?1:0,parsed.data.demo_actionable?1:0,request.params.id);if(!changed.changes)return reply.code(404).send({error:"agent not found"});return {agent_id:request.params.id,public:parsed.data.public,demo_actionable:parsed.data.demo_actionable};});

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

  /** Creates an agent with an EXACT id so the Walrus namespace `prefix:agent_id` can be reused. */
  app.post("/v1/agents/import", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const parsed = importAgentSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });
    const db = getDatabase();
    if (db.prepare("SELECT 1 FROM agents WHERE id=?").get(parsed.data.agent_id)) {
      return reply.code(409).send({ error: "agent already exists", agent_id: parsed.data.agent_id });
    }
    const apiKey = `plk_${randomBytes(32).toString("hex")}`;
    db.prepare("INSERT INTO agents(id,name,kind,description,api_key_hash,created_at) VALUES(?,?,?,?,?,?)")
      .run(parsed.data.agent_id, parsed.data.name, parsed.data.kind, parsed.data.description, sha256(apiKey), new Date().toISOString());
    return reply.code(201).send({ agent_id: parsed.data.agent_id, api_key: apiKey, imported: true });
  });

  /** Lessons recalled from the agent's own Walrus namespace (refresh=1 forces recall). */
  app.get("/v1/agents/:id/lessons", async (request, reply) => {
    const token = bearerToken(request);
    const admin = isAdminToken(token);
    const agent = admin ? null : agentForToken(token);
    if (!admin && !agent) return authError(reply);
    if (!admin && agent.id !== request.params.id) return reply.code(403).send({ error: "forbidden" });
    if (!getDatabase().prepare("SELECT 1 FROM agents WHERE id=?").get(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    const recall = await recallLessons(request.params.id, { force: request.query.refresh === "1" });
    const rows = lessonsForAgent(request.params.id).map((lesson) => ({
      kind: lesson.kind,
      capability_key: lesson.capability_key,
      task_category: lesson.task_category,
      verdict: lesson.verdict,
      detail: lesson.detail,
      blob_id: lesson.blob_id,
      recalled_at: lesson.recalled_at,
    }));
    return { agent_id: request.params.id, recall_ok: recall.ok, recall_error: recall.error ?? null, count: rows.length, lessons: rows };
  });

  /** Force a recall and report what Walrus returned, parsed by kind. */
  app.post("/v1/agents/:id/lessons/restore", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    if (!getDatabase().prepare("SELECT 1 FROM agents WHERE id=?").get(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    return restoreLessons(request.params.id);
  });

  /** Dry-run of proposal creation for one capability; nothing is created. */
  app.get("/v1/agents/:id/propose-check", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const capabilityKey = String(request.query.capability_key ?? "").trim();
    if (!capabilityKey) return reply.code(400).send({ error: "capability_key is required" });
    return proposeCheckForAgent({ agentId: request.params.id, capabilityKey });
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
    const sessionId = event.session_id ?? new Date(event.ts).toISOString().slice(0, 10);
    if (memoryWorthy) {
      const memoryId = newMemoryId();
      const text = buildMemoryText({ agentName: agent.name, event, eventId });
      const insert = db.transaction(() => {
        db.prepare(`INSERT INTO events(id,agent_id,type,task_category,summary,details_json,score,cost_usd,correction,ts,session_id,memory_status)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, agent.id, event.type, event.task_category, event.summary,
          event.details === undefined ? null : JSON.stringify(event.details), event.score ?? null,
          event.cost_usd ?? null, event.correction ?? null, event.ts, sessionId, "pending");
        db.prepare("INSERT INTO memories(id,event_id,agent_id,text,status,created_at) VALUES(?,?,?,?,?,?)")
          .run(memoryId, eventId, agent.id, text, "pending", new Date().toISOString());
      });
      insert();
      enqueueMemory(memoryId);
    } else {
      db.prepare(`INSERT INTO events(id,agent_id,type,task_category,summary,details_json,score,cost_usd,correction,ts,session_id,memory_status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, agent.id, event.type, event.task_category, event.summary,
        event.details === undefined ? null : JSON.stringify(event.details), event.score ?? null,
        event.cost_usd ?? null, event.correction ?? null, event.ts, sessionId, "none");
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
    return agents.map((agent) => ({ ...agent, memory_counts: countsByAgent.get(agent.id) ?? { pending: 0, stored: 0, failed: 0 }, latest_score: publicScore(getDatabase().prepare("SELECT * FROM agent_scores WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(agent.id)), pending_suggestion: publicSuggestion(getDatabase().prepare("SELECT * FROM salary_suggestions WHERE agent_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(agent.id)) }));
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

  app.put("/v1/agents/:id/settings", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    if (!getDatabase().prepare("SELECT 1 FROM agents WHERE id=?").get(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });
    const settings = parsed.data;
    getDatabase().prepare(`INSERT INTO agent_settings(agent_id,period,period_minutes,allowance_mist,improvement_reserve_pct,autonomy,auto_limit_mist,rollover,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET period=excluded.period, period_minutes=excluded.period_minutes,
        allowance_mist=excluded.allowance_mist, improvement_reserve_pct=excluded.improvement_reserve_pct,
        autonomy=excluded.autonomy, auto_limit_mist=excluded.auto_limit_mist, rollover=excluded.rollover,
        updated_at=excluded.updated_at`).run(
      request.params.id, settings.period, settings.period_minutes, settings.allowance_mist,
      settings.improvement_reserve_pct, settings.autonomy, settings.auto_limit_mist,
      settings.rollover === true || settings.rollover === 1 ? 1 : 0, new Date().toISOString(),
    );
    return settingsFor(request.params.id);
  });

  app.get("/v1/agents/:id/settings", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    if (!getDatabase().prepare("SELECT 1 FROM agents WHERE id=?").get(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    return settingsFor(request.params.id);
  });

  app.post("/v1/agents/:id/review/run", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const parsed = reviewRunSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });
    const result = await runReview({
      agentId: request.params.id,
      periodLabel: parsed.data.period_label,
      windowStart: parsed.data.window_start,
      windowEnd: parsed.data.window_end,
    });
    if(parsed.data.score_snapshot){const scoreData=computeScore(request.params.id,result.review.window_start,result.review.window_end);const score=storeScore(scoreData,result.review.period_label);const suggestion=createSuggestion({...scoreData,...score});result.score=score;result.suggestion=suggestion;}
    return reply.code(201).send(result);
  });

  const scoreWindowSchema=z.object({period_label:z.string().trim().min(1).max(100),window_start:z.string().datetime({offset:true}),window_end:z.string().datetime({offset:true})}).refine(x=>Date.parse(x.window_start)<=Date.parse(x.window_end),{path:["window_start"],message:"window_start must not be after window_end"});
  app.post("/v1/agents/:id/score/snapshot",async(request,reply)=>{
    if(!isAdminToken(bearerToken(request)))return authError(reply);
    const parsed=scoreWindowSchema.safeParse(request.body);if(!parsed.success)return reply.code(400).send({error:"invalid request",issues:parsed.error.issues});
    const db=getDatabase();if(!db.prepare("SELECT 1 FROM agents WHERE id=?").get(request.params.id))return reply.code(404).send({error:"agent not found"});
    const computed=computeScore(request.params.id,parsed.data.window_start,parsed.data.window_end);const score=storeScore(computed,parsed.data.period_label,request.query?.source==="replay"?"replay":"live");const suggestion=createSuggestion({...computed,...score});return reply.code(201).send({score,suggestion});
  });
  app.get("/v1/agents/:id/scores",async(request,reply)=>{const token=bearerToken(request),admin=isAdminToken(token),agent=admin?null:agentForToken(token);if(!admin&&!agent)return authError(reply);if(!admin&&agent.id!==request.params.id)return reply.code(403).send({error:"forbidden"});return getDatabase().prepare("SELECT * FROM agent_scores WHERE agent_id=? ORDER BY created_at DESC,rowid DESC").all(request.params.id).map(publicScore);});
  app.get("/v1/agents/:id/score",async(request,reply)=>{const token=bearerToken(request),admin=isAdminToken(token),agent=admin?null:agentForToken(token);if(!admin&&!agent)return authError(reply);if(!admin&&agent.id!==request.params.id)return reply.code(403).send({error:"forbidden"});return publicScore(getDatabase().prepare("SELECT * FROM agent_scores WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(request.params.id))??reply.code(404).send({error:"score not found"});});
  app.get("/v1/suggestions",async(request,reply)=>{if(!isAdminToken(bearerToken(request)))return authError(reply);const q=z.object({agent_id:z.string().min(1).optional(),status:z.enum(["pending","accepted","dismissed","superseded"]).optional()}).safeParse(request.query);if(!q.success)return reply.code(400).send({error:"invalid query",issues:q.error.issues});return listSuggestions({agentId:q.data.agent_id,status:q.data.status});});
  const decisionSchema=z.object({note:z.string().trim().max(500).optional()});
  app.post("/v1/suggestions/:id/accept",async(request,reply)=>{if(!isAdminToken(bearerToken(request)))return authError(reply);const p=decisionSchema.safeParse(request.body??{});if(!p.success)return reply.code(400).send({error:"invalid request",issues:p.error.issues});const out=acceptSuggestion(request.params.id,p.data.note);return out.status?reply.code(out.status).send({error:out.error}):out;});
  app.post("/v1/suggestions/:id/dismiss",async(request,reply)=>{if(!isAdminToken(bearerToken(request)))return authError(reply);const p=decisionSchema.safeParse(request.body??{});if(!p.success)return reply.code(400).send({error:"invalid request",issues:p.error.issues});const out=dismissSuggestion(request.params.id,p.data.note);return out.status?reply.code(out.status).send({error:out.error}):out;});

  app.get("/v1/agents/:id/reviews", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    if (!getDatabase().prepare("SELECT 1 FROM agents WHERE id=?").get(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    const rows = getDatabase().prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM gaps g WHERE g.review_id=r.id) AS gap_count,
        (SELECT COUNT(*) FROM gaps g WHERE g.review_id=r.id AND g.status='passed_gate') AS passed_gap_count
      FROM reviews r WHERE r.agent_id=? ORDER BY r.created_at DESC, r.rowid DESC
    `).all(request.params.id);
    return rows.map(publicReview);
  });

  app.get("/v1/reviews/:id", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const review = publicReview(getDatabase().prepare("SELECT * FROM reviews WHERE id=?").get(request.params.id));
    if (!review) return reply.code(404).send({ error: "review not found" });
    const gaps = getDatabase().prepare("SELECT * FROM gaps WHERE review_id=? ORDER BY priority DESC, task_category").all(request.params.id).map(publicGap);
    return { ...review, gaps };
  });

  app.post("/v1/gaps/:id/dismiss", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const db = getDatabase();
    const gap = db.prepare("SELECT * FROM gaps WHERE id=?").get(request.params.id);
    if (!gap) return reply.code(404).send({ error: "gap not found" });
    const memoryId = newMemoryId();
    const now = new Date().toISOString();
    const write = db.transaction(() => {
      db.prepare("INSERT INTO gap_dismissals(agent_id,task_category,taxonomy,created_at) VALUES(?,?,?,?) ON CONFLICT(agent_id,task_category,taxonomy) DO NOTHING")
        .run(gap.agent_id, gap.task_category, gap.taxonomy, now);
      db.prepare("UPDATE gaps SET status='dismissed' WHERE id=?").run(gap.id);
      db.prepare("INSERT INTO memories(id,event_id,agent_id,text,status,created_at) VALUES(?,?,?,?,?,?)")
        .run(memoryId, null, gap.agent_id, `Agent ${gap.agent_id} | gap_dismissed | ${gap.task_category}`, "pending", now);
    });
    write();
    enqueueMemory(memoryId);
    return {
      gap_id: gap.id,
      status: "dismissed",
      memory_id: memoryId,
      memory: "queued",
      gap: publicGap(db.prepare("SELECT * FROM gaps WHERE id=?").get(gap.id)),
    };
  });

  app.get("/v1/agents/:id/balance", async (request, reply) => {
    const token = bearerToken(request);
    const admin = isAdminToken(token);
    const agent = admin ? null : agentForToken(token);
    if (!admin && !agent) return authError(reply);
    if (!admin && agent.id !== request.params.id) return reply.code(403).send({ error: "forbidden" });
    const wallet = getWallet("agent", request.params.id);
    if (!wallet) return reply.code(404).send({ error: "agent wallet not found" });
    const balance = await getPayrollBalanceBreakdown(wallet.address, { bypassCache: true });
    return {
      address: wallet.address,
      balance_mist: balance.totalBalance.toString(),
      balance_sui: formatMist(balance.totalBalance),
      coin_balance_mist: balance.coinBalance.toString(),
      coin_balance_sui: formatMist(balance.coinBalance),
      address_balance_mist: balance.addressBalance.toString(),
      address_balance_sui: formatMist(balance.addressBalance),
      transport: "tatum-grpc",
    };
  });

  app.post("/v1/payroll/run", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const parsed = payrollSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });
    const db = getDatabase();
    const requestedIds = [...new Set([...(parsed.data.agent_id ? [parsed.data.agent_id] : []), ...(parsed.data.agent_ids ?? [])])];
    if (requestedIds.length) {
      const placeholders = requestedIds.map(() => "?").join(",");
      const foundIds = new Set(db.prepare(`SELECT id FROM agents WHERE id IN (${placeholders})`).all(...requestedIds).map((row) => row.id));
      const missingId = requestedIds.find((id) => !foundIds.has(id));
      if (missingId) return reply.code(404).send({ error: "agent not found", agent_id: missingId });
    }
    const agents = requestedIds.length
      ? (() => {
        const placeholders = requestedIds.map(() => "?").join(",");
        return db.prepare(`SELECT id,name FROM agents WHERE id IN (${placeholders}) AND status='active' ORDER BY created_at`).all(...requestedIds);
      })()
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

    const salariesRequired = eligible.reduce((sum, item) => sum + BigInt(item.policy.salary_mist), 0n);
    const estimatedGas = BigInt(eligible.length) * 50_000_000n;
    const required = salariesRequired + estimatedGas;
    const treasuryBalance = await getPayrollBalance(treasury.address);
    if (treasuryBalance < required) {
      return reply.code(402).send({
        error: "insufficient treasury balance for payroll and transaction gas",
        treasury_address: treasury.address,
        balance_sui: formatMist(treasuryBalance),
        required_sui: formatMist(required),
        agent_ids: eligible.map(({ agent }) => agent.id),
        total_required_sui: formatMist(required),
        estimated_gas_sui: formatMist(estimatedGas),
        treasury_balance_sui: formatMist(treasuryBalance),
      });
    }

    const paid = [];
    for (const item of eligible) {
      const amount = BigInt(item.policy.salary_mist);
      const txId = `pay_${randomUUID()}`;
      try {
        const confirmation = await transferSui(treasury, item.wallet.address, amount, {
          onExecuted: (execution) => db.prepare(`INSERT INTO transactions(id,agent_id,kind,to_address,amount_mist,rule_result,status,digest,confirmed_at,checkpoint,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(txId, item.agent.id, "salary", item.wallet.address, amount.toString(), execution.error ?? "execution_submitted", execution.status, execution.digest, execution.confirmedAt, execution.checkpoint, new Date().toISOString()),
        });
        const createdAt = new Date().toISOString();
        const start = periodStart(item.agent.id);
        const spent = spentSince(item.agent.id, start);
        const saved = amount - spent;
        const payslipId = `slip_${randomUUID()}`;
        const transaction = db.transaction(() => {
          db.prepare(`UPDATE transactions SET rule_result=?,status=?,digest=?,confirmed_at=?,checkpoint=? WHERE id=?`)
            .run(confirmation.error ?? "salary_paid", confirmation.status === "success" ? "executed" : confirmation.status, confirmation.digest, confirmation.confirmedAt, confirmation.checkpoint, txId);
          db.prepare(`INSERT INTO payslips(id,agent_id,period_label,salary_mist,spent_mist,saved_mist,salary_digest,created_at)
            VALUES(?,?,?,?,?,?,?,?)`).run(payslipId, item.agent.id, parsed.data.period_label, amount.toString(), spent.toString(), saved.toString(), confirmation.digest, createdAt);
        });
        transaction();
        paid.push({ agent_id: item.agent.id, salary_sui: formatMist(amount), digest: confirmation.digest, status: confirmation.status, payslip_id: payslipId });
      } catch (error) {
          const failure = reportTransferFailure(error);
        const existing = db.prepare("SELECT id FROM transactions WHERE id=?").get(txId);
        if (existing) db.prepare("UPDATE transactions SET rule_result=?,status='failed',digest=COALESCE(?,digest),confirmed_at=?,checkpoint=? WHERE id=?")
          .run(`${failure.stage}: ${failure.message}`, error.digest ?? null, error.confirmedAt ?? null, error.checkpoint ?? null, txId);
        else db.prepare(`INSERT INTO transactions(id,agent_id,kind,to_address,amount_mist,rule_result,status,digest,confirmed_at,created_at)
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

    const result = await spendForAgent({
      agentId: agent.id,
      vendorId: parsed.data.vendor_id,
      amountMist: amount,
      reason: parsed.data.reason,
      category: parsed.data.category,
    });
    if (!result.ok) {
      return reply.code(result.http_status).send({
        error: result.error,
        ...(result.rule ? { rule: result.rule } : {}),
        ...(result.stage ? { stage: result.stage } : {}),
        ...(result.message ? { message: result.message } : {}),
        ...(result.transaction_id ? { transaction_id: result.transaction_id } : {}),
      });
    }
    return reply.code(201).send({
      transaction_id: result.transaction_id,
      status: result.status,
      digest: result.digest,
      amount_mist: result.amount_mist,
      amount_sui: result.amount_sui,
      vendor_id: result.vendor_id,
    });
  });

  app.get("/v1/catalog", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    return listCatalog();
  });

  app.post("/v1/reviews/:id/proposals", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const result = await createProposalsForReview({ reviewId: request.params.id });
    return reply.code(201).send(result);
  });

  app.get("/v1/requests", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const parsed = requestQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid query", issues: parsed.error.issues });
    return listRequests({ agentId: parsed.data.agent_id, status: parsed.data.status });
  });

  app.get("/v1/requests/:id", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    return getRequest(request.params.id);
  });

  app.post("/v1/requests/:id/approve", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const parsed = approveSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });
    const result = await approveRequest({
      requestId: request.params.id,
      note: parsed.data.note,
      extraBudgetSui: parsed.data.extra_budget_sui,
    });
    return result;
  });

  app.post("/v1/requests/:id/reject", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    const parsed = rejectSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });
    return rejectRequest({ requestId: request.params.id, note: parsed.data.note });
  });

  app.post("/v1/requests/:id/verdict/evaluate", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    return evaluateVerdict({ requestId: request.params.id });
  });

  app.get("/v1/agents/:id/verdicts", async (request, reply) => {
    if (!isAdminToken(bearerToken(request))) return authError(reply);
    if (!getDatabase().prepare("SELECT 1 FROM agents WHERE id=?").get(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    return listVerdicts(request.params.id);
  });

  app.get("/v1/agents/:id/guidance", async (request, reply) => {
    const token = bearerToken(request);
    const admin = isAdminToken(token);
    const agent = admin ? null : agentForToken(token);
    if (!admin && !agent) return authError(reply);
    if (!admin && agent.id !== request.params.id) return reply.code(403).send({ error: "forbidden" });
    return guidanceForAgent(request.params.id);
  });

  app.post("/v1/premium/claim", async (request, reply) => {
    const agent = agentForToken(bearerToken(request));
    if (!agent) return authError(reply);
    const parsed = claimSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid request", issues: parsed.error.issues });
    const digest = parsed.data.digest;
    let verification;
    try {
      verification = await verifyReceipt(agent, digest, { pollTimeoutMs: parsed.data.poll_timeout_ms ?? PREMIUM_VERIFY_POLL_MS });
    } catch (error) {
      recordPremiumCall(agent.id, "claim", "verification_error", safeText(error.message));
      return reply.code(502).send({ error: "verification_unavailable", detail: safeText(error.message) });
    }
    if (!verification.ok) {
      recordPremiumCall(agent.id, "claim", verification.code, digest);
      const conflict = verification.code === "already_claimed" || verification.code === "claimed_by_other_agent";
      return reply.code(conflict ? 409 : 400).send({
        error: verification.code,
        ...(verification.detail ? { detail: safeText(verification.detail) } : {}),
        ...(verification.required_sui ? { required_sui: verification.required_sui, received_mist: verification.received_mist } : {}),
      });
    }
    recordPremiumCall(agent.id, "claim", "ok", digest);
    return reply.code(201).send({
      calls_granted: verification.calls_granted,
      calls_remaining: verification.calls_granted,
      expires_at: verification.expires_at,
      receipt: publicPass(verification.receipt),
    });
  });

  app.get("/v1/premium/data", async (request, reply) => {
    const agent = agentForToken(bearerToken(request));
    if (!agent) return authError(reply);
    const parsed = premiumQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid query", issues: parsed.error.issues });
    const { type, symbol, currency, address } = parsed.data;

    const remaining = consumeCall(agent.id);
    if (remaining === null) {
      recordPremiumCall(agent.id, type, "payment_required");
      return reply.code(402).send(paymentRequired());
    }
    try {
      if (type === "price") {
        const rate = await getRate(symbol, currency);
        recordPremiumCall(agent.id, type, "ok", `${rate.symbol}/${rate.basePair}`);
        return { type, symbol: rate.symbol, currency: rate.basePair, value: rate.value, timestamp: rate.timestamp, source: rate.source, calls_remaining: remaining };
      }
      const balance = await getPayrollBalanceBreakdown(address, { bypassCache: true });
      recordPremiumCall(agent.id, type, "ok", address);
      return {
        type,
        address,
        balance_sui: formatMist(balance.totalBalance),
        balance_mist: balance.totalBalance.toString(),
        coin_objects_sui: formatMist(balance.coinBalance),
        address_balance_sui: formatMist(balance.addressBalance),
        source: "tatum-grpc",
        calls_remaining: remaining,
      };
    } catch (error) {
      recordPremiumCall(agent.id, type, "error", safeText(error.message));
      return reply.code(502).send({ error: "upstream_unavailable", detail: safeText(error.message), calls_remaining: remaining });
    }
  });

  app.get("/v1/agents/:id/premium", async (request, reply) => {
    const token = bearerToken(request);
    const admin = isAdminToken(token);
    const agent = admin ? null : agentForToken(token);
    if (!admin && !agent) return authError(reply);
    if (!admin && agent.id !== request.params.id) return reply.code(403).send({ error: "forbidden" });
    if (!getDatabase().prepare("SELECT 1 FROM agents WHERE id=?").get(request.params.id)) return reply.code(404).send({ error: "agent not found" });
    return passStatus(request.params.id);
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

  await registerPublicRoutes(app);
  const dashboardRoot=resolve(process.cwd(),"dashboard/dist");
  if(existsSync(dashboardRoot)){
    await app.register(fastifyStatic,{root:dashboardRoot,prefix:"/",wildcard:false});
    app.get("/*",async(request,reply)=>{const path=request.url.split("?")[0];if(path.startsWith("/v1/")||path==="/v1"||path.startsWith("/public/")||path==="/public"||path.startsWith("/health"))return reply.code(404).send({error:"not found"});return reply.type("text/html; charset=utf-8").sendFile("index.html");});
  }else{     app.get("/",async(req,reply)=>{
       const htmlPath = path.join(__dirname, "../dashboard/dist/index.html");
       try {
         const indexHtml = await fs.readFile(htmlPath, "utf8");
         reply.type("text/html").send(indexHtml);
       } catch (err) {
         reply.code(404).send({error:"not found"});
       }
     });
     app.get("/public/v1/docs", async () => docs);
    app.get("/*",async(request,reply)=>reply.code(404).send({error:"not found"}));
  }

  app.get("/v1/transactions/:digest/verify", async (request, reply) => {
    const token = bearerToken(request);
    const admin = isAdminToken(token);
    const agent = admin ? null : agentForToken(token);
    if (!admin && !agent) return authError(reply);
    const record = getDatabase().prepare("SELECT * FROM transactions WHERE digest=?").get(request.params.digest);
    if (!record) return reply.code(404).send({ error: "transaction not found" });
    if (!admin && record.agent_id !== agent.id) return reply.code(403).send({ error: "forbidden" });
    const verified = await verifyTransaction(request.params.digest);
    getDatabase().prepare("UPDATE transactions SET status=?,confirmed_at=?,checkpoint=?,rule_result=? WHERE digest=?")
      .run(verified.status === "success" ? "executed" : verified.status, verified.confirmedAt, verified.checkpoint, verified.error ?? "verified", request.params.digest);
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
