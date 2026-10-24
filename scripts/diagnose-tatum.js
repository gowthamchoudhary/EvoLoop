import { getConfig } from "../src/config.js";

const config = getConfig();
const rootEndpoint = "https://sui-mainnet.gateway.tatum.io";
const endpoints = [config.SUI_RPC_URL];
if (config.SUI_RPC_URL.replace(/\/$/, "") !== rootEndpoint) endpoints.push(rootEndpoint);

function redact(value) {
  return value.split(config.TATUM_API_KEY).join("[REDACTED]");
}

let anyWorks = false;
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  console.log(`Endpoint ${url.origin}${url.pathname}: host=${url.host}, path=${url.pathname}`);
  let works = false;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "x-api-key": config.TATUM_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "suix_getBalance", params: [config.SUI_TEST_ADDRESS] }),
    });
    const fullBody = await response.text();
    const body = redact(fullBody).slice(0, 300);
    console.log(`HTTP status: ${response.status}`);
    console.log(`Response body (up to 300 characters): ${body}`);
    try {
      const payload = JSON.parse(fullBody);
      works = response.ok && payload.result !== undefined && payload.error === undefined;
    } catch {
      works = false;
    }
  } catch (error) {
    console.log(`HTTP status: unavailable`);
    console.log(`Response body (up to 300 characters): ${redact(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
  }
  console.log(`Verdict: ${works ? "JSON-RPC works" : "JSON-RPC not available"}`);
  anyWorks ||= works;
}
if (endpoints.length > 1) console.log(`Overall verdict: ${anyWorks ? "JSON-RPC works" : "JSON-RPC not available"}`);
