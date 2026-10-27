import { randomUUID } from "node:crypto";
import { computeBudget, decideStatus, periodWindow } from "./budget.js";
import { getConfig } from "./config.js";
import { getDatabase } from "./db.js";
import { reportTransferFailure, safeText } from "./events.js";
import { enqueueMemory, newMemoryId } from "./memory-queue.js";
import { formatMist, getPayrollBalance, suiToMist, transferSui } from "./payroll-chain.js";
import {
  decisionBasisForWalrus,
  lessonDismissalFor,
  lessonSkipReason,
  lessonsForAgent,
  recallLessons,
} from "./lessons.js";
import { MIN_ISSUE_RATE, PROPOSAL_COOLDOWN_MINUTES, REJECT_COOLDOWN_DAYS, UPGRADE_TOPUP_GAS_MARGIN_MIST } from "./review-config.js";
import { PREMIUM_CAPABILITY_KEY } from "./premium-config.js";
import { passStatus, verifyReceipt } from "./premium.js";
import { settingsFor } from "./settings.js";
import { spendForAgent, withAgentSpendLock } from "./spend.js";
import { verdictBlocking } from "./verdicts.js";
import { getWallet } from "./wallets.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const excerpt = (value, max = 120) => String(value ?? "").slice(0, max);
const NON_FINAL_STATUSES = ["pending_approval", "approved", "auto_approved", "needs_raise"];
const DECIDABLE_STATUSES = ["pending_approval", "needs_raise"];

