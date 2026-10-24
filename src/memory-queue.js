import { randomUUID } from "node:crypto";
import { createMemory } from "./walrus.js";
import { getConfig } from "./config.js";
import { findStoredMemory, getDatabase, getMemoryItem, getPendingMemories } from "./db.js";

const maxConcurrency = 2;
const retryDelaysMs = [5_000, 15_000, 45_000];
const clients = new Map();
const pending = [];
const queued = new Set();
let active = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeError = (error) => {
  const config = getConfig();
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN]) {
    message = message.split(secret).join("[REDACTED]");
  }
  return message.replace(/\b(?:plk_[a-f0-9]{64}|suiprivkey1[0-9a-z]+)\b/gi, "[REDACTED]");
};

export function namespaceForAgent(agentId) {
  return `${getConfig().NAMESPACE_PREFIX}:${agentId}`;
}

export function memoryClientForAgent(agentId) {
  const namespace = namespaceForAgent(agentId);
  if (!clients.has(namespace)) clients.set(namespace, createMemory(namespace));
  return clients.get(namespace);
}

export function buildMemoryText({ agentName, event, eventId }) {
  const parts = [
    `Agent ${agentName}`,
    event.type,
    event.task_category,
    event.type === "user_corrected" && event.correction
      ? `The user corrected: ${event.correction}.`
      : event.summary,
  ].filter((part) => typeof part === "string" && part.trim());
  if (event.cost_usd !== undefined && event.cost_usd !== null) parts.push(`cost: $${event.cost_usd.toFixed(2)}`);
  parts.push(`event: ${eventId}`);
  return parts.join(" | ");
}

export function enqueueMemory(memoryId) {
  if (queued.has(memoryId)) return;
  queued.add(memoryId);
  pending.push(memoryId);
  drain();
}

export function resumePendingMemories() {
  for (const { id } of getPendingMemories()) enqueueMemory(id);
}

async function checkRecall(client, text) {
  const result = await client.recall({ query: text });
  return result.results?.find((entry) => entry.text === text);
}

function saveStored(memoryId, jobId, blobId) {
  const db = getDatabase();
  const memory = getMemoryItem(memoryId);
  const storedAt = new Date().toISOString();
  db.prepare("UPDATE memories SET status='stored', job_id=COALESCE(?, job_id), blob_id=COALESCE(?, blob_id), last_error=NULL, stored_at=? WHERE id=?")
    .run(jobId ?? null, blobId ?? null, storedAt, memoryId);
  db.prepare("UPDATE events SET memory_status='stored' WHERE id=?").run(memory.event_id);
}

function saveFailed(memoryId, error) {
  const db = getDatabase();
  const memory = getMemoryItem(memoryId);
  db.prepare("UPDATE memories SET status='failed', last_error=? WHERE id=?").run(safeError(error), memoryId);
  db.prepare("UPDATE events SET memory_status='failed' WHERE id=?").run(memory.event_id);
}

async function writeMemory(memoryId) {
  const db = getDatabase();
  const row = getMemoryItem(memoryId);
  if (!row || row.status !== "pending") return;
  const client = memoryClientForAgent(row.agent_id);
  let lastError;

  for (let attempt = 1; attempt <= retryDelaysMs.length + 1; attempt += 1) {
    db.prepare("UPDATE memories SET attempts=? WHERE id=?").run(attempt, memoryId);
    let jobId;
    try {
      const job = await client.remember(row.text);
      jobId = job.job_id;
      const stored = await client.waitForRememberJob(jobId, { timeoutMs: 90_000 });
      saveStored(memoryId, stored.job_id ?? jobId, stored.blob_id);
      return;
    } catch (error) {
      lastError = error;
      // A failed wait can mean the relayer completed the accepted write. Check before retrying to avoid duplicates.
      try {
        const recalled = await checkRecall(client, row.text);
        if (recalled) {
          saveStored(memoryId, jobId, recalled.blob_id);
          return;
        }
      } catch (recallError) {
        saveFailed(memoryId, new Error(`${safeError(error)}; cannot check recall before retry: ${safeError(recallError)}`));
        return;
      }
      if (attempt > retryDelaysMs.length) break;
      await sleep(retryDelaysMs[attempt - 1]);
    }
  }
  saveFailed(memoryId, lastError ?? new Error("Memory write failed"));
}

function drain() {
  while (active < maxConcurrency && pending.length > 0) {
    const memoryId = pending.shift();
    active += 1;
    void writeMemory(memoryId)
      .catch((error) => saveFailed(memoryId, error))
      .finally(() => {
        active -= 1;
        queued.delete(memoryId);
        drain();
      });
  }
}

export async function recallForAgent(agentId, query, limit) {
  const result = await memoryClientForAgent(agentId).recall({ query, limit });
  return (result.results ?? []).map((entry) => {
    const known = entry.blob_id ? getDatabase().prepare("SELECT event_id FROM memories WHERE agent_id=? AND blob_id=? LIMIT 1").get(agentId, entry.blob_id) : findStoredMemory(agentId, entry.text);
    return {
      text: entry.text,
      distance: entry.distance ?? null,
      event_id: known?.event_id ?? null,
      blob_id: entry.blob_id ?? null,
    };
  });
}

export function newMemoryId() {
  return `mem_${randomUUID()}`;
}
