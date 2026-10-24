import { getConfig } from "./config.js";
import { tatumHttpJsonRpc } from "./tatum.js";

export async function getSuiBalance(address) {
  const config = getConfig();
  const payload = await tatumHttpJsonRpc({
    url: config.SUI_RPC_URL,
    apiKey: config.TATUM_API_KEY,
    method: "suix_getBalance",
    params: [address],
  });
  if (payload?.error) {
    const message = String(payload.error.message ?? JSON.stringify(payload.error)).split(config.TATUM_API_KEY).join("[REDACTED]");
    throw new Error(`Sui RPC request failed: ${message}`);
  }
  if (payload?.result?.totalBalance === undefined) throw new Error("Sui RPC response missing result.totalBalance");
  return Number(payload.result.totalBalance) / 1e9;
}
