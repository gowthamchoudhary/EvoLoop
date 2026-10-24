import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getConfig } from "./config.js";

let database;

export function initDatabase() {
  if (database) return database;
  const path = resolve(getConfig().DB_PATH);
  mkdirSync(dirname(path), { recursive: true });
  database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      description TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      type TEXT NOT NULL,
      task_category TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT,
      score REAL,
      cost_usd REAL,
      correction TEXT,
      ts TEXT NOT NULL,
      memory_status TEXT NOT NULL DEFAULT 'none'
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      text TEXT NOT NULL,
      job_id TEXT,
      blob_id TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      stored_at TEXT
    );
    CREATE INDEX IF NOT EXISTS events_agent_ts ON events(agent_id, ts DESC);
    CREATE INDEX IF NOT EXISTS memories_status ON memories(status);
    CREATE INDEX IF NOT EXISTS memories_agent ON memories(agent_id);
    CREATE TABLE IF NOT EXISTS wallets (
      owner_type TEXT NOT NULL CHECK(owner_type IN ('treasury','agent','vendor')),
      owner_id TEXT NOT NULL,
      address TEXT NOT NULL UNIQUE,
      enc_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(owner_type, owner_id)
    );
    CREATE TABLE IF NOT EXISTS policies (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      salary_mist TEXT NOT NULL,
      per_tx_cap_mist TEXT NOT NULL,
      period_cap_mist TEXT NOT NULL,
      allowed_vendor_ids_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vendors (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      category TEXT NOT NULL,
      address TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      kind TEXT NOT NULL CHECK(kind IN ('salary','spend')),
      to_address TEXT NOT NULL,
      amount_mist TEXT NOT NULL,
      reason TEXT,
      category TEXT,
      vendor_id TEXT REFERENCES vendors(id),
      rule_result TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('executed','unconfirmed','blocked','failed')),
      digest TEXT UNIQUE,
      confirmed_at TEXT,
      checkpoint TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS transactions_agent_created ON transactions(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS transactions_kind_status ON transactions(kind, status);
    CREATE TABLE IF NOT EXISTS payslips (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      period_label TEXT NOT NULL,
      salary_mist TEXT NOT NULL,
      spent_mist TEXT NOT NULL,
      saved_mist TEXT NOT NULL,
      salary_digest TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payslips_agent_created ON payslips(agent_id, created_at DESC);
  `);
  const transactionSchema = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get()?.sql ?? "";
  if (!transactionSchema.includes("'unconfirmed'") || !/checkpoint\s+TEXT/i.test(transactionSchema)) {
    database.exec(`
      ALTER TABLE transactions RENAME TO transactions_before_confirmation_migration;
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        kind TEXT NOT NULL CHECK(kind IN ('salary','spend')),
        to_address TEXT NOT NULL,
        amount_mist TEXT NOT NULL,
        reason TEXT,
        category TEXT,
        vendor_id TEXT REFERENCES vendors(id),
        rule_result TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('executed','unconfirmed','blocked','failed')),
        digest TEXT UNIQUE,
        confirmed_at TEXT,
        checkpoint TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO transactions(id,agent_id,kind,to_address,amount_mist,reason,category,vendor_id,rule_result,status,digest,confirmed_at,checkpoint,created_at)
        SELECT id,agent_id,kind,to_address,amount_mist,reason,category,vendor_id,rule_result,status,digest,confirmed_at,NULL,created_at
        FROM transactions_before_confirmation_migration;
      DROP TABLE transactions_before_confirmation_migration;
      CREATE INDEX IF NOT EXISTS transactions_agent_created ON transactions(agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS transactions_kind_status ON transactions(kind, status);
    `);
  }
  return database;
}

export function getDatabase() {
  if (!database) throw new Error("Database has not been initialized");
  return database;
}

export function closeDatabase() {
  database?.close();
  database = undefined;
}

export function getPendingMemories() {
  return getDatabase().prepare("SELECT id FROM memories WHERE status = 'pending' ORDER BY created_at").all();
}

export function getMemoryItem(id) {
  return getDatabase().prepare(`
    SELECT m.*, a.name AS agent_name, e.type AS event_type
    FROM memories m JOIN agents a ON a.id = m.agent_id JOIN events e ON e.id = m.event_id
    WHERE m.id = ?
  `).get(id);
}

export function findStoredMemory(agentId, text) {
  return getDatabase().prepare("SELECT * FROM memories WHERE agent_id = ? AND text = ? AND status = 'stored' LIMIT 1").get(agentId, text);
}
