import { randomUUID } from "node:crypto";
import { getDatabase } from "./db.js";
import {
  PREMIUM_CAPABILITY_KEY,
  PREMIUM_NETWORK,
  PREMIUM_PASS_CALLS,
  PREMIUM_PASS_TTL_MINUTES,
  PREMIUM_PRICE_MIST,
  PREMIUM_VERIFY_POLL_MS,
  SUI_COIN_SUFFIX,
} from "./premium-config.js";
import { formatMist } from "./payroll-chain.js";
import { getTatumClient } from "./tatum.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizeAddress(address) {
  const text = String(address ?? "").toLowerCase();
  const body = text.startsWith("0x") ? text.slice(2) : text;
  if (!/^[0-9a-f]*$/.test(body)) return null;
  return `0x${body.padStart(64, "0")}`;
}

function isSuiCoin(coinType) {
  return String(coinType ?? "").endsWith(SUI_COIN_SUFFIX);
}

function isNotFound(error) {
  return String(error?.code ?? error?.status ?? "").toUpperCase() === "NOT_FOUND"
    || /not[_ ]found|does not exist|unknown transaction/i.test(String(error?.message ?? ""));
}

/** The vendor the premium pass pays, resolved through the upgrade catalog. */
export function premiumVendor() {
  const db = getDatabase();
  const catalog = db.prepare("SELECT vendor_id FROM upgrade_catalog WHERE capability_key=? AND active=1 ORDER BY price_mist ASC LIMIT 1")
    .get(PREMIUM_CAPABILITY_KEY);
  const vendor = catalog
    ? db.prepare("SELECT * FROM vendors WHERE id=?").get(catalog.vendor_id)
    : db.prepare("SELECT * FROM vendors WHERE label='premium-data-source'").get();
  if (!vendor) {
    const error = new Error("premium vendor is missing; run npm run vendors:seed and npm run catalog:seed");
    error.statusCode = 500;
    throw error;
  }
  return vendor;
}

/** The 402 body handed to any agent without an active pass. */
export function paymentRequired() {
  const vendor = premiumVendor();
  return {
    error: "payment_required",
    pay_to: vendor.address,
    amount_sui: formatMist(PREMIUM_PRICE_MIST),
    network: PREMIUM_NETWORK,
    asset: "SUI",
    how: "pay then POST /v1/premium/claim with the transaction digest",
  };
}

export function recordPremiumCall(agentId, type, outcome, detail = null) {
  getDatabase().prepare("INSERT INTO premium_calls(id,agent_id,type,outcome,detail,created_at) VALUES(?,?,?,?,?,?)")
    .run(`pc_${randomUUID()}`, agentId, type, outcome, detail, new Date().toISOString());
}

/** Fetch a transaction with sender, effects status and balance changes, polling NOT_FOUND like the confirmation code. */
async function fetchTransaction(digest, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const client = getTatumClient();
  while (true) {
    try {
      const response = await client.getTransaction({
        digest,
        include: { transaction: true, effects: true, balanceChanges: true },
      });
      return response.Transaction ?? response.transaction ?? null;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(2_000, Math.max(250, deadline - Date.now())));
    }
  }
}

/**
 * Verify an on-chain payment for one premium pass: the digest must exist, succeed, be sent by the
 * agent's own wallet and pay the vendor at least the catalog price. Receipts are one claim per
 * digest per agent, so a digest cannot be replayed by another agent or claimed twice.
 */
