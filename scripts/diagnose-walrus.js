import { getConfig } from "../src/config.js";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

const config = getConfig();
const mainnetRelayer = "https://relayer.memory.walrus.xyz";

function check(label, status, detail) {
  console.log(`${status} ${label}${detail ? `: ${detail}` : ""}`);
}

const accountMatches = /^0x[0-9a-fA-F]{64}$/.test(config.MEMWAL_ACCOUNT_ID);
check("MEMWAL_ACCOUNT_ID format", accountMatches ? "PASS" : "FAIL", "expected 0x followed by 64 hexadecimal characters");

const sameAddress = config.MEMWAL_ACCOUNT_ID.toLowerCase() === config.SUI_TEST_ADDRESS.toLowerCase();
check("MEMWAL_ACCOUNT_ID differs from SUI_TEST_ADDRESS", sameAddress ? "FAIL" : "PASS", sameAddress ? "account id is the wallet address" : undefined);

let keyFormat = "unrecognized";
let keyLength = Buffer.byteLength(config.MEMWAL_KEY, "utf8");
if (config.MEMWAL_KEY.startsWith("suiprivkey")) {
  keyFormat = "suiprivkey";
} else if (/^(?:0x)?[0-9a-fA-F]+$/.test(config.MEMWAL_KEY)) {
  keyFormat = "hex";
  keyLength = (config.MEMWAL_KEY.replace(/^0x/, "").length / 2);
} else {
  try {
    const decoded = Buffer.from(config.MEMWAL_KEY, "base64");
    if (decoded.length > 0 && decoded.toString("base64").replace(/=+$/, "") === config.MEMWAL_KEY.replace(/=+$/, "")) {
      keyFormat = "base64";
      keyLength = decoded.length;
    }
  } catch {}
}
check("MEMWAL_KEY format", keyFormat === "unrecognized" ? "WARN" : "PASS", `length ${keyLength} bytes; looks like ${keyFormat}`);

check("MEMWAL_SERVER_URL", "PASS", `${config.MEMWAL_SERVER_URL} (mainnet relayer: ${config.MEMWAL_SERVER_URL.replace(/\/$/, "") === mainnetRelayer ? "yes" : "no"})`);

try {
  const healthUrl = new URL("/health", config.MEMWAL_SERVER_URL);
  const response = await fetch(healthUrl);
  const serverDate = response.headers.get("date");
  if (!serverDate) {
    check("Relayer clock skew", "WARN", `health HTTP ${response.status}; Date header missing`);
  } else {
    const differenceSeconds = (Date.parse(serverDate) - Date.now()) / 1000;
    const status = Math.abs(differenceSeconds) > 120 ? "WARN" : "PASS";
    check("Relayer clock skew", status, `${differenceSeconds.toFixed(1)} seconds (health HTTP ${response.status})`);
  }
} catch (error) {
  check("Relayer clock skew", "FAIL", error instanceof Error ? error.message : String(error));
}

try {
  let secretKey;
  if (config.MEMWAL_KEY.startsWith("suiprivkey")) {
    secretKey = decodeSuiPrivateKey(config.MEMWAL_KEY).secretKey;
  } else if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(config.MEMWAL_KEY)) {
    secretKey = Buffer.from(config.MEMWAL_KEY.replace(/^0x/, ""), "hex");
  } else {
    const decoded = Buffer.from(config.MEMWAL_KEY, "base64");
    if (decoded.toString("base64").replace(/=+$/, "") !== config.MEMWAL_KEY.replace(/=+$/, "")) {
      throw new Error("MEMWAL_KEY is not valid base64");
    }
    secretKey = decoded;
  }
  if (secretKey.length !== 32) throw new Error(`Expected a 32-byte Ed25519 secret key, received ${secretKey.length} bytes`);
  const publicKey = Ed25519Keypair.fromSecretKey(secretKey).getPublicKey().toRawBytes();
  check("Ed25519 public key", "PASS", `0x${Buffer.from(publicKey).toString("hex")}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  check("Ed25519 public key", "FAIL", message.split(config.MEMWAL_KEY).join("[REDACTED]"));
}
