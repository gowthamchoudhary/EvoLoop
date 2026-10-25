# payroll-layer

## Setup

Use Node.js 20 or newer. Run `npm install`, then configure `.env` with the existing Walrus and Tatum credentials plus `ADMIN_TOKEN` (required). `WALLET_ENC_KEY` is generated as a random 32-byte hex key and written to the ignored `.env` if missing. Keep the `.env` file private; the key encrypts persisted wallet signing keys.

Optional values: `NAMESPACE_PREFIX` defaults to `pl-dev`; `PORT` defaults to `8787`; `DB_PATH` defaults to `./data/payroll.db`; `SUI_NETWORK` defaults to `testnet`; `TATUM_GRPC_HOST` defaults to the Tatum testnet gRPC host for the selected network; `GAS_RESERVE_SUI` defaults to `0.02`. Reviews optionally use `GROQ_API_KEY` and `GROQ_MODEL` (default `llama-3.3-70b-versatile`); without a key, gap descriptions fall back to templates.

Start the API with `npm run dev`. `npm run treasury:create` creates the treasury keypair once and prints its public address. Fund it from the Sui testnet faucet before payroll. `npm run vendors:seed` creates the `premium-data-source` and `vision-api` recipient wallets, and `npm run catalog:seed` (idempotent) maps those vendor wallets into the upgrade catalog from `src/review-config.js`. The Block 1 check remains `npm run smoke:block1`; after funding the treasury, run `npm run smoke:block2` for live testnet payroll and spend checks. `npm run smoke:block3` exercises settings and the review engine against the running server; it registers its own `smoke-review-*` agent, posts events, reviews, dismisses a gap and deactivates the agent at the end. It never moves money and does not wait for Walrus writes to finish, only for them to be queued. `npm run smoke:block3b` exercises the upgrade catalog, budget planner, approval, rejection, autonomy modes and guidance with real testnet transfers; it needs at least 0.15 SUI in the treasury, pays only the `smoke-upgrade-*` agents it creates, and deactivates them whether it passes or fails.

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
- `GET /v1/agents/:id/guidance` — matching agent key or admin; unlocked capabilities, the current budget window and numbers, the on-chain balance, the pending request count, and up to 5 recalled upgrade/review memories from the agent's own namespace.
- `GET /v1/agents/:id/recall?q=&limit=5` — matching agent or admin; searches the agent's Walrus namespace.
- `GET /v1/agents/:id/transactions` and `GET /v1/agents/:id/payslips` — matching agent or admin.
- `GET /v1/transactions/:digest/verify` — owning agent or admin; fetch transaction status from Tatum.
- `GET /v1/agents` and `GET /v1/memories?status=` — admin summaries and memory queue records.
- `GET /v1/tatum/activity` — admin; recent rate-limited Tatum RPC activity and retry counts.

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
