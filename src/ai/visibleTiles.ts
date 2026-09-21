import type { Hand } from "../core/Hand.js";
import type { TileKind } from "../core/tiles.js";

/**
 * Physical tiles visible outside an AI player's concealed hand. A called-away discard is
 * retained in its owner's river for furiten/history, but its physical tile now lives in the
 * caller's meld and must therefore be counted only there.
 */
export function collectVisibleTileKinds(
  hands: readonly Hand[],
  doraIndicatorKinds: readonly TileKind[]
): TileKind[] {
  const kinds: TileKind[] = [];
  for (const hand of hands) {
    for (const discard of hand.discards) {
      if (!discard.calledAway) kinds.push(discard.tile.kind);
    }
    for (const meld of hand.melds) for (const tile of meld.tiles) kinds.push(tile.kind);
    for (const tile of hand.kitaTiles) kinds.push(tile.kind);
  }
  kinds.push(...doraIndicatorKinds);
  return kinds;
}
