import type { TileKind } from "./tiles.js";
import type { YakuHit } from "../yaku/types.js";
import type { RuleConfig } from "../rules/RuleConfig.js";

export interface HandStartEvent {
  type: "hand_start";
  handIndex: number;
  roundWind: number;
  roundHandNumber: number;
  dealer: number;
  honba: number;
  kyotaku: number;
  scores: [number, number, number];
  wallSeed: number;
}

export interface DealEvent {
  type: "deal";
  hands: [TileKind[], TileKind[], TileKind[]];
  doraIndicator: TileKind;
}

export interface DrawEvent {
  type: "draw";
  player: number;
  tile: TileKind;
  source: "wall" | "rinshan";
}

export interface DiscardEvent {
  type: "discard";
  player: number;
  tile: TileKind;
  tsumogiri: boolean;
  riichiDeclaration: boolean;
}

export interface CallEvent {
  type: "call";
  call: "pon" | "kan_open" | "kan_closed" | "kan_added";
  player: number;
  kind: TileKind;
  fromPlayer?: number;
}

export interface KitaEvent {
  type: "kita";
  player: number;
  tile: TileKind;
}

export interface RiichiEvent {
  type: "riichi";
  player: number;
}

export interface WinEvent {
  type: "win";
  player: number;
  isTsumo: boolean;
  ronFrom?: number;
  yaku: YakuHit[];
  han: number;
  fu: number;
  yakumanUnits: number;
  points: number;
  deltas: Record<number, number>;
}

export interface DrawGameEvent {
  type: "exhaustive_draw";
  tenpaiPlayers: number[];
  deltas: Record<number, number>;
}

export interface HandEndEvent {
  type: "hand_end";
  scores: [number, number, number];
  nextDealer: number;
  honba: number;
  kyotaku: number;
}

export interface GameEndEvent {
  type: "game_end";
  finalScores: [number, number, number];
  /** "length" = normal end-of-round-length termination; "tobi" = a player's score went
   *  below 0 at the end of some hand's scoring, ending the whole game immediately. */
  reason: "length" | "tobi";
  /** Player indices whose final score is < 0. Always [] for reason "length". */
  eliminatedPlayers: number[];
}

export type GameEvent =
  | HandStartEvent
  | DealEvent
  | DrawEvent
  | DiscardEvent
  | CallEvent
  | KitaEvent
  | RiichiEvent
  | WinEvent
  | DrawGameEvent
  | HandEndEvent
  | GameEndEvent;

export interface GameRecord {
  seed: string;
  rules: RuleConfig;
  events: GameEvent[];
}

/**
 * CharacterAI decision-debug entries, kept in a layer SEPARATE from the rule-accurate
 * GameEvent log above: this is instrumentation for external analysis/replay tooling, not
 * part of the engine's own state machine. Only discard decisions are captured, since
 * that's where CharacterAI's scored-candidate pool and special-mechanic flags live.
 */
