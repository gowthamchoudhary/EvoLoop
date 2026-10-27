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
      session_id TEXT,
      memory_status TEXT NOT NULL DEFAULT 'none'
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      event_id TEXT REFERENCES events(id),
      review_id TEXT,
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
    CREATE TABLE IF NOT EXISTS agent_settings (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      period TEXT NOT NULL DEFAULT 'monthly' CHECK(period IN ('daily','weekly','monthly','compressed')),
      period_minutes INTEGER,
      allowance_mist TEXT NOT NULL DEFAULT '0',
      improvement_reserve_pct INTEGER NOT NULL DEFAULT 40 CHECK(improvement_reserve_pct BETWEEN 0 AND 100),
      autonomy TEXT NOT NULL DEFAULT 'ask' CHECK(autonomy IN ('ask','auto_small','never')),
      auto_limit_mist TEXT NOT NULL DEFAULT '0',
      rollover INTEGER NOT NULL DEFAULT 0 CHECK(rollover IN (0,1)),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      period_label TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('gaps_found','no_gaps','insufficient_data')),
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reviews_agent_created ON reviews(agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS gaps (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      task_category TEXT NOT NULL,
      taxonomy TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      evidence_event_ids_json TEXT NOT NULL,
      severity REAL NOT NULL,
      impact REAL NOT NULL,
      priority REAL NOT NULL,
      priority_label TEXT NOT NULL CHECK(priority_label IN ('high','medium','low')),
      status TEXT NOT NULL CHECK(status IN ('passed_gate','rejected_gate','dismissed')),
      gate_reasons_json TEXT NOT NULL,
      description TEXT NOT NULL,
      description_source TEXT NOT NULL CHECK(description_source IN ('llm','template')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS gaps_review ON gaps(review_id);
    CREATE INDEX IF NOT EXISTS gaps_agent_created ON gaps(agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS gap_dismissals (
      agent_id TEXT NOT NULL REFERENCES agents(id),
      task_category TEXT NOT NULL,
      taxonomy TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(agent_id, task_category, taxonomy)
    );
    CREATE TABLE IF NOT EXISTS upgrade_catalog (
      id TEXT PRIMARY KEY,
      vendor_id TEXT NOT NULL REFERENCES vendors(id),
      capability_key TEXT NOT NULL,
      fix_type TEXT NOT NULL CHECK(fix_type IN ('model','data_source','tool','workflow','memory_strategy','none')),
      taxonomy TEXT NOT NULL,
      price_mist TEXT NOT NULL,
      description TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
    );
    CREATE INDEX IF NOT EXISTS upgrade_catalog_active ON upgrade_catalog(active, taxonomy);
    CREATE TABLE IF NOT EXISTS upgrade_requests (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      gap_id TEXT REFERENCES gaps(id),
      review_id TEXT REFERENCES reviews(id),
      catalog_id TEXT REFERENCES upgrade_catalog(id),
      vendor_id TEXT REFERENCES vendors(id),
      capability_key TEXT,
      cost_mist TEXT NOT NULL DEFAULT '0',
      expected_benefit TEXT,
      baseline_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('needs_raise','pending_approval','auto_approved','approved','rejected','executed','failed','note_only')),
      budget_json TEXT,
      decision_note TEXT,
      decided_by TEXT,
      spend_tx_id TEXT,
      topup_tx_id TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      executed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS upgrade_requests_agent_created ON upgrade_requests(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS upgrade_requests_status ON upgrade_requests(status);
    CREATE TABLE IF NOT EXISTS agent_capabilities (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      capability_key TEXT NOT NULL,
      request_id TEXT REFERENCES upgrade_requests(id),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      price_mist TEXT NOT NULL,
      spend_digest TEXT,
      unlocked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_capabilities_agent ON agent_capabilities(agent_id, active);
    CREATE TABLE IF NOT EXISTS payment_receipts (
      digest TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      vendor_id TEXT NOT NULL REFERENCES vendors(id),
      amount_mist TEXT NOT NULL,
      sender TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      calls_granted INTEGER NOT NULL,
      calls_used INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','exhausted','expired'))
    );
    CREATE INDEX IF NOT EXISTS payment_receipts_agent ON payment_receipts(agent_id, status);
    CREATE TABLE IF NOT EXISTS premium_calls (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS premium_calls_agent ON premium_calls(agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS upgrade_verdicts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES upgrade_requests(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      capability_key TEXT NOT NULL,
      task_category TEXT NOT NULL,
      baseline_rate REAL NOT NULL,
      baseline_outcomes INTEGER NOT NULL,
      after_rate REAL NOT NULL,
      after_outcomes INTEGER NOT NULL,
      delta REAL NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('worth_it','not_worth_it','inconclusive')),
      cost_mist TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS upgrade_verdicts_agent ON upgrade_verdicts(agent_id, evaluated_at DESC);
    CREATE INDEX IF NOT EXISTS upgrade_verdicts_request ON upgrade_verdicts(request_id);
  `);
  const capabilityColumns = database.prepare("PRAGMA table_info(agent_capabilities)").all().map((column) => column.name);
  if (capabilityColumns.length > 0 && !capabilityColumns.includes("note")) database.exec("ALTER TABLE agent_capabilities ADD COLUMN note TEXT");
  const eventColumns = database.prepare("PRAGMA table_info(events)").all().map((column) => column.name);
  if (!eventColumns.includes("session_id")) database.exec("ALTER TABLE events ADD COLUMN session_id TEXT");
  const memorySchema = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get()?.sql ?? "";
  if (/event_id\s+TEXT\s+NOT\s+NULL/i.test(memorySchema)) {
    database.exec(`
      ALTER TABLE memories RENAME TO memories_before_review_migration;
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        event_id TEXT REFERENCES events(id),
        review_id TEXT,
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
      INSERT INTO memories(id,event_id,agent_id,text,job_id,blob_id,status,attempts,last_error,created_at,stored_at)
        SELECT id,event_id,agent_id,text,job_id,blob_id,status,attempts,last_error,created_at,stored_at
        FROM memories_before_review_migration;
      DROP TABLE memories_before_review_migration;
      CREATE INDEX IF NOT EXISTS memories_status ON memories(status);
      CREATE INDEX IF NOT EXISTS memories_agent ON memories(agent_id);
    `);
  }
  const memoryColumns = database.prepare("PRAGMA table_info(memories)").all().map((column) => column.name);
  if (!memoryColumns.includes("review_id")) database.exec("ALTER TABLE memories ADD COLUMN review_id TEXT");
  const transactionSchema = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'").get()?.sql ?? "";
  if (!transactionSchema.includes("'unconfirmed'") || !/checkpoint\s+TEXT/i.test(transactionSchema) || !transactionSchema.includes("'topup'")) {
    database.exec(`
      ALTER TABLE transactions RENAME TO transactions_before_confirmation_migration;
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        kind TEXT NOT NULL CHECK(kind IN ('salary','spend','topup')),
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
  database.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      kind TEXT NOT NULL,
      capability_key TEXT,
      task_category TEXT,
      verdict TEXT,
      detail TEXT,
      source_text TEXT NOT NULL,
      blob_id TEXT,
      recalled_at TEXT NOT NULL,
      UNIQUE(agent_id, source_text)
    );
    CREATE INDEX IF NOT EXISTS lessons_agent_kind ON lessons(agent_id, kind);
  `);
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
    FROM memories m JOIN agents a ON a.id = m.agent_id LEFT JOIN events e ON e.id = m.event_id
    WHERE m.id = ?
  `).get(id);
}

export function findStoredMemory(agentId, text) {
  return getDatabase().prepare("SELECT * FROM memories WHERE agent_id = ? AND text = ? AND status = 'stored' LIMIT 1").get(agentId, text);
}
