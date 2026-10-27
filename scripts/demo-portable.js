/**
 * Block 3d-1 portable-memory demo.
 *
 * Everything proves that an agent's decision history lives in its Walrus namespace and not
 * in any single database: a SECOND server process starts with an empty SQLite file, imports
 * the SAME agent id, and rebuilds its lessons purely by recalling Walrus. No memory is
 * written, no lesson row inserted by hand, and no transfer is sent anywhere in this block.
 */

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { getConfig } from "../src/config.js";
import { closePayrollChain } from "../src/payroll-chain.js";

const config = getConfig();
const mainUrl = process.env.SMOKE_BASE_URL?.trim() || `http://127.0.0.1:${config.PORT}`;
const PORTABLE_PORT = 8788;
const portableUrl = `http://127.0.0.1:${PORTABLE_PORT}`;
const portableDbPath = resolve("./data/portable-demo.db");
const secrets = [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN, config.WALLET_ENC_KEY].filter(Boolean);
const mainDb = new Database(resolve(config.DB_PATH));
mainDb.pragma("busy_timeout = 5000");

let passed = 0;
let failed = 0;

function safeMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  return message.replace(/\b(?:plk_[a-f0-9]{64}|suiprivkey1[0-9a-z]+)\b/gi, "[REDACTED]");
}
function assert(condition, message) { if (!condition) throw new Error(message); }

