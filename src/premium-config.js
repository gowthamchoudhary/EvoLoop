import { UPGRADE_CATALOG } from "./review-config.js";

function envInt(name, fallback, min, max) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const premiumCatalogItem = UPGRADE_CATALOG.find((item) => item.capability_key === "premium_data");
if (!premiumCatalogItem) throw new Error("UPGRADE_CATALOG has no premium_data entry");

/** Capability that unlocks the premium data service. */
export const PREMIUM_CAPABILITY_KEY = "premium_data";
/** Price of one pass, in integer MIST, taken from the upgrade catalog. */
export const PREMIUM_PRICE_MIST = premiumCatalogItem.price_mist;
/** Calls one pass grants. Override with PREMIUM_PASS_CALLS. */
export const PREMIUM_PASS_CALLS = envInt("PREMIUM_PASS_CALLS", 20, 1, 1_000_000);
/** How long a pass stays usable. Override with PREMIUM_PASS_TTL_MINUTES. */
export const PREMIUM_PASS_TTL_MINUTES = envInt("PREMIUM_PASS_TTL_MINUTES", 1440, 1, 525_600);
/** Longest a claim waits for Tatum to index a transaction. Override with PREMIUM_VERIFY_POLL_MS. */
export const PREMIUM_VERIFY_POLL_MS = envInt("PREMIUM_VERIFY_POLL_MS", 40_000, 500, 40_000);
/** Network label reported to clients on the payment_required response. */
export const PREMIUM_NETWORK = process.env.SUI_NETWORK?.trim() === "mainnet" ? "sui-mainnet" : "sui-testnet";
/** Sui native coin, the only coin counted when verifying a receipt. */
export const SUI_COIN_SUFFIX = "::sui::SUI";