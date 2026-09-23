import type { Hand } from "./Hand.js";
import type { Tile, TileKind } from "./tiles.js";
import type { MeldSnapshot, TileRef } from "./GameLog.js";
import { tileToRef } from "../yaku/doraBreakdown.js";
import { meldToSnapshot } from "../yaku/winSnapshot.js";
import { NO_FURITEN, type FuritenSnapshot } from "../actions/furiten.js";
import { seatDistance } from "./seats.js";

/** Position, within the visible river (`discards`, called-away tiles excluded), of the tile
 *  to draw sideways because it declared riichi - null when no riichi declaration. If the
 *  declaration tile itself was called away, the next visible discard takes over (the usual
 *  table convention). Display data only; derived from DiscardEntry.isRiichiDeclaration. */
export function riichiDiscardIndexOf(hand: Hand): number | null {
  const declaredAt = hand.discards.findIndex((d) => d.isRiichiDeclaration);
  if (declaredAt === -1) return null;
  const visibleBefore = hand.discards.slice(0, declaredAt).filter((d) => !d.calledAway).length;
  const visibleTotal = hand.discards.filter((d) => !d.calledAway).length;
  return visibleBefore < visibleTotal ? visibleBefore : null;
}

export interface PlayerViewOpponent {
  seat: number;
  /** Own discards only, excluding any that were called away (those tiles now live in the
   *  caller's meld, not the river) - matches collectVisibleTileKinds' own convention. */
  discards: TileKind[];
  /** See riichiDiscardIndexOf. */
  riichiDiscardIndex: number | null;
  /** How many tiles this seat holds concealed - public information (a table sees the size of
   *  every hand), so a UI can draw the right number of face-down tiles. Count only: never
   *  which tiles. */
  concealedCount: number;
  melds: MeldSnapshot[];
  riichi: boolean;
  kitaCount: number;
}

/**
 * Everything a UI/HumanController may show one specific seat - and nothing else. No
 * opponent concealed tile ever appears here, by construction: `hands` supplies the full
 * per-seat state, but only `hands[seat]` is ever read for concealed/kita tiles below.
 */
export interface PlayerView {
  seat: number;
  concealedTiles: TileRef[];
  melds: MeldSnapshot[];
  kitaTiles: TileRef[];
  /** Own discards only, excluding any that were called away - same convention as
   *  PlayerViewOpponent.discards. Additive field (GUI river rendering needs this;
   *  the CLI driver does not use it). */
  discards: TileKind[];
  /** See riichiDiscardIndexOf. */
  riichiDiscardIndex: number | null;
  riichi: boolean;
  /** Seat wind of every seat this hand, indexed by seat: 1 East, 2 South, 3 West, 4 North -
   *  the same relation to the dealer the scorer uses. */
  seatWinds: number[];
  /** This seat's own furiten state by cause (see FuritenSnapshot). Never another seat's. */
  furiten: FuritenSnapshot;
  opponents: PlayerViewOpponent[];
  doraIndicators: TileRef[];
  scores: number[];
  dealerSeat: number;
  roundWind: number;
  roundHandNumber: number;
  honba: number;
  kyotaku: number;
  wallRemainingLive: number;
}

export interface BuildPlayerViewOptions {
  seat: number;
  /** Defaults to "not furiten" when omitted. */
  furiten?: FuritenSnapshot;
  hands: readonly Hand[];
  doraIndicators: readonly Tile[];
  scores: readonly number[];
  dealerSeat: number;
  roundWind: number;
  roundHandNumber: number;
  honba: number;
  kyotaku: number;
  wallRemainingLive: number;
}

export function buildPlayerView(options: BuildPlayerViewOptions): PlayerView {
  const { seat, hands, doraIndicators, scores, furiten, ...rest } = options;
  const own = hands[seat]!;
  const opponents: PlayerViewOpponent[] = hands
    .map((hand, i) => ({ hand, seat: i }))
    .filter(({ seat: i }) => i !== seat)
    .map(({ hand, seat: i }) => ({
      seat: i,
      discards: hand.discards.filter((d) => !d.calledAway).map((d) => d.tile.kind),
      riichiDiscardIndex: riichiDiscardIndexOf(hand),
      concealedCount: hand.concealed.length,
      melds: hand.melds.map(meldToSnapshot),
      riichi: hand.riichi,
      kitaCount: hand.kitaTiles.length,
    }));
  return {
    seat,
    concealedTiles: own.concealed.map(tileToRef),
    melds: own.melds.map(meldToSnapshot),
    kitaTiles: own.kitaTiles.map(tileToRef),
    discards: own.discards.filter((d) => !d.calledAway).map((d) => d.tile.kind),
    riichiDiscardIndex: riichiDiscardIndexOf(own),
    riichi: own.riichi,
    seatWinds: hands.map((_, s) => seatDistance(options.dealerSeat, s, hands.length) + 1),
    furiten: furiten ?? NO_FURITEN,
    opponents,
    doraIndicators: doraIndicators.map(tileToRef),
    scores: [...scores],
    ...rest,
  };
}
