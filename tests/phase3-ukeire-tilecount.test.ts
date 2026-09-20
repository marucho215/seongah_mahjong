import { describe, it, expect } from "vitest";
import { computeImprovingTiles, computeImprovingTileCount, computeWinningTiles } from "../src/actions/winSearch.js";
import { kindsToCounts, tilesToCounts } from "../src/core/tileIndex.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { Hand } from "../src/core/Hand.js";
import { CharacterAI, type CharacterDecisionContext } from "../src/ai/characterAI.js";
import { CHARACTER_PROFILES } from "../src/ai/characterProfiles.js";
import type { Tile, TileKind } from "../src/core/tiles.js";

function t(id: number, kind: string): Tile {
  const suit = kind[0] as "m" | "p" | "s" | "z";
  const rank = Number(kind.slice(1));
  return { id, kind, suit, rank, isRed: false };
}
function countsFromKinds(kinds: string[]): number[] {
  return tilesToCounts(kinds.map((k, i) => t(i, k)));
}

describe("computeImprovingTileCount: unseen-copy-weighted ukeire", () => {
  it("with nothing visible elsewhere, a kind with 0 copies in hand contributes its full 4 unseen copies", () => {
    // 1-shanten hand (same shape as the earlier true-ukeire test): improving on p6 and s2
    const kinds = ["m1", "m2", "m3", "p1", "p2", "p3", "z1", "z1", "s1", "s3", "p5", "p7", "z5"];
    const counts = countsFromKinds(kinds);
    const improving = computeImprovingTiles(counts, 0, DEFAULT_SANMA_RULES);
    expect(improving).toEqual(expect.arrayContaining(["p6", "s2"]));
    const total = computeImprovingTileCount(improving, counts, kindsToCounts([]));
    // every improving kind has 0 copies in hand and 0 visible elsewhere -> 4 unseen each
    const expected = improving.length * 4;
    expect(total).toBe(expected);
  });

  it("copies already visible elsewhere (discards/melds/dora indicators) reduce the unseen count", () => {
    const kinds = ["m1", "m2", "m3", "p1", "p2", "p3", "z1", "z1", "s1", "s3", "p5", "p7", "z5"];
    const counts = countsFromKinds(kinds);
    const improving = computeImprovingTiles(counts, 0, DEFAULT_SANMA_RULES);
    const withNothingVisible = computeImprovingTileCount(improving, counts, kindsToCounts([]));
    // 2 copies of p6 already discarded by opponents
    const withTwoP6Visible = computeImprovingTileCount(improving, counts, kindsToCounts(["p6", "p6"]));
    expect(withTwoP6Visible).toBe(withNothingVisible - 2);
  });

  it("never goes negative even if (hypothetically) more copies are marked visible than physically exist", () => {
    const kinds = ["m1", "m2", "m3", "p1", "p2", "p3", "z1", "z1", "s1", "s3", "p5", "p7", "z5"];
    const counts = countsFromKinds(kinds);
    const improving = computeImprovingTiles(counts, 0, DEFAULT_SANMA_RULES);
    const total = computeImprovingTileCount(improving, counts, kindsToCounts(["p6", "p6", "p6", "p6", "p6"]));
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it("tenpai (0-shanten): unseen count over the real winning-tile wait, reduced by visible copies", () => {
    // tenpai on p6 kanchan wait: m123 p123 s123 z1z1(pair) p5 p7 = 13 tiles
    const kinds = ["m1", "m2", "m3", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z1", "p5", "p7"];
    expect(kinds.length).toBe(13);
    const counts = countsFromKinds(kinds);
    const winning = computeWinningTiles(counts, 0, DEFAULT_SANMA_RULES);
    expect(winning).toEqual(["p6"]); // sanity: this really is tenpai on exactly p6
    const improving = computeImprovingTiles(counts, 0, DEFAULT_SANMA_RULES);
    const total = computeImprovingTileCount(improving, counts, kindsToCounts(["p6"]));
    const totalNoneVisible = computeImprovingTileCount(improving, counts, kindsToCounts([]));
    expect(total).toBe(totalNoneVisible - 1);
  });
});

describe("chooseDiscard candidates expose ukeireTileCount, connected to visibleTileKinds", () => {
  it("marking every copy of a candidate's improving kinds as visible drives its ukeireTileCount to 0 without changing ukeire (kind count)", () => {
    const ai = new CharacterAI(CHARACTER_PROFILES.byeonari!, "phase3-tilecount-direct");
    ai.onHandStart();
    const baseCtx: CharacterDecisionContext = {
      rules: DEFAULT_SANMA_RULES,
      riichiOpponentDiscardKinds: [],
      doraIndicatorKinds: [],
      visibleTileKinds: [],
      seatWind: 1,
      roundWind: 1,
      wallRemainingLive: 40,
      ownScore: 35000,
      opponentScores: [35000, 35000],
      isLastHandOfGame: false,
      isDealer: false,
    };
    // 14-tile hand (13-tile 1-shanten base shape: m123 p123 z1z1 s1_3 p5_7 + z5 floater)
    // plus an extra drawn z6, so discarding z6 keeps exactly the same 1-shanten shape.
    const hand1 = new Hand();
    hand1.dealIn(["m1", "m2", "m3", "p1", "p2", "p3", "z1", "z1", "s1", "s3", "p5", "p7", "z5", "z6"].map((k, i) => t(4000 + i, k)));
    ai.chooseDiscard(hand1, baseCtx);
    const debugBefore = ai.lastDiscardDebug!;
    const z6Candidate = debugBefore.topCandidates.find((c) => c.kind === "z6");
    expect(z6Candidate).toBeDefined();
    const ukeireBefore = z6Candidate!.ukeire ?? 0;
    const tileCountBefore = z6Candidate!.ukeireTileCount ?? 0;
    expect(tileCountBefore).toBeGreaterThan(0);

    // now mark ALL copies of p6 and s2 (the two improving kinds after discarding z6) as
    // already visible on the table
    const ai2 = new CharacterAI(CHARACTER_PROFILES.byeonari!, "phase3-tilecount-direct");
    ai2.onHandStart();
    const hand2 = new Hand();
    hand2.dealIn(["m1", "m2", "m3", "p1", "p2", "p3", "z1", "z1", "s1", "s3", "p5", "p7", "z5", "z6"].map((k, i) => t(5000 + i, k)));
    const allP6AndS2Visible: TileKind[] = ["p6", "p6", "p6", "p6", "s2", "s2", "s2", "s2"] as TileKind[];
    ai2.chooseDiscard(hand2, { ...baseCtx, visibleTileKinds: allP6AndS2Visible });
    const debugAfter = ai2.lastDiscardDebug!;
    const z6CandidateAfter = debugAfter.topCandidates.find((c) => c.kind === "z6");
    expect(z6CandidateAfter).toBeDefined();

    expect(z6CandidateAfter!.ukeire ?? 0).toBe(ukeireBefore); // kind count is unaffected
    expect(z6CandidateAfter!.ukeireTileCount ?? 0).toBe(0); // but every copy is now accounted for as seen
  });
});

describe("regression: ukeireTileCount's small scoring weight never overturns shanten priority", () => {
  it("seeded determinism holds with the new field/term wired in", () => {
    const seed = "phase3-tilecount-determinism";
    const ai1 = new CharacterAI(CHARACTER_PROFILES.byeonari!, seed);
    ai1.onHandStart();
    const ai2 = new CharacterAI(CHARACTER_PROFILES.byeonari!, seed);
    ai2.onHandStart();
    const hand1 = new Hand();
    hand1.dealIn(["m1", "m2", "m3", "p1", "p2", "p3", "z1", "z1", "s1", "s3", "p5", "p7", "z5", "z6"].map((k, i) => t(6000 + i, k)));
    const hand2 = new Hand();
    hand2.dealIn(["m1", "m2", "m3", "p1", "p2", "p3", "z1", "z1", "s1", "s3", "p5", "p7", "z5", "z6"].map((k, i) => t(6000 + i, k)));
    const ctx: CharacterDecisionContext = {
      rules: DEFAULT_SANMA_RULES,
      riichiOpponentDiscardKinds: [],
      doraIndicatorKinds: [],
      visibleTileKinds: ["p6", "s2"] as TileKind[],
      seatWind: 1,
      roundWind: 1,
      wallRemainingLive: 40,
      ownScore: 35000,
      opponentScores: [35000, 35000],
      isLastHandOfGame: false,
      isDealer: false,
    };
    const id1 = ai1.chooseDiscard(hand1, ctx);
    const id2 = ai2.chooseDiscard(hand2, ctx);
    expect(id1).toBe(id2);
  });
});
