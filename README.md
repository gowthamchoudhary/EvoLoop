# payroll-layer

## Setup

Use Node.js 20 or newer. Run `npm install`, then configure `.env` with the existing Walrus and Tatum credentials plus `ADMIN_TOKEN` (required). `WALLET_ENC_KEY` is generated as a random 32-byte hex key and written to the ignored `.env` if missing. Keep the `.env` file private; the key encrypts persisted wallet signing keys.

Optional values: `NAMESPACE_PREFIX` defaults to `pl-dev`; `PORT` defaults to `8787`; `DB_PATH` defaults to `./data/payroll.db`; `SUI_NETWORK` defaults to `testnet`; `TATUM_GRPC_HOST` defaults to the Tatum testnet gRPC host for the selected network; `GAS_RESERVE_SUI` defaults to `0.02`. Reviews optionally use `GROQ_API_KEY` and `GROQ_MODEL` (default `llama-3.3-70b-versatile`); without a key, gap descriptions fall back to templates. The premium pass uses `PREMIUM_PASS_CALLS` (default `20`), `PREMIUM_PASS_TTL_MINUTES` (default `1440`) and `PREMIUM_VERIFY_POLL_MS` (default `40000`, the longest a claim waits for Tatum to index a transaction).

Start the API with `npm run dev`. `npm run treasury:create` creates the treasury keypair once and prints its public address. Fund it from the Sui testnet faucet before payroll. `npm run vendors:seed` creates the `premium-data-source` and `vision-api` recipient wallets, and `npm run catalog:seed` (idempotent) maps those vendor wallets into the upgrade catalog from `src/review-config.js`. The Block 1 check remains `npm run smoke:block1`; after funding the treasury, run `npm run smoke:block2` for live testnet payroll and spend checks. `npm run smoke:block3` exercises settings and the review engine against the running server; it registers its own `smoke-review-*` agent, posts events, reviews, dismisses a gap and deactivates the agent at the end. It never moves money and does not wait for Walrus writes to finish, only for them to be queued. `npm run smoke:block3b` exercises the upgrade catalog, budget planner, approval, rejection, autonomy modes and guidance with real testnet transfers; it needs at least 0.15 SUI in the treasury, pays only the `smoke-upgrade-*` agents it creates, and deactivates them whether it passes or fails. `npm run smoke:block3c1` exercises the premium data paywall end to end with real transfers: two `smoke-premium-*` agents are paid 0.05 SUI each, one buys a pass, the pass drains and the agents are deactivated; it needs at least 0.12 SUI in the treasury.

## API

All responses are JSON. Admin routes use `Authorization: Bearer ADMIN_TOKEN`; agent routes use the one-time agent API key returned at registration.

