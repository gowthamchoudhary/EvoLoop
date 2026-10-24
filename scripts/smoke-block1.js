import { getConfig } from "../src/config.js";

const config = getConfig();
const baseUrl = `http://127.0.0.1:${config.PORT}`;
const secrets = [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN].filter(Boolean);
const state = { agentA: null, agentB: null, eventIds: [], queued: 0, skipped: 0 };
let passed = 0;
let failed = 0;

function safeMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  return message.replace(/\bplk_[a-f0-9]{64}\b/gi, "[REDACTED]");
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
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name} (${Date.now() - started} ms): ${safeMessage(error)}`);
  }
}

function requireStatus(result, expected, description) {
  if (result.status !== expected) throw new Error(`${description} returned HTTP ${result.status}`);
  return result.data;
}

await step("Register two agents", async () => {
  const [a, b] = await Promise.all([
    request("/v1/agents/register", { token: config.ADMIN_TOKEN, method: "POST", body: { name: "smoke-a", kind: "smoke", description: "Block 1 real-service smoke agent A" } }),
    request("/v1/agents/register", { token: config.ADMIN_TOKEN, method: "POST", body: { name: "smoke-b", kind: "smoke", description: "Block 1 real-service smoke agent B" } }),
  ]);
  state.agentA = requireStatus(a, 201, "Register smoke-a");
  state.agentB = requireStatus(b, 201, "Register smoke-b");
  if (!state.agentA.agent_id || !state.agentA.api_key || !state.agentB.agent_id || !state.agentB.api_key) throw new Error("Agent registration response was incomplete");
  return "smoke-a and smoke-b registered; API keys withheld";
});

await step("Post six events for agent A", async () => {
  if (!state.agentA) throw new Error("Agent A registration did not succeed");
  const events = [
    { type: "user_corrected", task_category: "pdf_summary", summary: "The summary missed a diagram.", correction: "missed diagrams in slide 4" },
    { type: "user_corrected", task_category: "pdf_summary", summary: "The summary omitted a key label.", correction: "restore the chart legend" },
    { type: "task_failed", task_category: "invoice_extract", summary: "The invoice date could not be extracted." },
    { type: "capability_missing", task_category: "spreadsheet", summary: "Could not preserve workbook macros." },
    { type: "cost_incurred", task_category: "pdf_summary", summary: "A document processing charge was incurred.", cost_usd: 0.02 },
    { type: "task_completed", task_category: "pdf_summary", summary: "The summary was completed successfully.", score: 0.9 },
  ];
  for (const event of events) {
    const response = await request("/v1/events", { token: state.agentA.api_key, method: "POST", body: event });
    const data = requireStatus(response, 201, `Create ${event.type}`);
    if (!data.event_id) throw new Error(`Missing event ID for ${event.type}`);
    state.eventIds.push(data.event_id);
    if (data.memory === "queued") state.queued += 1;
    else if (data.memory === "skipped") state.skipped += 1;
    else throw new Error(`Unexpected memory status for ${event.type}`);
  }
  if (state.queued !== 5 || state.skipped !== 1) throw new Error(`Expected 5 queued and 1 skipped; got ${state.queued} queued and ${state.skipped} skipped`);
  return `${state.queued} queued, ${state.skipped} skipped`;
});

await step("Wait for agent A memories to store", async () => {
  if (!state.agentA || state.eventIds.length !== 6) throw new Error("Agent A events were not all created");
  const memoryEventIds = new Set();
  let lastState = [];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await request("/v1/memories", { token: config.ADMIN_TOKEN });
    const rows = requireStatus(response, 200, "List memories");
    const forAgentEvents = rows.filter((row) => state.eventIds.includes(row.event_id));
    lastState = forAgentEvents.map((row) => row.status);
    for (const row of forAgentEvents) memoryEventIds.add(row.event_id);
    if (forAgentEvents.some((row) => row.status === "failed")) throw new Error(`A memory reached failed status (${lastState.join(", ")})`);
    if (forAgentEvents.length === state.queued && forAgentEvents.every((row) => row.status === "stored")) {
      return `${forAgentEvents.length} stored; ${state.queued} queued, ${state.skipped} skipped`;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out after 3 minutes waiting for memories (${lastState.join(", ")})`);
});

await step("Recall agent A correction from Walrus", async () => {
  if (!state.agentA) throw new Error("Agent A registration did not succeed");
  const query = new URLSearchParams({ q: "What correction was made to the slide 4 PDF summary?", limit: "5" });
  const response = await request(`/v1/agents/${encodeURIComponent(state.agentA.agent_id)}/recall?${query}`, { token: state.agentA.api_key });
  const results = requireStatus(response, 200, "Recall agent A memory");
  const expected = "missed diagrams in slide 4";
  if (!Array.isArray(results) || !results.some((result) => result.text?.includes(expected))) throw new Error("Recall did not return the expected correction text");
  return "returned text contains the slide 4 correction";
});

await step("Block agent B from recalling agent A memory", async () => {
  if (!state.agentA || !state.agentB) throw new Error("Both agents must register before isolation check");
  const query = new URLSearchParams({ q: "missed diagrams in slide 4" });
  const response = await request(`/v1/agents/${encodeURIComponent(state.agentA.agent_id)}/recall?${query}`, { token: state.agentB.api_key });
  if (response.status !== 403) throw new Error(`Expected HTTP 403, received HTTP ${response.status}`);
  return "cross-agent recall returned HTTP 403";
});

console.log(`Summary: ${passed} passed, ${failed} failed; ${state.queued} memories queued, ${state.skipped} skipped`);
process.exitCode = failed === 0 ? 0 : 1;
