import "dotenv/config";
import { getDatabase, closeDatabase } from "../src/db.js";
import { getConfig } from "../src/config.js";
import { registerPublicRoutes } from "../src/public-routes.js";
import Fastify from "fastify";

/**
 * Block 5b: public /public/purchases.sql monthly snapshot.
 * Introduced: GET /public/purchases.sql (returns array of executed upgrade purchases).
 */
const baseUrl = "http://127.0.0.1:8787";
const secrets = [];

function safeMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  return message.replace(/\b(?:plk_[a-f0-9]{64}|0x[a-f0-9]{64})\b/gi, "[REDACTED]");
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireStatus(result, expected, description) {
  if (result.status !== expected) {
    throw new Error(`${description} returned HTTP ${result.status}: ${typeof result.data === "string" ? result.data : JSON.stringify(result.data)}`);
  }
  return result.data;
}

async function main() {
  const config = getConfig();
  const adminToken = config.ADMIN_TOKEN?.trim();
  if (!adminToken) {
    console.error("SKIP scripts/smoke-block5b-public-purchases.sql.js: ADMIN_TOKEN not set");
    return;
  }

  let passed = 0, failed = 0;
  async function step(name, action) {
    const started = Date.now();
    try {
      const detail = await action();
      passed += 1;
      console.log(`PASS ${name} (${Date.now() - started} ms)${detail ? `: ${detail}` : ""}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name}: ${safeMessage(error)}`);
    }
  }

  try {
    await step("public /public/purchases.sql returns 200", async () => {
      const result = await request("/public/purchases.sql");
      requireStatus(result, 200, "GET /public/purchases.sql");
      assert(Array.isArray(result.data), "GET /public/purchases.sql did not return an array");
      return `array, length ${result.data.length}`;
    });

    await step("public /public/purchases.sql returns month summary", async () => {
      const result = await request("/public/purchases.sql");
      requireStatus(result, 200, "GET /public/purchases.sql");
      const rows = result.data;
      assert(rows.length > 0, "GET /public/purchases.sql returned empty array");
      const row = rows[0];
      assert(typeof row.agent === "string" && row.agent, "missing agent name");
      assert(typeof row.period === "string" && row.period, "missing period");
      assert(typeof row.capability_key === "string" && row.capability_key, "missing capability_key");
      assert(typeof row.cost_sui === "string" && row.cost_sui, "missing cost_sui");
      assert(typeof row.status === "string" && row.status, "missing status");
      return `first row agent=${row.agent} period=${row.period} capability=${row.capability_key}`;
    });
  } catch (error) {
    console.error("Unexpected error while checking public system:", safeMessage(error));
  } finally {
    try { closeDatabase(); } catch {}
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Unhandled error:", safeMessage(error));
  process.exitCode = 1;
});
