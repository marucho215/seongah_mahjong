import { describe, expect, it } from "vitest";
import { computeRoundProgression, type RoundProgressionInput } from "../src/core/roundProgression.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

function yonma(overrides: Partial<RoundProgressionInput> = {}): RoundProgressionInput {
  return {
    rules: MAJSOUL_YONMA_RULES,
    scores: [25000, 25000, 25000, 25000],
    dealerSeat: 0,
    roundWind: 1,
    roundHandNumber: 1,
    honba: 0,
    dealerRepeats: false,
    isExhaustiveDraw: false,
    allowDealerEnd: true,
    ...overrides,
  };
}

describe("Phase F3 round progression decision", () => {
  it("keeps the dealer and increments honba on dealer win or dealer-tenpai draw", () => {
    const win = computeRoundProgression(yonma({ dealerSeat: 2, roundHandNumber: 3, honba: 2, dealerRepeats: true }));
    const draw = computeRoundProgression(yonma({
      dealerSeat: 2,
      roundHandNumber: 3,
      honba: 2,
      dealerRepeats: true,
      isExhaustiveDraw: true,
    }));

    expect(win).toMatchObject({ nextDealer: 2, nextRoundHandNumber: 3, nextHonba: 3 });
    expect(draw).toMatchObject({ nextDealer: 2, nextRoundHandNumber: 3, nextHonba: 3 });
  });

  it("rotates after a non-dealer win and increments honba on a dealer-noten draw", () => {
    const win = computeRoundProgression(yonma({ dealerSeat: 1, roundHandNumber: 2, honba: 4 }));
    const draw = computeRoundProgression(yonma({
      dealerSeat: 1,
      roundHandNumber: 2,
      honba: 4,
      isExhaustiveDraw: true,
    }));

    expect(win).toMatchObject({ nextDealer: 2, nextRoundHandNumber: 3, nextHonba: 0 });
    expect(draw).toMatchObject({ nextDealer: 2, nextRoundHandNumber: 3, nextHonba: 5 });
  });

  it("advances each ruleset's last East hand into South", () => {
    const sanma = computeRoundProgression({
      ...yonma(),
      rules: DEFAULT_SANMA_RULES,
      scores: [35000, 35000, 35000],
      dealerSeat: 2,
      roundHandNumber: 3,
    });
    const fourPlayer = computeRoundProgression(yonma({ dealerSeat: 3, roundHandNumber: 4 }));

    expect(sanma).toMatchObject({ nextDealer: 0, nextRoundWind: 2, nextRoundHandNumber: 1 });
    expect(fourPlayer).toMatchObject({ nextDealer: 0, nextRoundWind: 2, nextRoundHandNumber: 1 });
  });

  it("keeps abortive-draw renchan without applying dealer-end policy", () => {
    const decision = computeRoundProgression(yonma({
      scores: [32000, 28000, 22000, 18000],
      roundHandNumber: 4,
      honba: 3,
      dealerRepeats: true,
      isExhaustiveDraw: true,
      allowDealerEnd: false,
    }));

    expect(decision).toMatchObject({
      nextDealer: 0,
      nextRoundHandNumber: 4,
      nextHonba: 4,
      dealerContinuationPending: true,
      dealerEndTriggered: false,
    });
  });

  it.each([false, true])("triggers last-dealer yame for win/tenpai continuation (draw=%s)", (isExhaustiveDraw) => {
    const decision = computeRoundProgression(yonma({
      scores: [32000, 28000, 22000, 18000],
      roundHandNumber: 4,
      dealerRepeats: true,
      isExhaustiveDraw,
    }));

    expect(decision.dealerEndTriggered).toBe(true);
    expect(decision.dealerContinuationPending).toBe(false);
  });

  it("advances beyond South 4 for the existing cap check without deciding game end itself", () => {
    const decision = computeRoundProgression(yonma({
      dealerSeat: 3,
      roundWind: 2,
      roundHandNumber: 4,
    }));

    expect(decision).toMatchObject({ nextDealer: 0, nextRoundWind: 3, nextRoundHandNumber: 1 });
  });

  it("flags only negative scores as tobi and does not mutate the score snapshot", () => {
    const negativeScores = [-100, 30100, 35000, 35000];
    const zeroScores = [0, 30000, 35000, 35000];

    expect(computeRoundProgression(yonma({ scores: negativeScores })).tobiTriggered).toBe(true);
    expect(computeRoundProgression(yonma({ scores: zeroScores })).tobiTriggered).toBe(false);
    expect(negativeScores).toEqual([-100, 30100, 35000, 35000]);
    expect(zeroScores).toEqual([0, 30000, 35000, 35000]);
  });
});
