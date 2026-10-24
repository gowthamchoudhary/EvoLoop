import { getConfig } from "./config.js";

const minimumIntervalMs = 400;
let lastRequestAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getSuiBalance(address) {
  const config = getConfig();
  const elapsed = Date.now() - lastRequestAt;
  if (lastRequestAt !== 0 && elapsed < minimumIntervalMs) {
    await sleep(minimumIntervalMs - elapsed);
  }
  lastRequestAt = Date.now();

  const response = await fetch(config.SUI_RPC_URL, {
    method: "POST",
    headers: {
      "x-api-key": config.TATUM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "suix_getBalance",
      params: [address],
    }),
  });

  const body = await response.text();
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = undefined;
  }

  const safeBody = body.split(config.TATUM_API_KEY).join("[REDACTED]");
  if (!response.ok) {
    throw new Error(`Sui RPC request failed with HTTP status ${response.status}: ${safeBody}`);
  }
  if (payload?.error) {
    const message = payload.error.message ?? safeBody;
    throw new Error(`Sui RPC request failed with HTTP status ${response.status}: ${String(message).split(config.TATUM_API_KEY).join("[REDACTED]")}`);
  }
  if (payload?.result?.totalBalance === undefined) {
    throw new Error(`Sui RPC response missing result.totalBalance (HTTP status ${response.status}): ${safeBody}`);
  }

  return Number(payload.result.totalBalance) / 1e9;
}
