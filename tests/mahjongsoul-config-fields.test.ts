import { describe, it, expect } from "vitest";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { GameState } from "../src/core/GameState.js";
import { evaluateWin } from "../src/yaku/evaluate.js";
import type { Tile } from "../src/core/tiles.js";
import type { WinContext } from "../src/yaku/types.js";

let nextId = 80000;
function t(kind: string): Tile {
  const suit = kind[0] as "m" | "p" | "s" | "z";
  const rank = Number(kind.slice(1));
  return { id: nextId++, kind, suit, rank, isRed: false };
}
function tiles(kinds: string[]): Tile[] {
  return kinds.map(t);
}
function baseCtx(overrides: Partial<WinContext> = {}): WinContext {
  return {
    seatWind: 1,
    roundWind: 1,
    isTsumo: false,
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

describe("returnScore + uma feed a real final-standings calculation", () => {
  it("computeFinalStandings ranks players and applies the return-score baseline + uma without touching raw scores", () => {
    const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "standings-test" });
    gs.scores = [40000, 38000, 32000];
    const standings = gs.computeFinalStandings();

    expect(standings.map((s) => s.player)).toEqual([0, 1, 2]); // already in descending score order
    expect(standings[0]!.placement).toBe(1);
    expect(standings[2]!.placement).toBe(3);
    // player 0: (40000 - 35000)/1000 + 15000/1000 = 20
    expect(standings[0]!.points).toBe(20);
    // player 1: (38000 - 35000)/1000 + 0/1000 = 3
    expect(standings[1]!.points).toBe(3);
    // player 2: (32000 - 35000)/1000 + (-15000)/1000 = -18
    expect(standings[2]!.points).toBe(-18);
    // raw scores are untouched - the conservation invariant used elsewhere still holds
    expect(gs.scores).toEqual([40000, 38000, 32000]);
  });

  it("ranks correctly regardless of seat order", () => {
    const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "standings-test-2" });
    gs.scores = [20000, 50000, 30000];
    const standings = gs.computeFinalStandings();
    expect(standings.map((s) => s.player)).toEqual([1, 2, 0]);
    expect(standings[0]!.rawScore).toBe(50000);
  });
});

describe("northIsYakuhai rule toggle", () => {
  const hand = tiles(["z4", "z4", "z4", "p1", "p2", "p3", "s1", "s2", "s3", "p7", "p8", "m1", "m1"]);

  it("a concealed North triplet gives no yakuhai when the flag is off (Mahjong Soul default)", () => {
    const winTile = t("p9");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.some((y) => y.name.startsWith("Yakuhai"))).toBe(false);
  });

  it("a concealed North triplet DOES give yakuhai when the flag is explicitly enabled", () => {
    const winTile = t("p9");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: { ...DEFAULT_SANMA_RULES, northIsYakuhai: true },
      winner: 0,
      dealer: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.some((y) => y.name === "Yakuhai (North)")).toBe(true);
  });
});
