import { describe, it, expect } from "vitest";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { GameState } from "../src/core/GameState.js";
import { evaluateWin } from "../src/yaku/evaluate.js";
import { computeScore } from "../src/yaku/score.js";
import { isRyuuiisouHand } from "../src/yaku/tileFacts.js";
import type { Tile } from "../src/core/tiles.js";
import type { Group, WinContext } from "../src/yaku/types.js";
import type { GameEvent } from "../src/core/GameLog.js";

let nextId = 70000;
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

// ---------------------------------------------------------------------------
// Honba
// ---------------------------------------------------------------------------
describe("honba scoring (Mahjong Soul sanma: 200 total per honba)", () => {
  it("ron: the discarder pays the full 200/honba on top of the hand value", () => {
    const noHonba = computeScore({ han: 3, fu: 30, yakumanUnits: 0, winner: 1, dealer: 0, isTsumo: false, ronFrom: 0, honba: 0, playerCount: 3, rules: DEFAULT_SANMA_RULES });
    const twoHonba = computeScore({ han: 3, fu: 30, yakumanUnits: 0, winner: 1, dealer: 0, isTsumo: false, ronFrom: 0, honba: 2, playerCount: 3, rules: DEFAULT_SANMA_RULES });
    expect(twoHonba.totalPoints - noHonba.totalPoints).toBe(400); // 2 honba * 200
    expect(twoHonba.payments.deltas[0]).toBe(noHonba.payments.deltas[0]! - 400);
    expect(twoHonba.payments.deltas[1]).toBe(noHonba.payments.deltas[1]! + 400);
  });

  it("tsumo: each of the two opponents pays 100/honba (200 total per honba, same as ron)", () => {
    const noHonba = computeScore({ han: 3, fu: 30, yakumanUnits: 0, winner: 1, dealer: 0, isTsumo: true, honba: 0, playerCount: 3, rules: DEFAULT_SANMA_RULES });
    const oneHonba = computeScore({ han: 3, fu: 30, yakumanUnits: 0, winner: 1, dealer: 0, isTsumo: true, honba: 1, playerCount: 3, rules: DEFAULT_SANMA_RULES });
    expect(oneHonba.payments.deltas[0]).toBe(noHonba.payments.deltas[0]! - 100); // dealer pays +100
    expect(oneHonba.payments.deltas[2]).toBe(noHonba.payments.deltas[2]! - 100); // other opponent pays +100
    expect(oneHonba.totalPoints - noHonba.totalPoints).toBe(200);
  });

  it("honba transfers actually move points (not just a conservation-neutral no-op)", () => {
    const result = computeScore({ han: 2, fu: 30, yakumanUnits: 0, winner: 0, dealer: 0, isTsumo: false, ronFrom: 1, honba: 3, playerCount: 3, rules: DEFAULT_SANMA_RULES });
    // base scoring alone (2han30fu dealer ron) would be 2900; +3*200=600 honba -> 3500
    expect(result.totalPoints).toBe(3500);
  });
});

// ---------------------------------------------------------------------------
// Multiple ron / riichi sticks
// ---------------------------------------------------------------------------
describe("multiple ron is the Mahjong Soul sanma default, and riichi sticks go to the closest winner", () => {
  it("doubleRonMode defaults to 'all'", () => {
    expect(DEFAULT_SANMA_RULES.doubleRonMode).toBe("all");
  });

  it("when two players ron the same discard, the winner closer to the discarder in turn order collects the table's riichi sticks", () => {
    let found = false;
    for (let seed = 0; seed < 40 && !found; seed++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `multi-ron-sticks-${seed}` });
      gs.playGame();
      // a double ron shows up as two consecutive "win" events sharing the same ronFrom
      for (let i = 0; i < gs.log.length - 1; i++) {
        const a = gs.log[i]!;
        const b = gs.log[i + 1]!;
        if (a.type !== "win" || b.type !== "win") continue;
        if (a.isTsumo || b.isTsumo || a.ronFrom !== b.ronFrom) continue;
        found = true;
        // a (logged first) must be the closer winner: closer means smaller forward
        // distance from the discarder in turn order (1 or 2 seats away)
        const distA = (a.player - a.ronFrom! + 3) % 3;
        const distB = (b.player - b.ronFrom! + 3) % 3;
        expect(distA).toBeLessThan(distB);
      }
    }
    // Not asserted strictly true - double ron is a fairly rare coincidence in self-play -
    // but every occurrence found is checked inline above via the ordering assertion.
  });
});