- `GET /health` — unauthenticated server and database health.
- `POST /v1/agents/register` — admin; body `{ "name", "kind", "description" }`.
- `POST /v1/agents/:id/wallet` — admin; create or return the agent's public wallet address.
- `PUT /v1/agents/:id/policy` — admin; set `salary_sui`, `per_tx_cap_sui`, `period_cap_sui`, and `allowed_vendor_ids`.
- `POST /v1/payroll/run` — admin; body `{ "period_label", "agent_id?" }`; pays eligible agents on Sui testnet.
- `POST /v1/spend` — agent; submit a vendor spend request subject to policy checks.
- `GET /v1/agents/:id/balance` — matching agent or admin; live Tatum gRPC balance.
- `GET /v1/agents/:id/events?limit=&type=` — matching agent or admin. `POST /v1/events` accepts an optional `session_id` (max 64 chars); when omitted it defaults to the UTC date (`YYYY-MM-DD`) of `ts`. Events may also carry `details.gap_hint`, one of `perception`, `knowledge`, `tools`, `reasoning`, `speed_cost`, `personalization`, `reliability`.
- `PUT /v1/agents/:id/settings` — admin; upsert `period` (`daily|weekly|monthly|compressed`), `period_minutes` (nullable), `allowance_mist`, `improvement_reserve_pct` (0-100), `autonomy` (`ask|auto_small|never`), `auto_limit_mist`, `rollover`.
- `GET /v1/agents/:id/settings` — admin; stored settings, or defaults (`monthly`, 40%, `ask`, zero allowances, no rollover) when none are set.
- `POST /v1/agents/:id/review/run` — admin; optional `period_label`, `window_start`, `window_end`; returns the stored review and its gaps.
- `GET /v1/agents/:id/reviews` and `GET /v1/reviews/:id` — admin; review history (with gap counts) and one review with its gaps.
- `POST /v1/gaps/:id/dismiss` — admin; records a `(agent_id, task_category, taxonomy)` dismissal, marks the gap `dismissed`, and queues a Walrus memory `gap dismissed by user: <task_category>`.
- `GET /v1/catalog` — admin; active and inactive upgrade catalog items with vendor labels, capabilities, taxonomies, fix types and prices.
- `POST /v1/reviews/:id/proposals` — admin; plans purchases for that review's `passed_gate` gaps with `medium` or `high` priority. Returns the created requests plus skipped gaps with a reason.
- `GET /v1/requests?agent_id=&status=` and `GET /v1/requests/:id` — admin; upgrade requests with their parsed budget and baseline, and the linked gap on the detail route.
- `POST /v1/requests/:id/approve` — admin; body `{ "note?", "extra_budget_sui?" }`. Approving a `needs_raise` request raises the agent's period allowance by `extra_budget_sui` (default: the recorded shortfall), then executes. A request that is already decided returns HTTP 409 and never pays twice.
- `POST /v1/requests/:id/reject` — admin; body `{ "note?" }`; marks the request `rejected` and queues `Agent <id> | upgrade_rejected | <capability_key> | <note>`.
- `GET /v1/agents/:id/guidance` — matching agent key or admin; unlocked capabilities, the current budget window and numbers, the on-chain balance, the pending request count, the premium pass status, and up to 5 recalled upgrade/review memories from the agent's own namespace.
- `POST /v1/premium/claim` — agent key; body `{ "digest", "poll_timeout_ms?" }`. Verifies the payment on chain and creates the pass; returns `{ calls_granted, calls_remaining, expires_at, receipt }`.
- `GET /v1/premium/data?type=price&symbol=SUI&currency=INR` and `?type=balance&address=0x…` — agent key; paywalled data. Without an active pass it answers HTTP 402 `{ "error": "payment_required", "pay_to", "amount_sui", "network", "asset", "how" }`.
- `GET /v1/agents/:id/premium` — matching agent key or admin; pass status (`active`, calls granted/used/remaining, expiry, price).
- `GET /v1/agents/:id/recall?q=&limit=5` — matching agent or admin; searches the agent's Walrus namespace.
- `GET /v1/agents/:id/transactions` and `GET /v1/agents/:id/payslips` — matching agent or admin.
- `GET /v1/transactions/:digest/verify` — owning agent or admin; fetch transaction status from Tatum.
- `GET /v1/agents` and `GET /v1/memories?status=` — admin summaries and memory queue records.
- `GET /v1/tatum/activity` — admin; recent rate-limited Tatum RPC activity and retry counts.
- `POST /v1/requests/:id/verdict/evaluate` — admin; compares the request's stored baseline against outcomes recorded after the capability was unlocked and stores a `worth_it` / `not_worth_it` / `inconclusive` verdict. An already-evaluated request returns its existing verdict unchanged; there is no endpoint that edits a verdict.
- `GET /v1/agents/:id/verdicts` — admin; the agent's verdict history, newest first.
- `GET /v1/agents/:id/lessons?refresh=1` — matching agent key or admin; the agent's parsed lessons (each with its `blob_id`). `refresh=1` forces a Walrus recall before answering.
- `POST /v1/agents/:id/lessons/restore` — admin; forces a recall and reports what came back per kind from Walrus.
- `POST /v1/agents/import` — admin; body `{ "agent_id", "name", "kind", "description" }`. Creates an agent record with EXACTLY that id (so the Walrus namespace `prefix:agent_id` matches an existing namespace) and returns a new api key; a second import of the same id returns 409.
- `GET /v1/agents/:id/propose-check?capability_key=…` — admin; dry-runs proposal creation for one capability (lessons + database blockers + budget/autonomy) and returns `{ would_propose, reasons[], decision_basis[], would_create_status? }` without creating anything.

## Review engine and evidence gate

Thresholds live in `src/review-config.js`: `MIN_OUTCOMES=5`, `MIN_ISSUE_RATE=0.30`, `MIN_SESSIONS_WITH_ISSUES=2`, `IMPACT_SATURATION=10`, `HIGH_PRIORITY=0.35`, `MEDIUM_PRIORITY=0.15`.