export interface AiDiscardDecisionEntry {
  type: "discard_decision";
  handIndex: number;
  player: number;
  characterId: string;
  chosenKind: TileKind;
  topCandidates: {
    kind: TileKind;
    score: number;
    baselineScore?: number;
    shapeCleanlinessDelta?: number;
    contaminationDelta?: number;
    ariShapeDelta?: number;
    ariContaminationDelta?: number;
    shanten?: number;
    ukeire?: number;
    danger?: number;
    isIsolated?: boolean;
    mageunaPlanDelta?: number;
    mageunaDisruptionDelta?: number;
    effieTurnsHeld?: number;
    effieAttachmentDelta?: number;
    kyleExperimentDelta?: number;
  }[];
  sandbagged: boolean;
  overloadTriggered: boolean;
  experimentRouteActive: "chiitoi" | "honitsu" | null;
  /** Ari-only (byeonari) diagnostics - null for every other character. See
   *  computeAriSpecialDeltas / CharacterAI.chooseDiscard's DiscardDebugInfo comment. */
  baselineBestKind: TileKind | null;
  specialAdjustedBestKind: TileKind | null;
  ariChoiceChanged: boolean | null;
  chosenBaselineScore: number | null;
  chosenSpecialScore: number | null;
  chosenShapeCleanlinessDelta: number | null;
  chosenContaminationDelta: number | null;
  ariBaselineBestKind: TileKind | null;
  ariAdjustedBestKind: TileKind | null;
  ariMechanicChangedBest: boolean | null;
  /** Mageuna-only (mageuna) diagnostics - null for every other character. */
  mageunaRoute: "chiitoi" | "honitsu" | "standard" | null;
  mageunaRouteConsistent: boolean | null;
  mageunaDisruptionActive: boolean | null;
  mageunaDisruptionTurnsLeft: number | null;
  mageunaPlanBonusApplied: number | null;
  mageunaBaselineBestKind: TileKind | null;
  mageunaAdjustedBestKind: TileKind | null;
  mageunaMechanicChangedBest: boolean | null;
  /** Effie-only (effieminos) diagnostics - null for every other character. */
  effieChosenTurnsHeld: number | null;
  effieChosenAttachmentDelta: number | null;
  effieBaselineBestKind: TileKind | null;
  effieAdjustedBestKind: TileKind | null;
  effieMechanicChangedBest: boolean | null;
  /** Optima-215-only (optima215) diagnostics - null for every other character. */
  optimaEffectiveEntropy: number | null;
  optimaState: "clear" | "ambiguous" | null;
  optimaScoreGap: number | null;
  optimaPoolSize: number | null;
  optimaBaselinePoolSize: number | null;
  optimaChosenRank: number | null;
  optimaBaseEntropy: number | null;
  optimaEntropyModifier: number | null;
  /** Kyle-only (kyletyler) diagnostics - null for every other character. */
  kyleBaselineBestKind: TileKind | null;
  kyleAdjustedBestKind: TileKind | null;
  kyleMechanicChangedBest: boolean | null;
  kyleRouteState: "chiitoi" | "honitsu" | null;
  /** Nahui-only (jegalnahui) diagnostics - null for every other character. */
  nahuiBaselineBestKind: TileKind | null;
  nahuiOverloadPoolBestKind: TileKind | null;
  nahuiActualChosenKind: TileKind | null;
  nahuiOverloadChangedChoice: boolean | null;
  /** Tosuke-only (seiyatosuke) diagnostics - null for every other character. */
  tosukeSandbaggingActive: boolean | null;
  tosukeInterventionTriggered: boolean | null;
  tosukeBaselineBestKind: TileKind | null;
  tosukeAdjustedBestKind: TileKind | null;
  tosukeMechanicChangedBest: boolean | null;
  tosukeSandbaggingDelta: number | null;
  tosukeReason: "sandbag" | "intervention" | "none" | null;
}

/**
 * Jo Sangmin-only diagnostic entries for riichi and call decisions, kept separate from
 * discard_decision above since effortAversion/commitmentAversion act on those decisions,
 * not on chooseDiscard. Only pushed for a profile with effortAversion/commitmentAversion
 * defined; other characters' riichi/call decisions aren't logged (matches the existing
 * discard_decision entry, which is likewise CharacterAI-only instrumentation).
 */
export interface AiRiichiDecisionEntry {
  type: "riichi_decision";
  handIndex: number;
  player: number;
  characterId: string;
  riichiScore: number;
  damaScore: number;
  commitmentCost: number;
  declared: boolean;
  baselineRiichiScore: number;
  baselineDamaScore: number;
  adjustedRiichiScore: number;
  adjustedDamaScore: number;
  baselineDecision: "riichi" | "dama";
  adjustedDecision: "riichi" | "dama";
  mechanicChangedDecision: boolean;
  actualDecision: "riichi" | "dama";
  /** True when dama had no legal win to fall back on, so riichi was declared
   *  unconditionally - the score fields are informational only in that case. */
  forced: boolean;
}

export interface AiCallDecisionEntry {
  type: "call_decision";
  handIndex: number;
  player: number;
  characterId: string;
  callKind: "pon" | "daiminkan";
  callScore: number;
  effortAversionCost: number;
  shantenGain: number;
  called: boolean;
  baselineCallScore: number;
  adjustedCallScore: number;
  effortModifier: number;
  commitmentModifier: number;
  baselineDecision: "call" | "pass";
  adjustedDecision: "call" | "pass";
  mechanicChangedDecision: boolean;
  actualDecision: "call" | "pass";
}

export type AiDecisionEntry = AiDiscardDecisionEntry | AiRiichiDecisionEntry | AiCallDecisionEntry;
