import { describe, expect, it } from "vitest";
import { resolveRonBeforeInterruption } from "../src/core/GameState.js";
import { Hand } from "../src/core/Hand.js";
import { Wall } from "../src/core/Wall.js";
import type { Tile, TileKind } from "../src/core/tiles.js";
import { isFourKansAbortive } from "../src/core/abortiveDraw.js";
import { MAJSOUL_YONMA_RULES, DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { nextDoraKind } from "../src/yaku/dora.js";
import { buildWinContext } from "../src/yaku/winContext.js";

let nextId = 95000;
function tile(kind: TileKind): Tile {
  return { id: nextId++, kind, suit: kind[0] as Tile["suit"], rank: Number(kind.slice(1)), isRed: false };
}

function rinshanContext(hand: Hand, wall: Wall) {
  return buildWinContext({
    hand,
    rules: MAJSOUL_YONMA_RULES,
    player: 0,
    dealer: 0,
    playerCount: 4,
    roundWind: 1,
    ippatsuEligible: false,
    doraIndicatorKinds: wall.doraIndicators().map((indicator) => indicator.kind),
    uraDoraIndicatorKinds: wall.uraDoraIndicators().map((indicator) => indicator.kind),
    isTsumo: true,
    isRinshan: true,
    isHaitei: false,
    isHoutei: false,
    isChankan: false,
    isTenhou: false,
    isChiihou: false,
  });
}

describe("FF-05 Mahjong Soul kan-dora reveal timing", () => {
  it("reveals ankan dora and matching ura immediately for rinshan scoring", () => {
    const wall = new Wall(MAJSOUL_YONMA_RULES, "ff05-ankan");
    wall.dealInitial(4, 13);

    wall.drawRinshan();

    expect(wall.kanCount()).toBe(1);
    expect(wall.pendingKanDora()).toBe(0);
    expect(wall.doraIndicators()).toHaveLength(2);
    expect(wall.uraDoraIndicators()).toHaveLength(2);
  });

  it("feeds the new indicator into ankan rinshan scoring but not daiminkan/shouminkan rinshan scoring", () => {
    const immediate = new Wall(MAJSOUL_YONMA_RULES, "ff05-rinshan-score");
    const deferred = new Wall(MAJSOUL_YONMA_RULES, "ff05-rinshan-score");
    immediate.dealInitial(4, 13);
    deferred.dealInitial(4, 13);
    immediate.drawRinshan();
    deferred.drawRinshan("after-discard");

    const newlyVisibleDora = nextDoraKind(immediate.doraIndicators()[1]!.kind, MAJSOUL_YONMA_RULES);
    const hand = new Hand();
    hand.dealIn([tile(newlyVisibleDora)]);

    expect(rinshanContext(hand, immediate).doraCount).toBe(rinshanContext(hand, deferred).doraCount + 1);

    const newlyVisibleUra = nextDoraKind(immediate.uraDoraIndicators()[1]!.kind, MAJSOUL_YONMA_RULES);
    const riichiHand = new Hand();
    riichiHand.riichi = true;
    riichiHand.dealIn([tile(newlyVisibleUra)]);
    expect(rinshanContext(riichiHand, immediate).uraDoraCount).toBe(
      rinshanContext(riichiHand, deferred).uraDoraCount + 1
    );
  });

  it.each(["daiminkan", "shouminkan"])(
    "keeps %s dora and ura hidden through its rinshan draw, then reveals on discard",
    () => {
      const wall = new Wall(MAJSOUL_YONMA_RULES, "ff05-open-added");
      wall.dealInitial(4, 13);
      const liveBefore = wall.remainingLiveCount();

      wall.drawRinshan("after-discard");

      expect(wall.kanCount()).toBe(1);
      expect(wall.remainingLiveCount()).toBe(liveBefore - 1);
      expect(wall.pendingKanDora()).toBe(1);
      expect(wall.doraIndicators()).toHaveLength(1);
      expect(wall.uraDoraIndicators()).toHaveLength(1);

      wall.revealPendingKanDora();
      expect(wall.pendingKanDora()).toBe(0);
      expect(wall.doraIndicators()).toHaveLength(2);
      expect(wall.uraDoraIndicators()).toHaveLength(2);
    }
  );

  it("reveals an earlier pending indicator before a consecutive kan and delays the new open-kan indicator", () => {
    const wall = new Wall(MAJSOUL_YONMA_RULES, "ff05-consecutive");
    wall.dealInitial(4, 13);

    wall.drawRinshan("after-discard");
    expect(wall.doraIndicators()).toHaveLength(1);

    wall.drawRinshan("after-discard");
    expect(wall.kanCount()).toBe(2);
    expect(wall.pendingKanDora()).toBe(1);
    expect(wall.doraIndicators()).toHaveLength(2);
    expect(wall.uraDoraIndicators()).toHaveLength(2);

    wall.revealPendingKanDora();
    expect(wall.doraIndicators()).toHaveLength(3);
    expect(wall.uraDoraIndicators()).toHaveLength(3);
  });

  it("reveals both the earlier pending kan and a consecutive ankan immediately", () => {
    const wall = new Wall(MAJSOUL_YONMA_RULES, "ff05-consecutive-ankan");
    wall.dealInitial(4, 13);

    wall.drawRinshan("after-discard");
    wall.drawRinshan();

    expect(wall.kanCount()).toBe(2);
    expect(wall.pendingKanDora()).toBe(0);
    expect(wall.doraIndicators()).toHaveLength(3);
    expect(wall.uraDoraIndicators()).toHaveLength(3);
  });

  it("keeps committed-kan limits independent from delayed indicator visibility", () => {
    const wall = new Wall(MAJSOUL_YONMA_RULES, "ff05-max-kans");
    wall.dealInitial(4, 13);

    for (let i = 0; i < MAJSOUL_YONMA_RULES.maxKans; i++) {
      expect(wall.canDrawRinshan(MAJSOUL_YONMA_RULES.maxKans)).toBe(true);
      wall.drawRinshan("after-discard");
    }

    expect(wall.kanCount()).toBe(MAJSOUL_YONMA_RULES.maxKans);
    expect(wall.canDrawRinshan(MAJSOUL_YONMA_RULES.maxKans)).toBe(false);
    expect(wall.pendingKanDora()).toBe(1);
    expect(wall.doraIndicators()).toHaveLength(MAJSOUL_YONMA_RULES.maxKans);
    wall.revealPendingKanDora();
    expect(wall.doraIndicators()).toHaveLength(1 + MAJSOUL_YONMA_RULES.maxKans);
  });

  it("keeps four-kans detection based on committed melds rather than indicator visibility", () => {
    const hands = [new Hand(), new Hand(), new Hand(), new Hand()];
    hands[0]!.melds.push(
      { type: "kan_open", tiles: [tile("p1"), tile("p1"), tile("p1"), tile("p1")] },
      { type: "kan_closed", tiles: [tile("p9"), tile("p9"), tile("p9"), tile("p9")] }
    );
    hands[1]!.melds.push(
      { type: "kan_added", tiles: [tile("s1"), tile("s1"), tile("s1"), tile("s1")] },
      { type: "kan_open", tiles: [tile("s9"), tile("s9"), tile("s9"), tile("s9")] }
    );
    const wall = new Wall(MAJSOUL_YONMA_RULES, "ff05-four-kans");
    wall.dealInitial(4, 13);
    wall.drawRinshan("after-discard");

    expect(wall.pendingKanDora()).toBe(1);
    expect(isFourKansAbortive(hands)).toBe(true);
  });

  it("does not change kan or indicator state for sanma kita replacement", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "ff05-kita");
    wall.dealInitial(3, 13);

    wall.drawKitaReplacement();

    expect(wall.kanCount()).toBe(0);
    expect(wall.pendingKanDora()).toBe(0);
    expect(wall.doraIndicators()).toHaveLength(1);
    expect(wall.uraDoraIndicators()).toHaveLength(1);
  });

  it.each(["ordinary chankan", "Kokushi ankan rob"])("does not reveal an indicator when %s cancels the kan", () => {
    const wall = new Wall(MAJSOUL_YONMA_RULES, "ff05-robbed-kan");
    wall.dealInitial(4, 13);
    const winners = resolveRonBeforeInterruption(
      () => ["ron"],
      () => wall.commitKan("after-discard")
    );

    expect(winners).toEqual(["ron"]);
    expect(wall.kanCount()).toBe(0);
    expect(wall.pendingKanDora()).toBe(0);
    expect(wall.doraIndicators()).toHaveLength(1);
    expect(wall.uraDoraIndicators()).toHaveLength(1);
  });
});
