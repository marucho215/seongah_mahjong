import type { Tile, TileKind } from "../core/tiles.js";
import type { RuleConfig } from "../rules/RuleConfig.js";

/**
 * The tile kind a given indicator points to. In sanma with manzu 2-8 removed, the manzu
 * suit can't follow the normal 1->2->...->9->1 cycle (2-8 don't exist), so it instead
 * cycles directly 1<->9.
 */
export function nextDoraKind(indicator: TileKind, rules: RuleConfig): TileKind {
  const suit = indicator[0]!;
  const rank = Number(indicator.slice(1));
  if (suit === "z") {
    if (rank <= 4) return `z${(rank % 4) + 1}`; // winds cycle E->S->W->N->E
    return `z${((rank - 5 + 1) % 3) + 5}`; // dragons cycle Haku->Hatsu->Chun->Haku
  }
  if (suit === "m" && rules.removeManzu2to8) {
    return rank === 1 ? "m9" : "m1";
  }
  return `${suit}${(rank % 9) + 1}`;
}

/**
 * Counts dora among `tiles` against `indicatorKinds`. Each indicator is counted
 * independently (not deduplicated) - two identical indicators both pointing to the same
 * kind means a single matching tile in hand counts twice, once per indicator.
 */
export function countDora(tiles: readonly Tile[], indicatorKinds: TileKind[], rules: RuleConfig): number {
  let count = 0;
  for (const indicator of indicatorKinds) {
    const wanted = nextDoraKind(indicator, rules);
    for (const t of tiles) if (t.kind === wanted) count++;
  }
  return count;
}

export function countAkaDora(tiles: readonly Tile[]): number {
  return tiles.filter((t) => t.isRed).length;
}

/** Each extracted north (nukidora) tile is worth 1 dora, always - independent of whether
 *  any dora indicator happens to also point to north (that's counted separately via
 *  countDora against the kita tiles, since a North sitting in the wall's dora-indicator
 *  region behaves exactly like any other hand tile for that purpose). */
export function countNukidora(kitaTiles: readonly Tile[]): number {
  return kitaTiles.length;
}
