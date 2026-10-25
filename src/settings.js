import { getDatabase } from "./db.js";

export const defaultSettings = {
  period: "monthly",
  period_minutes: null,
  allowance_mist: "0",
  improvement_reserve_pct: 40,
  autonomy: "ask",
  auto_limit_mist: "0",
  rollover: 0,
};

/** Stored settings, or the documented defaults when the agent has never saved any. */
export function settingsFor(agentId) {
  const row = getDatabase().prepare("SELECT * FROM agent_settings WHERE agent_id=?").get(agentId);
  return row ? { ...row } : { agent_id: agentId, ...defaultSettings, updated_at: null };
}
