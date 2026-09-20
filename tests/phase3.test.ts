import { describe, it, expect } from "vitest";
import { evaluateWin } from "../src/yaku/evaluate.js";
import { computeScore } from "../src/yaku/score.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import type { Tile } from "../src/core/tiles.js";
import type { WinContext, Group } from "../src/yaku/types.js";

let nextId = 0;
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

describe("pinfu + ryanmen ron", () => {
  it("scores pinfu ron as 30fu 1han (+riichi)", () => {
    // p1p2p3 p4p5p6 s4s5s6 s7s8 z-none pair(m1) ; wait on s6/s9 via s7s8 ryanmen, winning s9
    const hand = tiles(["p1", "p2", "p3", "p4", "p5", "p6", "s4", "s5", "s6", "s7", "s8", "m1", "m1"]);
    const winTile = t("s9");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isRiichi: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 1,
      dealer: 0,
      ronFrom: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.fu).toBe(30);
    const names = result!.yaku.map((y) => y.name);
    expect(names).toContain("Pinfu");
    expect(names).toContain("Riichi");
    expect(result!.han).toBe(2);
  });
});

describe("tanyao + menzen tsumo", () => {
  it("detects tanyao and menzen tsumo together", () => {
    const hand = tiles(["p2", "p3", "p4", "p5", "p6", "p7", "s3", "s4", "s5", "s6", "s7", "s8", "p2"]);
    const winTile = t("p2");
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
    const names = result!.yaku.map((y) => y.name);
    expect(names).toContain("Tanyao");
    expect(names).toContain("Menzen Tsumo");
  });
});

describe("yakuhai", () => {
  it("scores a dragon triplet as yakuhai", () => {
    const hand = tiles(["z5", "z5", "z5", "p2", "p3", "p4", "p5", "p6", "p7", "s2", "s3", "s4", "m1"]);
    const winTile = t("m1");
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
    expect(result!.yaku.map((y) => y.name)).toContain("Yakuhai (z5)");
  });
});

describe("no-yaku hand rejected", () => {
  it("returns null when a complete hand has no yaku at all", () => {
    // open hand (pon of a non-yakuhai simple), no other yaku qualifies, no riichi, no tsumo-menzen
    const meld: Group = { type: "triplet", kind: "p5", concealed: false, calledFrom: 2 };
    const hand = tiles(["p1", "p2", "p3", "s4", "s5", "s6", "s7", "s8", "z1", "z1"]);
    const winTile = t("s9");
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
    expect(result).toBeNull();
  });
});

describe("chiitoitsu", () => {
  it("scores seven pairs at 25fu 2han", () => {
    const hand = tiles(["m1", "m1", "m9", "m9", "p1", "p1", "p9", "p9", "s1", "s1", "s9", "s9", "z1"]);
    const winTile = t("z1");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx(),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
      ronFrom: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.fu).toBe(25);
    expect(result!.yaku.map((y) => y.name)).toContain("Chiitoitsu");
  });
});

describe("kokushi musou", () => {
  it("scores standard (single-wait) kokushi as a yakuman", () => {
    // 12 distinct kinds + a pair (z1z1) = 13 tiles, missing z7 entirely -> narrow wait on z7
    const hand = tiles(["m1", "m9", "p1", "p9", "s1", "s9", "z1", "z1", "z2", "z3", "z4", "z5", "z6"]);
    const winTile = t("z7");
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
    expect(result!.yakumanUnits).toBe(1);
    expect(result!.yaku.map((y) => y.name)).toContain("Kokushi Musou");
  });

  it("scores 13-wait kokushi as a double yakuman", () => {
    const hand = tiles(["m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "z3", "z4", "z5", "z6", "z7"]);
    // pre-win already holds one of every kind incl m1; winning m1 again -> 13-wait
    const winTile = t("m1");
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
    expect(result!.yakumanUnits).toBe(2);
  });
});

describe("scoring table", () => {
  it("matches standard mangan/haneman/baiman/yakuman payments", () => {
    const mkScore = (han: number, fu: number, yakumanUnits = 0) =>
      computeScore({
        han,
        fu,
        yakumanUnits,
        winner: 1,
        dealer: 0,
        isTsumo: false,
        ronFrom: 0,
        playerCount: 3,
        rules: DEFAULT_SANMA_RULES,
      });

    expect(mkScore(5, 30).totalPoints).toBe(8000); // mangan, non-dealer ron
    expect(mkScore(6, 30).totalPoints).toBe(12000); // haneman
    expect(mkScore(8, 30).totalPoints).toBe(16000); // baiman
    expect(mkScore(11, 30).totalPoints).toBe(24000); // sanbaiman
    expect(mkScore(13, 30, 1).totalPoints).toBe(32000); // yakuman
  });

  it("scores dealer ron higher than non-dealer ron for the same hand", () => {
    const nonDealer = computeScore({
      han: 3,
      fu: 30,
      yakumanUnits: 0,
      winner: 1,
      dealer: 0,
      isTsumo: false,
      ronFrom: 2,
      playerCount: 3,
      rules: DEFAULT_SANMA_RULES,
    });
    const dealer = computeScore({
      han: 3,
      fu: 30,
      yakumanUnits: 0,
      winner: 0,
      dealer: 0,
      isTsumo: false,
      ronFrom: 2,
      playerCount: 3,
      rules: DEFAULT_SANMA_RULES,
    });
    expect(dealer.totalPoints).toBeGreaterThan(nonDealer.totalPoints);
  });

  it("applies tsumo loss (dealer pays double, other non-dealer pays single) by default", () => {
    const result = computeScore({
      han: 3,
      fu: 30,
      yakumanUnits: 0,
      winner: 1,
      dealer: 0,
      isTsumo: true,
      playerCount: 3,
      rules: DEFAULT_SANMA_RULES,
    });
    // base = 30 * 2^(2+3) = 960 -> dealer pays ceil(960*2/100)*100=2000, other pays ceil(960/100)*100=1000
    expect(result.payments.deltas[0]).toBe(-2000);
    expect(result.payments.deltas[2]).toBe(-1000);
    expect(result.payments.deltas[1]).toBe(3000);
  });

  it("splits tsumo payments evenly when tsumoSplitEven is enabled", () => {
    const rules = { ...DEFAULT_SANMA_RULES, tsumoSplitEven: true };
    const result = computeScore({
      han: 3,
      fu: 30,
      yakumanUnits: 0,
      winner: 1,
      dealer: 0,
      isTsumo: true,
      playerCount: 3,
      rules,
    });
    expect(result.payments.deltas[0]).toBe(result.payments.deltas[2]);
  });
});