async function request(url, path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${url}${path}`, {
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
    throw new Error(`${description} returned HTTP ${result.status}: ${JSON.stringify(result.data)}`);
  }
  return result.data;
}

class StepFailure extends Error {}
async function step(name, action) {
  const started = Date.now();
  try {
    const detail = await action();
    passed += 1;
    console.log(`PASS ${name} (${Date.now() - started} ms)${detail ? `: ${mask(detail)}` : ""}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name} (${Date.now() - started} ms): ${mask(error)}`);
    throw new StepFailure();
  }
}
/** Mask secrets in anything we print (keeps Error messages readable). */
function mask(value) {
  const text = typeof value === "string"
    ? value
    : value instanceof Error
      ? `${value.name}: ${value.message}`
      : JSON.stringify(value);
  let out = text ?? "";
  for (const secret of secrets) out = out.split(secret).join("[REDACTED]");
  return out.replace(/\bplk_[a-f0-9]{64}\b/gi, "[REDACTED]").slice(0, 400);
}

function waitForHealth(url, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      try {
        const response = await fetch(`${url}/health`);
        if (response.ok) return;
      } catch {}
      if (Date.now() > deadline) throw new Error(`${url} did not become healthy within ${timeoutMs} ms`);
      await new Promise((next) => setTimeout(next, intervalMs));
    }
  })();
}

/** Spawn an offline script (env-injected DB_PATH) and stream its output into the demo log. */
function runEnvScript(script, label, extraEnv = {}) {
  return new Promise((finish, fail) => {
    const child = spawn(process.execPath, [resolve(script)], {
      env: { ...process.env, ...extraEnv },
      cwd: process.cwd(),
    });
    let output = "";
    child.stdout.on("data", (data) => { output += String(data); });
    child.stderr.on("data", (data) => { output += String(data); });
    child.on("error", fail);
    child.on("close", (code) => {
      console.log(`  [${label}] ${mask(output.trim())}`);
      code === 0 ? finish() : fail(new Error(`${label} exited ${code}`));
    });
  });
}

const state = { agent: null, child: null };

try {
  console.log("--- Portable memory demo: an agent's lessons live in Walrus, not in one database\n");

  await step("(a) find a research agent with stored upgrade_purchased and upgrade_verdict memories", async () => {
    const candidates = mainDb.prepare(`
      SELECT id, name, status, created_at
      FROM agents
      WHERE name LIKE 'research-agent%'
      ORDER BY created_at DESC
    `).all();
    for (const candidate of candidates) {
      const purchased = mainDb.prepare(`
        SELECT id, blob_id, stored_at FROM memories
        WHERE agent_id=? AND status='stored' AND blob_id IS NOT NULL AND text LIKE '%| upgrade_purchased |%'
        ORDER BY stored_at DESC LIMIT 1
      `).get(candidate.id);
      const verdict = mainDb.prepare(`
        SELECT id, blob_id, stored_at FROM memories
        WHERE agent_id=? AND status='stored' AND blob_id IS NOT NULL AND text LIKE '%| upgrade_verdict |%'
        ORDER BY stored_at DESC LIMIT 1
      `).get(candidate.id);
      if (purchased && verdict) {
        state.agent = { id: candidate.id, name: candidate.name, status: candidate.status };
        return `agent ${candidate.id} (${candidate.name}, ${candidate.status}); purchased blob ${purchased.blob_id}, verdict blob ${verdict.blob_id}`;
      }
    }
    throw new Error("No research-agent has two stored Walrus memories (upgrade_purchased + upgrade_verdict). Run npm run demo:cycle once first; nothing was modified.");
  });

  await step("(b) start a SECOND server on 8788 with an empty database", async () => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${portableDbPath}${suffix}`, { force: true });
    await runEnvScript("scripts/vendors-seed.js", "vendors-seed(portable)", { DB_PATH: portableDbPath });
    await runEnvScript("scripts/catalog-seed.js", "catalog-seed(portable)", { DB_PATH: portableDbPath });
    state.child = spawn(process.execPath, [resolve("src/server.js")], {
      env: {
        ...process.env,
        PORT: String(PORTABLE_PORT),
        DB_PATH: portableDbPath,
        NAMESPACE_PREFIX: config.NAMESPACE_PREFIX,
      },
      cwd: process.cwd(),
    });
    state.child.stderr.on("data", (data) => console.log(`  [server-8788] ${mask(String(data).trim())}`));
    await waitForHealth(portableUrl, 30_000);
    return `server ready on ${portableUrl}; DB ${portableDbPath}`;
  });

  let installedApiKey = null;
  await step("(c) import the same agent id on the second server", async () => {
    assert(state.agent, "No agent was selected in step (a)");
    const imported = requireStatus(await request(portableUrl, "/v1/agents/import", {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: {
        agent_id: state.agent.id,
        name: state.agent.name,
        kind: "research",
        description: "Imported by the portable-memory demo with an exact agent id",
      },
    }), 201, "Import agent");
    assert(imported.agent_id === state.agent.id, `Import returned agent_id ${imported.agent_id}`);
    installedApiKey = imported.api_key;
    assert(Boolean(installedApiKey), "Import did not return an api key");
    // A second import must be refused.
    const again = await request(portableUrl, "/v1/agents/import", {
      token: config.ADMIN_TOKEN,
      method: "POST",
      body: { agent_id: state.agent.id, name: state.agent.name, kind: "research", description: "dup" },
    });
    assert(again.status === 409, `Second import returned ${again.status}, expected 409`);
    return `agent ${state.agent.id} imported exactly once (new api key returned); duplicate refused`;
  });

  await step("(d) the second database has ZERO events and zero capabilities for the agent", async () => {
    assert(state.agent, "No agent was selected");
    const portable = new Database(portableDbPath);
    try {
      const events = portable.prepare("SELECT COUNT(*) AS count FROM events WHERE agent_id=?").get(state.agent.id).count;
      const capabilities = portable.prepare("SELECT COUNT(*) AS count FROM agent_capabilities WHERE agent_id=?").get(state.agent.id).count;
      const lessons = portable.prepare("SELECT COUNT(*) AS count FROM lessons WHERE agent_id=?").get(state.agent.id).count;
      assert(events === 0, `Second database had ${events} events for the agent`);
      assert(capabilities === 0, `Second database had ${capabilities} capabilities for the agent`);
      assert(lessons === 0, `Second database had ${lessons} lesson rows before any recall`);
      return `events 0, capabilities 0, lessons 0 before recall`;
    } finally { portable.close(); }
  });

  let restore = null;
  await step("(e) lessons/restore: everything comes back from Walrus", async () => {
    assert(state.agent, "No agent was selected");
    const response = await request(portableUrl, `/v1/agents/${encodeURIComponent(state.agent.id)}/lessons/restore`, {
      token: config.ADMIN_TOKEN,
      method: "POST",
    });
    assert(response.status === 200, `restore returned ${response.status}: ${JSON.stringify(response.data)}`);
    restore = response.data;
    assert(restore.ok === true, `restore failed: ${JSON.stringify(restore)}`);
    assert((restore.total ?? 0) >= 2, `restore found only ${restore.total} lessons, expected at least 2`);
    assert(restore.counts.upgrade_purchased >= 1, `no upgrade_purchased lesson: ${JSON.stringify(restore.counts)}`);
    assert(restore.counts.upgrade_verdict >= 1, `no upgrade_verdict lesson: ${JSON.stringify(restore.counts)}`);
    const portable = new Database(portableDbPath);
    const withBlob = portable.prepare("SELECT COUNT(*) AS count FROM lessons WHERE agent_id=? AND blob_id IS NOT NULL").get(state.agent.id).count;
    portable.close();
    assert(withBlob >= 1, `no recalled row kept a blob_id`);
    return `counts ${JSON.stringify(restore.counts)} (${restore.total} lessons, ${withBlob} with blob ids); all from Walrus`;
  });

  await step("(f) propose-check premium_data is refused, citing a walrus blob", async () => {
    assert(state.agent, "No agent was selected");
    const result = requireStatus(await request(portableUrl, `/v1/agents/${encodeURIComponent(state.agent.id)}/propose-check?capability_key=premium_data`, {
      token: config.ADMIN_TOKEN,
    }), 200, "propose-check premium_data");
    assert(result.would_propose === false, `premium_data would_propose was ${result.would_propose}: ${JSON.stringify(result.reasons)}`);
    const walrusHit = (result.decision_basis ?? []).find((item) => item.source === "walrus" && item.blob_id);
    assert(walrusHit, `decision_basis has no walrus item with a blob_id: ${JSON.stringify(result.decision_basis)}`);
    const reasons = (result.reasons ?? []).map((reason) => reason.reason).join(",");
    assert(reasons.includes("lesson_"), `no walrus-lesson reason: ${reasons}`);
    return `would_propose=false; reasons ${reasons}; basis cites walrus blob ${walrusHit.blob_id.slice(0, 16)}…`;
  });

  await step("(g) propose-check vision is reported honestly", async () => {
    assert(state.agent, "No agent was selected");
    const result = requireStatus(await request(portableUrl, `/v1/agents/${encodeURIComponent(state.agent.id)}/propose-check?capability_key=vision`, {
      token: config.ADMIN_TOKEN,
    }), 200, "propose-check vision");
    const reasons = (result.reasons ?? []).map((reason) => reason.reason).join(",");
    return `would_propose=${result.would_propose}${result.would_create_status ? ` (status ${result.would_create_status})` : ""}; reasons ${reasons}`;
  });
} catch (error) {
  if (!(error instanceof StepFailure)) {
    failed += 1;
    console.log(`FAIL unexpected error: ${typewritten(error)}`);
  }
} finally {
  if (state.child) {
    state.child.removeAllListeners();
    state.child.kill("SIGTERM");
    await new Promise((next) => setTimeout(next, 500));
    if (!state.child.killed) state.child.kill("SIGKILL");
    console.log("CLEANUP second server stopped");
  }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${portableDbPath}${suffix}`, { force: true });
  console.log("CLEANUP portable database deleted");
  mainDb.close();
  closePayrollChain();
}

console.log(`Summary: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
export {};
