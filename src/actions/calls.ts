import type { Hand, Meld } from "../core/Hand.js";
import type { Tile, TileKind } from "../core/tiles.js";
import type { RuleConfig } from "../rules/RuleConfig.js";
import type { Wall } from "../core/Wall.js";

/** Ruleset-level chi gate. Shape/seat legality is handled by discardResponses. */
export function canChi(rules: RuleConfig): boolean {
  return !rules.chiForbidden;
}

export function canPon(hand: Hand, discardedKind: TileKind): boolean {
  return hand.countOfKind(discardedKind) >= 2;
}

/** Applies one already-selected legal chi sequence. Legality/priority live in discardResponses. */
export function applyChi(
  hand: Hand,
  discardedTile: Tile,
  fromSeat: number,
  consumedKinds: readonly [TileKind, TileKind]
): Meld {
  const consumed = consumedKinds.map((kind) => hand.tilesOfKind(kind)[0]);
  if (consumed.some((tile) => tile === undefined)) {
    throw new Error("applyChi: selected sequence is no longer present in the caller hand");
  }
  const removed = hand.removeConcealedByIds(consumed.map((tile) => tile!.id));
  const meld: Meld = {
    type: "chi",
    tiles: [...removed, discardedTile],
    calledFrom: fromSeat,
    calledTile: discardedTile,
  };
  hand.melds.push(meld);
  return meld;
}

export function applyPon(hand: Hand, discardedTile: Tile, fromSeat: number): Meld {
  const pair = hand.tilesOfKind(discardedTile.kind).slice(0, 2);
  const removed = hand.removeConcealedByIds(pair.map((t) => t.id));
  const meld: Meld = {
    type: "pon",
    tiles: [...removed, discardedTile],
    calledFrom: fromSeat,
    calledTile: discardedTile,
  };
  hand.melds.push(meld);
  return meld;
}

export function canDaiminkan(hand: Hand, discardedKind: TileKind): boolean {
  return hand.countOfKind(discardedKind) >= 3;
}

export function canAnkan(hand: Hand, kind: TileKind): boolean {
  return hand.countOfKind(kind) >= 4;
}

export function canShouminkan(hand: Hand, kind: TileKind): boolean {
  return hand.melds.some((m) => m.type === "pon" && m.tiles[0]!.kind === kind) && hand.countOfKind(kind) >= 1;
}

export function canDeclareAnyKan(wall: Wall, rules: RuleConfig): boolean {
  return wall.canDrawRinshan(rules.maxKans);
}

/** Open kan (daiminkan): calling a discard while holding the other 3 copies. */
export function applyDaiminkan(hand: Hand, discardedTile: Tile, fromSeat: number): Meld {
  const trio = hand.tilesOfKind(discardedTile.kind).slice(0, 3);
  const removed = hand.removeConcealedByIds(trio.map((t) => t.id));
  const meld: Meld = {
    type: "kan_open",
    tiles: [...removed, discardedTile],
    calledFrom: fromSeat,
    calledTile: discardedTile,
  };
  hand.melds.push(meld);
  return meld;
}

/** Closed kan (ankan): all 4 copies come from the player's own concealed hand. */
export function applyAnkan(hand: Hand, kind: TileKind): Meld {
  const quad = hand.tilesOfKind(kind).slice(0, 4);
  const removed = hand.removeConcealedByIds(quad.map((t) => t.id));
  const meld: Meld = { type: "kan_closed", tiles: removed };
  hand.melds.push(meld);
  return meld;
}

/** Added kan (shouminkan): upgrades an existing pon using the just-drawn 4th tile. */
export function applyShouminkan(hand: Hand, tileId: number): Meld {
  const [tile] = hand.removeConcealedByIds([tileId]);
  const ponMeld = hand.melds.find((m) => m.type === "pon" && m.tiles[0]!.kind === tile!.kind);
  if (!ponMeld) throw new Error(`applyShouminkan: no existing pon of kind ${tile!.kind} to upgrade`);
  ponMeld.type = "kan_added";
  ponMeld.tiles.push(tile!);
  return ponMeld;
}
