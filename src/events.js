import { randomUUID } from "node:crypto";
import { getConfig } from "./config.js";
import { getDatabase } from "./db.js";
import { buildMemoryText, enqueueMemory, newMemoryId } from "./memory-queue.js";

/** Strip credentials and key-shaped strings from anything that can be logged or returned. */
export function safeText(value) {
  let text = String(value);
  try {
    const config = getConfig();
    for (const secret of [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN, config.WALLET_ENC_KEY]) text = text.split(secret).join("[REDACTED]");
  } catch {}
  return text
    .replace(/\b(?:plk_[a-f0-9]{64}|suiprivkey1[0-9a-z]+|(?:0x)?[a-f0-9]{64})\b/gi, "[REDACTED]");
}

export function reportTransferFailure(error) {
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

/** Insert an event and, when it is memory worthy, its Walrus memory row. */
export function insertEvent(agentId, event) {
  const agent = getDatabase().prepare("SELECT name FROM agents WHERE id=?").get(agentId);
  const eventId = `evt_${randomUUID()}`;
  const memoryId = newMemoryId();
  const text = buildMemoryText({ agentName: agent.name, event, eventId });
  const now = new Date().toISOString();
  const ts = event.ts ?? now;
  const sessionId = event.session_id ?? new Date(ts).toISOString().slice(0, 10);
  const db = getDatabase();
  const insert = db.transaction(() => {
    db.prepare(`INSERT INTO events(id,agent_id,type,task_category,summary,details_json,score,cost_usd,correction,ts,session_id,memory_status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      eventId, agentId, event.type, event.task_category, event.summary,
      event.details === undefined ? null : JSON.stringify(event.details), event.score ?? null,
      event.cost_usd ?? null, event.correction ?? null, ts, sessionId, "pending",
    );
    db.prepare("INSERT INTO memories(id,event_id,agent_id,text,status,created_at) VALUES(?,?,?,?,?,?)")
      .run(memoryId, eventId, agentId, text, "pending", now);
  });
  insert();
  enqueueMemory(memoryId);
  return eventId;
}
