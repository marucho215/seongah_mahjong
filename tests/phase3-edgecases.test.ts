import { describe, it, expect } from "vitest";
import { evaluateWin } from "../src/yaku/evaluate.js";
import { computeScore } from "../src/yaku/score.js";
import { pairFu } from "../src/yaku/fu.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import type { Tile } from "../src/core/tiles.js";
import type { WinContext, Group } from "../src/yaku/types.js";

let nextId = 9000;
function t(kind: string, isRed = false): Tile {
  const suit = kind[0] as "m" | "p" | "s" | "z";
  const rank = Number(kind.slice(1));
  return { id: nextId++, kind, suit, rank, isRed };
}
function tiles(kinds: string[]): Tile[] {
  return kinds.map((k) => t(k));
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
// 3. Ron-completed triplet concealment
// ---------------------------------------------------------------------------
describe("ron-completed triplet concealment", () => {
  // p2p3p4 + p6p7p8 + s2s3s4 (3 sequences, all simples) + shanpon on {p5,p5} / {s5,s5,s5}
  const shanponBase = ["p2", "p3", "p4", "p6", "p7", "p8", "s2", "s3", "s4", "p5", "p5", "s5", "s5"];

  it("scores the shanpon-completed triplet as open (minko) fu for a ron win", () => {
    const winTile = t("s5");
    const result = evaluateWin({
      concealedTiles: [...tiles(shanponBase), winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: false }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
      ronFrom: 1,
    });
    expect(result).not.toBeNull();
    // 20 base + 2 (open simple triplet) + 0 (non-yakuhai pair) + 0 (shanpon) + 10 (menzen ron) = 32 -> 40
    expect(result!.fu).toBe(40);
    expect(result!.waitType).toBe("shanpon");
    const winGroup = result!.groups.find((g) => g.kind === "s5")!;
    expect(winGroup.type).toBe("triplet");
    expect(winGroup.concealed).toBe(false);
  });

  it("scores the same shanpon completion as closed (ankou) fu for a tsumo win", () => {
    const winTile = t("s5");
    const result = evaluateWin({
      concealedTiles: [...tiles(shanponBase), winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    // 20 base + 4 (closed simple triplet) + 0 (pair) + 0 (shanpon) + 2 (tsumo) = 26 -> 30
    expect(result!.fu).toBe(30);
    const winGroup = result!.groups.find((g) => g.kind === "s5")!;
    expect(winGroup.concealed).toBe(true);
  });

  it("still counts sanankou when the winning tile completes a tanki pair, not a triplet", () => {
    // three genuine ankou (z1 z5 z6) + a sequence + a tanki wait on s5 - the win never
    // touches any of the three triplets, so all three stay concealed even via ron.
    const hand = tiles(["z1", "z1", "z1", "z5", "z5", "z5", "z6", "z6", "z6", "p2", "p3", "p4", "s5"]);
    const winTile = t("s5");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: false }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
      ronFrom: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.map((y) => y.name)).toContain("Sanankou");
  });

  it("suuankou requires all four triplets concealed - a shanpon ron on the 4th disqualifies it", () => {
    // z1z1z1, z5z5z5, z6z6z6 genuine ankou + shanpon {z2z2 / s5s5}; ron on z2 opens that triplet.
    const hand = tiles(["z1", "z1", "z1", "z5", "z5", "z5", "z6", "z6", "z6", "z2", "z2", "s5", "s5"]);
    const winTile = t("z2");
    const ronResult = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: false, seatWind: 1, roundWind: 1 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 0,
      ronFrom: 1,
    });
    expect(ronResult).not.toBeNull();
    expect(ronResult!.yakumanUnits).toBe(0);
    expect(ronResult!.yaku.map((y) => y.name)).toContain("Sanankou");
    expect(ronResult!.yaku.map((y) => y.name)).not.toContain("Suuankou");

    const tsumoResult = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true, seatWind: 1, roundWind: 1 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 0,
    });
    expect(tsumoResult).not.toBeNull();
    expect(tsumoResult!.yakumanUnits).toBe(1);
    expect(tsumoResult!.yaku.map((y) => y.name)).toContain("Suuankou");
  });
});

