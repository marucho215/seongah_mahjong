import type { Hand } from "../core/Hand.js";

const KITA_KIND = "z4";

export function canKita(hand: Hand, kitaEnabled: boolean): boolean {
  return kitaEnabled && hand.countOfKind(KITA_KIND) >= 1;
}

/** Sets aside a north tile. Caller is responsible for drawing the replacement tile
 *  from the wall (Wall.drawKitaReplacement) and adding it to the hand afterward. */
export function applyKita(hand: Hand, tileId: number) {
  const [tile] = hand.removeConcealedByIds([tileId]);
  hand.kitaTiles.push(tile!);
  return tile!;
}
