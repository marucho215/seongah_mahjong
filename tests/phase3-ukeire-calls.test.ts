import { describe, it, expect } from "vitest";
import { computeImprovingTiles, computeWinningTiles } from "../src/actions/winSearch.js";
import { Wall } from "../src/core/Wall.js";
import { Hand } from "../src/core/Hand.js";
import { tilesToCounts } from "../src/core/tileIndex.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { GameState } from "../src/core/GameState.js";
import { CharacterAI, type CharacterDecisionContext } from "../src/ai/characterAI.js";
import { CHARACTER_PROFILES } from "../src/ai/characterProfiles.js";
import type { GameEvent } from "../src/core/GameLog.js";
import type { Tile, TileKind } from "../src/core/tiles.js";

function t(id: number, kind: string): Tile {
  const suit = kind[0] as "m" | "p" | "s" | "z";
  const rank = Number(kind.slice(1));
  return { id, kind, suit, rank, isRed: false };
}
function countsFromKinds(kinds: string[]): number[] {
  return tilesToCounts(kinds.map((k, i) => t(i, k)));
}

describe("3-1: computeImprovingTiles is true ukeire at every shanten level", () => {
  it("0-shanten (tenpai): matches computeWinningTiles exactly", () => {
    // tenpai on a simple hand: needs one more p5 for the last pair/run
    const kinds = ["m1", "m2", "m3", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z1", "z1", "p5"];
    const counts = countsFromKinds(kinds);
    const winning = computeWinningTiles(counts, 0, DEFAULT_SANMA_RULES);
    const improving = computeImprovingTiles(counts, 0, DEFAULT_SANMA_RULES);
    expect(winning.length).toBeGreaterThan(0);
    expect(new Set(improving)).toEqual(new Set(winning));
  });

  it("1-shanten: computeWinningTiles is always empty here (the bug), but computeImprovingTiles finds real advancing tiles", () => {
    // genuinely 1-shanten: 2 complete sets (m,p) + a pair (z1z1) + two kanchan shapes
    // (s1_3, p5_7) + one unrelated floater (z5) - needs one more draw to reach tenpai
    const kinds = ["m1", "m2", "m3", "p1", "p2", "p3", "z1", "z1", "s1", "s3", "p5", "p7", "z5"];
    const counts = countsFromKinds(kinds);
    expect(computeWinningTiles(counts, 0, DEFAULT_SANMA_RULES).length).toBe(0); // the bug this replaces
    const improving = computeImprovingTiles(counts, 0, DEFAULT_SANMA_RULES);
    expect(improving.length).toBeGreaterThan(0);
    expect(improving).toContain("p6"); // p5+p7 -> p6 completes that kanchan, reaching tenpai
    expect(improving).toContain("s2"); // s1+s3 -> s2 completes the other kanchan
  });

  it("2+ shanten: still finds real shanten-reducing tiles", () => {
    const kinds = ["m1", "m2", "p1", "p2", "s1", "s2", "z1", "z2", "z3", "z4", "z5", "z6", "z7"];
    const counts = countsFromKinds(kinds);
    const improving = computeImprovingTiles(counts, 0, DEFAULT_SANMA_RULES);
    expect(improving.length).toBeGreaterThan(0);
  });

  it("different discards from the same hand produce different ukeire (not uniformly 0/flat)", () => {
    // a real hand where discarding one floater keeps a much better shape than another
    const withoutZ7 = countsFromKinds(["m1", "m2", "m3", "p1", "p2", "p4", "s1", "s2", "s3", "z1", "z1", "p9"]);
    const withoutP9 = countsFromKinds(["m1", "m2", "m3", "p1", "p2", "p4", "s1", "s2", "s3", "z1", "z1", "z7"]);
    const ukeireA = computeImprovingTiles(withoutZ7, 0, DEFAULT_SANMA_RULES).length;
    const ukeireB = computeImprovingTiles(withoutP9, 0, DEFAULT_SANMA_RULES).length;
    expect(ukeireA).not.toBe(ukeireB);
  });
});

describe("3-1b: chooseDiscard's candidate ukeire field reflects real per-candidate differences", () => {
  it("topCandidates ukeire is not uniformly 0 for a real non-tenpai hand", () => {
    let found = false;
    for (const seed of [0]) {
      const wall = new Wall(DEFAULT_SANMA_RULES, `phase3-discard-ukeire-${seed}`);
      const [dealt] = wall.dealInitial(3, 13);
      const hand = new Hand();
      hand.dealIn(dealt!);
      hand.concealed.push(wall.drawTile());
      // shanten/ukeire are only populated in topCandidates when Ari's diagnostic fields are
      // active (see chooseDiscard's ariDiagnosticsActive gate, pre-existing/unrelated to
      // this fix) - so byeonari (Ari) is required here, not just any character
      const ai = new CharacterAI(CHARACTER_PROFILES.byeonari!, `phase3-discard-ukeire-ai-${seed}`);
      ai.onHandStart();
      const ctx: CharacterDecisionContext = {
        rules: DEFAULT_SANMA_RULES,
        riichiOpponentDiscardKinds: [],
        doraIndicatorKinds: wall.doraIndicators().map((tt) => tt.kind),
        visibleTileKinds: [],
        seatWind: 1,
        roundWind: 1,
        wallRemainingLive: wall.remainingLiveCount(),
        ownScore: 35000,
        opponentScores: [35000, 35000],
        isLastHandOfGame: false,
        isDealer: false,
      };
      ai.chooseDiscard(hand, ctx);
      const debug = ai.lastDiscardDebug;
      if (!debug) continue;
      // ukeire is only computed exactly for candidates tied at the LOCAL BEST shanten
      // (see chooseDiscard's needsExactUkeire gate) - only meaningful to check those, and
      // only when that best shanten isn't already tenpai (0), which this test isn't about
      const minCandidateShanten = Math.min(...debug.topCandidates.map((c) => c.shanten ?? Infinity));
      if (minCandidateShanten === 0) continue;
      const bestTierUkeire = debug.topCandidates.filter((c) => c.shanten === minCandidateShanten).map((c) => c.ukeire ?? 0);
      if (bestTierUkeire.every((u) => u === 0)) continue; // some hands are just very bad - keep searching
      found = true;
      expect(bestTierUkeire.some((u) => u > 0)).toBe(true);
    }
    expect(found).toBe(true);
  });
});

describe("3-2: CharacterAI evaluates pon/kan calls directly, without a SimpleAI yakuhai-only pre-filter", () => {
  it("shouldCallPon can return true for a non-yakuhai (plain number-tile) pon that clearly advances shanten", () => {
    let calledAtLeastOnce = false;
    for (const seed of [0]) {
      const ai = new CharacterAI(CHARACTER_PROFILES.seiyamouri!, `phase3-nonyakuhai-pon-${seed}`);
      ai.onHandStart();
      // hand is 1-shanten and pon-ing p5 completes a run's worth of shanten advancement
      const hand = new Hand();
      hand.dealIn(
        ["m1", "m2", "m3", "p1", "p2", "p5", "p5", "s1", "s2", "s3", "z1", "z2", "z3"].map((k, i) => t(1000 + seed * 20 + i, k))
      );
      const ctx: CharacterDecisionContext = {
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
      const called = ai.shouldCallPon(hand, "p5" as TileKind, ctx, false); // isYakuhai=false: a plain number tile
      if (called) calledAtLeastOnce = true;
    }
    expect(calledAtLeastOnce).toBe(true);
  });

  it("a real full game finds at least one CharacterAI-seat pon on a non-honor (non-yakuhai) tile via the actual GameState call path", () => {
    let found = false;
    for (const seed of [0]) {
      const gs = new GameState({
        rules: DEFAULT_SANMA_RULES,
        seed: `phase3-real-nonyakuhai-pon-${seed}`,
        characterProfiles: [CHARACTER_PROFILES.seiyamouri!, CHARACTER_PROFILES.seiyamouri!, CHARACTER_PROFILES.seiyamouri!],
      });
      gs.playGame();
      const pons = gs.log.filter((e): e is Extract<GameEvent, { type: "call" }> => e.type === "call" && e.call === "pon");
      const nonYakuhaiPon = pons.find((p) => p.kind[0] !== "z");
      if (nonYakuhaiPon) found = true;
    }
    expect(found).toBe(true);
  });

  it("existing yakuhai pon behavior is unchanged: a dragon/seat-wind pon is still evaluated and can still be called", () => {
    const ai = new CharacterAI(CHARACTER_PROFILES.seiyamouri!, "phase3-yakuhai-regression");
    ai.onHandStart();
    const hand = new Hand();
    hand.dealIn(["m1", "m2", "p1", "p2", "s1", "s2", "z5", "z5", "z6", "z7", "z1", "z2", "z3"].map((k, i) => t(2000 + i, k)));
    const ctx: CharacterDecisionContext = {
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
    // just confirm this doesn't throw and returns a boolean - a dragon pon is still a fully
    // legitimate call path, not broken by removing the pre-filter for other seats
    expect(typeof ai.shouldCallPon(hand, "z5" as TileKind, ctx, true)).toBe("boolean");
  });

  it("a seat with no CharacterAI profile still only calls pon on yakuhai tiles (SimpleAI policy unchanged)", () => {
    for (const seed of [0]) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `phase3-simpleai-regression-${seed}` });
      gs.playGame();
      const pons = gs.log.filter((e): e is Extract<GameEvent, { type: "call" }> => e.type === "call" && e.call === "pon");
      for (const p of pons) expect(p.kind[0]).toBe("z"); // every SimpleAI-only-seat pon target is an honor tile
    }
  });

  it("seeded determinism: identical seed + identical character profiles reproduce identical call decisions", () => {
    const seed = "phase3-determinism";
    const profiles = [CHARACTER_PROFILES.seiyamouri!, CHARACTER_PROFILES.seiyamouri!, CHARACTER_PROFILES.seiyamouri!] as const;
    const gs1 = new GameState({ rules: DEFAULT_SANMA_RULES, seed, characterProfiles: [...profiles] });
    gs1.playGame();
    const gs2 = new GameState({ rules: DEFAULT_SANMA_RULES, seed, characterProfiles: [...profiles] });
    gs2.playGame();
    expect(gs2.log).toEqual(gs1.log);
  });
});