The review window is `window_start`/`window_end` from the request. Without them it runs from the end of the agent's previous review (or the agent's creation) until now. Outcomes are `task_completed`, `task_failed`, `user_corrected` and `task_abandoned`; issues are the last three. Categories are grouped by `task_category` within the window and metrics are computed in `src/review.js` only: outcome and issue counts, issue rate, issues per type, distinct sessions with issues, capability-missing count and total `cost_usd`.

A category passes the gate only when all of these hold, and every failed condition is stored in `gate_reasons`:

1. at least 5 outcomes;
2. issue rate at least 0.30;
3. at least 2 distinct sessions with issues;
4. every cited evidence event id exists in the database;
5. the `(task_category, taxonomy)` pair was not dismissed by the user.

Failing categories are stored as `rejected_gate` (or `dismissed` when the user dismissed them) with a template description; they are never sent to the model. A gap's taxonomy is the most frequent mapped cause across its issue and capability-missing events, where `details.gap_hint` wins when it is a known taxonomy value, `capability_missing` maps to `tools`, and anything else maps to `reliability`. Evidence is up to 20 of the most recent issue and capability-missing events in that category.

`severity` is the issue rate, `impact` is `min(1, issues / 10)`, `priority` is `severity * impact` rounded to 3 decimals, and the label is `high` at 0.35 or above, `medium` at 0.15 or above, else `low`. The review outcome is `insufficient_data` when no category reaches 5 outcomes, `no_gaps` when categories have enough data but none pass, and `gaps_found` otherwise; the summary is templated from those numbers.

Passed gaps get one Groq chat completion request containing only the computed metrics and event summaries. Its JSON reply must have a `fix_type` in `model`, `data_source`, `tool`, `workflow`, `memory_strategy`, `none`, a description of at most 300 characters, and may not cite event ids outside the evidence set. Anything else falls back to a template and `description_source` becomes `template`; `fix_type` is stored in the gap's `metrics_json`. Every review queues one Walrus memory (`Agent <id> | review | <period_label> | outcome: <outcome> | <summary>`), including `no_gaps` reviews; the memory row stores the review's `review_id` and has a NULL `event_id`.

The review engine never sends transfers or touches wallets.

## Upgrades, budget and autonomy

The upgrade tables are `upgrade_catalog`, `upgrade_requests` and `agent_capabilities`; treasury top-ups are stored in `transactions` with `kind = 'topup'` alongside `salary` and `spend`. Prices are integer MIST strings and all tunables live in `src/review-config.js` (`UPGRADE_CATALOG`, `REJECT_COOLDOWN_DAYS=7`, `PROPOSAL_COOLDOWN_MINUTES=30`, `UPGRADE_TOPUP_GAS_MARGIN_MIST`). `npm run catalog:seed` resolves each catalog item's vendor from the `vendors` table by label and is safe to re-run.

Proposals are planned by deterministic code (`src/upgrades.js`), not by a model:

- Only gaps from that review with `status='passed_gate'` and `priority_label` `medium` or `high` are considered, in `task_category` order then priority.
- The catalog item is chosen by the gap's taxonomy, preferring the gap's stored `fix_type`. With no match, a `note_only` request with cost 0 records the gap.
- A gap is skipped when the same `(agent, capability_key)` is already unlocked, has a request in `pending_approval`, `approved`, `auto_approved` or `needs_raise`, or was rejected within the cooldown (`REJECT_COOLDOWN_DAYS`, or `PROPOSAL_COOLDOWN_MINUTES` for compressed-period agents) unless the new gap's priority is strictly higher than the rejected request's.
- `expected_benefit`, `baseline_json` and the budget numbers are built from the gap's stored metrics. Each plan in the same run reserves its cost, so two proposals in one review cannot both spend the same improvement allowance.

The budget planner (`src/budget.js`) is pure and uses the agent's settings and the current period window (daily/weekly/monthly from UTC boundaries, `compressed` from `period_minutes`):

- `improvement_cap = allowance_mist * improvement_reserve_pct / 100`.
- `improvement_spent` is the sum of executed upgrade costs in the window plus the costs already reserved in this planning run.
- `improvement_remaining = max(0, cap - spent)`; a purchase is within budget only when its full cost fits.
- The planner also reports the agent's live balance (`Tatum`) and whether a treasury top-up would be needed for `cost + GAS_RESERVE`.

