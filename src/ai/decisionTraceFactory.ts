import type { ChiDecisionEvaluation } from "./chiDecision.js";
import type { CallDecisionTrace, DiscardDebugInfo, RiichiDecisionTrace } from "./characterAI.js";
import type { ChiCandidate } from "../core/discardResponses.js";
import type {
  AiCallDecisionEntry,
  AiDiscardDecisionEntry,
  AiRiichiDecisionEntry,
} from "../core/GameLog.js";
import type { TileKind } from "../core/tiles.js";

export interface DecisionTraceMeta {
  handIndex: number;
  player: number;
  characterId: string;
}

function jsonSafeCopy<T>(value: T): T {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("AI decision trace contains a non-finite number");
    return (Object.is(value, -0) ? 0 : value) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((entry) => jsonSafeCopy(entry)) as unknown as T;
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) copy[key] = jsonSafeCopy(entry);
    }
    return copy as unknown as T;
  }
  return value;
}

export function buildDiscardDecisionEntry(
  meta: DecisionTraceMeta,
  debug: DiscardDebugInfo
): AiDiscardDecisionEntry {
  return jsonSafeCopy<AiDiscardDecisionEntry>({
    type: "discard_decision",
    ...meta,
    chosenKind: debug.chosenKind,
    topCandidates: debug.topCandidates,
    sandbagged: debug.sandbagged,
    overloadTriggered: debug.overloadTriggered,
    experimentRouteActive: debug.experimentRouteActive,
    baselineBestKind: debug.baselineBestKind,
    specialAdjustedBestKind: debug.specialAdjustedBestKind,
    ariChoiceChanged: debug.ariChoiceChanged,
    chosenBaselineScore: debug.chosenBaselineScore,
    chosenSpecialScore: debug.chosenSpecialScore,
    chosenShapeCleanlinessDelta: debug.chosenShapeCleanlinessDelta,
    chosenContaminationDelta: debug.chosenContaminationDelta,
    mageunaRoute: debug.mageunaRoute,
    mageunaRouteConsistent: debug.mageunaRouteConsistent,
    mageunaDisruptionActive: debug.mageunaDisruptionActive,
    mageunaDisruptionTurnsLeft: debug.mageunaDisruptionTurnsLeft,
    mageunaPlanBonusApplied: debug.mageunaPlanBonusApplied,
    effieChosenTurnsHeld: debug.effieChosenTurnsHeld,
    effieChosenAttachmentDelta: debug.effieChosenAttachmentDelta,
    optimaEffectiveEntropy: debug.optimaEffectiveEntropy,
    optimaState: debug.optimaState,
    ariBaselineBestKind: debug.ariBaselineBestKind,
    ariAdjustedBestKind: debug.ariAdjustedBestKind,
    ariMechanicChangedBest: debug.ariMechanicChangedBest,
    mageunaBaselineBestKind: debug.mageunaBaselineBestKind,
    mageunaAdjustedBestKind: debug.mageunaAdjustedBestKind,
    mageunaMechanicChangedBest: debug.mageunaMechanicChangedBest,
    effieBaselineBestKind: debug.effieBaselineBestKind,
    effieAdjustedBestKind: debug.effieAdjustedBestKind,
    effieMechanicChangedBest: debug.effieMechanicChangedBest,
    optimaScoreGap: debug.optimaScoreGap,
    optimaPoolSize: debug.optimaPoolSize,
    optimaBaselinePoolSize: debug.optimaBaselinePoolSize,
    optimaChosenRank: debug.optimaChosenRank,
    optimaBaseEntropy: debug.optimaBaseEntropy,
    optimaEntropyModifier: debug.optimaEntropyModifier,
    kyleBaselineBestKind: debug.kyleBaselineBestKind,
    kyleAdjustedBestKind: debug.kyleAdjustedBestKind,
    kyleMechanicChangedBest: debug.kyleMechanicChangedBest,
    kyleRouteState: debug.kyleRouteState,
    nahuiBaselineBestKind: debug.nahuiBaselineBestKind,
    nahuiOverloadPoolBestKind: debug.nahuiOverloadPoolBestKind,
    nahuiActualChosenKind: debug.nahuiActualChosenKind,
    nahuiOverloadChangedChoice: debug.nahuiOverloadChangedChoice,
    tosukeSandbaggingActive: debug.tosukeSandbaggingActive,
    tosukeInterventionTriggered: debug.tosukeInterventionTriggered,
    tosukeBaselineBestKind: debug.tosukeBaselineBestKind,
    tosukeAdjustedBestKind: debug.tosukeAdjustedBestKind,
    tosukeMechanicChangedBest: debug.tosukeMechanicChangedBest,
    tosukeSandbaggingDelta: debug.tosukeSandbaggingDelta,
    tosukeReason: debug.tosukeReason,
  });
}