// ---------------------------------------------------------------------------
// 6. Scoring edge cases
// ---------------------------------------------------------------------------
// Shared shape for the wait-fu tests: m1m1m1 (ankou, terminal, closed = 8fu) + two complete
// simple sequences in s + a terminal pair (m9m9, 0 extra fu) + the tested 2-tile wait in p.
// Every case below is a closed-hand ron, so fu = 20 + 8 + 0 + 0 + waitFu + 10 (menzen ron).
function waitFuHand(waitTiles: string[]): string[] {
  return ["m1", "m1", "m1", "s1", "s2", "s3", "s4", "s5", "s6", "m9", "m9", ...waitTiles];
}

describe("fu edge cases: waits", () => {
  it("kanchan wait adds +2 fu (40 total)", () => {
    const hand = tiles(waitFuHand(["p4", "p6"]));
    const winTile = t("p5");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: false, isRiichi: true, seatWind: 2, roundWind: 3 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
      ronFrom: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.waitType).toBe("kanchan");
    expect(result!.fu).toBe(40);
  });

  it("penchan wait (1,2->3) adds +2 fu (40 total)", () => {
    const hand = tiles(waitFuHand(["p1", "p2"]));
    const winTile = t("p3");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: false, isRiichi: true, seatWind: 2, roundWind: 3 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
      ronFrom: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.waitType).toBe("penchan");
    expect(result!.fu).toBe(40);
  });

  it("penchan wait (8,9->7) adds +2 fu (40 total)", () => {
    const hand = tiles(waitFuHand(["p8", "p9"]));
    const winTile = t("p7");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: false, isRiichi: true, seatWind: 2, roundWind: 3 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
      ronFrom: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.waitType).toBe("penchan");
    expect(result!.fu).toBe(40);
  });

  it("tanki wait adds +2 fu (40 total)", () => {
    // 4 complete melds (m1 ankou + 3 simple sequences) + a single floating tile
    const hand = tiles(["m1", "m1", "m1", "s1", "s2", "s3", "s4", "s5", "s6", "p1", "p2", "p3", "p9"]);
    const winTile = t("p9");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: false, isRiichi: true, seatWind: 2, roundWind: 3 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
      ronFrom: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.waitType).toBe("tanki");
    expect(result!.fu).toBe(40);
  });
});

describe("fu edge cases: pair value", () => {
  const pairFuHand = ["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s1", "s2", "s3"];

  it("dragon pair adds +2 fu regardless of seat/round wind", () => {
    const hand = tiles([...pairFuHand, "z5"]);
    const winTile = t("z5");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true, seatWind: 2, roundWind: 3 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    // 20 + 8(m1 ankou terminal) + 2(tanki) + 2(tsumo) + 2(dragon pair) = 34 -> 40
    expect(result).not.toBeNull();
    expect(result!.fu).toBe(40);
  });

  it("seat-wind pair adds +2 fu when it doesn't also match round wind", () => {
    const hand = tiles([...pairFuHand, "z2"]);
    const winTile = t("z2");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      winTile,
      melds: [],
      context: baseCtx({ isTsumo: true, seatWind: 2, roundWind: 1 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.fu).toBe(40); // same total as the dragon case: 34 -> 40
  });

  it("round-wind pair adds +2 fu when it doesn't also match seat wind", () => {
    const hand = tiles([...pairFuHand, "z1"]);
    const winTile = t("z1");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      winTile,
      melds: [],
      context: baseCtx({ isTsumo: true, seatWind: 2, roundWind: 1 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.fu).toBe(40);
  });

  // The double-vs-single wind fu delta (4 vs 2) is exact-tested directly against pairFu()
  // below; at the whole-hand level here it can get swallowed by fu round-up-to-10, so it's
  // not asserted as a ">" comparison on evaluateWin's output.
});

describe("doubleWindFuStacks RuleConfig (unit level, exact fu contribution)", () => {
  it("stacks to 4 fu for a double-wind pair when enabled (default)", () => {
    expect(pairFu("z1", 1, 1, true)).toBe(4);
  });
  it("caps at 2 fu for a double-wind pair when disabled", () => {
    expect(pairFu("z1", 1, 1, false)).toBe(2);
  });
  it("single-wind pairs are unaffected by the toggle either way", () => {
    expect(pairFu("z1", 1, 2, true)).toBe(2);
    expect(pairFu("z1", 1, 2, false)).toBe(2);
  });
});

describe("no-yaku hands never win, dora or not", () => {
  it("rejects a complete hand with high dora count but zero yaku", () => {
    const meld: Group = { type: "triplet", kind: "p5", concealed: false, calledFrom: 2 };
    const hand = tiles(["p1", "p2", "p3", "s4", "s5", "s6", "s7", "s8", "z1", "z1"]);
    const winTile = t("s9");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [meld],
      winTile,
      context: baseCtx({ isTsumo: false, doraCount: 6 }), // absurdly high dora, still no yaku
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
      ronFrom: 2,
    });
    expect(result).toBeNull();
  });
});

