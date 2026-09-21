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
  scores: number[];
  wallSeed: number;
}

export interface DealEvent {
  type: "deal";
  hands: TileKind[][];
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
  call: "chi" | "pon" | "kan_open" | "kan_closed" | "kan_added";
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

export interface AbortiveDrawEvent {
  type: "abortive_draw";
  reason: import("./abortiveDraw.js").AbortiveDrawReason;
}

export interface HandEndTransition {
  roundWind: number;
  roundHandNumber: number;
  dealerSeat: number;
  dealerContinues: boolean;
  nextDealer: number;
  nextRoundWind: number;
  nextRoundHandNumber: number;
  honbaBefore: number;
  honbaAfter: number;
  kyotakuBefore: number;
  kyotakuAfter: number;
  scoresBeforeSettlement: number[];
  scoresAfterSettlement: number[];
  pointDeltas: Record<number, number>;
}

export interface AuditableWinResult {
  winnerSeat: number;
  loserSeat: number | null;
  method: "ron" | "tsumo";
  winningTile: { kind: TileKind; id: number };
  isDealer: boolean;
  yaku: YakuHit[];
  han: number;
  fu: number;
  yakumanUnits: number;
  basePoints: number;
  totalPoints: number;
  paymentDeltas: Record<number, number>;
  scoringFlags: {
    riichi: boolean;
    doubleRiichi: boolean;
    ippatsu: boolean;
    rinshan: boolean;
    chankan: boolean;
    haitei: boolean;
    houtei: boolean;
    tenhou: boolean;
    chiihou: boolean;
  };
}

export type HandResultSnapshot =
  | ({
      kind: "agari";
      winners: AuditableWinResult[];
      kyotakuRecipient: number | null;
      kyotakuAwarded: number;
    } & HandEndTransition)
  | ({
      kind: "exhaustive_draw";
      tenpaiSeats: number[];
      notenSeats: number[];
      nagashiManganSeats: number[];
    } & HandEndTransition)
  | ({
      kind: "abortive_draw";
      reason: import("./abortiveDraw.js").AbortiveDrawReason;
    } & HandEndTransition);

export interface HandEndEvent {
  type: "hand_end";
  scores: number[];
  nextDealer: number;
  honba: number;
  kyotaku: number;
  /** Additive authoritative snapshot. Historical replay records may omit this field. */
  result?: HandResultSnapshot;
}

export interface GameEndEvent {
  type: "game_end";
  finalScores: number[];
  /** "length" = ended right at the scheduled last hand (someone had already reached
   *  rules.targetScore by then, so no extension was needed); "extension_end" = the schedule
   *  was exhausted but nobody had reached targetScore yet, so 1+ extra hands were played
   *  (the configured target-score extension) until someone did; "tobi" = a player's
   *  score went below 0 at the end of some hand's scoring, ending the whole game
   *  immediately regardless of schedule/target. finalScores already reflects any leftover
   *  riichi-stick (kyotaku) settlement to the 1st-place player. */
  reason: "length" | "extension_end" | "tobi";
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
  | AbortiveDrawEvent
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
 * part of the engine's own state machine. Discard, riichi, and call decisions have distinct
 * entries so scored candidates and character-specific modifiers remain observable.
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
    ukeireTileCount?: number;
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

/** Riichi and call diagnostics remain separate from rule events. Riichi detail is emitted
 * for the existing supported path; call detail is emitted for every CharacterAI candidate. */
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
  callKind: "chi" | "pon" | "daiminkan";
  fromPlayer: number;
  tile: TileKind;
  /** Stable within one discard-response window; chi sequences distinguish alternatives. */
  candidateId: string;
  sequence?: [TileKind, TileKind, TileKind];
  shantenBefore: number;
  shantenAfter: number;
  callScore: number;
  effortAversionCost: number;
  shantenGain: number;
  ukeireBefore: number;
  ukeireAfter: number;
  ukeireGain: number;
  openMeldCount: number;
  isFirstOpen: boolean | null;
  yakuSecured: boolean;
  called: boolean;
  baselineCallScore: number;
  adjustedCallScore: number;
  effortModifier: number;
  commitmentModifier: number;
  baselineDecision: "call" | "pass";
  adjustedDecision: "call" | "pass";
  mechanicChangedDecision: boolean;
  /** Evaluator willingness before arbitration; actualDecision reflects the selected action. */
  evaluatorDecision: "call" | "pass";
  actualDecision: "call" | "pass";
  components: {
    base?: number;
    shantenBonus: number;
    ukeireBonus: number;
    callBias: number;
    aggression: number;
    defense: number;
    yakuBonus: number;
    opportunityCost?: number;
    noYakuCost?: number;
    neutralShantenCost?: number;
    continuationBonus?: number;
    effort: number;
    commitment: number;
    entropyJitter: number;
    mistakeJitter: number;
  };
}

export type AiDecisionEntry = AiDiscardDecisionEntry | AiRiichiDecisionEntry | AiCallDecisionEntry;
