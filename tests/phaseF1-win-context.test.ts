import { describe, expect, it } from "vitest";
import { Hand, type Meld } from "../src/core/Hand.js";
import { parseKind, type Tile } from "../src/core/tiles.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { buildWinContext } from "../src/yaku/winContext.js";

function tile(id: number, kind: string, isRed = false): Tile {
  const { suit, rank } = parseKind(kind);
  return { id, kind, suit, rank, isRed };
}

describe("Phase F1 win-context extraction", () => {
  it("constructs the existing scoring inputs without mutating the hand", () => {
    const hand = new Hand();
    hand.dealIn([tile(1, "p5", true), tile(2, "p5"), tile(3, "z4")]);
    hand.kitaTiles.push(tile(4, "z4"));
    const closedKan: Meld = {
      type: "kan_closed",
      tiles: [tile(5, "s1"), tile(6, "s1"), tile(7, "s1"), tile(8, "s1")],
    };
    hand.melds.push(closedKan);
    hand.riichi = true;
    hand.doubleRiichi = true;

    const concealedIds = hand.concealed.map((held) => held.id);
    const context = buildWinContext({
      hand,
      rules: DEFAULT_SANMA_RULES,
      player: 3,
      dealer: 1,
      playerCount: 4,
      roundWind: 2,
      ippatsuEligible: true,
      doraIndicatorKinds: ["p4", "z3"],
      uraDoraIndicatorKinds: ["p4"],
      isTsumo: true,
      isRinshan: true,
      isHaitei: false,
      isHoutei: false,
      isChankan: false,
      isTenhou: false,
      isChiihou: true,
    });

    expect(context).toEqual({
      seatWind: 3,
      roundWind: 2,
      isTsumo: true,
      isRiichi: true,
      isDoubleRiichi: true,
      isIppatsu: true,
      isHaitei: false,
      isHoutei: false,
      isRinshan: true,
      isChankan: false,
      isTenhou: false,
      isChiihou: true,
      doraCount: 5,
      uraDoraCount: 2,
      akaDoraCount: 1,
      kanCount: 1,
    });
    expect(hand.concealed.map((held) => held.id)).toEqual(concealedIds);
    expect(hand.melds).toEqual([closedKan]);
    expect(hand.kitaTiles.map((held) => held.id)).toEqual([4]);
  });
});