export function buildRiichiDecisionEntry(
  meta: DecisionTraceMeta,
  trace: RiichiDecisionTrace
): AiRiichiDecisionEntry {
  return jsonSafeCopy<AiRiichiDecisionEntry>({
    type: "riichi_decision",
    ...meta,
    riichiScore: trace.riichiScore,
    damaScore: trace.damaScore,
    commitmentCost: trace.commitmentCost,
    declared: trace.declared,
    baselineRiichiScore: trace.baselineRiichiScore,
    baselineDamaScore: trace.baselineDamaScore,
    adjustedRiichiScore: trace.adjustedRiichiScore,
    adjustedDamaScore: trace.adjustedDamaScore,
    baselineDecision: trace.baselineDecision,
    adjustedDecision: trace.adjustedDecision,
    mechanicChangedDecision: trace.mechanicChangedDecision,
    actualDecision: trace.actualDecision,
    forced: trace.forced,
  });
}

interface CharacterCallEntryInput {
  source: "character";
  trace: CallDecisionTrace;
}

interface ChiCallEntryInput {
  source: "chi";
  candidate: ChiCandidate;
  evaluation: ChiDecisionEvaluation;
  openMeldCount: number;
}

export interface BuildCallDecisionEntryOptions {
  meta: DecisionTraceMeta;
  fromPlayer: number;
  tile: TileKind;
  actualCalled: boolean;
  decision: CharacterCallEntryInput | ChiCallEntryInput;
}

export function buildCallDecisionEntry(options: BuildCallDecisionEntryOptions): AiCallDecisionEntry {
  const { meta, fromPlayer, tile, actualCalled, decision } = options;
  if (decision.source === "character") {
    const { trace } = decision;
    return jsonSafeCopy<AiCallDecisionEntry>({
      type: "call_decision",
      ...meta,
      callKind: trace.callKind,
      fromPlayer,
      tile,
      candidateId: `${trace.callKind}:${meta.player}:${tile}`,
      shantenBefore: trace.beforeShanten,
      shantenAfter: trace.afterShanten,
      callScore: trace.callScore,
      effortAversionCost: trace.effortAversionCost,
      shantenGain: trace.shantenGain,
      ukeireBefore: trace.beforeUkeire,
      ukeireAfter: trace.afterUkeire,
      ukeireGain: trace.ukeireGain,
      openMeldCount: trace.openMeldCount,
      isFirstOpen: trace.openMeldCount === 0,
      yakuSecured: trace.isYakuhai,
      called: actualCalled,
      baselineCallScore: trace.baselineCallScore,
      adjustedCallScore: trace.adjustedCallScore,
      effortModifier: trace.effortModifier,
      commitmentModifier: trace.commitmentModifier,
      baselineDecision: trace.baselineDecision,
      adjustedDecision: trace.adjustedDecision,
      mechanicChangedDecision: trace.mechanicChangedDecision,
      evaluatorDecision: trace.actualDecision,
      actualDecision: actualCalled ? "call" : "pass",
      components: {
        base: trace.components.base,
        shantenBonus: trace.components.shantenBonus,
        ukeireBonus: trace.components.ukeireBonus,
        callBias: trace.components.callBias,
        aggression: trace.components.aggression,
        defense: trace.components.defense,
        yakuBonus: trace.components.yakuhaiBonus,
        effort: trace.components.effort,
        commitment: trace.components.commitment,
        entropyJitter: trace.components.entropyJitter,
        mistakeJitter: trace.components.mistakeJitter,
      },
    });
  }

  const { candidate, evaluation, openMeldCount } = decision;
  const evaluatorDecision = evaluation.shouldCall ? "call" : "pass";
  return jsonSafeCopy<AiCallDecisionEntry>({
    type: "call_decision",
    ...meta,
    callKind: "chi",
    fromPlayer,
    tile,
    candidateId: `chi:${candidate.seat}:${candidate.sequence.join("-")}`,
    sequence: candidate.sequence,
    shantenBefore: evaluation.beforeShanten,
    shantenAfter: evaluation.afterShanten,
    callScore: evaluation.score,
    effortAversionCost: 0,
    shantenGain: evaluation.shantenGain,
    ukeireBefore: evaluation.beforeUkeire,
    ukeireAfter: evaluation.afterUkeire,
    ukeireGain: evaluation.ukeireGain,
    openMeldCount,
    isFirstOpen: evaluation.isFirstOpen,
    yakuSecured: evaluation.hasOpenYaku,
    called: actualCalled,
    baselineCallScore: evaluation.score,
    adjustedCallScore: evaluation.score,
    effortModifier: 0,
    commitmentModifier: 0,
    baselineDecision: evaluatorDecision,
    adjustedDecision: evaluatorDecision,
    mechanicChangedDecision: false,
    evaluatorDecision,
    actualDecision: actualCalled ? "call" : "pass",
    components: {
      ...evaluation.components,
      effort: 0,
      commitment: 0,
      entropyJitter: 0,
      mistakeJitter: 0,
    },
  });
}
