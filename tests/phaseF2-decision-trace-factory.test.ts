import { describe, expect, it } from "vitest";
import type {
  CallDecisionTrace,
  DiscardDebugInfo,
  RiichiDecisionTrace,
} from "../src/ai/characterAI.js";
import type { ChiDecisionEvaluation } from "../src/ai/chiDecision.js";
import {
  buildCallDecisionEntry,
  buildDiscardDecisionEntry,
  buildRiichiDecisionEntry,
} from "../src/ai/decisionTraceFactory.js";
import type { ChiCandidate } from "../src/core/discardResponses.js";

function expectJsonSafe(value: unknown, path = "$root"): void {
  expect(value, `${path} must not be undefined`).not.toBeUndefined();
  if (typeof value === "number") {
    expect(Number.isFinite(value), `${path} must be finite`).toBe(true);
    expect(Object.is(value, -0), `${path} must not be negative zero`).toBe(false);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectJsonSafe(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) expectJsonSafe(entry, `${path}.${key}`);
  }
}

function discardDebug(): DiscardDebugInfo {
  return {
    chosenKind: "p5",
    topCandidates: [{ kind: "p5", score: 1.25, danger: -0, ukeire: undefined }],
    sandbagged: false,
    overloadTriggered: false,
    experimentRouteActive: null,
    baselineBestKind: null,
    specialAdjustedBestKind: null,
    ariChoiceChanged: null,
    chosenBaselineScore: null,
    chosenSpecialScore: null,
    chosenShapeCleanlinessDelta: null,
    chosenContaminationDelta: null,
    ariBaselineBestKind: null,
    ariAdjustedBestKind: null,
    ariMechanicChangedBest: null,
    mageunaRoute: null,
    mageunaRouteConsistent: null,
    mageunaDisruptionActive: null,
    mageunaDisruptionTurnsLeft: null,
    mageunaPlanBonusApplied: null,
    mageunaBaselineBestKind: null,
    mageunaAdjustedBestKind: null,
    mageunaMechanicChangedBest: null,
    effieChosenTurnsHeld: null,
    effieChosenAttachmentDelta: null,
    effieBaselineBestKind: null,
    effieAdjustedBestKind: null,
    effieMechanicChangedBest: null,
    optimaEffectiveEntropy: null,
    optimaState: null,
    optimaScoreGap: null,
    optimaPoolSize: null,
    optimaBaselinePoolSize: null,
    optimaChosenRank: null,
    optimaBaseEntropy: null,
    optimaEntropyModifier: null,
    kyleBaselineBestKind: null,
    kyleAdjustedBestKind: null,
    kyleMechanicChangedBest: null,
    kyleRouteState: null,
    nahuiBaselineBestKind: null,
    nahuiOverloadPoolBestKind: null,
    nahuiActualChosenKind: null,
    nahuiOverloadChangedChoice: null,
    tosukeSandbaggingActive: null,
    tosukeInterventionTriggered: null,
    tosukeBaselineBestKind: null,
    tosukeAdjustedBestKind: null,
    tosukeMechanicChangedBest: null,
    tosukeSandbaggingDelta: null,
    tosukeReason: null,
  };
}

const meta = { handIndex: 3, player: 2, characterId: "seiyakouri" };

