import type { RuleConfig } from "../rules/RuleConfig.js";

/**
 * Given every player eligible to ron a discard, in turn order starting immediately after
 * the discarder (so index 0 is the "closest" player), decides who actually wins:
 *  - "atamahane" ("head bump"): only the closest eligible player wins; the others get
 *    nothing and are NOT considered to have "declined" (no furiten consequence).
 *  - "all": every eligible player wins simultaneously (double or triple ron), each scored
 *    and paid independently against the discarder.
 */
export function resolveRonWinners<T>(eligibleInOrder: T[], mode: RuleConfig["doubleRonMode"]): T[] {
  if (eligibleInOrder.length === 0) return [];
  return mode === "atamahane" ? [eligibleInOrder[0]!] : eligibleInOrder;
}