Autonomy is applied after the budget: `never` records `note_only`; `ask` records `pending_approval`; `auto_small` records `auto_approved` and executes immediately only when the cost is at most `auto_limit_mist`, otherwise `pending_approval`. A purchase that does not fit the improvement allowance is always `needs_raise`, which needs an explicit admin approval regardless of autonomy.

Approval and auto-approval run the same `executeRequest`: add the vendor to the agent's `allowed_vendor_ids`; top up from the treasury (kind `topup`, confirmed through Tatum) when the agent balance cannot cover the cost plus reserve; spend through the normal policy path with reason `Upgrade: <capability_key> for <task_category>` and category `upgrade`, which produces the usual `cost_incurred` event and Walrus memory; then set the request `executed`, unlock the capability in `agent_capabilities`, and queue `Agent <id> | upgrade_purchased | <capability_key> | cost <x> SUI | reason <description> | digest <digest>`. A blocked rule or failed transfer sets the request `failed` with the stage and stops before any further transfer. The request status transition is atomic, and execution is serialized per agent, so concurrent approvals cannot both send money.

## Premium data service (receipt-gated)

One pass costs the `premium_data` catalog price (0.015 SUI) and is paid like any other spend to the `premium-data-source` vendor. The pass is a row in `payment_receipts` keyed by the payment digest: `PREMIUM_PASS_CALLS` calls (default 20) for `PREMIUM_PASS_TTL_MINUTES` minutes (default 1440).

`POST /v1/premium/claim` verifies the receipt in `src/premium.js` against Tatum's `LedgerService.GetTransaction`, polling `NOT_FOUND` for up to `PREMIUM_VERIFY_POLL_MS` (40 s) and reading the `digest`, `transaction.sender`, `effects.status` and `balance_changes` fields. A claim succeeds only when all of these hold, and returns exactly one of these error codes otherwise:

1. the digest exists on chain — otherwise `receipt_not_found`;
2. the transaction succeeded — otherwise `tx_failed`;
3. the sender is the agent's own wallet — otherwise `wrong_sender`;
4. the `premium-data-source` address received SUI in `balance_changes` — otherwise `wrong_recipient`;
5. that amount is at least the catalog price — otherwise `insufficient_amount`;
6. the digest is not already a receipt: `already_claimed` for the same agent, `claimed_by_other_agent` for any other agent (replay protection, HTTP 409).

`GET /v1/premium/data` consumes one call atomically (`calls_used` increments only while `calls_used < calls_granted`, the row is active and unexpired, and it flips to `exhausted` on the last call). Without a usable pass it returns HTTP 402 with `pay_to`, `amount_sui`, `network` (`sui-testnet`/`sui-mainnet`), `asset: "SUI"` and the claim instructions. With a pass:

- `type=price` returns the Tatum v4 rate `GET https://api.tatum.io/v4/data/rate/symbol?symbol=…&basePair=…` (header `x-api-key`), routed through the same queue, retry policy and activity log as the gRPC calls under `rest:GET /v4/data/rate/symbol`, cached 20 s per pair, as `{ type, symbol, currency, value, timestamp, source: "tatum-rates", calls_remaining }`;
- `type=balance` returns the live Sui balance from the Tatum gRPC `GetBalance` as `{ balance_sui, coin_objects_sui, address_balance_sui, source: "tatum-grpc", calls_remaining }`.

Every premium call is logged to `premium_calls` (agent, type, outcome). When an upgrade purchase of `premium_data` executes, the flow claims its own spend digest automatically; if that verification fails the capability row is flagged `receipt_unverified` and nothing is reversed. `GET /v1/agents/:id/guidance` carries the pass status alongside the budget and capabilities.

## Upgrade verdicts

every executed upgrade request is measured once: `POST /v1/requests/:id/verdict/evaluate` stores one verdict in `upgrade_verdicts` from stored numbers only. The baseline is the request's `baseline_json` (the gap's issue rate at proposal time); the after side counts outcomes of the same `task_category` with `ts` after the capability's `unlocked_at` (`issue_rate = issues / outcomes`, issues are `task_failed`, `user_corrected`, `task_abandoned`).

