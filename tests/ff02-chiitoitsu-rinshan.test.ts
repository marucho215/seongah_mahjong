import { describe, expect, it } from "vitest";
import { applyKita } from "../src/actions/kita.js";
import { Hand } from "../src/core/Hand.js";
import type { Tile, TileKind } from "../src/core/tiles.js";
import { Wall } from "../src/core/Wall.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";
import { evaluateWin } from "../src/yaku/evaluate.js";
import type { WinContext } from "../src/yaku/types.js";
import { buildWinContext } from "../src/yaku/winContext.js";

let nextId = 70000;
function tile(kind: TileKind): Tile {
  return {
    id: nextId++,
    kind,
    suit: kind[0] as Tile["suit"],
    rank: Number(kind.slice(1)),
    isRed: false,
  };
}

function context(overrides: Partial<WinContext> = {}): WinContext {
  return {
    seatWind: 2,
    roundWind: 1,
    isTsumo: true,
    isRiichi: false,
    isDoubleRiichi: false,
    isIppatsu: false,
    isHaitei: false,
    isHoutei: false,
    isRinshan: false,
    isChankan: false,
    isTenhou: false,
    isChiihou: false,
    doraCount: 0,
    uraDoraCount: 0,
    akaDoraCount: 0,
    kanCount: 0,
    ...overrides,
  };
}

function fixedChiitoitsu(): { concealed: Tile[]; winTile: Tile } {
  const pairs: TileKind[] = ["m1", "m9", "p1", "p4", "p7", "s2"];
  const concealed = pairs.flatMap((kind) => [tile(kind), tile(kind)]);
  const waiting = tile("s5");
  const winTile = tile("s5");
  return { concealed: [...concealed, waiting, winTile], winTile };
}

describe("FF-02 Chiitoitsu on a Mahjong Soul sanma Kita replacement", () => {
  it("awards Chiitoitsu and Rinshan Kaihou through the production Kita/context path", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "ff02-kita-chiitoitsu");
    wall.dealInitial(DEFAULT_SANMA_RULES.playerCount, 13);
    const replacement = wall.drawKitaReplacement();
    const pairKinds: TileKind[] = ["m1", "m9", "p1", "p4", "p7", "s2", "s5", "s8", "z1", "z2", "z3", "z5", "z6", "z7"];
    const sixPairs = pairKinds.filter((kind) => kind !== replacement.kind).slice(0, 6);

    const hand = new Hand();
    hand.dealIn([
      ...sixPairs.flatMap((kind) => [tile(kind), tile(kind)]),
      tile(replacement.kind),
      tile("z4"),
    ]);
    const north = hand.concealed[hand.concealed.length - 1]!;
    applyKita(hand, north.id);
    hand.addDrawn(replacement);

    const winContext = buildWinContext({
      hand,
      rules: DEFAULT_SANMA_RULES,
      player: 1,
      dealer: 0,
      playerCount: DEFAULT_SANMA_RULES.playerCount,
      roundWind: 1,
      ippatsuEligible: false,
      doraIndicatorKinds: wall.doraIndicators().map((indicator) => indicator.kind),
      uraDoraIndicatorKinds: [],
      isTsumo: true,
      isRinshan: true,
      isHaitei: false,
      isHoutei: false,
      isChankan: false,
      isTenhou: false,
      isChiihou: false,
    });
    const result = evaluateWin({
      concealedTiles: hand.concealed,
      melds: [],
      winTile: replacement,
      context: winContext,
      rules: DEFAULT_SANMA_RULES,
      winner: 1,
      dealer: 0,
    });

    expect(result).not.toBeNull();
    expect(result!.fu).toBe(25);
    expect(result!.yaku).toEqual(expect.arrayContaining([
      { name: "Chiitoitsu", han: 2 },
      { name: "Rinshan Kaihou", han: 1 },
    ]));
  });

  it("does not award Rinshan on an ordinary Chiitoitsu tsumo and keeps 25 fu", () => {
    const hand = fixedChiitoitsu();
    const result = evaluateWin({
      concealedTiles: hand.concealed,
      melds: [],
      winTile: hand.winTile,
      context: context(),
      rules: DEFAULT_SANMA_RULES,
      winner: 1,
      dealer: 0,
    });

    expect(result).not.toBeNull();
    expect(result!.fu).toBe(25);
    expect(result!.yaku.map((hit) => hit.name)).toContain("Chiitoitsu");
    expect(result!.yaku.map((hit) => hit.name)).not.toContain("Rinshan Kaihou");
  });

  it("does not add Chankan to the structurally incompatible Chiitoitsu branch", () => {
    const hand = fixedChiitoitsu();
    const result = evaluateWin({
      concealedTiles: hand.concealed,
      melds: [],
      winTile: hand.winTile,
      context: context({ isTsumo: false, isChankan: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 1,
      dealer: 0,
      ronFrom: 2,
    });

    expect(result).not.toBeNull();
    expect(result!.yaku.map((hit) => hit.name)).toContain("Chiitoitsu");
    expect(result!.yaku.map((hit) => hit.name)).not.toContain("Chankan");
  });

  it("leaves ordinary yonma Chiitoitsu behavior unchanged", () => {
    const hand = fixedChiitoitsu();
    const result = evaluateWin({
      concealedTiles: hand.concealed,
      melds: [],
      winTile: hand.winTile,
      context: context(),
      rules: MAJSOUL_YONMA_RULES,
      winner: 1,
      dealer: 0,
    });

    expect(result).not.toBeNull();
    expect(result!.fu).toBe(25);
    expect(result!.yaku.map((hit) => hit.name)).toContain("Chiitoitsu");
    expect(result!.yaku.map((hit) => hit.name)).not.toContain("Rinshan Kaihou");
  });
});
