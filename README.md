# payroll-layer

## Setup

Use Node.js 20 or newer. Run `npm install`, then configure `.env` with the existing Walrus and Tatum credentials plus `ADMIN_TOKEN` (required). `WALLET_ENC_KEY` is generated as a random 32-byte hex key and written to the ignored `.env` if missing. Keep the `.env` file private; the key encrypts persisted wallet signing keys.

Optional values: `NAMESPACE_PREFIX` defaults to `pl-dev`; `PORT` defaults to `8787`; `DB_PATH` defaults to `./data/payroll.db`; `SUI_NETWORK` defaults to `testnet`; `TATUM_GRPC_HOST` defaults to the Tatum testnet gRPC host for the selected network; `GAS_RESERVE_SUI` defaults to `0.02`.

Start the API with `npm run dev`. `npm run treasury:create` creates the treasury keypair once and prints its public address. Fund it from the Sui testnet faucet before payroll. `npm run vendors:seed` creates the `premium-data-source` and `vision-api` recipient wallets. The Block 1 check remains `npm run smoke:block1`; after funding the treasury, run `npm run smoke:block2` for live testnet payroll and spend checks.

## API

All responses are JSON. Admin routes use `Authorization: Bearer ADMIN_TOKEN`; agent routes use the one-time agent API key returned at registration.

- `GET /health` — unauthenticated server and database health.
- `POST /v1/agents/register` — admin; body `{ "name", "kind", "description" }`.
- `POST /v1/agents/:id/wallet` — admin; create or return the agent's public wallet address.
- `PUT /v1/agents/:id/policy` — admin; set `salary_sui`, `per_tx_cap_sui`, `period_cap_sui`, and `allowed_vendor_ids`.
- `POST /v1/payroll/run` — admin; body `{ "period_label", "agent_id?" }`; pays eligible agents on Sui testnet.
- `POST /v1/spend` — agent; submit a vendor spend request subject to policy checks.
- `GET /v1/agents/:id/balance` — matching agent or admin; live Tatum gRPC balance.
- `GET /v1/agents/:id/events?limit=&type=` — matching agent or admin.
- `GET /v1/agents/:id/recall?q=&limit=5` — matching agent or admin; searches the agent's Walrus namespace.
- `GET /v1/agents/:id/transactions` and `GET /v1/agents/:id/payslips` — matching agent or admin.
- `GET /v1/transactions/:digest/verify` — owning agent or admin; fetch transaction status from Tatum.
- `GET /v1/agents` and `GET /v1/memories?status=` — admin summaries and memory queue records.
- `GET /v1/tatum/activity` — admin; recent rate-limited Tatum RPC activity and retry counts.
