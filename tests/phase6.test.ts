import { describe, it, expect } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";

describe("full game simulation", () => {
  it("plays an east-only game to completion without throwing, for many seeds", () => {
    for (let i = 0; i < 25; i++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `full-game-${i}` });
      expect(() => gs.playGame()).not.toThrow();
      expect(gs.isGameOver()).toBe(true);
      expect(gs.log.some((e) => e.type === "game_end")).toBe(true);
    }
  });

  it("conserves total points (scores + riichi sticks on the table) across every hand", () => {
    const rules = DEFAULT_SANMA_RULES;
    const gs = new GameState({ rules, seed: "conservation-seed" });
    const expectedTotal = rules.startingScore * 3;
    let handCount = 0;
    while (!gs.isGameOver() && handCount < 50) {
      gs.playHand();
      const total = gs.scores[0] + gs.scores[1] + gs.scores[2] + gs.kyotaku * 1000;
      expect(total).toBe(expectedTotal);
      handCount++;
    }
    expect(handCount).toBeGreaterThan(0);
  });

  it("is fully deterministic: identical seed produces identical final scores and log length", () => {
    const gs1 = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "determinism-seed" });
    const gs2 = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "determinism-seed" });
    gs1.playGame();
    gs2.playGame();
    expect(gs1.scores).toEqual(gs2.scores);
    expect(gs1.log.length).toEqual(gs2.log.length);
    expect(gs1.log).toEqual(gs2.log);
  });

  it("produces at least one win or exhaustive draw for every hand played", () => {
    const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "resolution-seed" });
    gs.playGame();
    const handStarts = gs.log.filter((e) => e.type === "hand_start").length;
    const resolutions = gs.log.filter((e) => e.type === "win" || e.type === "exhaustive_draw").length;
    expect(resolutions).toBeGreaterThanOrEqual(handStarts);
  });

  it("ends an east-south game only after round wind exceeds South", () => {
    const rules = { ...DEFAULT_SANMA_RULES, gameLength: "east-south" as const };
    const gs = new GameState({ rules, seed: "east-south-seed" });
    gs.playGame();
    expect(gs.roundWind).toBeGreaterThanOrEqual(2);
  });

  it("never lets a hand's discard pile contain a tile the player never held (structural sanity via no thrown errors)", () => {
    // discardById / applyPon / applyAnkan all throw on illegal tile references, so a clean
    // completed game is itself strong evidence no phantom tiles were discarded.
    const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "phantom-tile-seed" });
    expect(() => gs.playGame()).not.toThrow();
  });
});
