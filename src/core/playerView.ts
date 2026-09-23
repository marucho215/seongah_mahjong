import type { Hand } from "./Hand.js";
import type { Tile, TileKind } from "./tiles.js";
import type { MeldSnapshot, TileRef } from "./GameLog.js";
import { tileToRef } from "../yaku/doraBreakdown.js";
import { meldToSnapshot } from "../yaku/winSnapshot.js";

export interface PlayerViewOpponent {
  seat: number;
  /** Own discards only, excluding any that were called away (those tiles now live in the
   *  caller's meld, not the river) - matches collectVisibleTileKinds' own convention. */
  discards: TileKind[];
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
  riichi: boolean;
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
  const { seat, hands, doraIndicators, scores, ...rest } = options;
  const own = hands[seat]!;
  const opponents: PlayerViewOpponent[] = hands
    .map((hand, i) => ({ hand, seat: i }))
    .filter(({ seat: i }) => i !== seat)
    .map(({ hand, seat: i }) => ({
      seat: i,
      discards: hand.discards.filter((d) => !d.calledAway).map((d) => d.tile.kind),
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
    riichi: own.riichi,
    opponents,
    doraIndicators: doraIndicators.map(tileToRef),
    scores: [...scores],
    ...rest,
  };
}
