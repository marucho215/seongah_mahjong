import type { RuleConfig } from "../rules/RuleConfig.js";
import { allKindsForRules, type TileKind } from "../core/tiles.js";
import { kindToSlot } from "../core/tileIndex.js";
import { minShanten } from "../shanten/shanten.js";

/**
 * All tile kinds that would complete the given concealed hand (tenpai wait set).
 * `concealedCounts` must be the 13-tile-equivalent concealed hand (i.e. NOT including
 * a just-drawn tile); `existingMelds` is the number of melds already locked in by calls.
 */
export function computeWinningTiles(concealedCounts: number[], existingMelds: number, rules: RuleConfig): TileKind[] {
  const winners: TileKind[] = [];
  for (const kind of allKindsForRules(rules)) {
    const slot = kindToSlot(kind);
    if (concealedCounts[slot]! >= 4) continue;
    const testCounts = concealedCounts.slice();
    testCounts[slot]!++;
    if (minShanten(testCounts, existingMelds) <= -1) winners.push(kind);
  }
  return winners;
}

export function isTenpai(concealedCounts: number[], existingMelds: number, rules: RuleConfig): boolean {
  return computeWinningTiles(concealedCounts, existingMelds, rules).length > 0;
}

/**
 * True ukeire: every tile kind that would strictly lower this hand's shanten if drawn,
 * regardless of the hand's current shanten level. At tenpai (shanten 0), this is exactly
 * the same set computeWinningTiles returns (dropping to -1 IS "strictly lower"), so the two
 * agree there by construction. Away from tenpai, computeWinningTiles alone always returns
 * an empty set (adding one tile can reach shanten -1 only from an already-tenpai hand), so
 * it must not be used as a general ukeire proxy - this is what actually measures ukeire at
 * any shanten. Returns kinds only (not unseen-tile-weighted counts); see callers for why.
 *
 * `knownCurrentShanten`: pass this hand's shanten if the caller already computed it (a
 * common case - e.g. evaluateCallAdvantage already needs beforeShanten/afterShanten for its
 * own shantenGain calculation) to skip recomputing it here. minShanten is an expensive
 * brute-force search, so this avoids running it twice on the exact same counts for no
 * behavioral difference - purely a redundant-call reduction, never changes the result.
 */
export function computeImprovingTiles(
  concealedCounts: number[],
  existingMelds: number,
  rules: RuleConfig,
  knownCurrentShanten?: number
): TileKind[] {
  const currentShanten = knownCurrentShanten ?? minShanten(concealedCounts, existingMelds);
  const improving: TileKind[] = [];
  for (const kind of allKindsForRules(rules)) {
    const slot = kindToSlot(kind);
    if (concealedCounts[slot]! >= 4) continue;
    const testCounts = concealedCounts.slice();
    testCounts[slot]!++;
    if (minShanten(testCounts, existingMelds) < currentShanten) improving.push(kind);
  }
  return improving;
}

/**
 * Effective ukeire tile COUNT (not just kind count): sums, over every improving kind, how
 * many physical copies of it are still unseen - i.e. not in this hand and not already
 * visible elsewhere on the table (opponents' discards/melds/kita, dora indicators).
 * `visibleElsewhereCounts` must NOT include this hand's own concealedCounts (those are
 * subtracted separately here) - see characterAI.ts's callers for how it's assembled.
 */
export function computeImprovingTileCount(
  improvingKinds: readonly TileKind[],
  concealedCounts: number[],
  visibleElsewhereCounts: number[]
): number {
  let total = 0;
  for (const kind of improvingKinds) {
    const slot = kindToSlot(kind);
    const unseen = 4 - concealedCounts[slot]! - (visibleElsewhereCounts[slot] ?? 0);
    total += Math.max(0, unseen);
  }
  return total;
}
