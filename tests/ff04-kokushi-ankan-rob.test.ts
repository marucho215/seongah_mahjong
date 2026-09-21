import { describe, expect, it } from "vitest";
import { FuritenTracker } from "../src/actions/furiten.js";
import { isKokushiAnkanRon } from "../src/actions/kokushiAnkan.js";
import { resolveRonBeforeInterruption } from "../src/core/GameState.js";
import type { Tile, TileKind } from "../src/core/tiles.js";
import { MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";
import { evaluateWin } from "../src/yaku/evaluate.js";
import type { WinContext } from "../src/yaku/types.js";

let nextId = 90000;
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
    isTsumo: false,
    isRiichi: false,
    isDoubleRiichi: false,
    isIppatsu: false,
    isHaitei: false,
    isHoutei: false,
    isRinshan: false,
    isChankan: true,
    isTenhou: false,
    isChiihou: false,
    doraCount: 0,
    uraDoraCount: 0,
    akaDoraCount: 0,
    kanCount: 0,
    ...overrides,
  };
}

function ron(kinds: TileKind[], winKind: TileKind) {
  const winTile = tile(winKind);
  return evaluateWin({
    concealedTiles: [...kinds.map(tile), winTile],
    melds: [],
    winTile,
    context: context(),
    rules: MAJSOUL_YONMA_RULES,
    winner: 1,
    dealer: 0,
    ronFrom: 0,
  });
}

describe("FF-04 Mahjong Soul Kokushi concealed-kan rob", () => {
  it("accepts only a Kokushi result in the concealed-kan ron window", () => {
    const kokushi = ron(
      ["m1", "m9", "p1", "p9", "s1", "s9", "z1", "z1", "z2", "z3", "z4", "z5", "z6"],
      "z7"
    );
    const ordinary = ron(
      ["m1", "m2", "m3", "p1", "p2", "p3", "s1", "s2", "s3", "s7", "s8", "s9", "z1"],
      "z1"
    );
    const chuuren = ron(
      ["m1", "m1", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m9", "m9"],
      "m5"
    );

    expect(isKokushiAnkanRon(kokushi)).toBe(true);
    expect(kokushi!.yaku.map((hit) => hit.name)).toEqual(["Kokushi Musou"]);
    expect(kokushi!.yakumanUnits).toBe(1);
    expect(isKokushiAnkanRon(ordinary)).toBe(false);
    expect(chuuren!.yaku.map((hit) => hit.name)).toContain("Junsei Chuuren Poutou");
    expect(isKokushiAnkanRon(chuuren)).toBe(false);
  });

  it("keeps normal furiten rules applicable to the Kokushi wait", () => {
    const furiten = new FuritenTracker();
    expect(furiten.isFuriten(["z7"], ["z7"])).toBe(true);
    expect(furiten.isFuriten(["z7"], ["m1"])).toBe(false);
    furiten.onMissedRonChance();
    expect(furiten.isFuriten(["z7"], [])).toBe(true);
  });

  it("does not commit kan-side mutations when Kokushi robs the declaration", () => {
    const state = { kanMelds: 0, rinshanDraws: 0, kanCount: 0, ippatsu: true };
    const winners = resolveRonBeforeInterruption(
      () => ["kokushi"],
      () => {
        state.kanMelds++;
        state.rinshanDraws++;
        state.kanCount++;
        state.ippatsu = false;
      }
    );

    expect(winners).toEqual(["kokushi"]);
    expect(state).toEqual({ kanMelds: 0, rinshanDraws: 0, kanCount: 0, ippatsu: true });
  });

  it("continues the existing kan path and cancels ippatsu when nobody can rob it", () => {
    const state = { interruptions: 0, ippatsu: true };
    const winners = resolveRonBeforeInterruption(
      () => [],
      () => {
        state.interruptions++;
        state.ippatsu = false;
      }
    );

    expect(winners).toEqual([]);
    expect(state).toEqual({ interruptions: 1, ippatsu: false });
  });
});