describe("Phase F2 AI decision trace factories", () => {
  it("builds the existing discard shape without mutating its debug snapshot", () => {
    const debug = discardDebug();
    const entry = buildDiscardDecisionEntry(meta, debug);

    expect(entry).toMatchObject({
      type: "discard_decision",
      ...meta,
      chosenKind: "p5",
      topCandidates: [{ kind: "p5", score: 1.25, danger: 0 }],
      kyleRouteState: null,
      tosukeReason: null,
    });
    expect(Object.is(debug.topCandidates[0]!.danger, -0)).toBe(true);
    expect("ukeire" in entry.topCandidates[0]!).toBe(false);
    expectJsonSafe(entry);
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });

  it("builds the existing riichi shape and normalizes trace-only negative zero", () => {
    const trace: RiichiDecisionTrace = {
      riichiScore: 0.7,
      damaScore: 0.6,
      commitmentCost: -0,
      declared: true,
      baselineRiichiScore: 0.7,
      baselineDamaScore: 0.6,
      adjustedRiichiScore: 0.7,
      adjustedDamaScore: 0.6,
      baselineDecision: "riichi",
      adjustedDecision: "riichi",
      mechanicChangedDecision: false,
      actualDecision: "riichi",
      forced: false,
    };
    const entry = buildRiichiDecisionEntry(meta, trace);

    expect(entry).toMatchObject({ type: "riichi_decision", ...meta, commitmentCost: 0, actualDecision: "riichi" });
    expect(Object.is(trace.commitmentCost, -0)).toBe(true);
    expectJsonSafe(entry);
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });

  it("builds pon and chi entries with the existing common schema", () => {
    const callTrace: CallDecisionTrace = {
      callScore: 0.8,
      effortAversionCost: 0.1,
      beforeShanten: 2,
      afterShanten: 1,
      shantenGain: 1,
      beforeUkeire: 4,
      afterUkeire: 7,
      ukeireGain: 3,
      openMeldCount: 0,
      isYakuhai: true,
      called: true,
      callKind: "pon",
      baselineCallScore: 0.9,
      adjustedCallScore: 0.8,
      effortModifier: 0.1,
      commitmentModifier: 0,
      baselineDecision: "call",
      adjustedDecision: "call",
      mechanicChangedDecision: false,
      actualDecision: "call",
      components: {
        base: 0.15,
        shantenBonus: 0.5,
        ukeireBonus: 0.1,
        yakuhaiBonus: 0.15,
        callBias: 0.1,
        aggression: 0.05,
        defense: -0,
        effort: -0.1,
        commitment: 0,
        entropyJitter: 0,
        mistakeJitter: 0,
      },
    };
    const pon = buildCallDecisionEntry({
      meta,
      fromPlayer: 1,
      tile: "z5",
      actualCalled: false,
      decision: { source: "character", trace: callTrace },
    });

    const candidate: ChiCandidate = {
      type: "chi",
      seat: 2,
      sequence: ["m1", "m2", "m3"],
      consumedKinds: ["m1", "m2"],
    };
    const evaluation: ChiDecisionEvaluation = {
      candidate,
      beforeShanten: 2,
      afterShanten: 1,
      shantenGain: 1,
      beforeUkeire: 3,
      afterUkeire: 8,
      ukeireGain: 5,
      isFirstOpen: true,
      hasOpenYaku: true,
      opportunityCost: 0.5,
      score: 0.6,
      shouldCall: true,
      components: {
        shantenBonus: 1,
        ukeireBonus: 0.2,
        callBias: -0,
        aggression: 0.05,
        yakuBonus: 0.3,
        opportunityCost: -0.5,
        noYakuCost: 0,
        neutralShantenCost: 0,
        defense: 0,
        continuationBonus: 0,
      },
    };
    const chi = buildCallDecisionEntry({
      meta,
      fromPlayer: 1,
      tile: "m3",
      actualCalled: true,
      decision: { source: "chi", candidate, evaluation, openMeldCount: 0 },
    });

    expect(pon).toMatchObject({
      callKind: "pon",
      candidateId: "pon:2:z5",
      evaluatorDecision: "call",
      actualDecision: "pass",
      called: false,
      isFirstOpen: true,
      components: { yakuBonus: 0.15, defense: 0 },
    });
    expect(chi).toMatchObject({
      callKind: "chi",
      candidateId: "chi:2:m1-m2-m3",
      sequence: ["m1", "m2", "m3"],
      evaluatorDecision: "call",
      actualDecision: "call",
      called: true,
      components: { callBias: 0 },
    });
    expect(Object.is(callTrace.components.defense, -0)).toBe(true);
    expect(Object.is(evaluation.components.callBias, -0)).toBe(true);
    expectJsonSafe([pon, chi]);
    expect(JSON.parse(JSON.stringify([pon, chi]))).toEqual([pon, chi]);
  });
});
