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
  it("separates starting, return, and target scores and configures ranked uma", () => {
    expect(DEFAULT_SANMA_RULES.startingScore).toBe(35000);
    expect(DEFAULT_SANMA_RULES.returnScore).toBe(35000);
    expect(DEFAULT_SANMA_RULES.targetScore).toBe(40000);
    expect(DEFAULT_SANMA_RULES.uma).toEqual([15000, 0, -15000]);

    expect(MAJSOUL_YONMA_RULES.startingScore).toBe(25000);
    expect(MAJSOUL_YONMA_RULES.returnScore).toBe(25000);
    expect(MAJSOUL_YONMA_RULES.targetScore).toBe(30000);
    expect(MAJSOUL_YONMA_RULES.uma).toEqual([15000, 5000, -5000, -15000]);
  });

  it("computes yonma and sanma game scores without oka and preserves a zero sum", () => {
    const yonma = standings(MAJSOUL_YONMA_RULES, [40000, 30000, 20000, 10000]);
    expect(yonma.map((entry) => entry.uma)).toEqual([15, 5, -5, -15]);
    expect(yonma.map((entry) => entry.points)).toEqual([30, 10, -10, -30]);
    expect(yonma.reduce((sum, entry) => sum + entry.points, 0)).toBe(0);

    const sanma = standings(DEFAULT_SANMA_RULES, [50000, 35000, 20000]);
    expect(sanma.map((entry) => entry.uma)).toEqual([15, 0, -15]);
    expect(sanma.map((entry) => entry.points)).toEqual([30, 0, -30]);
    expect(sanma.reduce((sum, entry) => sum + entry.points, 0)).toBe(0);
  });

  it("keeps 100-point precision and the initial-seat tie break", () => {
    const fractional = standings(MAJSOUL_YONMA_RULES, [25300, 25200, 24900, 24600]);
    expect(fractional[0]!.points).toBeCloseTo(15.3);
    expect(fractional.reduce((sum, entry) => sum + entry.points, 0)).toBeCloseTo(0);

    const tied = standings(MAJSOUL_YONMA_RULES, [30000, 30000, 20000, 20000]);
    expect(tied.map((entry) => entry.player)).toEqual([0, 1, 2, 3]);
  });
});

describe("FF-12 target score is independent from final-score return baseline", () => {
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
  ])("does not trigger automatic dealer-end merely above returnScore ($score)", ({ rules, score }) => {
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
    expect(score).toBeGreaterThan(rules.returnScore);
    expect(score).toBeLessThan(rules.targetScore);
    expect(decision.dealerEndTriggered).toBe(false);
    expect(decision.dealerContinuationPending).toBe(true);
  });

  it("keeps custom target, return, and uma independent", () => {
    const rules = {
      ...MAJSOUL_YONMA_RULES,
      returnScore: 20000,
      targetScore: 60000,
      uma: [3000, 1000, -1000, -3000],
    };
    const game = new GameState({ rules, seed: "ff12-custom" });
    game.scores = [50000, 20000, 20000, -10000];
    setPastScheduledLength(game);

    expect(game.isGameOver()).toBe(false);
    expect(game.computeFinalStandings().map((entry) => entry.points)).toEqual([33, 1, -1, -33]);
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
    expect(game.computeFinalStandings().map((entry) => entry.points)).toEqual([21, 4, -25]);
  });

  it("uses the same standings formula after a tobi termination", () => {
    const game = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "ff12-tobi" });
    game.scores = [-100, 70100, 35000];
    (game as unknown as { tobiTriggered: boolean }).tobiTriggered = true;

    const result = game.computeFinalStandings();
    expect(result.map((entry) => entry.player)).toEqual([1, 2, 0]);
    expect(result.map((entry) => entry.points)).toEqual([50.1, 0, -50.1]);
    expect(result.reduce((sum, entry) => sum + entry.points, 0)).toBeCloseTo(0);
  });
});
