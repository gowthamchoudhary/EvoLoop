/**
 * Phase B1 auth smoke (no transfers, no funding).
 * Run against a live server: node scripts/smoke-auth.js
 * Env: SMOKE_BASE_URL (default http://127.0.0.1:8787), DB_PATH (default ./data/payroll.db)
 *
 * Registers users named smoke-auth-A/B, runs through the auth + ownership
 * matrix, archives the created agents, and (in the DB) prefixes the guest
 * user for cleanup.
 */
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { resolve } from "node:path";

const BASE = process.env.SMOKE_BASE_URL || "http://127.0.0.1:8787";
const DB_PATH = process.env.DB_PATH ? resolve(process.env.DB_PATH) : resolve(process.cwd(), "data/payroll.db");
const WEB = { "x-evoloop-client": "web" };
const suffix = Date.now().toString(36).slice(-6);
const EMAIL_A = `smoke-auth-a-${suffix}@example.com`;
const EMAIL_B = `smoke-auth-b-${suffix}@example.com`;
const PASSWORD = "correct-horse-battery-test";
const addressOf = () => `0x${"ab".repeat(32)}`;

let apiKeyCurrent;

let passed = 0;
let failed = 0;
function assert(condition, label, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

async function call(path, { method = "GET", body, headers = {}, cookie } = {}) {
  const allHeaders = { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) };
  const res = await fetch(`${BASE}${path}`, { method, headers: allHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, body: data, cookies: res.headers.getSetCookie?.() ?? [] };
}

function sessionCookie(cookies) {
  const raw = cookies.find((line) => line.startsWith("evl_session="));
  return raw ? raw.split(";")[0] : null;
}

async function main() {
  console.log(`smoke-auth against ${BASE}`);

  console.log("register / cookies / no token in body");
  const regA = await call("/v1/auth/register", { method: "POST", headers: WEB, body: { name: `smoke-auth-A-${suffix}`, email: EMAIL_A, password: PASSWORD } });
  assert(regA.status === 201, "register user A returns 201", regA);
  const cookieA = sessionCookie(regA.cookies);
  assert(Boolean(cookieA), "register sets evl_session cookie");
  assert(cookieA && /HttpOnly/i.test(regA.cookies.join("|")), "cookie is HttpOnly");
  assert(cookieA && /SameSite=Lax/i.test(regA.cookies.join("|")), "cookie is SameSite=Lax");
  assert(!(/;\s*Secure/i.test(regA.cookies.join("|")) || /;\s*Secure$/i.test(regA.cookies.join("|"))), "cookie has no Secure over plain http");
  assert(regA.body && !JSON.stringify(regA.body).includes(cookieA), "raw session token absent from register body");
  assert(regA.body?.user?.role === "user", "user A role is user", regA.body?.user);
  assert(regA.body?.workspace?.id?.startsWith("ws_"), "register created a personal workspace", regA.body?.workspace);

  const regB = await call("/v1/auth/register", { method: "POST", headers: WEB, body: { name: `smoke-auth-B-${suffix}`, email: EMAIL_B, password: PASSWORD } });
  assert(regB.status === 201, "register user B returns 201", regB);
  const cookieB = sessionCookie(regB.cookies);

  console.log("csrf guard on state-changing /v1/auth calls");
  const csrfNoHeader = await call("/v1/auth/register", { method: "POST", body: {} });
  assert(csrfNoHeader.status === 403 && csrfNoHeader.body?.error === "csrf_blocked", "POST without X-EvoLoop-Client is 403 csrf_blocked", csrfNoHeader.body);
  const csrfForeign = await call("/v1/auth/login", { method: "POST", headers: { ...WEB, origin: "https://evil.example" }, body: { email: EMAIL_A, password: "whatever-12345" } });
  assert(csrfForeign.status === 403 && csrfForeign.body?.error === "csrf_blocked", "POST with foreign Origin is 403 csrf_blocked", csrfForeign.body);

  console.log("login: generic error, lockout, session semantics");
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const res = await call("/v1/auth/login", { method: "POST", headers: WEB, body: { email: EMAIL_A, password: `wrong-password-${attempt}` } });
    assert(res.status === 401 && res.body?.error === "invalid email or password", `failed login ${attempt} → 401 generic error`, res.body);
  }
  const locked = await call("/v1/auth/login", { method: "POST", headers: WEB, body: { email: EMAIL_A, password: PASSWORD } });
  assert(locked.status === 429, "9th login attempt (even correct password) is 429", locked.body);
  const stillLocked = await call("/v1/auth/login", { method: "POST", headers: WEB, body: { email: EMAIL_A, password: `wrong-again-${Date.now()}` } });
  assert(stillLocked.status === 429, "email stays locked in the 15-minute window", stillLocked.body);

  const dup = await call("/v1/auth/register", { method: "POST", headers: WEB, body: { name: "smoke-dup", email: EMAIL_A, password: PASSWORD } });
  assert(dup.status === 409 && dup.body?.error === "email already registered", "duplicate email register returns 409", dup.body);
  const weak = await call("/v1/auth/register", { method: "POST", headers: WEB, body: { name: "smoke-weak", email: `smoke-weak-${suffix}@example.com`, password: "password" } });
  assert(weak.status === 400, "weak password register returns 400", weak.body);

  const httpsLogin = await call("/v1/auth/login", { method: "POST", headers: { ...WEB, "x-forwarded-proto": "https" }, body: { email: EMAIL_B, password: PASSWORD } });
  assert(httpsLogin.status === 200, "correct-password login works", httpsLogin.body);
  assert(httpsLogin.cookies.join("|").includes("Secure"), "Secure flag present when X-Forwarded-Proto: https");
  const cookieBHttps = sessionCookie(httpsLogin.cookies);

  console.log("agents: create, key-once, cross-workspace 404s");
  const createA = await call("/v1/my/agents", { method: "POST", headers: WEB, cookie: cookieA, body: { name: "smoke-agent", kind: "demo", description: "smoke-auth agent" } });
  assert(createA.status === 201, "A creates an agent (201)", createA.body);
  const apiKey = createA.body?.api_key;
  assert(typeof apiKey === "string" && apiKey.startsWith("plk_"), "api key returned once at creation");
  const agentId = createA.body?.agent_id;
  const detailA = await call(`/v1/my/agents/${agentId}`, { headers: {}, cookie: cookieA });
  assert(!JSON.stringify(detailA.body ?? {}).includes(apiKey), "GET /v1/my/agents/:id never returns the api key");

  assert((await call(`/v1/my/agents/${agentId}`, { cookie: cookieB })).status === 404, "B reading A's agent → 404");
  assert((await call(`/v1/my/agents/${agentId}`, { method: "PATCH", headers: WEB, cookie: cookieB, body: { name: "nope" } })).status === 404, "B PATCH A's agent → 404");
  assert((await call(`/v1/my/agents/${agentId}/settings`, { method: "PUT", headers: WEB, cookie: cookieB, body: {} })).status === 404, "B settings A's agent → 404");
  assert((await call(`/v1/my/agents/${agentId}/pause`, { method: "POST", headers: WEB, cookie: cookieB, body: {} })).status === 404, "B pause A's agent → 404");
  assert((await call(`/v1/my/agents/${agentId}/rotate-key`, { method: "POST", headers: WEB, cookie: cookieB, body: {} })).status === 404, "B rotate-key A's agent → 404");
  assert((await call("/v1/my/requests/rq_nonexistent/approve", { method: "POST", headers: WEB, cookie: cookieB, body: {} })).status === 404, "B approval attempt on A's request → 404");
  const payrollA = await call("/v1/my/payroll/run", { method: "POST", headers: WEB, cookie: cookieA, body: { agent_ids: [agentId], period_label: "smoke" } });
  assert(payrollA.status === 409, "A payroll without treasury → clear refusal", payrollA.body);
  // Cross-account payroll guard: B's workspace has no visibility of A's agent id.
  const payrollB = await call("/v1/my/payroll/run", { method: "POST", headers: WEB, cookie: cookieBHttps, body: { agent_ids: [agentId], period_label: "smoke" } });
  assert(payrollB.status === 404, "A's agent_id is invisible to B's payroll → 404", payrollB.body);

  console.log("pause / resume / 423 / rotate-key");
  const pause = await call(`/v1/my/agents/${agentId}/pause`, { method: "POST", headers: WEB, cookie: cookieA, body: {} });
  assert(pause.status === 200 && pause.body?.status === "paused", "owner pauses the agent", pause.body);
  const pausedEvent = await call("/v1/events", { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: { type: "task_completed", task_category: "smoke", summary: "paused" } });
  assert(pausedEvent.status === 423 && pausedEvent.body?.error === "agent_paused", "event ingestion on paused agent → 423 agent_paused", pausedEvent.body);
  const resume = await call(`/v1/my/agents/${agentId}/resume`, { method: "POST", headers: WEB, cookie: cookieA, body: {} });
  assert(resume.status === 200 && resume.body?.status === "active", "owner resumes the agent", resume.body);
  const liveEvent = await call("/v1/events", { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: { type: "task_completed", task_category: "smoke", summary: "resumed" } });
  assert(liveEvent.status === 201, "event ingestion works after resume", liveEvent.body);

  const rotate = await call(`/v1/my/agents/${agentId}/rotate-key`, { method: "POST", headers: WEB, cookie: cookieA, body: {} });
  assert(rotate.status === 200 && typeof rotate.body?.api_key === "string", "rotate-key returns the new key once", rotate.body);
  const oldKey = apiKey;
  apiKeyCurrent = rotate.body.api_key;
  assert((await call("/v1/events", { method: "POST", headers: { authorization: `Bearer ${oldKey}` }, body: { type: "task_completed", task_category: "smoke", summary: "old key" } })).status === 401, "old key is invalid after rotate");
  assert((await call("/v1/events", { method: "POST", headers: { authorization: `Bearer ${apiKeyCurrent}` }, body: { type: "task_completed", task_category: "smoke", summary: "new key" } })).status === 201, "new key works after rotate");

  console.log("guest session: read-only on ws_default");
  const guest = await call("/v1/auth/guest", { method: "POST", headers: WEB, body: {} });
  assert(guest.status === 201 && guest.body?.user?.role === "guest", "guest session created", guest.body);
  const cookieGuest = sessionCookie(guest.cookies);
  assert((await call("/v1/my/agents", { cookie: cookieGuest })).status === 200, "guest can list workspace agents");
  assert((await call("/v1/my/agents", { method: "POST", headers: WEB, cookie: cookieGuest, body: { name: "nope", kind: "demo", description: "n" } })).status === 403, "guest cannot create agents → 403");
  const guestWs = await call("/v1/my/workspace", { cookie: cookieGuest });
  assert(guestWs.status === 200 && guestWs.body?.role === "viewer", "guest reads ws_default as viewer", guestWs.body);
  assert((await call("/v1/my/payroll/run", { method: "POST", headers: WEB, cookie: cookieGuest, body: { period_label: "smoke" } })).status === 403, "guest cannot run payroll → 403");

  console.log("logout invalidates + session state");
  const before = await call("/v1/auth/session", { cookie: cookieGuest });
  assert(before.status === 200 && before.body?.user?.role === "guest", "session resolves while logged in", before.body);
  const out = await call("/v1/auth/logout", { method: "POST", headers: WEB, cookie: cookieGuest, body: {} });
  assert(out.status === 200, "logout succeeds", out.body);
  const after = await call("/v1/auth/session", { cookie: cookieGuest });
  assert(after.status === 401, "session is gone after logout → 401", after.body);
  assert((await call("/v1/auth/session", { cookie: "evl_session=definitely-not-a-real-token" })).status === 401, "unknown token → 401");

  console.log("sessions table stores sha256, not the raw token");
  const db = new Database(DB_PATH, { readonly: true });
  const hashed = db.prepare("SELECT id, expires_at FROM sessions WHERE user_id = (SELECT id FROM users WHERE email=?) ORDER BY created_at DESC").get(EMAIL_A);
  const rawA = cookieA.split("=")[1];
  assert(Boolean(hashed), "session row exists in sqlite");
  assert(hashed?.id === createHash("sha256").update(rawA).digest("hex"), "sessions.id is sha256 of the cookie token");
  assert(hashed?.id !== rawA, "sessions.id is not the raw token");
  assert(!JSON.stringify(hashed ?? {}).includes(rawA), "raw token never stored");
  const guestUser = db.prepare("SELECT id, name FROM users WHERE id = ?").get(guest.body?.user?.id);
  db.close();
  if (guestUser) {
    const mark = new Database(DB_PATH);
    mark.prepare("UPDATE users SET name = ? WHERE id = ?").run(`smoke-auth-guest-${suffix}`, guestUser.id);
    mark.close();
    console.log(`  ok  guest user renamed for cleanup: smoke-auth-guest-${suffix}`);
  }

  console.log("logout secondary sessions (cleanup guest already logged out; archive test agent)");
  assert((await call(`/v1/my/agents/${agentId}/archive`, { method: "POST", headers: WEB, cookie: cookieA, body: {} })).status === 200, "archive test agent (cleanup)");

  console.log("wallet nonce is single-use");
  const nonce = await call("/v1/auth/wallet/nonce?purpose=login", { headers: {} });
  assert(nonce.status === 200 && typeof nonce.body?.nonce === "string", "nonce issued", nonce.body);
  const garbage = { purpose: "login", nonce: nonce.body.nonce, address: addressOf(), signature: "garbage-signature-value", message: nonce.body.message };
  const first = await call("/v1/auth/wallet", { method: "POST", headers: WEB, body: garbage });
  assert(first.status === 400 && first.body?.error === "invalid_signature", "first use with garbage signature rejected as invalid_signature", first.body);
  const second = await call("/v1/auth/wallet", { method: "POST", headers: WEB, body: garbage });
  assert(second.status === 400 && second.body?.error === "nonce expired or unknown", "second use rejected: nonce consumed", second.body);

  console.log(`\nsmoke-auth: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(`smoke-auth crashed: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
