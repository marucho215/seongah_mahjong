import type { Hand } from "../core/Hand.js";
import { seatDistance } from "../core/seats.js";
import type { TileKind } from "../core/tiles.js";
import type { RuleConfig } from "../rules/RuleConfig.js";
import { countAkaDora, countDora, countNukidora } from "./dora.js";
import { countOwnKanMelds } from "./kanCount.js";
import type { WinContext } from "./types.js";

export interface BuildWinContextOptions {
  hand: Hand;
  rules: RuleConfig;
  player: number;
  dealer: number;
  playerCount: number;
  roundWind: number;
  ippatsuEligible: boolean;
  doraIndicatorKinds: TileKind[];
  uraDoraIndicatorKinds: TileKind[];
  isTsumo: boolean;
  isRinshan: boolean;
  isHaitei: boolean;
  isHoutei: boolean;
  isChankan: boolean;
  isTenhou: boolean;
  isChiihou: boolean;
}

/**
 * Builds the immutable scoring context from one player's current hand and the public
 * indicator state. It does not evaluate the hand or mutate any supplied state.
 */
export function buildWinContext(options: BuildWinContextOptions): WinContext {
  const {
    hand,
    rules,
    player,
    dealer,
    playerCount,
    roundWind,
    ippatsuEligible,
    doraIndicatorKinds,
    uraDoraIndicatorKinds,
    isTsumo,
    isRinshan,
    isHaitei,
    isHoutei,
    isChankan,
    isTenhou,
    isChiihou,
  } = options;
  const meldTiles = hand.melds.flatMap((meld) => meld.tiles);
  const scoringTiles = [...hand.concealed, ...meldTiles];
  const uraDoraCount = hand.riichi
    ? countDora(scoringTiles, uraDoraIndicatorKinds, rules) +
      countDora(hand.kitaTiles, uraDoraIndicatorKinds, rules)
    : 0;

  return {
    seatWind: seatDistance(dealer, player, playerCount) + 1,
    roundWind,
    isTsumo,
    isRiichi: hand.riichi,
    isDoubleRiichi: hand.doubleRiichi,
    isIppatsu: ippatsuEligible,
    isHaitei,
    isHoutei,
    isRinshan,
    isChankan,
    isTenhou,
    isChiihou,
    doraCount:
      countDora(scoringTiles, doraIndicatorKinds, rules) +
      countDora(hand.kitaTiles, doraIndicatorKinds, rules) +
      countNukidora(hand.kitaTiles),
    uraDoraCount,
    akaDoraCount: countAkaDora(scoringTiles),
    kanCount: countOwnKanMelds(hand.melds),
  };
}