function httpError(statusCode, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function topupReserveMist() {
  const configured = suiToMist(getConfig().GAS_RESERVE_SUI);
  const margin = BigInt(UPGRADE_TOPUP_GAS_MARGIN_MIST);
  return configured > margin ? configured : margin;
}

function periodSpentTotal(agentId, start) {
  const rows = getDatabase()
    .prepare("SELECT amount_mist FROM transactions WHERE agent_id=? AND kind IN ('spend','topup') AND status IN ('executed','unconfirmed') AND created_at>=?")
    .all(agentId, start);
  return rows.reduce((total, row) => total + BigInt(row.amount_mist), 0n);
}

function improvementSpentTotal(agentId, start) {
  const rows = getDatabase()
    .prepare("SELECT cost_mist FROM upgrade_requests WHERE agent_id=? AND status='executed' AND COALESCE(executed_at, created_at)>=?")
    .all(agentId, start);
  return rows.reduce((total, row) => total + BigInt(row.cost_mist), 0n);
}

function queueMemory(agentId, text) {
  const memoryId = newMemoryId();
  getDatabase().prepare("INSERT INTO memories(id,event_id,agent_id,text,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(memoryId, null, agentId, text, "pending", new Date().toISOString());
  enqueueMemory(memoryId);
  return memoryId;
}

function expectedBenefitFor(gap, metrics) {
  const percent = Math.round(Number(metrics.issue_rate ?? 0) * 100);
  return `Issue rate on ${gap.task_category} is ${percent}% over ${metrics.outcomes ?? 0} outcomes; target: below ${Math.round(MIN_ISSUE_RATE * 100)}%.`;
}

function catalogForGap(gap) {
  const metrics = parseJson(gap.metrics_json) ?? {};
  const items = getDatabase().prepare(`
    SELECT c.*, v.label AS vendor_label
    FROM upgrade_catalog c JOIN vendors v ON v.id = c.vendor_id
    WHERE c.active = 1 AND c.taxonomy = ?
    ORDER BY c.price_mist ASC, c.id ASC
  `).all(gap.taxonomy);
  if (items.length === 0) return null;
  if (metrics.fix_type) {
    const preferred = items.find((item) => item.fix_type === metrics.fix_type);
    if (preferred) return preferred;
  }
  return items[0];
}

function activeCapability(agentId, capabilityKey) {
  return getDatabase().prepare("SELECT * FROM agent_capabilities WHERE agent_id=? AND capability_key=? AND active=1 ORDER BY unlocked_at DESC LIMIT 1")
    .get(agentId, capabilityKey);
}

function blockingRequest(agentId, capabilityKey, gap, settings) {
  const db = getDatabase();
  const open = db.prepare(`
    SELECT id,status FROM upgrade_requests
    WHERE agent_id=? AND capability_key=? AND status IN (${NON_FINAL_STATUSES.map(() => "?").join(",")})
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(agentId, capabilityKey, ...NON_FINAL_STATUSES);
  if (open) return { reason: "request_already_open", status: open.status, request_id: open.id };

  const rejected = db.prepare("SELECT * FROM upgrade_requests WHERE agent_id=? AND capability_key=? AND status='rejected' ORDER BY decided_at DESC, rowid DESC LIMIT 1")
    .get(agentId, capabilityKey);
  if (!rejected) return null;
  const rejectedPriority = Number(parseJson(rejected.baseline_json)?.priority ?? 0);
  if (Number(gap.priority) > rejectedPriority) return null;
  const cooldownMs = settings.period === "compressed" ? PROPOSAL_COOLDOWN_MINUTES * MINUTE_MS : REJECT_COOLDOWN_DAYS * DAY_MS;
  const decidedAt = Date.parse(rejected.decided_at ?? rejected.created_at);
  if (Number.isFinite(decidedAt) && Date.now() - decidedAt < cooldownMs) {
    return { reason: "rejected_cooldown", request_id: rejected.id, cooldown_hours: cooldownMs / 3_600_000 };
  }
  return null;
}

function insertRequest({ gap, catalog, status, costMist, expectedBenefit, baseline, budget, note }) {
  const id = `req_${randomUUID()}`;
  getDatabase().prepare(`
    INSERT INTO upgrade_requests(id,agent_id,gap_id,review_id,catalog_id,vendor_id,capability_key,cost_mist,expected_benefit,
      baseline_json,status,budget_json,decision_note,decided_by,created_at,decided_at,executed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, gap.agent_id, gap.id, gap.review_id, catalog?.id ?? null, catalog?.vendor_id ?? null,
    catalog?.capability_key ?? null, costMist, expectedBenefit, JSON.stringify(baseline), status,
    budget ? JSON.stringify(budget) : null, note ?? null, status === "auto_approved" ? "autonomy:auto_small" : null,
    new Date().toISOString(), status === "auto_approved" ? new Date().toISOString() : null, null,
  );
  return id;
}

export function publicRequest(row) {
  if (!row) return null;
  const { budget_json, baseline_json, ...rest } = row;
  return {
    ...rest,
    cost_sui: formatMist(row.cost_mist),
    budget: parseJson(budget_json),
    baseline: parseJson(baseline_json),
  };
}

export function publicCapability(row) {
  if (!row) return null;
  return { ...row, price_sui: formatMist(row.price_mist) };
}

export function listCatalog() {
  return getDatabase().prepare(`
    SELECT c.*, v.label AS vendor_label
    FROM upgrade_catalog c JOIN vendors v ON v.id = c.vendor_id
    ORDER BY c.taxonomy ASC, c.price_mist ASC
  `).all().map((row) => ({ ...row, price_sui: formatMist(row.price_mist) }));
}

/**
 * Deterministic planning pass for one review. Gaps are processed by task_category (then priority
 * descending) and every purchase planned in this pass reserves its cost for the following ones, so
 * the improvement budget is never committed twice inside one run.
 *
 * Before planning, the agent's Walrus namespace is recalled for lessons; the lessons and the
 * database state are consulted together, and skip if EITHER says skip. Every skipped or created
 * request records the consulted evidence as decision_basis in its budget_json.
 */
export async function createProposalsForReview({ reviewId }) {
  const db = getDatabase();
  const review = db.prepare("SELECT * FROM reviews WHERE id=?").get(reviewId);
  if (!review) throw httpError(404, "review not found");
  const settings = settingsFor(review.agent_id);
  const lessonResult = await recallLessons(review.agent_id, { force: false });
  const lessons = lessonResult.ok ? lessonsForAgent(review.agent_id) : [];
  const decisionBasisNote = lessonResult.ok ? undefined : "walrus_recall_failed_used_database";

  const dbBasis = (kind, capabilityKey, text) => ({
    source: "database",
    kind,
    capability_key: capabilityKey ?? null,
    ...(text ? { text_excerpt: excerpt(JSON.stringify(text)) } : {}),
  });

  const window = periodWindow(settings);
  const wallet = getWallet("agent", review.agent_id);
  const balance = wallet ? await getPayrollBalance(wallet.address, { bypassCache: true }) : 0n;
  const periodSpent = periodSpentTotal(review.agent_id, window.start);
  const improvementSpent = improvementSpentTotal(review.agent_id, window.start);
  const reserve = topupReserveMist();

  const gaps = db.prepare(`
    SELECT * FROM gaps
    WHERE review_id=? AND status='passed_gate' AND priority_label IN ('medium','high')
    ORDER BY task_category ASC, priority DESC, id ASC
  `).all(reviewId);

  const requests = [];
  const skipped = [];
  let reserved = 0n;

  for (const gap of gaps) {
    const metrics = parseJson(gap.metrics_json) ?? {};
    const catalog = catalogForGap(gap);
    const expectedBenefit = expectedBenefitFor(gap, metrics);
    const baseline = {
      task_category: gap.task_category,
      issue_rate: metrics.issue_rate,
      outcomes: metrics.outcomes,
      issues: metrics.issues,
      priority: gap.priority,
      priority_label: gap.priority_label,
      fix_type: metrics.fix_type ?? null,
    };

    if (!catalog) {
      const requestId = insertRequest({
        gap, catalog: null, status: "note_only", costMist: "0", expectedBenefit, baseline, budget: null,
        note: `no active catalog capability for taxonomy ${gap.taxonomy}`,
      });
      requests.push(publicRequest(db.prepare("SELECT * FROM upgrade_requests WHERE id=?").get(requestId)));
      continue;
    }

    const owned = activeCapability(gap.agent_id, catalog.capability_key);
    const basis = [owned
      ? dbBasis("capability_already_active", catalog.capability_key, `active capability unlocked at ${owned.unlocked_at}`)
      : null].filter(Boolean);
    if (owned) {
      skipped.push({
        gap_id: gap.id, task_category: gap.task_category, capability_key: catalog.capability_key,
        reason: "capability_already_active", decision_basis: basis, decision_basis_note: decisionBasisNote ?? null,
      });
      continue;
    }
    const blocking = blockingRequest(gap.agent_id, catalog.capability_key, gap, settings);
    if (blocking) {
      skipped.push({
        gap_id: gap.id, task_category: gap.task_category, capability_key: catalog.capability_key,
        ...blocking, decision_basis: [...basis, dbBasis(blocking.reason, catalog.capability_key, blocking)], decision_basis_note: decisionBasisNote ?? null,
      });
      continue;
    }
    const verdictBlock = verdictBlocking(gap.agent_id, catalog.capability_key, settings);
    if (verdictBlock) {
      skipped.push({
        gap_id: gap.id, task_category: gap.task_category, capability_key: catalog.capability_key,
        ...verdictBlock, decision_basis: [...basis, dbBasis(verdictBlock.reason, catalog.capability_key, verdictBlock)], decision_basis_note: decisionBasisNote ?? null,
      });
      continue;
    }
    // Walrus lessons do their own blocking check (cooldown windows per the agent's settings).
    const lessonBlock = lessonSkipReason(lessons, catalog.capability_key, settings);
    if (lessonBlock) {
      skipped.push({
        gap_id: gap.id, task_category: gap.task_category, capability_key: catalog.capability_key,
        ...lessonBlock, decision_basis: decisionBasisForWalrus(lessons, { capabilityKey: catalog.capability_key, taskCategory: gap.task_category }),
        decision_basis_note: decisionBasisNote ?? null,
      });
      continue;
    }
    const dismissalLesson = lessonDismissalFor(lessons, gap.task_category);
    if (dismissalLesson) {
      skipped.push({
        gap_id: gap.id, task_category: gap.task_category, capability_key: catalog.capability_key,
        reason: "lesson_gap_dismissed", kind: dismissalLesson.kind, blob_id: dismissalLesson.blob_id,
        decision_basis: decisionBasisForWalrus(lessons, { capabilityKey: catalog.capability_key, taskCategory: gap.task_category }),
        decision_basis_note: decisionBasisNote ?? null,
      });
      continue;
    }

    const budgetNumbers = computeBudget({
      settings,
      costMist: catalog.price_mist,
      periodSpentMist: periodSpent,
      improvementSpentMist: improvementSpent,
      reservedMist: reserved,
      balanceMist: balance,
      gasReserveMist: reserve,
    });
    const status = decideStatus(settings, budgetNumbers);
    let note = null;
    if (status === "needs_raise") note = `improvement budget short by ${formatMist(BigInt(budgetNumbers.shortfall_mist))} SUI`;
    if (status === "note_only") note = "autonomy is never; recorded without spending";
    // Created requests record the consulted lesson and database-evidence basis too.
    const decisionBasis = [
      dbBasis("gate_passed", catalog.capability_key, `gap passed for ${gap.task_category}`),
      ...decisionBasisForWalrus(lessons, { capabilityKey: catalog.capability_key, taskCategory: gap.task_category }),
    ];
    const budget = {
      ...budgetNumbers,
      decision_basis: decisionBasis,
      ...(decisionBasisNote ? { decision_basis_note: decisionBasisNote } : {}),
    };

    const requestId = insertRequest({
      gap, catalog, status, costMist: catalog.price_mist, expectedBenefit, baseline, budget, note,
    });
    reserved += BigInt(catalog.price_mist);

    if (status === "auto_approved") {
      db.prepare("UPDATE upgrade_requests SET status='approved' WHERE id=? AND status='auto_approved'").run(requestId);
      requests.push(await executeRequest({ requestId }));
    } else {
      requests.push(publicRequest(db.prepare("SELECT * FROM upgrade_requests WHERE id=?").get(requestId)));
    }
  }

  return {
    review_id: reviewId,
    window_start: window.start,
    window_end: window.end,
    requests,
    skipped,
    skipped_proposals: skipped,
    ...(decisionBasisNote ? { decision_basis_note: decisionBasisNote } : {}),
  };
}

/**
 * Dry-run of proposal creation for one capability: the same lessons + database blockers as
 * createProposalsForReview, the same budget/autonomy computation, but nothing is created.
 */
export async function proposeCheckForAgent({ agentId, capabilityKey }) {
  const db = getDatabase();
  if (!db.prepare("SELECT 1 FROM agents WHERE id=?").get(agentId)) throw httpError(404, "agent not found");
  const settings = settingsFor(agentId);
  const lessonResult = await recallLessons(agentId, { force: false });
  const lessons = lessonResult.ok ? lessonsForAgent(agentId) : [];
  const decisionBasisNote = lessonResult.ok ? undefined : "walrus_recall_failed_used_database";

  const reasons = [];
  const decisionBasis = [];
  const dbBasis = (kind, text) => {
    decisionBasis.push({ source: "database", kind, capability_key: capabilityKey ?? null, ...(text ? { text_excerpt: excerpt(JSON.stringify(text)) } : {}) });
  };

  const catalog = db.prepare(`
    SELECT c.*, v.label AS vendor_label
    FROM upgrade_catalog c JOIN vendors v ON v.id = c.vendor_id
    WHERE c.active = 1 AND c.capability_key=?
    ORDER BY c.price_mist ASC, c.id ASC
  `).get(capabilityKey);
  if (!catalog) {
    reasons.push({ reason: "no_active_catalog_item", source: "database" });
    dbBasis("no_active_catalog_item", null);
  }

  const owned = activeCapability(agentId, capabilityKey);
  if (owned) {
    reasons.push({ reason: "capability_already_active", source: "database", unlocked_at: owned.unlocked_at });
    dbBasis("capability_already_active", `active capability unlocked at ${owned.unlocked_at}`);
  }
  const open = db.prepare(`
    SELECT id,status FROM upgrade_requests
    WHERE agent_id=? AND capability_key=? AND status IN (${NON_FINAL_STATUSES.map(() => "?").join(",")})
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(agentId, capabilityKey, ...NON_FINAL_STATUSES);
  if (open) {
    reasons.push({ reason: "request_already_open", source: "database", status: open.status, request_id: open.id });
    dbBasis("request_already_open", open);
  }
  const rejected = db.prepare("SELECT * FROM upgrade_requests WHERE agent_id=? AND capability_key=? AND status='rejected' ORDER BY decided_at DESC, rowid DESC LIMIT 1")
    .get(agentId, capabilityKey);
  if (rejected) {
    // No gap in play here, so use the most favourable priority: only a fresh rejection blocks.
    const gapPriority = 1;
    const rejectedPriority = Number(parseJson(rejected.baseline_json)?.priority ?? 0);
    if (gapPriority <= rejectedPriority || Number.isFinite(rejectedPriority) === false) {
      const cooldownMs = settings.period === "compressed" ? PROPOSAL_COOLDOWN_MINUTES * MINUTE_MS : REJECT_COOLDOWN_DAYS * DAY_MS;
      const decidedAt = Date.parse(rejected.decided_at ?? rejected.created_at);
      if (Number.isFinite(decidedAt) && Date.now() - decidedAt < cooldownMs) {
        reasons.push({ reason: "rejected_cooldown", source: "database", request_id: rejected.id, cooldown_hours: cooldownMs / 3_600_000 });
        dbBasis("rejected_cooldown", { request_id: rejected.id, decided_at: rejected.decided_at });
      }
    }
  }
  const verdictBlock = verdictBlocking(agentId, capabilityKey, settings);
  if (verdictBlock) {
    reasons.push({ reason: "verdict_cooldown", source: "database", ...verdictBlock });
    dbBasis("verdict_cooldown", verdictBlock);
  }

  const lessonBlock = lessonSkipReason(lessons, capabilityKey, settings);
  if (lessonBlock) {
    reasons.push({ reason: lessonBlock.reason, source: "walrus", kind: lessonBlock.kind, blob_id: lessonBlock.blob_id ?? null });
  }
  const walrusBasis = decisionBasisForWalrus(lessons, { capabilityKey });
  decisionBasis.push(...walrusBasis);

  const wouldPropose = reasons.length === 0;
  let status = null;
  let budget = null;
  if (wouldPropose && catalog) {
    const window = periodWindow(settings);
    const wallet = getWallet("agent", agentId);
    let balance = 0n;
    try {
      balance = wallet ? await getPayrollBalance(wallet.address, { bypassCache: true }) : 0n;
    } catch {
      balance = 0n;
    }
    budget = computeBudget({
      settings,
      costMist: catalog.price_mist,
      periodSpentMist: periodSpentTotal(agentId, window.start),
      improvementSpentMist: improvementSpentTotal(agentId, window.start),
      reservedMist: 0n,
      balanceMist: balance,
      gasReserveMist: topupReserveMist(),
    });
    status = decideStatus(settings, budget);
    reasons.push({
      reason: status === "needs_raise" ? "would_create_needs_raise" : `would_create_${status}`,
      source: "database",
      within_budget: budget.within_budget,
      shortfall_sui: formatMist(BigInt(budget.shortfall_mist)),
    });
  }

  return {
    agent_id: agentId,
    capability_key: capabilityKey,
    ...(catalog ? { catalog_id: catalog.id, cost_sui: formatMist(BigInt(catalog.price_mist)) } : {}),
    would_propose: wouldPropose,
    would_create_status: status,
    ...(budget ? { budget } : {}),
    reasons,
    decision_basis: decisionBasis,
    ...(decisionBasisNote ? { decision_basis_note: decisionBasisNote } : {}),
  };
}

/**
 * Execute an already-approved request. Steps: widen the vendor allowlist, top up from the treasury
 * when the agent cannot cover cost plus reserve, spend through the normal policy path, then record
 * the unlocked capability and queue the Walrus memory. Nothing is sent when any step fails.
 */
export async function executeRequest({ requestId }) {
  const db = getDatabase();
  const initial = db.prepare("SELECT * FROM upgrade_requests WHERE id=?").get(requestId);
  if (!initial) throw httpError(404, "request not found");

  return withAgentSpendLock(initial.agent_id, async () => {
    const request = db.prepare("SELECT * FROM upgrade_requests WHERE id=?").get(requestId);
    if (!request) throw httpError(404, "request not found");
    if (request.status !== "approved") throw httpError(409, "request is not approved", { status: request.status });

    const finish = (stage, message) => {
      db.prepare("UPDATE upgrade_requests SET status='failed', decision_note=? WHERE id=?").run(safeText(`${stage}: ${message}`), requestId);
      return publicRequest(db.prepare("SELECT * FROM upgrade_requests WHERE id=?").get(requestId));
    };
    const recordBudget = (patch) => {
      const current = parseJson(request.budget_json) ?? {};
      db.prepare("UPDATE upgrade_requests SET budget_json=? WHERE id=?").run(JSON.stringify({ ...current, ...patch }), requestId);
    };

    const agentWallet = getWallet("agent", request.agent_id);
    if (!agentWallet) return finish("wallet", "agent wallet is missing");
    if (!request.vendor_id || !request.capability_key) return finish("catalog", "request has no catalog capability");
    const vendor = db.prepare("SELECT * FROM vendors WHERE id=?").get(request.vendor_id);
    const policy = db.prepare("SELECT * FROM policies WHERE agent_id=?").get(request.agent_id);
    if (!vendor) return finish("vendor", "catalog vendor is missing");
    if (!policy) return finish("policy", "agent policy is missing");

    const allowed = JSON.parse(policy.allowed_vendor_ids_json);
    if (!allowed.includes(vendor.id)) {
      const next = [...allowed, vendor.id];
      db.prepare("UPDATE policies SET allowed_vendor_ids_json=?, updated_at=? WHERE agent_id=?")
        .run(JSON.stringify(next), new Date().toISOString(), request.agent_id);
      recordBudget({ vendor_added: vendor.id });
    }

    const cost = BigInt(request.cost_mist);
    const reserve = topupReserveMist();
    const balance = await getPayrollBalance(agentWallet.address, { bypassCache: true });
    if (balance < cost + reserve) {
      const shortfall = cost + reserve - balance;
      const treasury = getWallet("treasury", "treasury");
      if (!treasury) return finish("topup", "treasury wallet is missing");
      const txId = `topup_${randomUUID()}`;
      const createdAt = new Date().toISOString();
      try {
        const confirmation = await transferSui(treasury, agentWallet.address, shortfall, {
          onExecuted: (execution) => db.prepare(`INSERT INTO transactions(id,agent_id,kind,to_address,amount_mist,reason,category,rule_result,status,digest,confirmed_at,checkpoint,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            txId, request.agent_id, "topup", agentWallet.address, shortfall.toString(), `Treasury top-up for upgrade ${request.capability_key}`,
            "upgrade", execution.error ?? "execution_submitted", execution.status, execution.digest, execution.confirmedAt, execution.checkpoint, createdAt,
          ),
        });
        db.prepare("UPDATE transactions SET rule_result='treasury_topup',status=?,digest=?,confirmed_at=?,checkpoint=? WHERE id=?")
          .run(confirmation.status === "success" ? "executed" : confirmation.status, confirmation.digest, confirmation.confirmedAt ?? null, confirmation.checkpoint ?? null, txId);
        db.prepare("UPDATE upgrade_requests SET topup_tx_id=? WHERE id=?").run(txId, requestId);
        recordBudget({ topup: { transaction_id: txId, amount_mist: shortfall.toString(), amount_sui: formatMist(shortfall), digest: confirmation.digest, status: confirmation.status } });
        if (confirmation.status !== "success") return finish("topup_confirm", `treasury top-up status ${confirmation.status}`);
      } catch (error) {
        const failure = reportTransferFailure(error);
        db.prepare("UPDATE transactions SET status='failed',rule_result=? WHERE id=?").run(`${failure.stage}: ${failure.message}`, txId);
        return finish("topup", failure.message);
      }
    }

    const category = db.prepare("SELECT task_category FROM gaps WHERE id=?").get(request.gap_id ?? "")?.task_category ?? "upgrade";
    const description = db.prepare("SELECT description FROM gaps WHERE id=?").get(request.gap_id ?? "")?.description ?? request.expected_benefit ?? "requested upgrade";
    const spend = await spendForAgent({
      agentId: request.agent_id,
      vendorId: vendor.id,
      amountMist: cost.toString(),
      reason: `Upgrade: ${request.capability_key} for ${category}`,
      category: "upgrade",
      lock: false,
    });
    if (!spend.ok) {
      db.prepare("UPDATE upgrade_requests SET spend_tx_id=? WHERE id=?").run(spend.transaction_id ?? null, requestId);
      return finish(spend.rule ?? spend.stage ?? "spend", spend.error ?? "spend failed");
    }
    if (spend.status !== "success") {
      db.prepare("UPDATE upgrade_requests SET spend_tx_id=? WHERE id=?").run(spend.transaction_id, requestId);
      return finish("spend_unconfirmed", `spend status ${spend.status}`);
    }

    const unlockedAt = new Date().toISOString();
    const capabilityId = `cap_${randomUUID()}`;
    const body = `Agent ${request.agent_id} | upgrade_purchased | ${request.capability_key} | cost ${formatMist(cost)} SUI | reason ${description} | digest ${spend.digest}`;
    const memoryId = newMemoryId();
    db.transaction(() => {
      db.prepare("UPDATE upgrade_requests SET status='executed', spend_tx_id=?, executed_at=? WHERE id=?")
        .run(spend.transaction_id, unlockedAt, requestId);
      db.prepare(`INSERT INTO agent_capabilities(id,agent_id,capability_key,request_id,active,price_mist,spend_digest,unlocked_at)
        VALUES(?,?,?,?,1,?,?,?)`).run(capabilityId, request.agent_id, request.capability_key, requestId, cost.toString(), spend.digest, unlockedAt);
      db.prepare("INSERT INTO memories(id,event_id,agent_id,text,status,created_at) VALUES(?,?,?,?,?,?)")
        .run(memoryId, null, request.agent_id, body, "pending", unlockedAt);
    })();
    enqueueMemory(memoryId);

    if (request.capability_key === PREMIUM_CAPABILITY_KEY) {
      let verified = false;
      try {
        verified = (await verifyReceipt({ id: request.agent_id }, spend.digest)).ok;
      } catch {
        verified = false;
      }
      if (!verified) db.prepare("UPDATE agent_capabilities SET note='receipt_unverified' WHERE request_id=?").run(requestId);
    }

    return publicRequest(db.prepare("SELECT * FROM upgrade_requests WHERE id=?").get(requestId));
  });
}