describe("dora sources", () => {
  it("adds red-five (aka) dora han directly from context", () => {
    const hand = tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "s9", "z1", "z1"]);
    const winTile = hand.pop()!;
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true, akaDoraCount: 1 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.some((y) => y.name === "Dora" && y.han === 1)).toBe(true);
  });

  it("adds ura dora han only in a riichi context", () => {
    const hand = tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "s9", "z1", "z1"]);
    const winTile = hand.pop()!;
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true, isRiichi: true, uraDoraCount: 2 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    const dora = result!.yaku.find((y) => y.name === "Dora");
    expect(dora?.han).toBe(2);
  });
});

describe("kazoe yakuman policy", () => {
  it("caps at sanbaiman when kazoeYakumanEnabled is false, even at 13+ han", () => {
    // riichi + menzen tsumo + dora stacked to reach 13+ han without a real yakuman shape
    const hand = tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "s9", "z1", "z1"]);
    const winTile = hand.pop()!;
    // yaku: riichi(1) + menzen tsumo(1) = 2 han; dora(11) pushes the total to 13
    const ctx = baseCtx({ isTsumo: true, isRiichi: true, doraCount: 11 });
    const enabled = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: ctx,
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 0,
    });
    const disabled = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: ctx,
      rules: { ...DEFAULT_SANMA_RULES, kazoeYakumanEnabled: false },
      winner: 0,
      dealer: 0,
    });
    expect(enabled).not.toBeNull();
    expect(disabled).not.toBeNull();
    expect(enabled!.han).toBeGreaterThanOrEqual(13);
    expect(enabled!.score.totalPoints).toBeGreaterThan(disabled!.score.totalPoints);
  });
});

describe("multiple yakuman stack", () => {
  it("sums units when two distinct yakuman conditions both apply", () => {
    // suuankou (4 concealed triplets + pair) that also happens to be tsuuiisou (all honors)
    const hand = tiles(["z1", "z1", "z1", "z2", "z2", "z2", "z5", "z5", "z5", "z6", "z6", "z6", "z7"]);
    const winTile = t("z7");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true, seatWind: 2, roundWind: 1 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.yakumanUnits).toBeGreaterThanOrEqual(2);
    const names = result!.yaku.map((y) => y.name);
    expect(names).toContain("Suuankou Tanki");
    expect(names).toContain("Tsuuiisou");
  });
});

describe("optional double-yakuman variant", () => {
  it("caps every yakuman hit at a single unit when doubleYakumanEnabled is false", () => {
    const hand = tiles(["m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "z3", "z4", "z5", "z6", "z7"]);
    const winTile = t("m1"); // 13-wait kokushi (double, by default)
    const enabled = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    const disabled = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: { ...DEFAULT_SANMA_RULES, doubleYakumanEnabled: false },
      winner: 0,
      dealer: 1,
    });
    expect(enabled!.yakumanUnits).toBe(2);
    expect(disabled!.yakumanUnits).toBe(1);
    expect(enabled!.score.totalPoints).toBeGreaterThan(disabled!.score.totalPoints);
  });
});

describe("standard mangan-and-up score table (unit)", () => {
  it("matches known point totals", () => {
    const mk = (han: number, fu: number, yakumanUnits = 0) =>
      computeScore({ han, fu, yakumanUnits, winner: 1, dealer: 0, isTsumo: false, ronFrom: 0, playerCount: 3, rules: DEFAULT_SANMA_RULES });
    expect(mk(5, 30).totalPoints).toBe(8000);
    expect(mk(13, 30, 1).totalPoints).toBe(32000);
  });
});
