// Block 3a review tuning. Change these here; the review engine reads nothing else.

export const MIN_OUTCOMES = 5;
export const MIN_ISSUE_RATE = 0.3;
export const MIN_SESSIONS_WITH_ISSUES = 2;
export const IMPACT_SATURATION = 10;
export const HIGH_PRIORITY = 0.35;
export const MEDIUM_PRIORITY = 0.15;

export const TAXONOMY = [
  "perception",
  "knowledge",
  "tools",
  "reasoning",
  "speed_cost",
  "personalization",
  "reliability",
];

// Events that count as task outcomes, and the subset that counts as issues.
export const OUTCOME_TYPES = ["task_completed", "task_failed", "user_corrected", "task_abandoned"];
export const ISSUE_TYPES = ["task_failed", "user_corrected", "task_abandoned"];

// Fallback taxonomy: capability_missing -> tools, everything else -> reliability.
export const CAPABILITY_MISSING_TAXONOMY = "tools";
export const DEFAULT_TAXONOMY = "reliability";

export const FIX_TYPES = ["model", "data_source", "tool", "workflow", "memory_strategy", "none"];

// Block 3b upgrade tuning.

// A rejected request blocks a new proposal for the same (agent, capability) for this long.
export const REJECT_COOLDOWN_DAYS = 7;
// Compressed-period agents use a short cooldown instead of days.
export const PROPOSAL_COOLDOWN_MINUTES = 30;
// Extra MIST kept on the agent beyond GAS_RESERVE when sizing a treasury top-up so the
// follow-up spend can cover its own transfer gas.
export const UPGRADE_TOPUP_GAS_MARGIN_MIST = "10000000";

// Seeded by `npm run catalog:seed`. Prices are integer MIST strings; vendor ids are resolved
// from the vendors table by label so the catalog always points at real vendor wallets.
export const UPGRADE_CATALOG = [
  {
    id: "upgrade-premium-data",
    vendor_label: "premium-data-source",
    capability_key: "premium_data",
    fix_type: "data_source",
    taxonomy: "knowledge",
    price_mist: "15000000",
    description: "Premium market and invoice data feed for accurate, current finance answers.",
  },
  {
    id: "upgrade-vision",
    vendor_label: "vision-api",
    capability_key: "vision",
    fix_type: "model",
    taxonomy: "perception",
    price_mist: "20000000",
    description: "Vision model access for charts, diagrams and scanned documents.",
  },
];
