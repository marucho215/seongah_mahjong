import { describe, expect, it } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { computeRoundProgression, type RoundProgressionInput } from "../src/core/roundProgression.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

function sanma(overrides: Partial<RoundProgressionInput> = {}): RoundProgressionInput {
  return {
    rules: DEFAULT_SANMA_RULES,
    scores: [41000, 34000, 30000],
    dealerSeat: 0,
    roundWind: 1,
    roundHandNumber: DEFAULT_SANMA_RULES.handsPerRound,
    honba: 0,
    dealerRepeats: true,
    isExhaustiveDraw: false,
    allowDealerEnd: true,
    ...overrides,
  };
}

describe("FF-09 Mahjong Soul sanma automatic dealer end", () => {
  it("triggers sanma agari-yame after settlement when the final dealer leads at target", () => {
    const decision = computeRoundProgression(sanma());
    expect(decision.dealerEndTriggered).toBe(true);
    expect(decision.dealerContinuationPending).toBe(false);

    const game = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "ff09-agari-yame" });
    game.roundHandNumber = DEFAULT_SANMA_RULES.handsPerRound;
    game.dealerSeat = 0;
    game.scores = [41000, 34000, 30000];
    (game as unknown as { advanceAfterHand(repeats: boolean, draw: boolean): void }).advanceAfterHand(true, false);
    expect(game.isGameOver()).toBe(true);
  });

  it("does not trigger agari-yame below target or when the dealer is not first", () => {
    const belowTarget = computeRoundProgression(sanma({ scores: [39900, 35100, 30000] }));
    const notFirst = computeRoundProgression(sanma({ scores: [41000, 43000, 21000] }));

    expect(belowTarget.dealerEndTriggered).toBe(false);
    expect(belowTarget.dealerContinuationPending).toBe(true);
    expect(notFirst.dealerEndTriggered).toBe(false);
    expect(notFirst.dealerContinuationPending).toBe(true);
  });

  it("uses the ruleset dealer-end policy rather than player-count inference", () => {
    const disabled = computeRoundProgression(sanma({
      rules: { ...DEFAULT_SANMA_RULES, automaticDealerEnd: false },
    }));

    expect(disabled.dealerEndTriggered).toBe(false);
    expect(disabled.dealerContinuationPending).toBe(true);
  });

  it("triggers tenpai-yame from post-noten-payment scores", () => {
    const decision = computeRoundProgression(sanma({
      scores: [41000, 35000, 29000],
      isExhaustiveDraw: true,
    }));

    expect(decision.dealerEndTriggered).toBe(true);
    expect(decision.nextHonba).toBe(1);
  });

  it("does not trigger tenpai-yame below target, outside first, or when dealer is noten", () => {
    const belowTarget = computeRoundProgression(sanma({
      scores: [39900, 35100, 30000],
      isExhaustiveDraw: true,
    }));
    const notFirst = computeRoundProgression(sanma({
      scores: [41000, 43000, 21000],
      isExhaustiveDraw: true,
    }));
    const dealerNoten = computeRoundProgression(sanma({
      dealerRepeats: false,
      isExhaustiveDraw: true,
    }));

    expect(belowTarget.dealerEndTriggered).toBe(false);
    expect(notFirst.dealerEndTriggered).toBe(false);
    expect(dealerNoten.dealerEndTriggered).toBe(false);
    expect(dealerNoten.nextDealer).toBe(1);
  });

  it("uses the existing starting-seat tie break when identifying first place", () => {
    const dealerLosesTie = computeRoundProgression(sanma({
      dealerSeat: 2,
      scores: [41000, 23000, 41000],
    }));
    const dealerWinsTie = computeRoundProgression(sanma({
      dealerSeat: 0,
      scores: [41000, 23000, 41000],
    }));

    expect(dealerLosesTie.dealerEndTriggered).toBe(false);
    expect(dealerWinsTie.dealerEndTriggered).toBe(true);
  });

  it("keeps abortive draws out of dealer-end while preserving renchan and honba", () => {
    const game = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "ff09-abortive" });
    game.roundHandNumber = DEFAULT_SANMA_RULES.handsPerRound;
    game.dealerSeat = 0;
    game.scores = [41000, 34000, 30000];
    game.honba = 2;

    game.applyAbortiveDraw("nine_terminals");

    expect(game.isGameOver()).toBe(false);
    expect(game.dealerSeat).toBe(0);
    expect(game.roundHandNumber).toBe(DEFAULT_SANMA_RULES.handsPerRound);
    expect(game.honba).toBe(3);
  });

  it("preserves negative-only tobi and exact-zero survival", () => {
    const negative = computeRoundProgression(sanma({
      scores: [-100, 65100, 40000],
      dealerRepeats: false,
    }));
    const zero = computeRoundProgression(sanma({
      scores: [0, 65000, 40000],
      dealerRepeats: false,
    }));

    expect(negative.tobiTriggered).toBe(true);
    expect(zero.tobiTriggered).toBe(false);
  });

  it.each([false, true])("preserves yonma dealer-end semantics (draw=%s)", (isExhaustiveDraw) => {
    const decision = computeRoundProgression({
      ...sanma(),
      rules: MAJSOUL_YONMA_RULES,
      scores: [32000, 28000, 22000, 18000],
      roundHandNumber: MAJSOUL_YONMA_RULES.handsPerRound,
      isExhaustiveDraw,
    });

    expect(decision.dealerEndTriggered).toBe(true);
    expect(decision.dealerContinuationPending).toBe(false);
  });
});
