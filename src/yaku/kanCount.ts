import type { Meld } from "../core/Hand.js";

/** Counts only kans owned by this hand; table-wide wall kan count is not a yaku input. */
export function countOwnKanMelds(melds: readonly Meld[]): number {
  return melds.filter(
    (meld) => meld.type === "kan_open" || meld.type === "kan_closed" || meld.type === "kan_added"
  ).length;
}
