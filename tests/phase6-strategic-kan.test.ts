import { describe, expect, it } from "vitest";
import { CharacterAI, evaluateStrategicKanDecision, type StrategicKanInput } from "../src/ai/characterAI.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";

const goodAnkan: StrategicKanInput = {
  kind: "ankan",
  currentShanten: 1,
  afterKanShanten: 1,
  currentUkeire: 5,
  afterKanUkeire: 8,
  currentUkeireTileCount: 14,
  afterKanUkeireTileCount: 22,
  riichi: false,
  riichiOpponentCount: 0,
  wallRemainingLive: 35,
  defense: 0.5,
  riskTolerance: 0.5,
};

const badShouminkan: StrategicKanInput = {
  kind: "shouminkan",
  currentShanten: 3,
  afterKanShanten: 4,
  currentUkeire: 10,
  afterKanUkeire: 4,
  currentUkeireTileCount: 30,
  afterKanUkeireTileCount: 10,
  riichi: false,
  riichiOpponentCount: 1,
  wallRemainingLive: 7,
  defense: 0.8,
  riskTolerance: 0.25,
};

describe("Phase 6 strategic kan decisions", () => {
  it("ankan is not unconditional and distinguishes a good kan from a damaged line", () => {
    expect(evaluateStrategicKanDecision(goodAnkan).declared).toBe(true);
    expect(
      evaluateStrategicKanDecision({ ...goodAnkan, afterKanShanten: 3, afterKanUkeire: 1, afterKanUkeireTileCount: 3 }).declared
    ).toBe(false);
  });

  it("shouminkan is not unconditional and declines a defensive/progression loss", () => {
    expect(evaluateStrategicKanDecision(badShouminkan).declared).toBe(false);
    expect(
      evaluateStrategicKanDecision({
        ...badShouminkan,
        currentShanten: 1,
        afterKanShanten: 1,
        afterKanUkeire: 12,
        afterKanUkeireTileCount: 34,
        riichiOpponentCount: 0,
        wallRemainingLive: 35,
      }).declared
    ).toBe(true);
  });

  it("riichi state is an explicit strategic veto without changing kan legality", () => {
    expect(evaluateStrategicKanDecision({ ...goodAnkan, riichi: true }).declared).toBe(false);
  });

  it("Jo Sangmin's real modifiers flip an otherwise accepted kan selection", () => {
    const closeKan: StrategicKanInput = {
      ...goodAnkan,
      currentShanten: 2,
      afterKanShanten: 2,
      currentUkeire: 6,
      afterKanUkeire: 8,
      currentUkeireTileCount: 18,
      afterKanUkeireTileCount: 22,
    };
    const neutral = evaluateStrategicKanDecision(closeKan);
    const sangmin = new CharacterAI(getCharacterProfile("josangmin"), "phase6-sangmin-kan");

    const selected = sangmin.decideKanFromMetricsForTest(closeKan);
    const trace = sangmin.lastKanTrace!;

    expect(neutral.declared).toBe(true);
    expect(selected).toBe(false);
    expect(trace.baselineDecision).toBe("kan");
    expect(trace.adjustedDecision).toBe("pass");
    expect(trace.adjustedScore).toBeLessThan(trace.baselineScore);
  });

  it("is deterministic for identical fixed inputs", () => {
    const a = new CharacterAI(getCharacterProfile("josangmin"), "same-seed");
    const b = new CharacterAI(getCharacterProfile("josangmin"), "same-seed");
    expect(a.decideKanFromMetricsForTest(goodAnkan)).toBe(b.decideKanFromMetricsForTest(goodAnkan));
    expect(a.lastKanTrace).toEqual(b.lastKanTrace);
  });
});