export async function verifyReceipt(agent, digest, { pollTimeoutMs = PREMIUM_VERIFY_POLL_MS } = {}) {
  const db = getDatabase();
  const existing = db.prepare("SELECT * FROM payment_receipts WHERE digest=?").get(digest);
  if (existing) {
    return { ok: false, code: existing.agent_id === agent.id ? "already_claimed" : "claimed_by_other_agent", receipt: existing };
  }

  const transaction = await fetchTransaction(digest, pollTimeoutMs);
  if (!transaction) return { ok: false, code: "receipt_not_found" };
  if (!transaction.status?.success) return { ok: false, code: "tx_failed", detail: transaction.status?.error ?? "transaction failed" };

  const wallet = db.prepare("SELECT address FROM wallets WHERE owner_type='agent' AND owner_id=?").get(agent.id);
  if (!wallet) return { ok: false, code: "wrong_sender", detail: "agent has no wallet" };
  const sender = normalizeAddress(transaction.transaction?.sender);
  const agentAddress = normalizeAddress(wallet.address);
  if (!sender || sender !== agentAddress) {
    return { ok: false, code: "wrong_sender", detail: `sender ${sender ?? "<missing>"} is not the agent wallet` };
  }

  const vendor = premiumVendor();
  const vendorAddress = normalizeAddress(vendor.address);
  const received = (transaction.balanceChanges ?? []).reduce((total, change) => {
    if (!isSuiCoin(change.coinType)) return total;
    if (normalizeAddress(change.address) !== vendorAddress) return total;
    const amount = BigInt(change.amount ?? "0");
    return amount > 0n ? total + amount : total;
  }, 0n);
  if (received === 0n) return { ok: false, code: "wrong_recipient", detail: "the vendor received no SUI in this transaction" };
  const price = BigInt(PREMIUM_PRICE_MIST);
  if (received < price) {
    return { ok: false, code: "insufficient_amount", received_mist: received.toString(), required_mist: price.toString(), required_sui: formatMist(price) };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + PREMIUM_PASS_TTL_MINUTES * 60_000).toISOString();
  const row = {
    digest,
    agent_id: agent.id,
    vendor_id: vendor.id,
    amount_mist: received.toString(),
    sender,
    verified_at: now.toISOString(),
    calls_granted: PREMIUM_PASS_CALLS,
    calls_used: 0,
    expires_at: expiresAt,
    status: "active",
  };
  try {
    db.prepare(`INSERT INTO payment_receipts(digest,agent_id,vendor_id,amount_mist,sender,verified_at,calls_granted,calls_used,expires_at,status)
      VALUES(?,?,?,?,?,?,?,?,?,'active')`)
      .run(row.digest, row.agent_id, row.vendor_id, row.amount_mist, row.sender, row.verified_at, row.calls_granted, row.calls_used, row.expires_at);
  } catch (error) {
    if (!/UNIQUE|constraint/i.test(String(error?.message))) throw error;
    const winner = db.prepare("SELECT * FROM payment_receipts WHERE digest=?").get(digest);
    return { ok: false, code: winner?.agent_id === agent.id ? "already_claimed" : "claimed_by_other_agent", receipt: winner };
  }

  return { ok: true, receipt: row, calls_granted: row.calls_granted, expires_at: row.expires_at, amount_sui: formatMist(received) };
}

/** Best usable pass for an agent, lazily marking expired and exhausted rows. */
export function currentPass(agentId) {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare("UPDATE payment_receipts SET status='expired' WHERE agent_id=? AND status='active' AND expires_at<=?").run(agentId, now);
  return db.prepare(`
    SELECT * FROM payment_receipts
    WHERE agent_id=? AND status='active' AND calls_used < calls_granted AND expires_at > ?
    ORDER BY expires_at DESC, verified_at DESC LIMIT 1
  `).get(agentId, now) ?? null;
}

/** Atomically consume one call. Returns the remaining calls, or null when no usable pass exists. */
export function consumeCall(agentId) {
  const db = getDatabase();
  const pass = currentPass(agentId);
  if (!pass) return null;
  const now = new Date().toISOString();
  const consume = db.transaction(() => {
    const result = db.prepare(`
      UPDATE payment_receipts SET calls_used = calls_used + 1
      WHERE digest=? AND status='active' AND calls_used < calls_granted AND expires_at > ?
    `).run(pass.digest, now);
    if (result.changes !== 1) return null;
    const used = pass.calls_used + 1;
    const remaining = pass.calls_granted - used;
    if (remaining <= 0) db.prepare("UPDATE payment_receipts SET status='exhausted' WHERE digest=?").run(pass.digest);
    return remaining;
  });
  return consume();
}

export function publicPass(pass) {
  if (!pass) return null;
  return {
    digest: pass.digest,
    status: pass.status,
    calls_granted: pass.calls_granted,
    calls_used: pass.calls_used,
    calls_remaining: pass.calls_granted - pass.calls_used,
    expires_at: pass.expires_at,
    verified_at: pass.verified_at,
    amount_mist: pass.amount_mist,
    amount_sui: formatMist(pass.amount_mist),
    network: PREMIUM_NETWORK,
  };
}

/** Pass status for GET /v1/agents/:id/premium and guidance. */
export function passStatus(agentId) {
  const pass = currentPass(agentId);
  if (pass) return { active: true, ...publicPass(pass) };
  const db = getDatabase();
  const last = db.prepare("SELECT * FROM payment_receipts WHERE agent_id=? ORDER BY verified_at DESC LIMIT 1").get(agentId);
  if (last) return { active: false, ...publicPass(last) };
  return {
    active: false,
    status: "none",
    calls_granted: PREMIUM_PASS_CALLS,
    calls_used: 0,
    calls_remaining: 0,
    expires_at: null,
    amount_mist: PREMIUM_PRICE_MIST,
    amount_sui: formatMist(PREMIUM_PRICE_MIST),
    network: PREMIUM_NETWORK,
  };
}

export function premiumConfigSummary() {
  return {
    price_mist: PREMIUM_PRICE_MIST,
    price_sui: formatMist(PREMIUM_PRICE_MIST),
    pass_calls: PREMIUM_PASS_CALLS,
    pass_ttl_minutes: PREMIUM_PASS_TTL_MINUTES,
    network: PREMIUM_NETWORK,
  };
}