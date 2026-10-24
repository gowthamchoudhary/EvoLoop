import "dotenv/config";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const requiredVariables = [
  "MEMWAL_KEY",
  "MEMWAL_ACCOUNT_ID",
  "MEMWAL_SERVER_URL",
  "MEMWAL_NAMESPACE",
  "TATUM_API_KEY",
  "SUI_RPC_URL",
  "SUI_TEST_ADDRESS",
  "ADMIN_TOKEN",
];

function walletEncryptionKey() {
  let key = process.env.WALLET_ENC_KEY?.trim();
  if (!key) {
    key = randomBytes(32).toString("hex");
    const envPath = resolve(process.cwd(), ".env");
    const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const line = `WALLET_ENC_KEY=${key}`;
    if (/^\s*WALLET_ENC_KEY\s*=/m.test(current)) {
      writeFileSync(envPath, current.replace(/^\s*WALLET_ENC_KEY\s*=.*$/m, line), { mode: 0o600 });
    } else {
      appendFileSync(envPath, `${current.length && !current.endsWith("\n") ? "\n" : ""}${line}\n`, { mode: 0o600 });
    }
    process.env.WALLET_ENC_KEY = key;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("WALLET_ENC_KEY must be exactly 32 bytes encoded as 64 hexadecimal characters");
  }
  return key;
}

export function getConfig() {
  const missing = requiredVariables.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  const network = process.env.SUI_NETWORK?.trim() || "testnet";
  if (!new Set(["testnet", "mainnet"]).has(network)) throw new Error("SUI_NETWORK must be testnet or mainnet");
  const grpcDefault = network === "testnet" ? "sui-testnet-grpc.gateway.tatum.io:443" : "sui-mainnet-grpc.gateway.tatum.io:443";
  return {
    ...Object.fromEntries(requiredVariables.map((name) => [name, process.env[name].trim()])),
    SUI_NETWORK: network,
    TATUM_GRPC_HOST: process.env.TATUM_GRPC_HOST?.trim() || grpcDefault,
    WALLET_ENC_KEY: walletEncryptionKey(),
    GAS_RESERVE_SUI: process.env.GAS_RESERVE_SUI?.trim() || "0.02",
    NAMESPACE_PREFIX: process.env.NAMESPACE_PREFIX?.trim() || "pl-dev",
    PORT: Number(process.env.PORT?.trim() || 8787),
    DB_PATH: process.env.DB_PATH?.trim() || "./data/payroll.db",
  };
}
