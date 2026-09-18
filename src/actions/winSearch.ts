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
