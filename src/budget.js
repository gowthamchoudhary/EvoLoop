/**
 * Deterministic budget planner for upgrade requests. No database or network access here:
 * the caller supplies the settings and the amounts it already summed, so every number is
 * reproducible from stored rows.
 */

const MINUTE_MS = 60_000;

/** Current spend window for an agent's settings. `compressed` uses period_minutes. */
export function periodWindow(settings, now = new Date()) {
  const end = now.toISOString();
  const period = settings.period ?? "monthly";
  if (period === "compressed") {
    const minutes = Number(settings.period_minutes ?? 0);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw Object.assign(new Error("compressed period requires period_minutes"), { statusCode: 400 });
    }
    return { start: new Date(now.getTime() - minutes * MINUTE_MS).toISOString(), end, period };
  }
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "daily") return { start: date.toISOString(), end, period };
  if (period === "weekly") {
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);
    return { start: date.toISOString(), end, period };
  }
  return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), end, period };
}

const mist = (value) => BigInt(value ?? 0);

/**
 * Budget for one contemplated purchase.
 *
 * improvement_cap = allowance * reserve%
 * improvement_spent = executed upgrades in the window + purchases already reserved in this run
 * remaining = max(0, cap - spent)
 * A purchase is approved by the budget only when its full cost fits in the remaining allowance.
 */
export function computeBudget({
  settings,
  costMist,
  periodSpentMist = 0n,
  improvementSpentMist = 0n,
  reservedMist = 0n,
  balanceMist = 0n,
  gasReserveMist = 0n,
}) {
  const allowance = mist(settings.allowance_mist);
  const reservePct = BigInt(settings.improvement_reserve_pct ?? 0);
  const cost = mist(costMist);
  const cap = (allowance * reservePct) / 100n;
  const improvementSpent = mist(improvementSpentMist) + mist(reservedMist);
  const remaining = cap > improvementSpent ? cap - improvementSpent : 0n;
  const withinBudget = cost <= remaining;
  const shortfall = withinBudget ? 0n : cost - remaining;
  const balance = mist(balanceMist);
  const reserve = mist(gasReserveMist);
  const topupNeeded = balance < cost + reserve;
  const topupShortfall = topupNeeded ? cost + reserve - balance : 0n;
  return {
    allowance_mist: allowance.toString(),
    improvement_reserve_pct: Number(reservePct),
    improvement_cap_mist: cap.toString(),
    period_spent_mist: mist(periodSpentMist).toString(),
    improvement_spent_mist: improvementSpent.toString(),
    improvement_remaining_mist: remaining.toString(),
    cost_mist: cost.toString(),
    within_budget: withinBudget,
    shortfall_mist: shortfall.toString(),
    balance_mist: balance.toString(),
    gas_reserve_mist: reserve.toString(),
    topup_needed: topupNeeded,
    topup_shortfall_mist: topupShortfall.toString(),
  };
}

/**
 * Budget first, then autonomy: an unaffordable purchase always needs a human even for
 * auto_small agents; `never` only records a note; auto_small pays by itself up to its limit.
 */
export function decideStatus(settings, budget) {
  if (!budget.within_budget) return "needs_raise";
  if (settings.autonomy === "never") return "note_only";
  if (settings.autonomy === "auto_small" && BigInt(budget.cost_mist) <= mist(settings.auto_limit_mist)) return "auto_approved";
  return "pending_approval";
}
