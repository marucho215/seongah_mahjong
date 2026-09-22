import type { Hand, Meld, MeldType } from "../core/Hand.js";
import type { Tile } from "../core/tiles.js";
import type { MeldSnapshot, ReplayMeldType, WinSnapshot } from "../core/GameLog.js";
import { tileToRef } from "./doraBreakdown.js";

/** Replay-facing meld names, decoupled from the engine's internal `MeldType` spelling so
 *  the replay format doesn't depend on an internal implementation name - engine code (Hand,
 *  GameState, calls) keeps using `MeldType` unchanged. */
const MELD_TYPE_TO_REPLAY: Record<MeldType, ReplayMeldType> = {
  chi: "chi",
  pon: "pon",
  kan_open: "daiminkan",
  kan_closed: "ankan",
  kan_added: "kakan",
};

export function meldToSnapshot(meld: Meld): MeldSnapshot {
  const tiles = meld.tiles.map(tileToRef);
  return meld.calledFrom === undefined
    ? { type: MELD_TYPE_TO_REPLAY[meld.type], tiles }
    : { type: MELD_TYPE_TO_REPLAY[meld.type], tiles, fromPlayer: meld.calledFrom };
}

export interface BuildWinSnapshotOptions {
  hand: Hand;
  winningTile: Tile;
  isTsumo: boolean;
}

/**
 * Snapshots the winner's hand exactly as `Hand` already represents it at win time - no
 * GameState changes, no fabricated tile ownership. For tsumo the winning tile is already
 * part of `hand.concealed` (added by the normal draw step before evaluation); for ron it
 * deliberately is not (the ron tile is pushed into `concealed` only transiently during
 * evaluation and popped back out - see `tryRon` in GameState.ts). `winningTile` is always
 * recorded separately regardless of which case applies.
 */
export function buildWinSnapshot(options: BuildWinSnapshotOptions): WinSnapshot {
  const { hand, winningTile, isTsumo } = options;
  return {
    concealedTiles: hand.concealed.map(tileToRef),
    melds: hand.melds.map(meldToSnapshot),
    kitaTiles: hand.kitaTiles.map(tileToRef),
    winningTile: tileToRef(winningTile),
    winningTileSource: isTsumo ? "tsumo" : "ron",
    riichiState: hand.doubleRiichi ? "double_riichi" : hand.riichi ? "riichi" : "none",
  };
}
