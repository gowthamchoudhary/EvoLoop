import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { getDatabase } from "./db.js";
import { getConfig } from "./config.js";
import { getWallet } from "./wallets.js";

/* ---------------------------------------------------------------------------
 * Phase B1: accounts, sessions, workspaces and ownership helpers.
 *
 * - Passwords: scrypt (N=16384, r=8, p=1, 64-byte key, 16-byte random salt),
 *   stored as `s2_<saltHex>$<hashHex>`, compared with timingSafeEqual.
 * - Sessions: the cookie holds the raw random token; only sha256(token) is
 *   stored (sessions.id). The raw token is never returned in any JSON body
 *   and there is no Bearer fallback for browser sessions.
 * - Every user owns a personal workspace (role 'owner') created at signup;
 *   guests are attached read-only (viewer) to ws_default.
 * - Per-workspace treasury: wallets(owner_type='treasury', owner_id = the
 *   workspace's treasury_wallet_ref). ws_default keeps owner_id 'treasury'
 *   so existing admin routes behave exactly as before.
 * ------------------------------------------------------------------------ */

export const SESSION_COOKIE = "evl_session";
const DEFAULT_WORKSPACE_ID = "ws_default";
const SYSTEM_USER_ID = "usr_system";

const SESSION_TTL_DAYS = Math.max(1, Math.min(180, Number(process.env.SESSION_TTL_DAYS?.trim() || 30)));
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const GUEST_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;
const LOGIN_LOCK_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MAX_FAILURES = 8;

const WEAK_PASSWORDS = new Set([
  "password", "password1", "password123", "123456", "1234567", "12345678", "123456789", "1234567890",
  "qwerty", "qwerty123", "abc123", "letmein", "iloveyou", "welcome", "welcome1", "admin", "admin123",
  "111111", "000000", "abcdef", "p@ssw0rd", "passw0rd", "monkey", "dragon", "football", "trustno1",
]);

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/* --------------------------------- passwords ----------------------------- */

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `s2_${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== "string" || !stored.startsWith("s2_")) return false;
  const [saltHex, hashHex] = stored.slice(3).split("$");
  if (!saltHex || !hashHex) return false;
  const actual = Buffer.from(hashHex, "hex");
  const candidate = scryptSync(password, saltHex, actual.length);
  if (actual.length !== candidate.length) return false;
  return timingSafeEqual(actual, candidate);
}

export function isWeakPassword(password) {
  return WEAK_PASSWORDS.has(password.toLowerCase());
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    name: user.name,
    wallet_address: user.wallet_address?.toLowerCase() ?? null,
    wallet_verified_at: user.wallet_verified_at ?? null,
    role: user.role,
    created_at: user.created_at,
  };
}

/* ------------------------------ rate limiting ---------------------------- */
// In-memory sliding windows are fine for this process (single node).

const requestBuckets = new Map();

export function rateAllowed(bucket, key, max, windowMs = 60_000) {
  const now = Date.now();
  const mapKey = `${bucket}:${key}`;
  const current = (requestBuckets.get(mapKey) ?? []).filter((t) => now - t < windowMs);
  if (current.length >= max) {
    requestBuckets.set(mapKey, current);
    return false;
  }
  current.push(now);
  requestBuckets.set(mapKey, current);
  if (requestBuckets.size > 5000) requestBuckets.clear();
  return true;
}

export function clientIp(request) {
  return request.ip ?? "127.0.0.1";
}

const loginFailures = new Map(); // normalized email -> { failures: string[], blocked_until: number }

export function loginLockRemainingMs(email) {
  const entry = loginFailures.get(email.toLowerCase());
  if (!entry?.blocked_until) return 0;
  return Math.max(0, entry.blocked_until - Date.now());
}

export function recordFailedLogin(email) {
  const key = email.toLowerCase();
  const entry = loginFailures.get(key) ?? { failures: [], blocked_until: 0 };
  entry.failures = entry.failures.filter((t) => Date.now() - t < LOGIN_LOCK_WINDOW_MS);
  entry.failures.push(Date.now());
  if (entry.failures.length >= LOGIN_LOCK_MAX_FAILURES) {
    entry.blocked_until = Date.now() + LOGIN_LOCK_WINDOW_MS;
    entry.failures = [];
  }
  loginFailures.set(key, entry);
}

export function clearFailedLogin(email) {
  loginFailures.delete(email.toLowerCase());
}

/* ------------------------- CSRF / client-origin guard -------------------- */

function appOrigins() {
  const configured = process.env.APP_ORIGIN?.trim() || "http://127.0.0.1:8787";
  const origins = [configured];
  if (process.env.NODE_ENV !== "production") origins.push("http://localhost:5173");
  return origins;
}

/** POST/PUT/PATCH/DELETE on /v1/auth/* and /v1/my/* must come from our web client. */
export function csrfAllowed(request) {
  if (request.headers["x-evoloop-client"] !== "web") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  return appOrigins().includes(String(origin));
}

export function csrfGuard(request, reply) {
  if (csrfAllowed(request)) return true;
  reply.code(403).send({ error: "csrf_blocked" });
  return false;
}

function isSecureRequest(request) {
  const proto = request.headers["x-forwarded-proto"] ?? request.protocol ?? "http";
  return process.env.NODE_ENV === "production" || String(proto.split(",")[0]).trim() === "https";
}

/* --------------------------------- sessions ------------------------------ */

function readSessionCookie(request) {
  const header = request.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Raw token goes ONLY into the cookie; sessions.id stores sha256(token). */
export function createSessionToken(userId, request, ttlMs = SESSION_TTL_MS) {
  const raw = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  getDatabase().prepare("INSERT INTO sessions(id,user_id,created_at,expires_at,ip_hash,user_agent_hash) VALUES(?,?,?,?,?,?)")
    .run(sha256Hex(raw), userId, now, new Date(Date.now() + ttlMs).toISOString(), sha256Hex(clientIp(request)), sha256Hex(request.headers["user-agent"] ?? ""));
  return raw;
}

export function setSessionCookie(reply, request, rawToken) {
  const parts = [
    `${SESSION_COOKIE}=${rawToken}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecureRequest(request)) parts.push("Secure");
  reply.header("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(reply, request) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecureRequest(request)) parts.push("Secure");
  reply.header("Set-Cookie", parts.join("; "));
}