/** Approve a pending or needs_raise request. The status claim is atomic, so only one caller pays. */
export async function approveRequest({ requestId, note, extraBudgetSui }) {
  const db = getDatabase();
  const request = db.prepare("SELECT * FROM upgrade_requests WHERE id=?").get(requestId);
  if (!request) throw httpError(404, "request not found");
  if (!DECIDABLE_STATUSES.includes(request.status)) {
    throw httpError(409, "request is already decided", { status: request.status });
  }

  let extraMist = null;
  if (request.status === "needs_raise") {
    try {
      extraMist = extraBudgetSui === undefined || extraBudgetSui === null
        ? BigInt(parseJson(request.budget_json)?.shortfall_mist ?? request.cost_mist)
        : suiToMist(extraBudgetSui);
    } catch (error) {
      throw httpError(400, safeText(error.message));
    }
    if (extraMist <= 0n) throw httpError(400, "extra_budget_sui must raise the allowance by more than zero");
  }

  const decidedAt = new Date().toISOString();
  const claim = db.prepare("UPDATE upgrade_requests SET status='approved', decided_at=?, decided_by='admin', decision_note=COALESCE(?, decision_note) WHERE id=? AND status=?")
    .run(decidedAt, note ?? null, requestId, request.status);
  if (claim.changes !== 1) throw httpError(409, "request is already decided", { status: request.status });

  if (extraMist !== null) {
    const settings = settingsFor(request.agent_id);
    const before = BigInt(settings.allowance_mist);
    const after = before + extraMist;
    db.prepare("UPDATE agent_settings SET allowance_mist=?, updated_at=? WHERE agent_id=?")
      .run(after.toString(), decidedAt, request.agent_id);
    const budget = parseJson(request.budget_json) ?? {};
    db.prepare("UPDATE upgrade_requests SET budget_json=? WHERE id=?").run(JSON.stringify({
      ...budget,
      extra_budget_mist: extraMist.toString(),
      allowance_before_mist: before.toString(),
      allowance_after_mist: after.toString(),
    }), requestId);
  }

  return executeRequest({ requestId });
}

