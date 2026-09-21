import { describe, expect, it } from "vitest";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";
import { MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";
import { evaluateWin } from "../src/yaku/evaluate.js";
import type { WinContext } from "../src/yaku/types.js";

let nextId = 150000;
function tile(kind: TileKind): Tile {
  const parsed = parseKind(kind);
  return { id: nextId++, kind, suit: parsed.suit, rank: parsed.rank, isRed: false };
}

const KOKUSHI: TileKind[] = [
  "m1", "m9", "p1", "p9", "s1", "s9",
  "z1", "z2", "z3", "z4", "z5", "z6", "z7",
];

function chiihouContext(): WinContext {
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
    isChiihou: true,
    doraCount: 0,
    uraDoraCount: 0,
    akaDoraCount: 0,
    kanCount: 0,
  };
}

function score(doubleYakumanEnabled: boolean, winningKind: TileKind = "m1") {
  const concealedTiles = [...KOKUSHI, winningKind].map(tile);
  const winTile = concealedTiles.at(-1)!;
  return evaluateWin({
    concealedTiles,
    melds: [],
    winTile,
    context: chiihouContext(),
    rules: { ...MAJSOUL_YONMA_RULES, doubleYakumanEnabled },
    winner: 1,
    dealer: 0,
    honba: 0,
  });
}

describe("FF-15 Kokushi Musou + Chiihou", () => {
  it("stacks Chiihou with Kokushi Musou 13-sided wait", () => {
    const result = score(true);

    expect(result).not.toBeNull();
    expect(result!.yaku).toEqual(expect.arrayContaining([
      { name: "Kokushi Musou (13-wait)", han: 26 },
      { name: "Chiihou", han: 13 },
    ]));
    expect(result!.yakumanUnits).toBe(3);
    expect(result!.score.totalPoints).toBe(96000);
  });

  it("follows the existing double-yakuman configuration", () => {
    const result = score(false);

    expect(result).not.toBeNull();
    expect(result!.yaku).toEqual(expect.arrayContaining([
      { name: "Kokushi Musou (13-wait)", han: 13 },
      { name: "Chiihou", han: 13 },
    ]));
    expect(result!.yakumanUnits).toBe(2);
    expect(result!.score.totalPoints).toBe(64000);
  });

  it("does not add Tenhou to a non-dealer Chiihou result", () => {
    const result = score(true, "z7");

    expect(result).not.toBeNull();
    expect(result!.yaku.map((hit) => hit.name)).toEqual([
      "Kokushi Musou (13-wait)",
      "Chiihou",
    ]);
    expect(result!.yaku.some((hit) => hit.name === "Tenhou")).toBe(false);
  });
});