export function sessionUserForRequest(request) {
  const raw = readSessionCookie(request);
  if (!raw) return null;
  const row = getDatabase().prepare(`
    SELECT u.*, s.id AS session_id, s.expires_at AS session_expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sha256Hex(raw));
  if (!row) return null;
  if (row.session_expires_at < new Date().toISOString()) {
    getDatabase().prepare("DELETE FROM sessions WHERE id=?").run(row.session_id);
    return null;
  }
  return publicUser(row);
}

/** Resolves the authenticated user or replies 401; returns null when it replied. */
export function authenticateMy(request, reply) {
  const user = sessionUserForRequest(request);
  if (!user) {
    if (readSessionCookie(request)) clearSessionCookie(reply, request);
    reply.code(401).send({ error: "sign in required" });
    return null;
  }
  return user;
}

export function destroySessionByRequest(request) {
  const raw = readSessionCookie(request);
  if (raw) getDatabase().prepare("DELETE FROM sessions WHERE id=?").run(sha256Hex(raw));
}

export function pruneAuthTables() {
  const now = new Date().toISOString();
  getDatabase().prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
  getDatabase().prepare("DELETE FROM auth_nonces WHERE created_at < ?").run(new Date(Date.now() - NONCE_TTL_MS).toISOString());
}

/* ------------------------------- workspaces ------------------------------ */

export function defaultWorkspace() {
  return getDatabase().prepare("SELECT * FROM workspaces WHERE id=?").get(DEFAULT_WORKSPACE_ID);
}

export function membershipFor(workspaceId, userId) {
  return getDatabase().prepare("SELECT * FROM workspace_members WHERE workspace_id=? AND user_id=?").get(workspaceId, userId) ?? null;
}

export function personalWorkspaceFor(userId) {
  return getDatabase().prepare(`
    SELECT w.*, 'owner' AS my_role FROM workspaces w
    JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
    WHERE m.role = 'owner' LIMIT 1
  `).get(userId) ?? null;
}

/** Workspace the session user acts in: guests land in ws_default, everyone else in their own. */
export function workspaceForUser(user) {
  if (user.role === "guest") {
    const ws = defaultWorkspace();
    return ws ? { ...ws, my_role: "viewer" } : null;
  }
  return personalWorkspaceFor(user.id);
}

export function createWorkspaceForUser(user) {
  const db = getDatabase();
  const id = `ws_${randomUUID()}`;
  const name = user.name ? `${user.name}'s workspace` : `Workspace ${user.email ?? user.id}`;
  db.prepare("INSERT INTO workspaces(id,name,owner_user_id,treasury_wallet_ref,network,created_at,status) VALUES(?,?,?,?,?,?,?)")
    .run(id, name, user.id, id, getConfig().SUI_NETWORK, new Date().toISOString(), "active");
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(?,?,?)").run(id, user.id, "owner");
  return db.prepare("SELECT * FROM workspaces WHERE id=?").get(id);
}

/**
 * A record resolves to a workspace only if the user is a member; callers turn
 * null into 404 so records in other workspaces do not leak their existence.
 */
export function membershipForAgent(agentId, userId) {
  const agent = getDatabase().prepare("SELECT * FROM agents WHERE id=?").get(agentId);
  if (!agent || !agent.workspace_id) return null;
  const membership = membershipFor(agent.workspace_id, userId);
  if (!membership) return null;
  return { agent, membership };
}

export function memberRoleFor(workspaceId, userId) {
  return membershipFor(workspaceId, userId)?.role ?? null;
}

export function canApprove(role) {
  return role === "owner" || role === "approver";
}

/* ------------------------------- guest users ----------------------------- */

export function createGuestUserAndSession(request) {
  const db = getDatabase();
  const id = `usr_${randomUUID()}`;
  const name = `Guest ${randomBytes(2).toString("hex")}`;
  db.prepare("INSERT INTO users(id,name,role,created_at,last_login_at) VALUES(?,?,?,?,?)")
    .run(id, name, "guest", new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(?,?,?)").run(DEFAULT_WORKSPACE_ID, id, "viewer");
  const token = createSessionToken(id, request, GUEST_SESSION_TTL_MS);
  return { user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(id)), token };
}

/* --------------------------- wallet login (Sui) -------------------------- */

export function createNonce(purpose) {
  const nonce = { nonce: randomBytes(24).toString("hex"), purpose, created_at: new Date().toISOString() };
  getDatabase().prepare("INSERT INTO auth_nonces(nonce,purpose,created_at) VALUES(?,?,?)").run(nonce.nonce, purpose, nonce.created_at);
  return nonce;
}

export function walletMessage(nonceRow) {
  const intent = nonceRow.purpose === "link" ? "link this address to your account" : "sign in";
  return `EvoLoop\nSign this message to ${intent}.\nNonce: ${nonceRow.nonce}\nNetwork: ${getConfig().SUI_NETWORK}\nIssued at: ${nonceRow.created_at}`;
}

/** Single-use: the nonce row is consumed (SELECT + DELETE) before any check. */
export function takeNonce(nonceValue, purpose) {
  const value = String(nonceValue ?? "");
  const row = getDatabase().prepare("SELECT * FROM auth_nonces WHERE nonce=?").get(value);
  if (!row || row.purpose !== purpose) return null;
  getDatabase().prepare("DELETE FROM auth_nonces WHERE nonce=?").run(value);
  if (Date.parse(row.created_at) + NONCE_TTL_MS < Date.now()) return null;
  return row;
}

export function normalizeSuiAddress(address) {
  const text = String(address ?? "").trim().toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(text) ? text : null;
}

export async function verifyWalletSignature({ message, signature, expectedAddress, expectedMessage }) {
  if (typeof message !== "string" || message !== expectedMessage) return { ok: false, error: "message_does_not_match_nonce" };
  if (!signature || typeof signature !== "string") return { ok: false, error: "signature_required" };
  const address = normalizeSuiAddress(expectedAddress);
  if (!address) return { ok: false, error: "invalid_sui_address" };
  try {
    // verifies the signature against the message bytes AND asserts the recovered
    // key derives exactly `address` (option verifies address binding).
    await verifyPersonalMessageSignature(new TextEncoder().encode(message), signature, { address });
    return { ok: true, address };
  } catch (error) {
    const detail = String(error?.message ?? error).slice(0, 200);
    return { ok: false, error: /address/i.test(detail) ? "signature_address_mismatch" : "invalid_signature", detail };
  }
}

/* ------------------------- per-workspace treasury ------------------------ */

/** wallets.owner_id for a workspace's treasury (ws_default keeps the legacy 'treasury' row). */
export function treasuryRefForWorkspace(workspaceId) {
  const ws = getDatabase().prepare("SELECT id,treasury_wallet_ref FROM workspaces WHERE id=?").get(workspaceId);
  return ws?.treasury_wallet_ref ?? (workspaceId === DEFAULT_WORKSPACE_ID ? "treasury" : workspaceId);
}

export function treasuryWalletForAgent(agentId) {
  const agent = getDatabase().prepare("SELECT workspace_id FROM agents WHERE id=?").get(agentId);
  if (!agent) return null;
  return getWallet("treasury", treasuryRefForWorkspace(agent.workspace_id ?? DEFAULT_WORKSPACE_ID));
}
