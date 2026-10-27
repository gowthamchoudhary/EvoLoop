/**
 * LayerClient — a plain JavaScript client for the payroll-layer agent HTTP API.
 *
 * It talks only to the public agent-key routes (`Authorization: Bearer <agent api key>`)
 * and never imports anything from `src/`. Every method resolves to `{ status, data }`
 * where `data` is the parsed JSON body, so error codes such as `payment_required`
 * are returned to the caller instead of being thrown away. Network failures reject.
 */

const DEFAULT_BASE_URL = `http://127.0.0.1:${process.env.PORT?.trim() || "8787"}`;

export class LayerClient {
  /**
   * @param {{ baseUrl?: string, apiKey: string, agentId?: string }} options
   *   `agentId` is only needed for `guidance()`, which is addressed per agent.
   */
  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey, agentId = null } = {}) {
    if (!apiKey || typeof apiKey !== "string") throw new Error("LayerClient requires an apiKey (the agent api key)");
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.agentId = agentId;
  }

  async #request(path, { method = "GET", body } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let data;
    if (!text) data = null;
    else {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    return { status: response.status, data };
  }

  /** Report one agent event. Body: type, task_category, summary, optional details/score/session_id/ts. */
  report(event) {
    return this.#request("/v1/events", { method: "POST", body: event });
  }

  /** Capabilities, budget position, pending requests, premium pass status and recalled lessons. */
  guidance() {
    if (!this.agentId) return Promise.resolve({ status: 400, data: { error: "agentId is required for guidance()" } });
    return this.#request(`/v1/agents/${encodeURIComponent(this.agentId)}/guidance`);
  }

  /** Paywalled live rate: { type, symbol, currency, value, timestamp, source, calls_remaining } or 402 payment_required. */
  premiumPrice(symbol = "SUI", currency = "USD") {
    const query = new URLSearchParams({ type: "price", symbol, currency });
    return this.#request(`/v1/premium/data?${query}`);
  }

  /** Paywalled live Sui balance: { type, address, balance_sui, ..., source, calls_remaining } or 402 payment_required. */
  premiumBalance(address) {
    const query = new URLSearchParams({ type: "balance", address });
    return this.#request(`/v1/premium/data?${query}`);
  }

  /** Claim a verified on-chain payment digest as a premium pass: { calls_granted, calls_remaining, expires_at }. */
  claimReceipt(digest) {
    return this.#request("/v1/premium/claim", { method: "POST", body: { digest } });
  }
}

export function createLayerClient(options) {
  return new LayerClient(options);
}
