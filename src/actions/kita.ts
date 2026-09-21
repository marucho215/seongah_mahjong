import type { Hand } from "../core/Hand.js";
import type { Tile } from "../core/tiles.js";

const KITA_KIND = "z4";

export function canKita(hand: Hand, kitaEnabled: boolean): boolean {
  return kitaEnabled && hand.countOfKind(KITA_KIND) >= 1;
}

/** Riichi keeps the original hand locked: only the physical north tile just drawn may be extracted. */
export function canRiichiKita(hand: Hand, currentDraw: Tile, kitaEnabled: boolean): boolean {
  return (
    hand.riichi &&
    canKita(hand, kitaEnabled) &&
    currentDraw.kind === KITA_KIND &&
    hand.hasTileId(currentDraw.id)
  );
}

export type KitaAction = "kita" | "pass" | "unavailable";

/** Separates the legal availability of Kita from the actor's deterministic choice. */
export function chooseKitaAction(
  hand: Hand,
  kitaEnabled: boolean,
  shouldDeclare: () => boolean
): KitaAction {
  if (!canKita(hand, kitaEnabled)) return "unavailable";
  return shouldDeclare() ? "kita" : "pass";
}

/** Sets aside a north tile. Caller is responsible for drawing the replacement tile
 *  from the wall (Wall.drawKitaReplacement) and adding it to the hand afterward. */
export function applyKita(hand: Hand, tileId: number) {
  const [tile] = hand.removeConcealedByIds([tileId]);
  hand.kitaTiles.push(tile!);
  return tile!;
}
