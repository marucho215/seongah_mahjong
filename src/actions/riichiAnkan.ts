import type { Hand, Meld } from "../core/Hand.js";
import type { Tile, TileKind } from "../core/tiles.js";
import { kindToSlot, tilesToCounts } from "../core/tileIndex.js";
import type { RuleConfig } from "../rules/RuleConfig.js";
import { computeWinningTiles } from "./winSearch.js";
import { canAnkan } from "./calls.js";

export interface RiichiWaitEntry {
  kind: TileKind;
  /** Theoretical copies not already owned by this player; no hidden table information. */
  remainingCopies: number;
}

function copiesForKind(kind: TileKind, rules: RuleConfig): number {
  return kind === "z4" ? rules.northTileCopies : rules.tileCopiesPerKind;
}

/** Wait kinds plus their theoretical remaining-copy counts for one 13-tile-equivalent state. */
export function riichiWaitSignature(
  concealedTiles: readonly Tile[],
  melds: readonly Meld[],
  kitaTiles: readonly Tile[],
  rules: RuleConfig
): RiichiWaitEntry[] {
  const concealedCounts = tilesToCounts(concealedTiles);
  const ownedCounts = tilesToCounts([
    ...concealedTiles,
    ...melds.flatMap((meld) => meld.tiles),
    ...kitaTiles,
  ]);
  return computeWinningTiles(concealedCounts, melds.length, rules).map((kind) => ({
    kind,
    remainingCopies: Math.max(0, copiesForKind(kind, rules) - ownedCounts[kindToSlot(kind)]!),
  }));
}

function sameWaitSignature(before: readonly RiichiWaitEntry[], after: readonly RiichiWaitEntry[]): boolean {
  return (
    before.length === after.length &&
    before.every((entry, index) => entry.kind === after[index]!.kind && entry.remainingCopies === after[index]!.remainingCopies)
  );
}

/** Mahjong Soul post-riichi ankan legality: drawn fourth tile, unchanged wait kinds/counts. */
export function canRiichiAnkan(
  hand: Hand,
  candidateKind: TileKind,
  currentDraw: Tile,
  rules: RuleConfig
): boolean {
  if (!hand.riichi || !canAnkan(hand, candidateKind)) return false;
  if (currentDraw.kind !== candidateKind || !hand.hasTileId(currentDraw.id)) return false;

  const beforeConcealed = hand.concealed.filter((tile) => tile.id !== currentDraw.id);
  const afterConcealed = hand.concealed.filter((tile) => tile.kind !== candidateKind);
  const virtualKan: Meld = {
    type: "kan_closed",
    tiles: hand.tilesOfKind(candidateKind).slice(0, 4),
  };
  const before = riichiWaitSignature(beforeConcealed, hand.melds, hand.kitaTiles, rules);
  if (before.length === 0) return false;
  const after = riichiWaitSignature(afterConcealed, [...hand.melds, virtualKan], hand.kitaTiles, rules);
  return sameWaitSignature(before, after);
}