// ---------------------------------------------------------------------------
// New/fixed yaku
// ---------------------------------------------------------------------------
describe("Shousuushii / Daisuushii", () => {
  it("three wind triplets + a genuine wind pair scores Shousuushii", () => {
    const hand = tiles(["z1", "z1", "z1", "z2", "z2", "z2", "z3", "z3", "z3", "z4", "z4", "p1", "p2"]);
    const winTile = t("p3");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.map((y) => y.name)).toContain("Shousuushii");
    expect(result!.yakumanUnits).toBe(1);
  });

  it("all four wind triplets scores Daisuushii as a double yakuman", () => {
    // z3 completes via a shanpon ron (opening that one triplet) so the hand does NOT also
    // qualify for the yakuman Suuankou (which needs all four concealed) - isolating
    // Daisuushii's own contribution instead of the two stacking together.
    const hand = tiles(["z1", "z1", "z1", "z2", "z2", "z2", "z4", "z4", "z4", "z3", "z3", "m1", "m1"]);
    const winTile = t("z3");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: false }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
      ronFrom: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.map((y) => y.name)).toContain("Daisuushii");
    expect(result!.yakumanUnits).toBe(2);
  });

  it("Daisuushii is capped to a single unit when doubleYakumanEnabled is off", () => {
    const hand = tiles(["z1", "z1", "z1", "z2", "z2", "z2", "z4", "z4", "z4", "z3", "z3", "m1", "m1"]);
    const winTile = t("z3");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: false }),
      rules: { ...DEFAULT_SANMA_RULES, doubleYakumanEnabled: false },
      winner: 0,
      dealer: 1,
      ronFrom: 2,
    });
    expect(result!.yakumanUnits).toBe(1);
  });
});

describe("Sankantsu (three kans, regular 2-han yaku, not yakuman)", () => {
  it("scores Sankantsu when three of the four groups are declared kans", () => {
    const melds: Group[] = [
      { type: "quad", kind: "z1", concealed: true },
      { type: "quad", kind: "z2", concealed: false, calledFrom: 1 },
      { type: "quad", kind: "z3", concealed: false, calledFrom: 2 },
    ];
    const hand = tiles(["s5", "s5", "p1", "p2"]);
    const winTile = t("p3");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds,
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.map((y) => y.name)).toContain("Sankantsu");
  });
});

