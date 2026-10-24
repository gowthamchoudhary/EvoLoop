import { getConfig } from "../src/config.js";
import { getDatabase, initDatabase } from "../src/db.js";
import { closePayrollChain, formatMist, getPayrollBalanceBreakdown, transferSui } from "../src/payroll-chain.js";
import { getWallet } from "../src/wallets.js";
import { getTatumActivity } from "../src/tatum.js";

const config = getConfig();
if (config.SUI_NETWORK !== "testnet" || !config.TATUM_GRPC_HOST.startsWith("sui-testnet-grpc.gateway.tatum.io")) {
  console.error("FAIL configuration: debug:transfer requires the Tatum Sui testnet gRPC endpoint");
  process.exit(1);
}
function safeMessage(value) {
  let message = String(value);
  for (const secret of [config.MEMWAL_KEY, config.TATUM_API_KEY, config.ADMIN_TOKEN, config.WALLET_ENC_KEY]) {
    if (secret) message = message.split(secret).join("[REDACTED]");
  }
  return message.replace(/\b(?:plk_[a-f0-9]{64}|suiprivkey1[0-9a-z]+|(?:0x)?[a-f0-9]{64})\b/gi, "[REDACTED]");
}

initDatabase();
const treasury = getWallet("treasury", "treasury");
const vendor = getDatabase().prepare("SELECT * FROM vendors ORDER BY id LIMIT 1").get();
if (!treasury || !vendor) {
  console.error(`FAIL setup: ${!treasury ? "treasury wallet is missing" : "no vendor wallet is configured"}`);
  process.exit(1);
}

const describeStageResult = ({ stage, result }) => {
  if (stage === "dry_run") {
    return `status=${JSON.stringify(result?.status)} gasUsed=${JSON.stringify(result?.gasUsed)} SDK budget=${result?.sdkGasBudgetMist} MIST chosen budget=${result?.chosenGasBudgetMist} MIST final simulation passed=${result?.finalSimulationPassed}`;
  }
  if (stage === "execute") return `digest=${result?.Transaction?.digest ?? result?.FailedTransaction?.digest ?? "unavailable"}`;
  if (stage === "confirm") return `status=${result?.status} digest=${result?.digest ?? "unavailable"}`;
  return "completed";
};

try {
  const balances = await getPayrollBalanceBreakdown(treasury.address);
  console.log(`Treasury SUI balance: total=${balances.totalBalance} MIST, coin objects=${balances.coinBalance} MIST, address balance=${balances.addressBalance} MIST`);
  const confirmation = await transferSui(treasury, vendor.address, 1_000_000n, {
    onStage({ stage, durationMs, result: stageResult, error }) {
      if (error) {
        console.error(`FAIL ${stage} (${durationMs} ms): ${error.originalErrorClass ?? error.name ?? error.constructor?.name ?? "Error"}: ${safeMessage(error.message)}`);
        return;
      }
      console.log(`PASS ${stage} (${durationMs} ms): ${describeStageResult({ stage, result: stageResult })}`);
    },
  });
  console.log(`TRANSFER SUCCESS: ${formatMist(1_000_000n)} SUI; digest=${confirmation.digest}`);
  console.log(`Tatum confirmation: ${JSON.stringify(confirmation)}`);
} catch (error) {
  if (!error.stage) console.error(`FAIL setup: ${error.constructor?.name ?? "Error"}: ${safeMessage(error.message)}`);
  process.exitCode = 1;
} finally {
  const activity = getTatumActivity();
  console.log(`Tatum calls made: ${activity.totalCalls}`);
  console.log(`Tatum 429 retries: ${activity.retries429}`);
  if (process.exitCode) {
    console.log("Last Tatum call log entries:");
    console.log(JSON.stringify(activity.calls.slice(-10), null, 2));
  }
  closePayrollChain();
  getDatabase().close();
}
