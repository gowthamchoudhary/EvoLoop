import { getConfig } from "../src/config.js";
import { health, recall, remember } from "../src/walrus.js";
import { getSuiBalance } from "../src/sui-grpc.js";
import { getSuiBalance as getSuiBalanceJsonRpc } from "../src/sui.js";

const secrets = [process.env.MEMWAL_KEY, process.env.TATUM_API_KEY].filter(Boolean);
function safeMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  return message;
}

let passed = 0;
let failed = 0;

async function step(name, action) {
  const started = Date.now();
  try {
    const detail = await action();
    passed += 1;
    console.log(`PASS ${name} (${Date.now() - started} ms)${detail ? `: ${detail}` : ""}`);
    return true;
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name} (${Date.now() - started} ms): ${safeMessage(error)}`);
    return false;
  }
}

await step("Config check", () => {
  getConfig();
});

await step("Walrus health", async () => {
  await health();
});

await step("Walrus write and recall", async () => {
  await remember("[smoke] agent desktop-01 reported 3 corrections on PDF summaries this week; diagrams were missed");
  const results = await recall("what corrections did desktop-01 get?");
  const found = results.some((result) => JSON.stringify(result).includes("desktop-01"));
  if (!found) throw new Error('Recall results did not contain "desktop-01"');
});

await step("Tatum Sui balance", async () => {
  const address = getConfig().SUI_TEST_ADDRESS;
  try {
    const balance = await getSuiBalance(address);
    return `gRPC: ${balance} SUI`;
  } catch (grpcError) {
    try {
      const balance = await getSuiBalanceJsonRpc(address);
      return `JSON-RPC fallback: ${balance} SUI (gRPC failed: ${safeMessage(grpcError)})`;
    } catch (jsonRpcError) {
      throw new Error(`gRPC failed: ${safeMessage(grpcError)}; JSON-RPC fallback failed: ${safeMessage(jsonRpcError)}`);
    }
  }
});

console.log(`Summary: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