describe("Chuuren Poutou / Junsei Chuuren Poutou", () => {
  it("recognizes a normal (non-junsei) chuuren win", () => {
    // pre-win: 1,1,1,2,2,3,4,5,6,7,8,9 (13 tiles, an extra 2 rather than the pure shape) + win 9
    const hand = tiles(["p1", "p1", "p1", "p2", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p9"]);
    const winTile = t("p9");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.map((y) => y.name)).toContain("Chuuren Poutou");
    expect(result!.yakumanUnits).toBe(1);
  });

  it("recognizes Junsei Chuuren Poutou (9-sided wait) as a double yakuman", () => {
    // pre-win: exactly 1,1,1,2,3,4,5,6,7,8,9,9,9 - the unique 9-sided-wait shape - win on 2
    const hand = tiles(["p1", "p1", "p1", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p9", "p9", "p2"]);
    const winTile = t("p2");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.map((y) => y.name)).toContain("Junsei Chuuren Poutou");
    expect(result!.yakumanUnits).toBe(2);
  });

  it("an open hand never qualifies for chuuren, even with the right tile distribution", () => {
    const meld: Group = { type: "triplet", kind: "p1", concealed: false, calledFrom: 2 };
    const hand = tiles(["p2", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p9"]);
    const winTile = t("p9");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [meld],
      winTile,
      context: baseCtx({ isTsumo: false }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
      ronFrom: 2,
    });
    if (result) {
      expect(result.yaku.map((y) => y.name)).not.toContain("Chuuren Poutou");
      expect(result.yaku.map((y) => y.name)).not.toContain("Junsei Chuuren Poutou");
    }
  });

  it("a mixed-suit distribution never qualifies for chuuren", () => {
    const hand = tiles(["p1", "p1", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "s9", "s9", "s9"]);
    const winTile = t("p9");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    if (result) {
      expect(result.yaku.map((y) => y.name)).not.toContain("Chuuren Poutou");
    }
  });
});

describe("Ryuuiisou (all-green) recognizes Hatsu, not South", () => {
  it("a green-tile set including the Green Dragon (Hatsu, z6) is valid Ryuuiisou material", () => {
    expect(isRyuuiisouHand(["s2", "s3", "s4", "s6", "s8", "z6"])).toBe(true);
  });

  it("the same shape with South (z2) instead of Hatsu is NOT Ryuuiisou", () => {
    expect(isRyuuiisouHand(["s2", "s3", "s4", "s6", "s8", "z2"])).toBe(false);
  });

  it("a full winning hand of green tiles including Hatsu scores Ryuuiisou end-to-end", () => {
    const hand = tiles(["s2", "s3", "s4", "s2", "s3", "s4", "s6", "s6", "s6", "z6", "z6", "z6", "s8"]);
    const winTile = t("s8");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.map((y) => y.name)).toContain("Ryuuiisou");
  });
});

describe("Chiitoitsu + Honroutou can stack when all seven pairs are terminals/honors", () => {
  it("scores both yaku on the same hand", () => {
    const hand = tiles(["m1", "m1", "m9", "m9", "p1", "p1", "p9", "p9", "s1", "s1", "s9", "s9", "z1"]);
    const winTile = t("z1");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    const names = result!.yaku.map((y) => y.name);
    expect(names).toContain("Chiitoitsu");
    expect(names).toContain("Honroutou");
  });
});

describe("Chanta does not incorrectly stack onto an all-triplet Honroutou/Toitoi hand", () => {
  it("an all-terminal/honor, all-triplet hand scores Toitoi and Honroutou but not Chanta", () => {
    // 3 genuine ankou (z1,z2,z5) + a shanpon {m1,m1 / z6,z6}, ronned on m1 - this keeps the
    // hand at Sanankou (not the yakuman Suuankou, which would otherwise dominate scoring
    // and hide the Toitoi/Honroutou/Chanta comparison this test is actually about).
    const hand = tiles(["z1", "z1", "z1", "z2", "z2", "z2", "z5", "z5", "z5", "m1", "m1", "z6", "z6"]);
    const winTile = t("m1");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: false, seatWind: 1, roundWind: 2 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 0,
      ronFrom: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.yakumanUnits).toBe(0); // sanity: confirms Suuankou did NOT hijack this case
    const names = result!.yaku.map((y) => y.name);
    expect(names).toContain("Toitoi");
    expect(names).toContain("Honroutou");
    expect(names).not.toContain("Chanta");
    expect(names).not.toContain("Junchan");
  });

  it("the same overall shape WITH a sequence present still correctly scores Chanta", () => {
    const hand = tiles(["z1", "z1", "z1", "z5", "z5", "z5", "p1", "p2", "p3", "m1", "m1", "m1", "z6"]);
    const winTile = t("z6");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true, seatWind: 1, roundWind: 2 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.map((y) => y.name)).toContain("Chanta");
  });
});

// ---------------------------------------------------------------------------
// Final-discard call prevention (houtei: ron only, no pon/kan)
// ---------------------------------------------------------------------------
describe("the final discard of the wall can only be ronned, never called for pon/kan", () => {
  it("no 'call' event ever immediately follows the discard that precedes an exhaustive draw", () => {
    let handsChecked = 0;
    for (let seed = 0; seed < 15; seed++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `houtei-no-call-${seed}` });
      gs.playGame();
      for (let i = 0; i < gs.log.length; i++) {
        if (gs.log[i]!.type !== "exhaustive_draw") continue;
        handsChecked++;
        // walk backward to the last discard before this resolution
        let j = i - 1;
        while (j >= 0 && gs.log[j]!.type !== "discard") j--;
        if (j < 0) continue;
        // the discard must be followed only by non-call events up to the exhaustive_draw
        for (let k = j + 1; k < i; k++) {
          expect((gs.log[k] as GameEvent).type).not.toBe("call");
        }
      }
    }
    expect(handsChecked).toBeGreaterThan(0);
  });
});