export function rejectRequest({ requestId, note }) {
  const db = getDatabase();
  const request = db.prepare("SELECT * FROM upgrade_requests WHERE id=?").get(requestId);
  if (!request) throw httpError(404, "request not found");
  if (!DECIDABLE_STATUSES.includes(request.status)) {
    throw httpError(409, "request is already decided", { status: request.status });
  }
  const claim = db.prepare("UPDATE upgrade_requests SET status='rejected', decided_at=?, decided_by='admin', decision_note=? WHERE id=? AND status=?")
    .run(new Date().toISOString(), note ?? null, requestId, request.status);
  if (claim.changes !== 1) throw httpError(409, "request is already decided", { status: request.status });
  queueMemory(request.agent_id, `Agent ${request.agent_id} | upgrade_rejected | ${request.capability_key ?? "none"} | ${note ?? "no note"}`);
  return publicRequest(db.prepare("SELECT * FROM upgrade_requests WHERE id=?").get(requestId));
}

export function listRequests({ agentId, status }) {
  const db = getDatabase();
  const clauses = [];
  const params = [];
  if (agentId) { clauses.push("agent_id=?"); params.push(agentId); }
  if (status) { clauses.push("status=?"); params.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM upgrade_requests ${where} ORDER BY created_at DESC, rowid DESC`).all(...params).map(publicRequest);
}

export function getRequest(requestId) {
  const row = getDatabase().prepare("SELECT * FROM upgrade_requests WHERE id=?").get(requestId);
  if (!row) throw httpError(404, "request not found");
  const gap = row.gap_id ? getDatabase().prepare("SELECT * FROM gaps WHERE id=?").get(row.gap_id) : null;
  return {
    ...publicRequest(row),
    gap: gap ? { id: gap.id, task_category: gap.task_category, taxonomy: gap.taxonomy, description: gap.description, priority: gap.priority, priority_label: gap.priority_label } : null,
  };
}

/** Capabilities, budget position, pending approvals and recalled lessons for one agent. */
export async function guidanceForAgent(agentId) {
  const db = getDatabase();
  if (!db.prepare("SELECT 1 FROM agents WHERE id=?").get(agentId)) throw httpError(404, "agent not found");
  const settings = settingsFor(agentId);
  const window = periodWindow(settings);
  const wallet = getWallet("agent", agentId);
  let balance = null;
  if (wallet) {
    try {
      balance = (await getPayrollBalance(wallet.address, { bypassCache: true })).toString();
    } catch {
      balance = null;
    }
  }
  const cap = (BigInt(settings.allowance_mist) * BigInt(settings.improvement_reserve_pct)) / 100n;
  const improvementSpent = improvementSpentTotal(agentId, window.start);
  const remaining = cap > improvementSpent ? cap - improvementSpent : 0n;
  const pending = db.prepare("SELECT COUNT(*) AS count FROM upgrade_requests WHERE agent_id=? AND status IN ('pending_approval','needs_raise','approved')").get(agentId).count;

  let lessons = [];
  let lessonsRecall = { ok: false, error: "not requested" };
  try {
    const recalled = await recallLessons(agentId, { force: false });
    lessonsRecall = recalled.ok ? { ok: true } : { ok: false, error: recalled.error };
    if (recalled.ok) {
      lessons = lessonsForAgent(agentId).slice(0, 5).map((lesson) => ({
        kind: lesson.kind,
        capability_key: lesson.capability_key,
        task_category: lesson.task_category,
        verdict: lesson.verdict,
        text_excerpt: String(lesson.detail ?? lesson.source_text ?? "").slice(0, 160),
        blob_id: lesson.blob_id,
      }));
    }
  } catch (error) {
    lessonsRecall = { ok: false, error: safeText(error) };
  }

  return {
    agent_id: agentId,
    capabilities: db.prepare("SELECT * FROM agent_capabilities WHERE agent_id=? AND active=1 ORDER BY unlocked_at ASC").all(agentId).map(publicCapability),
    budget: {
      period: window.period,
      window_start: window.start,
      window_end: window.end,
      allowance_mist: settings.allowance_mist,
      spent_mist: periodSpentTotal(agentId, window.start).toString(),
      improvement_cap_mist: cap.toString(),
      improvement_spent_mist: improvementSpent.toString(),
      improvement_remaining_mist: remaining.toString(),
      balance_mist: balance,
    },
    pending_requests: pending,
    premium_pass: passStatus(agentId),
    lessons,
    lessons_recall: lessonsRecall,
  };
}