Tunables in `src/review-config.js`: `MIN_AFTER_OUTCOMES=5`, `WORTH_IT_DROP=0.20`, `NOT_WORTH_DROP=0.05`, `VERDICT_COOLDOWN_DAYS=30`, `VERDICT_COOLDOWN_MINUTES_COMPRESSED=120`.

- `after_outcomes >= MIN_AFTER_OUTCOMES` and `baseline_rate - after_rate >= WORTH_IT_DROP` → `worth_it`;
- `after_outcomes >= MIN_AFTER_OUTCOMES` and `baseline_rate - after_rate <= NOT_WORTH_DROP` → `not_worth_it`;
- otherwise `inconclusive` (including fewer than `MIN_AFTER_OUTCOMES` after outcomes).

The summary and the queued Walrus memory (`Agent <id> | upgrade_verdict | <capability_key> | <verdict> | issue rate <b>% -> <a>% over <n> tasks | cost <x> SUI`) are templated from the numbers. A `not_worth_it` verdict blocks re-proposing the same capability for the cooldown (30 days, 120 minutes for compressed-period agents), proposal pages skip verdict-cooldown capabilities with a `verdict_cooldown` reason, and reviews append the relevant verdict history to their summary.

## SDK client (`sdk/client.js`)

`LayerClient` is dependency-free plain JS (fetch only) and imports nothing from `src/`. `new LayerClient({ baseUrl?, apiKey, agentId? })` and its methods return `{ status, data }` — parsed JSON including error codes like `payment_required` — or reject on network failure:

- `report(event)` — `POST /v1/events` with the agent key;
- `guidance()` — capabilities, budget, pending requests, premium pass status and recalled lessons;
- `premiumPrice(symbol, currency)` and `premiumBalance(address)` — paywalled data (200 or 402);
- `claimReceipt(digest)` — claim a verified on-chain payment as a premium pass.

## Research agent (`agents/research-agent/`)

`answerQuestion(question, { client, groq, sessionId })`:

1. `guidance()` decides whether `premium_data` is unlocked and the pass has calls remaining.
2. A Groq chat call (temperature 0, model `GROQ_MODEL`, default `llama-3.3-70b-versatile`; set `GROQ_MODEL` to a model your key can use — the shared key works with `qwen/qwen3.8-27b` and `allam-2-7b`) classifies the question with strict JSON validation: `needs_live_data`, and for live questions `{ kind: "price", symbol, currency }` or `{ kind: "balance", address }`. Invalid JSON is treated as a static question, never guessed.
3. Live and capable: the answer states only the value returned by the premium endpoint and its source; a 402 `payment_required` is treated as not having the capability.
4. Live and not capable: a `capability_missing` event (summary `needs live data: <kind>`, `details.gap_hint "knowledge"`, `task_category "finance_qa"`) is posted, then the model alone answers best-effort — knowingly imperfect, never faked.
5. Static: the model answers directly.

Returns `{ answer, usedPremium, needsLive }`.

## Automated grader (`agents/research-agent/`)

The grader posts a graded event for every answer with the agent's key and uses Tatum data as ground truth fetched by the runner at grading time (through `src/tatum.js`/`src/payroll-chain.js` on the admin side, never through the agent's pass):

- price answers: correct when a parsed number is within 3% of a fresh Tatum rate (`getRate`);
- balance answers: correct when a parsed number matches the live Tatum gRPC total within 0.0005 SUI;
- static answers: correct when every expected keyword appears (case-insensitive, word-boundary matched).

Number parsing handles commas, currency symbols and strips 0x addresses. Every graded event carries `details.source = "automated_grader"`, the runner-supplied `session_id` and `task_category`; correct answers are `task_completed` (score 1), incorrect ones `user_corrected` (score 0) with correction text `expected about X, got Y`.

The question bank (`questions.js`) has live `finance_qa` questions per phrasing/currency/address (3 price phrasings × USD/INR/EUR, 4 balance phrasings × the treasury and both vendor addresses, read from the database at run time) and at least 12 static `general_knowledge` facts with expected keywords.

## Demo cycle

`npm run demo:cycle` runs one complete upgrade lifecycle against the running server with real services (Groq, Tatum, Sui testnet payroll and upgrade transfers, Walrus memories). Preconditions are checked before any transfer and stop with clear messages: `GROQ_API_KEY` set and one real call succeeds, treasury ≥ 0.2 SUI, catalog seeded.

