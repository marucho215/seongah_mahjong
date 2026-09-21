import { describe, expect, it } from "vitest";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";
import { MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";
import { evaluateInitialDealerWin, evaluateWin } from "../src/yaku/evaluate.js";
import type { WinContext } from "../src/yaku/types.js";

let nextId = 130000;
function tile(kind: TileKind): Tile {
  const parsed = parseKind(kind);
  return { id: nextId++, kind, suit: parsed.suit, rank: parsed.rank, isRed: false };
}

function tiles(kinds: TileKind[]): Tile[] {
  return kinds.map(tile);
}

function context(overrides: Partial<WinContext> = {}): WinContext {
  return {
    seatWind: 1,
    roundWind: 1,
    isTsumo: true,
    isRiichi: false,
    isDoubleRiichi: false,
    isIppatsu: false,
    isHaitei: false,
    isHoutei: false,
    isRinshan: false,
    isChankan: false,
    isTenhou: true,
    isChiihou: false,
    doraCount: 0,
    uraDoraCount: 0,
    akaDoraCount: 0,
    kanCount: 0,
    ...overrides,
  };
}

const KOKUSHI_KINDS: TileKind[] = [
  "m1", "m9", "p1", "p9", "s1", "s9",
  "z1", "z2", "z3", "z4", "z5", "z6", "z7",
];

function initialWin(concealedTiles: Tile[], doubleYakumanEnabled = true) {
  return evaluateInitialDealerWin({
    concealedTiles,
    melds: [],
    context: context(),
    rules: { ...MAJSOUL_YONMA_RULES, doubleYakumanEnabled },
    winner: 0,
    dealer: 0,
    honba: 0,
  });
}

describe("FF-13 Mahjong Soul initial dealer hand interpretation", () => {
  it("selects Kokushi Musou 13-wait and stacks it with Tenhou", () => {
    const result = initialWin(tiles([...KOKUSHI_KINDS, "m1"]));

    expect(result).not.toBeNull();
    expect(result!.yaku).toEqual(expect.arrayContaining([
      { name: "Kokushi Musou (13-wait)", han: 26 },
      { name: "Tenhou", han: 13 },
    ]));
    expect(result!.yakumanUnits).toBe(3);
    expect(result!.score.totalPoints).toBe(144000);
  });

  it("follows the existing double-yakuman configuration", () => {
    const result = initialWin(tiles([...KOKUSHI_KINDS, "m1"]), false);

    expect(result).not.toBeNull();
    expect(result!.yaku).toEqual(expect.arrayContaining([
      { name: "Kokushi Musou (13-wait)", han: 13 },
      { name: "Tenhou", han: 13 },
    ]));
    expect(result!.yakumanUnits).toBe(2);
    expect(result!.score.totalPoints).toBe(96000);
  });

  it("does not reinterpret a known ordinary winning tile", () => {
    const concealedTiles = tiles([...KOKUSHI_KINDS, "m1"]);
    const actualWinningTile = concealedTiles.find((candidate) => candidate.kind === "z7")!;
    const result = evaluateWin({
      concealedTiles,
      melds: [],
      winTile: actualWinningTile,
      context: context({ isTenhou: false }),
      rules: MAJSOUL_YONMA_RULES,
      winner: 0,
      dealer: 0,
      honba: 0,
    });

    expect(result).not.toBeNull();
    expect(result!.yaku.map((hit) => hit.name)).toEqual(["Kokushi Musou"]);
    expect(result!.yakumanUnits).toBe(1);
  });

  it("preserves an ordinary non-wait-sensitive Tenhou", () => {
    const concealedTiles = tiles([
      "m1", "m2", "m3", "p1", "p2", "p3", "s1", "s2", "s3",
      "s7", "s8", "s9", "z1", "z1",
    ]);
    const result = initialWin(concealedTiles);

    expect(result).not.toBeNull();
    expect(result!.yaku).toEqual([{ name: "Tenhou", han: 13 }]);
    expect(result!.yakumanUnits).toBe(1);
    expect(result!.score.totalPoints).toBe(48000);
  });

  it("also selects the strongest Junsei Chuuren interpretation without a special case", () => {
    const concealedTiles = tiles([
      "m1", "m1", "m1", "m2", "m3", "m4", "m5", "m5",
      "m6", "m7", "m8", "m9", "m9", "m9",
    ]);
    const result = initialWin(concealedTiles);

    expect(result).not.toBeNull();
    expect(result!.yaku).toEqual(expect.arrayContaining([
      { name: "Junsei Chuuren Poutou", han: 26 },
      { name: "Tenhou", han: 13 },
    ]));
    expect(result!.yakumanUnits).toBe(3);
  });
});
