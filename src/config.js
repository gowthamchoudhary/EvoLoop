import "dotenv/config";

const requiredVariables = [
  "MEMWAL_KEY",
  "MEMWAL_ACCOUNT_ID",
  "MEMWAL_SERVER_URL",
  "MEMWAL_NAMESPACE",
  "TATUM_API_KEY",
  "SUI_RPC_URL",
  "SUI_TEST_ADDRESS",
];

export function getConfig() {
  const missing = requiredVariables.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  return Object.fromEntries(requiredVariables.map((name) => [name, process.env[name].trim()]));
}