The cycle: registers `research-agent-<random>`, creates its wallet, allows no vendors, and sets compressed settings (30 min period, 0.05 SUI allowance, 40% reserve, autonomy `ask`), then runs payroll for that one agent (0.05 SUI, verified). It runs two 14-task periods (10 live `finance_qa` + 4 static `general_knowledge`) across 3 sessions each through the real agent and grader, printing a line per task. Between them: review 1 (must gate the `finance_qa` knowledge gap), proposals (premium_data `pending_approval`), admin approval (real 0.015 SUI spend through the normal upgrade path, capability unlocked, pass auto-claimed — needs `PREMIUM_PASS_CALLS >= 12`), then `POST /v1/requests/:id/verdict/evaluate` and a second review whose proposals must not re-propose `premium_data`. It prints guidance, verdict history and the last 10 Tatum activity entries, states the final verdict with the raw numbers even when it is `not_worth_it`, deactivates the agent in all cases, and prints the treasury balance before and after.

## Lessons: Walrus-driven memory

Upgrade-decision memories all have the structured shape `Agent <agent_id> | <kind> | ...` — `upgrade_purchased`, `upgrade_rejected`, `upgrade_verdict`, `gap_dismissed` (a dismissal memory is now `Agent <id> | gap_dismissed | <task_category>`; the legacy `gap dismissed by user: <category>` text is still parsed) and `review` (`... | <period_label> | outcome: <x> | ...`). `src/lessons.js` parses those texts (`parseMemoryText`) and ignores foreign agent ids and unknown kinds.

`recallLessons(agentId, { force })` runs five recall queries against the agent's own Walrus namespace through the existing per-agent recall helper (limit 10 each), parses every hit and upserts it into the `lessons` table — one row per `(agent_id, source_text)`, keeping the recalled `blob_id`. Results are cached per agent for 60 seconds unless forced; a recall failure or a 20 s timeout resolves to `{ ok: false, error }` so callers can fall back to the database instead of crashing. Nothing is ever inserted into `lessons` by hand: every row exists because a real blob was recalled.

Decisions consume the lessons: proposal planning and the review gate's dismissal check call `recallLessons` first, then look at BOTH state sources and skip when either says skip:

- an `upgrade_verdict` lesson with `not_worth_it` inside the verdict cooldown → `lesson_verdict_not_worth_it`;
- an `upgrade_rejected` lesson inside the rejection cooldown → `lesson_rejected_cooldown`;
- an `upgrade_purchased` lesson for the capability → `lesson_capability_purchased`;
- a `gap_dismissed` lesson for the same task_category → `lesson_gap_dismissed` (and the review gate records `dismissed_by_user` for that category, citing the lesson's blob id).

Every skipped entry and every created request additionally records `decision_basis` in `budget_json` (and on entries returned by the proposals endpoint): a list of the consulted evidence, each item `{ source: "walrus"|"database", kind, capability_key, blob_id?, text_excerpt (max 120 chars) }`. When the recall failed, `decision_basis_note: "walrus_recall_failed_used_database"` says the database alone decided. The request detail route exposes the parsed `decision_basis`; the proposals response carries a `skipped_proposals` array with the same reason and basis payloads, and `GET /v1/agents/:id/guidance` includes up to 5 lessons (with blob ids) plus a `lessons_recall` status.

## Portable memory demo

`npm run demo:portable` proves that an agent's decision history lives in its Walrus namespace, not in any single database, and sends no money:

1. It finds the most recent `research-agent*` in the main database with at least one stored `upgrade_purchased` and one stored `upgrade_verdict` memory, printing their blob ids (clear stop message when none — run `npm run demo:cycle` first).
2. It deletes `./data/portable-demo.db`, seeds it with the real vendors and upgrade catalog, and starts a SECOND server process on port 8788 with that empty database and the same namespace prefix and Walrus credentials.
3. On the second server it imports the SAME agent id (`POST /v1/agents/import`), confirms the fresh database has zero events, zero capabilities and zero lesson rows for the agent, then calls `lessons/restore`: every lesson row is rebuilt from Walrus recall only, keeping each recalled `blob_id`.
4. It dry-runs `propose-check` for `premium_data` (must be `would_propose=false` with a decision_basis item whose source is `walrus` and which cites a blob id) and reports the check for `vision` honestly (without lessons for that capability it is usually `true`).
5. It stops the second server and deletes its database file, printing PASS/FAIL with timings per step and exiting non-zero on failure.