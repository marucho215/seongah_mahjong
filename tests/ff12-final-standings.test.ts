import { describe, expect, it } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { computeRoundProgression } from "../src/core/roundProgression.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

function standings(rules: typeof DEFAULT_SANMA_RULES, scores: number[]) {
  const game = new GameState({ rules, seed: "ff12-standings" });
  game.scores = [...scores];
  return game.computeFinalStandings();
}

function setPastScheduledLength(game: GameState): void {
  game.roundWind = game.rules.gameLength === "east" ? 2 : 3;
  game.roundHandNumber = 1;
}

describe("FF-12 Mahjong Soul ranked score configuration", () => {
  it("separates starting and target scores", () => {
    expect(DEFAULT_SANMA_RULES.startingScore).toBe(35000);
    expect(DEFAULT_SANMA_RULES.targetScore).toBe(40000);
    expect(MAJSOUL_YONMA_RULES.startingScore).toBe(25000);
    expect(MAJSOUL_YONMA_RULES.targetScore).toBe(30000);
  });

  it("ranks yonma and sanma by raw score", () => {
    const yonma = standings(MAJSOUL_YONMA_RULES, [10000, 40000, 20000, 30000]);
    expect(yonma.map((entry) => entry.player)).toEqual([1, 3, 2, 0]);
    expect(yonma.map((entry) => entry.placement)).toEqual([1, 2, 3, 4]);

    const sanma = standings(DEFAULT_SANMA_RULES, [20000, 50000, 35000]);
    expect(sanma.map((entry) => entry.player)).toEqual([1, 2, 0]);
    expect(sanma.map((entry) => entry.rawScore)).toEqual([50000, 35000, 20000]);
  });

  it("keeps the initial-seat tie break", () => {
    const tied = standings(MAJSOUL_YONMA_RULES, [30000, 30000, 20000, 20000]);
    expect(tied.map((entry) => entry.player)).toEqual([0, 1, 2, 3]);
  });
});

describe("FF-12 target score", () => {
  it.each([
    { rules: DEFAULT_SANMA_RULES, below: 39900, reached: 40000 },
    { rules: MAJSOUL_YONMA_RULES, below: 29900, reached: 30000 },
  ])("uses targetScore for extension termination ($reached)", ({ rules, below, reached }) => {
    const game = new GameState({ rules, seed: "ff12-target-boundary" });
    setPastScheduledLength(game);
    game.scores = [below, ...Array.from({ length: rules.playerCount - 1 }, () => 0)];
    expect(game.isGameOver()).toBe(false);

    game.scores[0] = reached;
    expect(game.isGameOver()).toBe(true);
  });

  it.each([
    { rules: DEFAULT_SANMA_RULES, score: 36000 },
    { rules: MAJSOUL_YONMA_RULES, score: 26000 },
  ])("does not trigger automatic dealer-end merely above the starting score ($score)", ({ rules, score }) => {
    const decision = computeRoundProgression({
      rules,
      scores: [score, ...Array.from({ length: rules.playerCount - 1 }, () => 0)],
      dealerSeat: 0,
      roundWind: rules.gameLength === "east" ? 1 : 2,
      roundHandNumber: rules.handsPerRound,
      honba: 0,
      dealerRepeats: true,
      isExhaustiveDraw: false,
      allowDealerEnd: true,
    });
    expect(score).toBeGreaterThan(rules.startingScore);
    expect(score).toBeLessThan(rules.targetScore);
    expect(decision.dealerEndTriggered).toBe(false);
    expect(decision.dealerContinuationPending).toBe(true);
  });

  it("honors a custom target score", () => {
    const rules = {
      ...MAJSOUL_YONMA_RULES,
      targetScore: 60000,
    };
    const game = new GameState({ rules, seed: "ff12-custom" });
    game.scores = [50000, 20000, 20000, -10000];
    setPastScheduledLength(game);

    expect(game.isGameOver()).toBe(false);
    game.scores[0] = 60000;
    expect(game.isGameOver()).toBe(true);
  });
});

describe("FF-12 finalization boundaries", () => {
  it("sweeps leftover kyotaku before computing final standings", () => {
    const game = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "ff12-kyotaku" });
    game.scores = [39000, 39000, 25000];
    game.kyotaku = 2;
    (game as unknown as { tobiTriggered: boolean }).tobiTriggered = true;

    game.playGame();

    expect(game.scores).toEqual([41000, 39000, 25000]);
    expect(game.computeFinalStandings().map((entry) => entry.rawScore)).toEqual([41000, 39000, 25000]);
  });

  it("ranks the same way after a tobi termination", () => {
    const game = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "ff12-tobi" });
    game.scores = [-100, 70100, 35000];
    (game as unknown as { tobiTriggered: boolean }).tobiTriggered = true;

    const result = game.computeFinalStandings();
    expect(result.map((entry) => entry.player)).toEqual([1, 2, 0]);
    expect(result.map((entry) => entry.rawScore)).toEqual([70100, 35000, -100]);
  });
});
