import type { Hand } from "../core/Hand.js";
import type { RuleConfig } from "../rules/RuleConfig.js";
import type { ChiCandidate } from "../core/discardResponses.js";
import { evaluateChiDecision, type ChiDecisionEvaluation } from "./chiDecision.js";
import type { Tile, TileKind } from "../core/tiles.js";
import { isHonor, isTerminalOrHonor, parseKind, allKindsForRules } from "../core/tiles.js";
import { tilesToCounts, kindsToCounts, kindToSlot } from "../core/tileIndex.js";
import { standardShanten, chiitoitsuShanten, kokushiShanten } from "../shanten/shanten.js";
import { computeWinningTiles, computeImprovingTiles, computeImprovingTileCount } from "../actions/winSearch.js";
import { canDeclareRiichi, wouldBeTenpaiAfterDiscard } from "../actions/riichi.js";
import { countDora, countAkaDora } from "../yaku/dora.js";
import { evaluateWin } from "../yaku/evaluate.js";
import type { WinContext } from "../yaku/types.js";
import { meldsToGroups } from "../yaku/meldConvert.js";
import { SeededRng } from "../core/rng.js";
import { pickNonRedRepresentative, shouldDeclareKita } from "./simpleAI.js";
import type { CharacterProfile } from "./characterProfile.js";

/**
 * CharacterAI is an additive personality layer built ON TOP of the same primitives
 * SimpleAI uses (shanten, winSearch, riichi eligibility, dora) - it does not replace or
 * modify SimpleAI, and SimpleAI remains the engine's default decision-maker when no
 * character profile is assigned to a seat. This keeps every existing SimpleAI-driven test
 * byte-for-byte unaffected by this feature.
 *
 * Global rules (see characterProfile.ts) are enforced structurally here: every decision
 * starts from the same legality-gated candidate set SimpleAI would use, personality only
 * re-weights and stochastically selects among candidates that are already legal and
 * reasonable - it never invents an illegal or nonsensical option.
 */

function bestShanten(counts: number[], existingMelds: number): number {
  let s = standardShanten(counts, existingMelds);
  if (existingMelds === 0) {
    s = Math.min(s, chiitoitsuShanten(counts), kokushiShanten(counts));
  }
  return s;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** JSON serializes -0 as 0. Trace-only values are normalized at their source so the
 * in-memory decision log and its replay representation remain structurally identical. */
function jsonSafeTraceNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export interface CharacterDecisionContext {
  rules: RuleConfig;
  riichiOpponentDiscardKinds: TileKind[][];
  doraIndicatorKinds: TileKind[];
  /** Every tile kind currently visible on the table OUTSIDE this hand: all 3 seats'
   *  discards, meld tiles, and extracted kita tiles, plus the revealed dora indicators (ura
   *  indicators are hidden until a win and are NOT included). Used to compute true
   *  unseen-copy counts (computeImprovingTileCount) - never includes this hand's own
   *  concealed tiles, which callers subtract separately. */
  visibleTileKinds: TileKind[];
  seatWind: number;
  roundWind: number;
  wallRemainingLive: number;
  /** This player's own score and the other two seats' scores, for Tosuke's intervention check. */
  ownScore: number;
  opponentScores: number[];
  /** Seats corresponding to opponentScores, in table turn order. */
  opponentSeats?: number[];
  /** Riichi seats corresponding to riichiOpponentDiscardKinds when available. */
  riichiOpponentSeats?: number[];
  isLastHandOfGame: boolean;
  /** Whether this seat is the current hand's dealer. Plumbing only in this pass - no
   *  decision formula reads it yet; wire it into an existing formula (via this shared
   *  context) rather than adding a new dealer-specific profile parameter. */
  isDealer: boolean;
}

interface DiscardCandidate {
  kind: TileKind;
  tile: Tile;
  shanten: number;
  ukeire: number;
  /** Unseen-copy-weighted ukeire (computeImprovingTileCount): sums actual remaining
   *  physical copies of every improving kind, not just how many distinct kinds improve.
   *  0 whenever `ukeire` itself wasn't computed exactly (needsExactUkeire false). */
  ukeireTileCount: number;
  danger: number;
  keepValue: number;
  honitsuFit: number;
  chiitoiFit: number;
  yakumanFit: number;
  isIsolated: boolean;
  score: number;
  /** Diagnostic-only (Ari): score before shapeCleanlinessBias/contaminationAversion are
   *  added, but after everything else including this candidate's skill-noise draw - so
   *  `baselineScore + shapeCleanlinessDelta + contaminationDelta === score` holds exactly.
   *  Always 0 for a profile without either special param. */
  baselineScore: number;
  shapeCleanlinessDelta: number;
  contaminationDelta: number;
  /** Diagnostic-only (Mageuna): the plan-persistence bonus actually added to this
   *  candidate's score, from computeMageunaPlanBonus. */
  mageunaPlanBonus: number;
  /** Diagnostic-only (Effie): turns-held and the attachment delta actually added to
   *  this candidate's score, from computeEffieAttachmentDelta. */
  effieTurnsHeld: number;
  effieAttachmentDelta: number;
  /** Diagnostic-only (Mageuna): the disruption-jitter delta actually added to this
   *  candidate's score this turn (0 whenever disruption isn't active). */
  mageunaDisruptionDelta: number;
  /** Diagnostic-only (Kyle): the net delta applyExperimentBias actually added to this
   *  candidate's score (route-consistency bonus + the general yakuman-curiosity bump
   *  combined - see the report note on why these two aren't cleanly separable without
   *  restructuring computeExperimentBonus's formula). */
  kyleExperimentDelta: number;
}

export interface KyleRouteState {
  route: "chiitoi" | "honitsu" | null;
  committedTurns: number;
}

export interface KyleRouteCandidate {
  shanten: number;
  chiitoiFit: number;
  honitsuFit: number;
  yakumanFit: number;
}

/** Dama legality must consider every real wait; ordering is not a strategic preference. */
export function scanAllDamaWaits(winningKinds: readonly TileKind[], isViable: (kind: TileKind) => boolean): boolean {
  return winningKinds.some(isViable);
}

const SHANTEN_WEIGHT = 10;
/** Upper clamp on speedWeight (see chooseDiscard) - kept as a shared named constant so the
 *  fast-path safety margin below can be derived from it instead of re-guessing the bound. */
const MAX_SPEED_WEIGHT = 0.6;
/** How much extra weight the unseen-copy-weighted ukeireTileCount term gets, relative to
 *  speedWeight's existing per-kind rate - kept small (1/50th) so this only breaks near-ties
 *  between candidates that already tie on shanten and improving-kind count; it never
 *  outweighs a genuine kind-count difference, let alone shanten. */
const UKEIRE_TILE_COUNT_WEIGHT = 0.02;
/** Structural upper bound on ukeireTileCount: at most every tile kind, each with at most 4
 *  physical copies (SLOT_COUNT's own convention - see tileIndex.ts). Used only to size the
 *  fast-path safety margin below, never in real scoring. */
const MAX_COPIES_PER_KIND = 4;

/** rank distance used for suji: a same-suit discard at rank+-3 makes a ryanmen-based deal-in less likely. */
function isSuji(kind: TileKind, discardedKinds: TileKind[]): boolean {
  if (kind[0] === "z") return false;
  const { suit, rank } = parseKind(kind);
  const sujiPartner = rank <= 6 ? `${suit}${rank + 3}` : null;
  const sujiPartner2 = rank >= 4 ? `${suit}${rank - 3}` : null;
  return (sujiPartner !== null && discardedKinds.includes(sujiPartner)) || (sujiPartner2 !== null && discardedKinds.includes(sujiPartner2));
}

function dangerOf(kind: TileKind, riverKinds: TileKind[], useSuji: boolean): number {
  if (riverKinds.includes(kind)) return 0; // genbutsu
  if (useSuji && isSuji(kind, riverKinds)) return 0.35;
  return 1;
}

function isIsolatedTile(kind: TileKind, counts: number[]): boolean {
  if (kind[0] === "z") return counts[parseKind(kind).rank - 1 + 27]! <= 1;
  const { suit, rank } = parseKind(kind);
  const base = { m: 0, p: 9, s: 18 }[suit as "m" | "p" | "s"]!;
  const own = counts[base + rank - 1]!;
  if (own >= 2) return false; // part of a pair already
  const left2 = rank >= 3 ? counts[base + rank - 3]! : 0;
  const left1 = rank >= 2 ? counts[base + rank - 2]! : 0;
  const right1 = rank <= 8 ? counts[base + rank]! : 0;
  const right2 = rank <= 7 ? counts[base + rank + 1]! : 0;
  return left2 + left1 + right1 + right2 === 0;
}

// ---------------------------------------------------------------------------
// Pure, exported building blocks - extracted so each mechanic can be verified in
// isolation with directly-controlled inputs, independent of hand/shanten computation
// or the class's own RNG/state wiring.
// ---------------------------------------------------------------------------

export interface ScoredOption<T> {
  value: T;
  score: number;
}

/** Entropy-controlled softmax selection among already-scored options. Pure function of
 *  its inputs: no shanten, no tolerance/pool-filtering, no skill-noise - just "given these
 *  scores and this entropy, which one gets picked." Higher entropy -> higher temperature
 *  -> flatter distribution -> more selection variety among the options passed in. */
export function sampleByEntropy<T>(options: ScoredOption<T>[], entropy: number, rng: SeededRng): T {
  if (options.length === 0) throw new Error("sampleByEntropy: options must not be empty");
  if (options.length === 1) return options[0]!.value;
  const bestScore = Math.max(...options.map((o) => o.score));
  const temperature = Math.max(0.05, entropy) * 1.5;
  const weights = options.map((o) => Math.exp((o.score - bestScore) / temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng.next() * total;
  for (let i = 0; i < options.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return options[i]!.value;
  }
  return options[options.length - 1]!.value;
}

/** Kyle's experimental-route bonus, isolated from route-selection/abandonment logic:
 *  given that a route is (or isn't) currently active and a candidate's fit for it, how
 *  much bonus does experimentBias/routePersistence add? Zero whenever no route is active,
 *  regardless of fitValue - routePersistence only ever amplifies an already-chosen route. */
export function computeExperimentBonus(routeActive: boolean, fitValue: number, experimentBias: number, routePersistence: number): number {
  if (!routeActive) return 0;
  return experimentBias * routePersistence * 1.2 * fitValue;
}

export interface InterventionFactors {
  /** max(0, best opponent score - own score). */
  scoreDeficit: number;
  isLastHandOfGame: boolean;
  riichiOpponentCount: number;
  /** The best (lowest) shanten among this turn's discard candidates. */
  ownMinShanten: number;
}

/** Tosuke's intervention-pressure score, decoupled from any specific candidate list or
 *  CharacterDecisionContext shape so it can be constructed and logged directly. */
export function computeInterventionPressure(factors: InterventionFactors): number {
  let pressure = 0;
  pressure += clamp(factors.scoreDeficit / 20000, 0, 1) * 0.4;
  if (factors.isLastHandOfGame) pressure += 0.4;
  if (factors.riichiOpponentCount >= 2) pressure += 0.25;
  if (factors.ownMinShanten <= 0) pressure += 0.2;
  return clamp(pressure, 0, 1.5);
}

export interface AriSpecialDeltas {
  shapeCleanlinessDelta: number;
  contaminationDelta: number;
}

/** Ari's two special-mechanic score deltas, isolated as a pure function of exactly the
 *  inputs they depend on - directly unit-testable without constructing a hand, a
 *  profile, or a CharacterAI instance. Mirrors the score computation inline in
 *  chooseDiscard exactly (same terms, same order of operations); undefined once for
 *  the missing param means that term is always 0, matching "not this character". */
export function computeAriSpecialDeltas(
  isolated: boolean,
  danger: number,
  shapeCleanlinessBias: number | undefined,
  contaminationAversion: number | undefined
): AriSpecialDeltas {
  let shapeCleanlinessDelta = 0;
  if (shapeCleanlinessBias !== undefined && isolated) {
    shapeCleanlinessDelta = shapeCleanlinessBias * 0.5;
  }
  let contaminationDelta = 0;
  if (contaminationAversion !== undefined) {
    if (danger > 0 && danger < 1) contaminationDelta -= contaminationAversion * 0.4; // marginal (suji-only) pushes
    if (isolated) contaminationDelta += contaminationAversion * 0.15; // prefer clearing dead tiles
  }
  return { shapeCleanlinessDelta, contaminationDelta };
}

/** Mageuna's plan-persistence bonus: zero unless the candidate is consistent with the
 *  hand's already-forming development direction (routeConsistent), mirroring
 *  computeExperimentBonus's shape - a small, bounded nudge that can never override a
 *  genuinely better candidate (SHANTEN_WEIGHT still dominates by a wide margin). */
export function computeMageunaPlanBonus(routeConsistent: boolean, fitValue: number, planPersistence: number): number {
  if (!routeConsistent) return 0;
  return planPersistence * 0.4 * fitValue;
}

/** Effie's attachment retention delta: always <= 0 (a penalty against discarding
 *  material that has accumulated value-relevant attachment), scaled down to 0 by
 *  releaseFactor once the material stops being the best-shanten line, becomes
 *  meaningfully dangerous, or no longer contributes to any tracked value. */
export function computeEffieAttachmentDelta(attachmentLevel: number, attachmentBias: number, releaseFactor: number): number {
  return -(attachmentBias * attachmentLevel * releaseFactor * 0.5);
}

/** Optima-215's conditional entropy reinterpretation: a large score gap between the top
 *  two pool candidates collapses entropy toward near-deterministic top-pick selection
 *  (scaled by binaryConfidence); a tight cluster within the normal close-candidate band
 *  instead inflates entropy among just that cluster (scaled by ambiguitySensitivity).
 *  Pure function of the pool's own scores - consumes no RNG itself; the resulting value
 *  is simply the entropy sampleByEntropy already accepts as a parameter. */
export function computeOptimaEffectiveEntropy(
  poolScoresDescending: number[],
  baseEntropy: number,
  binaryConfidence: number,
  ambiguitySensitivity: number,
  toleranceUnit: number
): number {
  if (poolScoresDescending.length <= 1) return baseEntropy;
  const gap = poolScoresDescending[0]! - poolScoresDescending[1]!;
  if (gap > toleranceUnit * 0.5) return baseEntropy * (1 - binaryConfidence);
  return baseEntropy * (1 + ambiguitySensitivity);
}

/** Jo Sangmin's small fixed cost against declaring riichi, applied to riichiScore before
 *  it's compared with damaScore - only flips genuinely close decisions (see
 *  shouldDeclareRiichi), never a hand with no other legal way to win (that check already
 *  short-circuits before this cost is ever applied). */
export function computeSangminRiichiCommitmentCost(commitmentAversion: number): number {
  return commitmentAversion * 0.12;
}

/** Jo Sangmin's small cost against calling: a flat commitment cost for any call, plus an
 *  extra effort cost when the call doesn't even clearly advance shanten (shantenGain < 1)
 *  - a call with a real shanten advantage only pays the flat commitment cost. */
export function computeSangminCallCost(effortAversion: number, commitmentAversion: number, shantenGain: number): number {
  let cost = commitmentAversion * 0.1;
  if (shantenGain < 1) cost += effortAversion * 0.12;
  return cost;
}

/** Jo Sangmin-only: the riichi-vs-dama decision, with the commitment cost actually
 *  applied. Populated only when commitmentAversion is defined (else stays null - see
 *  shouldDeclareRiichi). */
export interface RiichiDecisionTrace {
  /** Post-cost, post-jitter - the REAL score that decided `declared` (identical to the
   *  actual production computation; kept for backward compatibility with existing code). */
  riichiScore: number;
  damaScore: number;
  commitmentCost: number;
  declared: boolean;
  /** Deterministic, pre-jitter, pre-cost riichi score (the shared-evaluator baseline). */
  baselineRiichiScore: number;
  baselineDamaScore: number;
  /** Deterministic, pre-jitter, WITH commitmentCost applied. */
  adjustedRiichiScore: number;
  adjustedDamaScore: number;
  /** Deterministic decisions (no entropy/mistakeRate jitter) - "riichi" or "dama". */
  baselineDecision: "riichi" | "dama";
  adjustedDecision: "riichi" | "dama";
  mechanicChangedDecision: boolean;
  /** The real, RNG-jitter-included decision - identical to `declared`, named to match
   *  the requested actualDecision/baselineDecision/adjustedDecision triple. */
  actualDecision: "riichi" | "dama";
  /** True when dama had no legal win to fall back on, so riichi was declared
   *  unconditionally (the score comparison below never actually ran/decided anything -
   *  the score fields are still computed and reported for information, but
   *  mechanicChangedDecision is always false here since nothing could have changed a
   *  forced outcome). */
  forced: boolean;
}

/** Read-only observability for the existing pon/daiminkan evaluator. */
export interface CallDecisionTrace {
  /** Post-cost, post-jitter - the REAL score that decided `called`. */
  callScore: number;
  effortAversionCost: number;
  beforeShanten: number;
  afterShanten: number;
  shantenGain: number;
  beforeUkeire: number;
  afterUkeire: number;
  ukeireGain: number;
  openMeldCount: number;
  isYakuhai: boolean;
  called: boolean;
  callKind: "pon" | "daiminkan";
  /** Deterministic, pre-jitter, pre-cost call score (the shared-evaluator baseline). This
   *  architecture uses a single threshold (callScore > 0.5), not a symmetric call-vs-pass
   *  score pair, so there is no real "pass score" to report separately - inventing one
   *  wasn't done here per the "don't invent a debug-only score" instruction. */
  baselineCallScore: number;
  /** Deterministic, pre-jitter, WITH effort/commitment cost applied. */
  adjustedCallScore: number;
  effortModifier: number;
  commitmentModifier: number;
  baselineDecision: "call" | "pass";
  adjustedDecision: "call" | "pass";
  mechanicChangedDecision: boolean;
  actualDecision: "call" | "pass";
  components: {
    base: number;
    shantenBonus: number;
    ukeireBonus: number;
    yakuhaiBonus: number;
    callBias: number;
    aggression: number;
    defense: number;
    effort: number;
    commitment: number;
    entropyJitter: number;
    mistakeJitter: number;
  };
}

export type StrategicKanKind = "ankan" | "shouminkan";

export interface StrategicKanInput {
  kind: StrategicKanKind;
  currentShanten: number;
  afterKanShanten: number;
  currentUkeire: number;
  afterKanUkeire: number;
  currentUkeireTileCount: number;
  afterKanUkeireTileCount: number;
  riichi: boolean;
  riichiOpponentCount: number;
  wallRemainingLive: number;
  defense: number;
  riskTolerance: number;
}

export interface KanDecisionTrace {
  kind: StrategicKanKind;
  baselineScore: number;
  adjustedScore: number;
  effortModifier: number;
  commitmentModifier: number;
  baselineDecision: "kan" | "pass";
  adjustedDecision: "kan" | "pass";
  declared: boolean;
}

export function evaluateStrategicKanDecision(
  input: StrategicKanInput,
  effortAversion = 0,
  commitmentAversion = 0
): KanDecisionTrace {
  const shantenDelta = input.currentShanten - input.afterKanShanten;
  const ukeireDelta = input.afterKanUkeire - input.currentUkeire;
  const tileCountDelta = input.afterKanUkeireTileCount - input.currentUkeireTileCount;
  const closeToTenpai = input.currentShanten <= 1 ? 0.14 : -Math.min(0.24, (input.currentShanten - 1) * 0.08);
  const progressValue = shantenDelta * 0.38 + clamp(ukeireDelta, -8, 8) * 0.025 + clamp(tileCountDelta, -24, 24) * 0.008;
  const threatPenalty = input.riichiOpponentCount * (0.1 + input.defense * 0.12) * (1.2 - input.riskTolerance * 0.4);
  const lateWallPenalty = input.wallRemainingLive < 8 ? 0.18 : input.wallRemainingLive < 15 ? 0.08 : 0;
  const riichiPenalty = input.riichi ? 1 : 0;
  const baselineScore = 0.5 + closeToTenpai + progressValue - threatPenalty - lateWallPenalty - riichiPenalty;
  const commitmentModifier = commitmentAversion * 0.14;
  const effortModifier = effortAversion * (shantenDelta > 0 || tileCountDelta >= 4 ? 0.03 : 0.12);
  const adjustedScore = baselineScore - commitmentModifier - effortModifier;
  return {
    kind: input.kind,
    baselineScore,
    adjustedScore,
    effortModifier,
    commitmentModifier,
    baselineDecision: baselineScore >= 0.5 ? "kan" : "pass",
    adjustedDecision: adjustedScore >= 0.5 ? "kan" : "pass",
    declared: adjustedScore >= 0.5,
  };
}

export interface SandbaggingTrace {
  trueChoice: TileKind;
  finalChoice: TileKind;
  sandbagged: boolean;
  interventionPressure: number;
  interventionThreshold: number;
  interventionActive: boolean;
}

/** Read-only introspection snapshot of one chooseDiscard call, for external logging
 *  (e.g. a replay/kifu recorder) - never consulted by any decision logic itself. */
export interface DiscardDebugInfo {
  chosenKind: TileKind;
  /** Up to the top 5 candidates by final score, most-preferred first. The extra
   *  baselineScore/shapeCleanlinessDelta/contaminationDelta fields are only populated
   *  when the profile has shapeCleanlinessBias or contaminationAversion defined (Ari) -
   *  omitted (undefined) for every other character to keep this lightweight elsewhere. */
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
  /** Ari-only diagnostics (null for every other character - no shapeCleanlinessBias or
   *  contaminationAversion means baselineScore === score for every candidate, so these
   *  would carry no information). See computeAriSpecialDeltas for the delta formulas. */
  baselineBestKind: TileKind | null;
  /** Equal to topCandidates[0].kind - the real, special-adjusted top pick - kept as its
   *  own named field so "did the special logic change the #1 candidate" (this vs.
   *  baselineBestKind) reads clearly without re-deriving it from topCandidates. */
  specialAdjustedBestKind: TileKind | null;
  /** baselineBestKind !== specialAdjustedBestKind - whether Ari's special logic changed
   *  which candidate ranks #1. NOT the same question as "did chosenKind change": entropy/
   *  mistakeRate/pool selection can still pick something other than the #1 candidate. */
  ariChoiceChanged: boolean | null;
  chosenBaselineScore: number | null;
  chosenSpecialScore: number | null;
  chosenShapeCleanlinessDelta: number | null;
  chosenContaminationDelta: number | null;
  /** Ari-only aliases of baselineBestKind/specialAdjustedBestKind/ariChoiceChanged above,
   *  named to match the other 7 mechanics' <character>BaselineBestKind/<character>
   *  AdjustedBestKind/<character>MechanicChangedBest convention - same values, kept for
   *  cross-character tooling consistency. Not a rename of the originals (unchanged). */
  ariBaselineBestKind: TileKind | null;
  ariAdjustedBestKind: TileKind | null;
  ariMechanicChangedBest: boolean | null;
  /** Mageuna-only (null for every other character). See updateMageunaState.
   *  mageunaBaselineBestKind/mageunaAdjustedBestKind/mageunaMechanicChangedBest isolate
   *  BOTH of her delta terms (plan bonus + disruption jitter) together as "the mechanic",
   *  since disruption only ever fires as a side effect of the same profile. */
  mageunaRoute: "chiitoi" | "honitsu" | "standard" | null;
  mageunaRouteConsistent: boolean | null;
  mageunaDisruptionActive: boolean | null;
  mageunaDisruptionTurnsLeft: number | null;
  mageunaPlanBonusApplied: number | null;
  mageunaBaselineBestKind: TileKind | null;
  mageunaAdjustedBestKind: TileKind | null;
  mageunaMechanicChangedBest: boolean | null;
  /** Effie-only (null for every other character). turnsHeld/attachmentLevel/delta are
   *  for the CHOSEN candidate specifically - see computeEffieAttachmentDelta. */
  effieChosenTurnsHeld: number | null;
  effieChosenAttachmentDelta: number | null;
  effieBaselineBestKind: TileKind | null;
  effieAdjustedBestKind: TileKind | null;
  effieMechanicChangedBest: boolean | null;
  /** Optima-215-only (null for every other character). See computeOptimaEffectiveEntropy.
   *  optimaPoolSize/optimaBaselinePoolSize are always equal by construction (the entropy
   *  reinterpretation only reweights sampling within the pool selectPool/mistakeRate
   *  already produced - it never changes pool membership); both are exposed anyway so
   *  that invariant is directly verifiable from replay data rather than merely asserted. */
  optimaEffectiveEntropy: number | null;
  optimaState: "clear" | "ambiguous" | null;
  optimaScoreGap: number | null;
  optimaPoolSize: number | null;
  optimaBaselinePoolSize: number | null;
  optimaChosenRank: number | null;
  optimaBaseEntropy: number | null;
  /** effectiveEntropy / baseEntropy - reveals which factor (1-binaryConfidence, in the
   *  "clear" state, or 1+ambiguitySensitivity, in the "ambiguous" state) was applied. */
  optimaEntropyModifier: number | null;
  /** Kyle-only (null for every other character). kyleExperimentDelta on topCandidates is
   *  the per-candidate value; these are the resulting best-kind comparison.
   *  kyleRoutePersistenceDelta is NOT separately trackable: computeExperimentBonus
   *  multiplies experimentBias*routePersistence together as a single term, so the two
   *  parameters' individual contributions aren't separable without restructuring that
   *  formula (out of scope here) - kyleExperimentDelta already reflects their combined
   *  effect (plus the general yakuman-curiosity bump), see the report note. */
  kyleBaselineBestKind: TileKind | null;
  kyleAdjustedBestKind: TileKind | null;
  kyleMechanicChangedBest: boolean | null;
  kyleRouteState: "chiitoi" | "honitsu" | null;
  /** Nahui-only (null for every other character). nahuiOverloadChangedChoice follows the
   *  report's suggested definition: overloadTriggered && actualChosenKind !==
   *  nahuiBaselineBestKind - i.e. the glitch didn't just fire, it changed what got picked
   *  (entropy/mistakeRate could still steer the final choice away from either pool's own
   *  deterministic best, which is exactly what this field distinguishes). */
  nahuiBaselineBestKind: TileKind | null;
  nahuiOverloadPoolBestKind: TileKind | null;
  nahuiActualChosenKind: TileKind | null;
  nahuiOverloadChangedChoice: boolean | null;
  /** Tosuke-only (null for every other character) - reuses lastSandbaggingTrace's own
   *  fields rather than recomputing a separate deterministic baseline, per the report's
   *  instruction to reuse that existing trace: trueChoice is already "what would have
   *  been chosen without sandbagging" (via the real entropy-sampled pool pick), and
   *  finalChoice is the post-sandbagging result - both already RNG-consistent with the
   *  real decision, so no new comparison needed. */
  tosukeSandbaggingActive: boolean | null;
  tosukeInterventionTriggered: boolean | null;
  tosukeBaselineBestKind: TileKind | null;
  tosukeAdjustedBestKind: TileKind | null;
  tosukeMechanicChangedBest: boolean | null;
  tosukeSandbaggingDelta: number | null;
  tosukeReason: "sandbag" | "intervention" | "none" | null;
}

export interface CharacterAIOptions {
  /** Test-only escape hatch: forces exact ukeire computation for every discard candidate
   *  instead of only the shanten-tied ones (see the "Pass 1 / Pass 2" comment in
   *  chooseDiscard). Exists so a test can compare the fast path's candidate selection
   *  against the unoptimized reference and confirm the shortcut never changes the outcome.
   *  GameState never sets this - production play always uses the fast path. */
  useExactUkeireForAllCandidates?: boolean;
  /** Test-only escape hatch: seeds the skill-noise and selection-randomness RNG streams
   *  independently instead of both deriving from the single `seed` constructor argument.
   *  Lets a test hold skill-noise's realization fixed while varying only the
   *  entropy/mistakeRate/mechanic-roll stream (or vice versa), to isolate one source of
   *  randomness from the other - which a single shared seed can't do, since candidates
   *  that are genuinely score-tied before noise have their post-noise ranking decided
   *  entirely by skill-noise, and a fresh skill-noise draw per sample would wash out
   *  entropy's own effect on selection even though the two streams are architecturally
   *  separate. GameState never sets this - production play always derives both from `seed`. */
  independentStreamSeeds?: { skillSeed: string | number; selectionSeed: string | number };
}

export class CharacterAI {
  readonly profile: CharacterProfile;
  /** Skill's own noise stream: "skill affects evaluation quality" only ever touches this
   *  RNG, applied once per candidate during scoring, before any pool/selection logic runs. */
  private skillRng: SeededRng;
  /** Everything downstream of scoring - entropy's softmax sampling, mistakeRate's pool
   *  widening, and every special mechanic's own stochastic roll (Nahui's glitch, Tosuke's
   *  sandbagging, the riichi/call decision jitter) - draws from this separate stream, so
   *  skill-driven scoring noise can never masquerade as (or drown out) entropy's own,
   *  distinct "vary selection among already-close candidates" effect. */
  private selectionRng: SeededRng;
  private experimentRoute: "chiitoi" | "honitsu" | null = null;
  private routeCommittedTurns = 0;
  /** Mageuna: the hand-development direction her recent discards have been consistent
   *  with, classified fresh each chooseDiscard call from currently-available candidate
   *  info (no separate route-selection engine). */
  private mageunaRoute: "chiitoi" | "honitsu" | "standard" | null = null;
  private mageunaLastSnapshot: { existingMelds: number; riichiOpponentCount: number; maxDanger: number } | null = null;
  /** Mageuna: counts down after multiple disruption signals overlap in one turn; while
   *  positive, this turn's candidate scores get extra bounded jitter (briefly less
   *  consistent selection) before decaying back to 0. */
  private mageunaDisruptionTurnsLeft = 0;
  /** Effie: turns-held counter per tile kind currently judged "valuable" (dora, honor
   *  pair+, chiitoi/honitsu-contributing material) - entries for kinds no longer in hand
   *  are pruned each call rather than left stale. */
  private effieAttachment: Map<TileKind, number> = new Map();
  private _lastMageunaDebug: { route: "chiitoi" | "honitsu" | "standard"; routeConsistent: boolean; disruptionActive: boolean; disruptionTurnsLeft: number } | null = null;
  private _lastOptimaEffectiveEntropy: number | null = null;
  private _lastOptimaState: "clear" | "ambiguous" | null = null;
  private _lastOptimaExtras: {
    /** null when the pool has only 1 candidate - there's no second-place score to
     *  compare against, so "gap" isn't a meaningful number (not the same as a gap of 0,
     *  which would mean two candidates tied exactly). */
    scoreGap: number | null;
    poolSize: number;
    baseEntropy: number;
    entropyModifier: number;
  } | null = null;
  private _lastOptimaPoolSortedKinds: TileKind[] | null = null;
  private _lastRiichiTrace: RiichiDecisionTrace | null = null;
  private _lastCallTrace: CallDecisionTrace | null = null;
  private _lastKanTrace: KanDecisionTrace | null = null;
  private readonly useExactUkeireForAllCandidates: boolean;
  /** Populated by applySandbagging on every chooseDiscard call for a sandbagging-enabled
   *  profile; null otherwise. Read-only introspection for tests/logging - production code
   *  never depends on it. */
  private _lastSandbaggingTrace: SandbaggingTrace | null = null;
  private _lastOverloadTriggered = false;
  /** Populated at the end of every chooseDiscard call. Read-only introspection for
   *  logging/replay tooling; production decision logic never reads it back. */
  private _lastDiscardDebug: DiscardDebugInfo | null = null;

  get lastSandbaggingTrace(): SandbaggingTrace | null {
    return this._lastSandbaggingTrace;
  }

  get lastDiscardDebug(): DiscardDebugInfo | null {
    return this._lastDiscardDebug;
  }

  /** Mageuna-only diagnostics: this turn's classified route, whether it was consistent
   *  with the prior turn's, and whether disruption-driven jitter was active this turn.
   *  Populated on every chooseDiscard call for a planPersistence-enabled profile. */
  get lastMageunaDebug(): { route: "chiitoi" | "honitsu" | "standard"; routeConsistent: boolean; disruptionActive: boolean; disruptionTurnsLeft: number } | null {
    return this._lastMageunaDebug;
  }

  /** Effie-only diagnostics: a snapshot (turns-held per kind) of the attachment state as
   *  of the end of the most recent chooseDiscard call. Empty map for any other profile. */
  get lastEffieAttachmentSnapshot(): Map<TileKind, number> {
    return new Map(this.effieAttachment);
  }

  /** Optima-215-only diagnostics: the effective entropy actually used for the most
   *  recent chooseDiscard's final selection (null for any other profile, or before the
   *  first call). See computeOptimaEffectiveEntropy. */
  get lastOptimaEffectiveEntropy(): number | null {
    return this._lastOptimaEffectiveEntropy;
  }

  /** Jo Sangmin-only: the most recent shouldDeclareRiichi call's trace, or null if
   *  commitmentAversion isn't defined for this profile (or no call has been made yet). */
  get lastRiichiTrace(): RiichiDecisionTrace | null {
    return this._lastRiichiTrace;
  }

  /** Most recent pon/daiminkan evaluation; read-only and never consulted by decisions. */
  get lastCallTrace(): CallDecisionTrace | null {
    return this._lastCallTrace;
  }

  get lastKanTrace(): KanDecisionTrace | null {
    return this._lastKanTrace;
  }

  constructor(profile: CharacterProfile, seed: string | number, options?: CharacterAIOptions) {
    this.profile = profile;
    if (options?.independentStreamSeeds) {
      this.skillRng = new SeededRng(options.independentStreamSeeds.skillSeed);
      this.selectionRng = new SeededRng(options.independentStreamSeeds.selectionSeed);
    } else {
      this.skillRng = new SeededRng(`${seed}::skill`);
      this.selectionRng = new SeededRng(`${seed}::selection`);
    }
    this.useExactUkeireForAllCandidates = options?.useExactUkeireForAllCandidates ?? false;
  }

  /** Resets per-hand state (Kyle's experimental route tracking). Call at the start of every hand. */
  onHandStart(): void {
    this.experimentRoute = null;
    this.routeCommittedTurns = 0;
    this.mageunaRoute = null;
    this.mageunaLastSnapshot = null;
    this.mageunaDisruptionTurnsLeft = 0;
    this.effieAttachment.clear();
  }

  /** Test-only: forces the experimental-route state directly, bypassing the route-selection
   *  heuristic in applyExperimentBias. Lets a test verify "given a route is ALREADY active,
   *  what does routePersistence do" without needing a real hand to organically trigger route
   *  selection first. Production code (GameState) never calls this. */
  setExperimentRouteForTest(route: "chiitoi" | "honitsu" | null): void {
    this.experimentRoute = route;
    this.routeCommittedTurns = 0;
  }

  /** Test-only snapshot used by Phase 4 regressions to prove candidate scoring is pure and
   *  a completed decision commits at most one route-state transition. */
  getExperimentRouteStateForTest(): Readonly<KyleRouteState> {
    return { route: this.experimentRoute, committedTurns: this.routeCommittedTurns };
  }

  /** Test-only entry point for the same pure candidate evaluator chooseDiscard uses. */
  evaluateExperimentCandidateForTest(
    score: number,
    candidate: KyleRouteCandidate,
    state: Readonly<KyleRouteState>
  ): number {
    return this.applyExperimentBias(score, candidate, state, this.profile);
  }

  // -------------------------------------------------------------------------
  // Discard choice
  // -------------------------------------------------------------------------

  chooseDiscard(hand: Hand, ctx: CharacterDecisionContext, forbiddenDiscardKinds: readonly TileKind[] = []): number {
    const p = this.profile;
    const existingMelds = hand.melds.length;
    const handKinds = new Set(hand.concealed.map((t) => t.kind));
    // Kyle's candidate order is canonical so equivalent hands cannot assign the seeded
    // per-candidate RNG draws differently merely because their physical tiles were listed
    // in a different order. Other profiles retain their established enumeration behavior.
    const uniqueKinds =
      p.experimentBias !== undefined
        ? allKindsForRules(ctx.rules).filter((kind) => handKinds.has(kind))
        : [...handKinds];
    const riichiOpponentCount = ctx.riichiOpponentDiscardKinds.length;
    const allRiverKinds = ctx.riichiOpponentDiscardKinds; // per-opponent rivers

    const baseCounts = tilesToCounts(hand.concealed);
    const baseShanten = bestShanten(baseCounts, existingMelds);
    const isSelfTenpai = baseShanten === 0;

    const foldPressure = this.computeFoldPressure(riichiOpponentCount, isSelfTenpai, baseShanten);
    const useSuji = p.skill >= 0.5; // low-skill characters only recognize plain genbutsu

    // Pass 1: shanten only (cheap - the same per-candidate cost SimpleAI already pays).
    // Pass 2 (below) only spends the expensive full ukeire computation on candidates within
    // fastPathShantenMargin of the best shanten - true ukeire (computeImprovingTiles) can be
    // large at any shanten level (unlike the old, always-near-0 computeWinningTiles misuse
    // this replaced), so a shanten-worse candidate's skipped (assumed-0) ukeire/ukeireTileCount
    // terms could in principle have been large enough to offset SHANTEN_WEIGHT's gap - this
    // margin is sized so that can never happen: the max possible combined contribution of
    // both ukeire terms (kind count, capped at every tile kind; tile count, capped at every
    // kind times its max physical copies) divided by SHANTEN_WEIGHT bounds how many shanten
    // levels they could ever "buy back" together, rounded up.
    const totalKinds = allKindsForRules(ctx.rules).length;
    const maxUkeireContribution =
      MAX_SPEED_WEIGHT * totalKinds + MAX_SPEED_WEIGHT * UKEIRE_TILE_COUNT_WEIGHT * totalKinds * MAX_COPIES_PER_KIND;
    const fastPathShantenMargin = Math.ceil(maxUkeireContribution / SHANTEN_WEIGHT);
    const shantenByKind = new Map<TileKind, number>();
    for (const kind of uniqueKinds) {
      const tile = pickNonRedRepresentative(hand, kind);
      const remaining = hand.concealed.filter((t) => t.id !== tile.id);
      shantenByKind.set(kind, bestShanten(tilesToCounts(remaining), existingMelds));
    }
    const minCandidateShanten = Math.min(...shantenByKind.values());
    // ctx.visibleTileKinds never includes this hand's own concealed tiles (see
    // CharacterDecisionContext) - computeImprovingTileCount subtracts remainingCounts
    // separately per candidate, so this is safe to compute once per decision.
    const visibleElsewhereCounts = kindsToCounts(ctx.visibleTileKinds);

    const candidates: DiscardCandidate[] = [];
    for (const kind of uniqueKinds) {
      const tile = pickNonRedRepresentative(hand, kind);
      const remaining = hand.concealed.filter((t) => t.id !== tile.id);
      const remainingCounts = tilesToCounts(remaining);
      const shanten = shantenByKind.get(kind)!;
      const needsExactUkeire = this.useExactUkeireForAllCandidates || shanten <= minCandidateShanten + fastPathShantenMargin;
      let ukeire = 0;
      let ukeireTileCount = 0;
      if (needsExactUkeire) {
        const improvingKinds = computeImprovingTiles(remainingCounts, existingMelds, ctx.rules, shanten);
        ukeire = improvingKinds.length;
        ukeireTileCount = computeImprovingTileCount(improvingKinds, remainingCounts, visibleElsewhereCounts);
      }

      const danger =
        riichiOpponentCount === 0
          ? 0
          : Math.max(...allRiverKinds.map((river) => dangerOf(kind, river, useSuji)));

      const keepValue = countDora([tile], ctx.doraIndicatorKinds, ctx.rules) + (tile.isRed ? 1 : 0);

      const meldTiles = hand.melds.flatMap((m) => m.tiles);
      const suitCounts = new Map<string, number>();
      for (const t of [...remaining, ...meldTiles]) suitCounts.set(t.kind[0]!, (suitCounts.get(t.kind[0]!) ?? 0) + 1);
      const numberSuitTiles = [...remaining, ...meldTiles].filter((t) => t.kind[0] !== "z").length;
      const dominantSuitCount = Math.max(0, ...[...suitCounts.entries()].filter(([s]) => s !== "z").map(([, c]) => c));
      const suitPurity = numberSuitTiles > 0 ? dominantSuitCount / numberSuitTiles : 0;
      const honitsuFit = suitPurity > 0.6 ? suitPurity : 0;

      const chiitoiShantenAfter = existingMelds === 0 ? chiitoitsuShanten(remainingCounts) : 8;
      const chiitoiFit = existingMelds === 0 && chiitoiShantenAfter <= shanten + 1 ? Math.max(0, (6 - chiitoiShantenAfter) / 6) : 0;

      const kokushiShantenAfter = existingMelds === 0 ? kokushiShanten(remainingCounts) : 13;
      const yakumanFit = existingMelds === 0 && kokushiShantenAfter <= 5 ? Math.max(0, (7 - kokushiShantenAfter) / 7) : 0;

      const isIsolated = isIsolatedTile(kind, baseCounts);

      candidates.push({
        kind,
        tile,
        shanten,
        ukeire,
        ukeireTileCount,
        danger,
        keepValue,
        honitsuFit,
        chiitoiFit,
        yakumanFit,
        isIsolated,
        score: 0,
        baselineScore: 0,
        shapeCleanlinessDelta: 0,
        contaminationDelta: 0,
        mageunaPlanBonus: 0,
        effieTurnsHeld: 0,
        effieAttachmentDelta: 0,
        mageunaDisruptionDelta: 0,
        kyleExperimentDelta: 0,
      });
    }

    const speedWeight = clamp(0.25 + (p.aggression - 0.5) * 0.3 - (p.valueGreed - 0.5) * 0.15, 0.05, MAX_SPEED_WEIGHT);
    const keepValueWeight = clamp(0.4 + (p.valueGreed - 0.5) * 0.8, 0.1, 1.2);
    let dangerWeight = clamp(0.5 * (1 + (p.defense - 0.5) * 2) * (1 - (p.aggression - 0.5) * 0.6) * (1 - (p.riskTolerance - 0.5) * 0.8), 0.15, 2.5);
    dangerWeight *= isSelfTenpai ? 0.35 : 1 + baseShanten * 0.15;
    dangerWeight *= 1 + foldPressure * 3;

    // Mageuna (route-consistency snapshot + disruption-signal update) and Effie
    // (attachment accumulation) both update their small per-hand state once per call,
    // before scoring, so every candidate this turn sees the same, already-updated state.
    const mageunaState = p.planPersistence !== undefined ? this.updateMageunaState(candidates, baseCounts, existingMelds, riichiOpponentCount) : null;
    if (p.attachmentBias !== undefined) this.updateEffieAttachment(candidates, uniqueKinds);
    const kyleDecisionState =
      p.experimentBias !== undefined
        ? this.createKyleDecisionState(candidates, baseCounts, existingMelds)
        : null;

    for (const c of candidates) {
      const generalScore =
        SHANTEN_WEIGHT * -c.shanten +
        speedWeight * c.ukeire +
        speedWeight * UKEIRE_TILE_COUNT_WEIGHT * c.ukeireTileCount -
        dangerWeight * c.danger -
        keepValueWeight * c.keepValue +
        p.honitsuBias * c.honitsuFit +
        p.chiitoitsuBias * c.chiitoiFit +
        p.yakumanGreed * c.yakumanFit;

      // shapeCleanlinessBias/contaminationAversion (Ari only) - computed as explicit
      // deltas via computeAriSpecialDeltas (same formula, same operation order as
      // before) so a diagnostic "baseline" score excluding just these two terms can be
      // reconstructed below without altering the real score's value or computation.
      const { shapeCleanlinessDelta, contaminationDelta } = computeAriSpecialDeltas(
        c.isIsolated,
        c.danger,
        p.shapeCleanlinessBias,
        p.contaminationAversion
      );

      let score = generalScore + shapeCleanlinessDelta + contaminationDelta;

      // experimentBias/routePersistence (Kyle only)
      if (p.experimentBias !== undefined) {
        const scoreBeforeExperiment = score;
        score = this.applyExperimentBias(score, c, kyleDecisionState!, p);
        c.kyleExperimentDelta = score - scoreBeforeExperiment;
      }

      // planPersistence (Mageuna only): small bonus for candidates consistent with the
      // hand's already-forming development direction, among otherwise-close candidates.
      if (mageunaState) {
        const fitValue = mageunaState.route === "chiitoi" ? c.chiitoiFit : mageunaState.route === "honitsu" ? c.honitsuFit : 0;
        const planBonus = computeMageunaPlanBonus(mageunaState.routeConsistent, fitValue, p.planPersistence!);
        score += planBonus;
        c.mageunaPlanBonus = planBonus;
      }

      // attachmentBias/attachmentReleaseThreshold (Effie only): small retention penalty
      // against discarding material that has accumulated value-relevant attachment,
      // released once it's no longer the best-shanten line, meaningfully dangerous, or
      // no longer contributes to any tracked value.
      if (p.attachmentBias !== undefined) {
        const heldTurns = this.effieAttachment.get(c.kind) ?? 0;
        const attachmentLevel = clamp(heldTurns / 5, 0, 1);
        const isValuable = this.isEffieValuable(c);
        let releaseFactor = 1;
        if (c.danger >= 1) releaseFactor -= (p.attachmentReleaseThreshold ?? 0) * 0.6;
        if (c.shanten > minCandidateShanten) releaseFactor -= (p.attachmentReleaseThreshold ?? 0) * 0.6;
        if (!isValuable) releaseFactor = 0;
        releaseFactor = clamp(releaseFactor, 0, 1);
        const attachmentDelta = computeEffieAttachmentDelta(attachmentLevel, p.attachmentBias, releaseFactor);
        score += attachmentDelta;
        c.effieTurnsHeld = heldTurns;
        c.effieAttachmentDelta = attachmentDelta;
      }

      // skill-driven evaluation noise (never a direct probability of the "correct" pick) -
      // isolated to skillRng so it never contaminates entropy's own selection-diversity
      // role. Exactly one draw per candidate, same position as always - the diagnostic
      // fields below reuse this same value rather than drawing again, so RNG consumption
      // order/count is completely unaffected by this instrumentation.
      const noiseScale = (1 - p.skill) * 1.5;
      const noise = (this.skillRng.next() - 0.5) * 2 * noiseScale;
      score += noise;

      c.score = score;
      c.baselineScore = generalScore + noise;
      c.shapeCleanlinessDelta = shapeCleanlinessDelta;
      c.contaminationDelta = contaminationDelta;
    }

    // disruptionInstability (Mageuna only): only once multiple disruption signals have
    // overlapped in close succession (see updateMageunaState) - briefly less consistent
    // selection via bounded score jitter, decaying back to 0 within 1-2 further calls.
    // Draws from selectionRng (never skillRng), consistent with every other downstream/
    // selection-level mechanic - does not touch RNG consumption for any other character.
    if (mageunaState?.disruptionActive && p.disruptionInstability !== undefined) {
      for (const c of candidates) {
        const jitter = (this.selectionRng.next() - 0.5) * 2 * p.disruptionInstability * 0.6;
        c.score += jitter;
        c.mageunaDisruptionDelta = jitter;
      }
    }

    // Score every kind exactly as before so per-candidate skill RNG consumption stays
    // stable; kuikae is a legality gate on the selection pool, not an AI preference.
    const forbidden = new Set(forbiddenDiscardKinds);
    const legalCandidates = candidates.filter((candidate) => !forbidden.has(candidate.kind));
    if (legalCandidates.length === 0) throw new Error("CharacterAI.chooseDiscard: no legal discard candidate");

    let pool = this.selectPool(legalCandidates, p);

    // Nahui's overload glitch: under high decision complexity, occasionally drop the
    // danger term entirely (simulating a skipped risk check) before re-selecting.
    // nahuiBaselineBestKind (deterministic argmax over ALL candidates, pre-overload) and
    // nahuiOverloadPoolBestKind (deterministic argmax over whatever pool overload leaves
    // behind) are both pure score comparisons - no new RNG draw either way.
    let nahuiBaselineBestKind: TileKind | null = null;
    let nahuiOverloadPoolBestKind: TileKind | null = null;
    if (p.overloadSensitivity !== undefined) {
      nahuiBaselineBestKind = legalCandidates.reduce((best, c) => (c.score > best.score ? c : best)).kind;
      pool = this.applyOverloadGlitch(legalCandidates, pool, ctx, riichiOpponentCount, p);
      nahuiOverloadPoolBestKind = pool.reduce((best, c) => (c.score > best.score ? c : best)).kind;
    }

    // Tosuke's sandbagging: after computing the true best pool, deliberately settle one
    // tier down unless intervention conditions are active.
    let finalKind = this.pickFromPool(pool, p);
    if (p.sandbagging !== undefined) {
      finalKind = this.applySandbagging(legalCandidates, finalKind, ctx, p);
    }

    const chosen = candidates.find((c) => c.kind === finalKind)!;

    // Kyle's only route-state mutation for this decision: commit exactly once, using the
    // selected candidate. Candidate evaluation above reads one immutable start snapshot.
    if (kyleDecisionState) this.commitKyleRouteState(kyleDecisionState, chosen);

    // Ari-only diagnostics: null for any profile without either special param, since
    // baselineScore === score for every candidate in that case (nothing informative to
    // report). specialAdjustedBestKind asks "which candidate currently ranks #1 by the
    // real score" - independent of finalKind, which entropy/mistakeRate/pool selection
    // can still steer elsewhere even when the special logic didn't change the #1 rank.
    const ariDiagnosticsActive = p.shapeCleanlinessBias !== undefined || p.contaminationAversion !== undefined;
    let baselineBestKind: TileKind | null = null;
    let specialAdjustedBestKind: TileKind | null = null;
    if (ariDiagnosticsActive) {
      baselineBestKind = legalCandidates.reduce((best, c) => (c.baselineScore > best.baselineScore ? c : best)).kind;
      specialAdjustedBestKind = legalCandidates.reduce((best, c) => (c.score > best.score ? c : best)).kind;
    }

    // Kyle: baseline = score with kyleExperimentDelta subtracted back out (mirrors Ari's
    // baselineScore pattern exactly - pure post-hoc subtraction, no recomputation).
    const kyleDiagnosticsActive = p.experimentBias !== undefined;
    let kyleBaselineBestKind: TileKind | null = null;
    let kyleAdjustedBestKind: TileKind | null = null;
    if (kyleDiagnosticsActive) {
      kyleBaselineBestKind = legalCandidates.reduce((best, c) => (c.score - c.kyleExperimentDelta > best.score - best.kyleExperimentDelta ? c : best)).kind;
      kyleAdjustedBestKind = legalCandidates.reduce((best, c) => (c.score > best.score ? c : best)).kind;
    }

    // Mageuna: baseline = score with both her own delta terms (plan bonus + disruption
    // jitter) subtracted back out; adjusted = the real score including both.
    const mageunaDiagnosticsActive = mageunaState !== null;
    let mageunaBaselineBestKind: TileKind | null = null;
    let mageunaAdjustedBestKind: TileKind | null = null;
    if (mageunaDiagnosticsActive) {
      mageunaBaselineBestKind = legalCandidates.reduce((best, c) =>
        c.score - c.mageunaPlanBonus - c.mageunaDisruptionDelta > best.score - best.mageunaPlanBonus - best.mageunaDisruptionDelta ? c : best
      ).kind;
      mageunaAdjustedBestKind = legalCandidates.reduce((best, c) => (c.score > best.score ? c : best)).kind;
    }

    // Effie: baseline = score with effieAttachmentDelta subtracted back out.
    const effieDiagnosticsActive = p.attachmentBias !== undefined;
    let effieBaselineBestKind: TileKind | null = null;
    let effieAdjustedBestKind: TileKind | null = null;
    if (effieDiagnosticsActive) {
      effieBaselineBestKind = legalCandidates.reduce((best, c) => (c.score - c.effieAttachmentDelta > best.score - best.effieAttachmentDelta ? c : best)).kind;
      effieAdjustedBestKind = legalCandidates.reduce((best, c) => (c.score > best.score ? c : best)).kind;
    }

    this._lastDiscardDebug = {
      chosenKind: finalKind,
      topCandidates: [...legalCandidates]
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((c) => ({
          kind: c.kind,
          score: c.score,
          ...(ariDiagnosticsActive
            ? {
                baselineScore: c.baselineScore,
                shapeCleanlinessDelta: c.shapeCleanlinessDelta,
                contaminationDelta: c.contaminationDelta,
                ariShapeDelta: c.shapeCleanlinessDelta,
                ariContaminationDelta: c.contaminationDelta,
                shanten: c.shanten,
                ukeire: c.ukeire,
                ukeireTileCount: c.ukeireTileCount,
                danger: c.danger,
                isIsolated: c.isIsolated,
              }
            : {}),
          ...(mageunaDiagnosticsActive ? { mageunaPlanDelta: c.mageunaPlanBonus, mageunaDisruptionDelta: c.mageunaDisruptionDelta } : {}),
          ...(effieDiagnosticsActive ? { effieTurnsHeld: c.effieTurnsHeld, effieAttachmentDelta: c.effieAttachmentDelta } : {}),
          ...(kyleDiagnosticsActive ? { kyleExperimentDelta: c.kyleExperimentDelta } : {}),
        })),
      sandbagged: this._lastSandbaggingTrace?.sandbagged ?? false,
      overloadTriggered: this._lastOverloadTriggered,
      experimentRouteActive: this.experimentRoute,
      baselineBestKind,
      specialAdjustedBestKind,
      ariChoiceChanged: ariDiagnosticsActive ? baselineBestKind !== specialAdjustedBestKind : null,
      chosenBaselineScore: ariDiagnosticsActive ? chosen.baselineScore : null,
      chosenSpecialScore: ariDiagnosticsActive ? chosen.score : null,
      chosenShapeCleanlinessDelta: ariDiagnosticsActive ? chosen.shapeCleanlinessDelta : null,
      chosenContaminationDelta: ariDiagnosticsActive ? chosen.contaminationDelta : null,
      mageunaRoute: mageunaState?.route ?? null,
      mageunaRouteConsistent: mageunaState?.routeConsistent ?? null,
      mageunaDisruptionActive: mageunaState?.disruptionActive ?? null,
      mageunaDisruptionTurnsLeft: mageunaState?.disruptionTurnsLeft ?? null,
      mageunaPlanBonusApplied: mageunaState ? chosen.mageunaPlanBonus : null,
      effieChosenTurnsHeld: p.attachmentBias !== undefined ? chosen.effieTurnsHeld : null,
      effieChosenAttachmentDelta: p.attachmentBias !== undefined ? chosen.effieAttachmentDelta : null,
      ariBaselineBestKind: baselineBestKind,
      ariAdjustedBestKind: specialAdjustedBestKind,
      ariMechanicChangedBest: ariDiagnosticsActive ? baselineBestKind !== specialAdjustedBestKind : null,
      mageunaBaselineBestKind,
      mageunaAdjustedBestKind,
      mageunaMechanicChangedBest: mageunaDiagnosticsActive ? mageunaBaselineBestKind !== mageunaAdjustedBestKind : null,
      effieBaselineBestKind,
      effieAdjustedBestKind,
      effieMechanicChangedBest: effieDiagnosticsActive ? effieBaselineBestKind !== effieAdjustedBestKind : null,
      optimaEffectiveEntropy: p.binaryConfidence !== undefined ? this._lastOptimaEffectiveEntropy : null,
      optimaState: p.binaryConfidence !== undefined ? this._lastOptimaState : null,
      optimaScoreGap: p.binaryConfidence !== undefined ? this._lastOptimaExtras?.scoreGap ?? null : null,
      optimaPoolSize: p.binaryConfidence !== undefined ? this._lastOptimaExtras?.poolSize ?? null : null,
      optimaBaselinePoolSize: p.binaryConfidence !== undefined ? this._lastOptimaExtras?.poolSize ?? null : null,
      optimaChosenRank:
        p.binaryConfidence !== undefined && this._lastOptimaPoolSortedKinds
          ? this._lastOptimaPoolSortedKinds.indexOf(finalKind) + 1
          : null,
      optimaBaseEntropy: p.binaryConfidence !== undefined ? this._lastOptimaExtras?.baseEntropy ?? null : null,
      optimaEntropyModifier: p.binaryConfidence !== undefined ? this._lastOptimaExtras?.entropyModifier ?? null : null,
      kyleBaselineBestKind,
      kyleAdjustedBestKind,
      kyleMechanicChangedBest: kyleDiagnosticsActive ? kyleBaselineBestKind !== kyleAdjustedBestKind : null,
      kyleRouteState: kyleDiagnosticsActive ? this.experimentRoute : null,
      nahuiBaselineBestKind,
      nahuiOverloadPoolBestKind,
      nahuiActualChosenKind: p.overloadSensitivity !== undefined ? finalKind : null,
      nahuiOverloadChangedChoice: p.overloadSensitivity !== undefined ? this._lastOverloadTriggered && finalKind !== nahuiBaselineBestKind : null,
      tosukeSandbaggingActive: p.sandbagging !== undefined ? (this._lastSandbaggingTrace?.sandbagged ?? false) : null,
      tosukeInterventionTriggered: p.sandbagging !== undefined ? (this._lastSandbaggingTrace?.interventionActive ?? false) : null,
      tosukeBaselineBestKind: p.sandbagging !== undefined ? (this._lastSandbaggingTrace?.trueChoice ?? null) : null,
      tosukeAdjustedBestKind: p.sandbagging !== undefined ? (this._lastSandbaggingTrace?.finalChoice ?? null) : null,
      tosukeMechanicChangedBest: p.sandbagging !== undefined ? (this._lastSandbaggingTrace?.sandbagged ?? false) : null,
      tosukeSandbaggingDelta:
        p.sandbagging !== undefined && this._lastSandbaggingTrace
          ? (candidates.find((c) => c.kind === this._lastSandbaggingTrace!.trueChoice)?.score ?? 0) -
            (candidates.find((c) => c.kind === this._lastSandbaggingTrace!.finalChoice)?.score ?? 0)
          : null,
      tosukeReason:
        p.sandbagging !== undefined
          ? this._lastSandbaggingTrace?.interventionActive
            ? "intervention"
            : this._lastSandbaggingTrace?.sandbagged
              ? "sandbag"
              : "none"
          : null,
    };

    return chosen.tile.id;
  }

  private computeFoldPressure(riichiOpponentCount: number, isSelfTenpai: boolean, ownShanten: number): number {
    if (riichiOpponentCount === 0) return 0;
    const p = this.profile;
    let pressure = 0.3 + (riichiOpponentCount - 1) * 0.25;
    if (isSelfTenpai) pressure -= 0.35 + (p.valueGreed - 0.5) * 0.2;
    else pressure += ownShanten * 0.15;
    pressure += (p.foldThreshold - 0.5) * 1.0;
    pressure -= (p.aggression - 0.5) * 0.5;
    pressure -= (p.riskTolerance - 0.5) * 0.5;
    pressure += (p.defense - 0.5) * 0.5;
    return clamp(pressure, 0, 1.5);
  }

  private createKyleDecisionState(
    candidates: readonly KyleRouteCandidate[],
    baseCounts: number[],
    existingMelds: number
  ): KyleRouteState {
    let route = this.experimentRoute;
    if (route === null && existingMelds === 0) {
      const pairs = baseCounts.filter((n) => n >= 2).length;
      if (pairs >= 3 && candidates.some((c) => c.chiitoiFit > 0)) route = "chiitoi";
      else if (candidates.some((c) => c.honitsuFit > 0.55)) route = "honitsu";
    }
    return { route, committedTurns: this.routeCommittedTurns };
  }

  private applyExperimentBias(
    score: number,
    c: KyleRouteCandidate,
    state: Readonly<KyleRouteState>,
    p: CharacterProfile
  ): number {
    if (state.route === "chiitoi") {
      if (!(c.chiitoiFit === 0 || c.shanten - Math.min(c.shanten, 8) > 3)) {
        score += computeExperimentBonus(true, c.chiitoiFit, p.experimentBias ?? 0, p.routePersistence ?? 0);
      }
    } else if (state.route === "honitsu") {
      if (c.honitsuFit !== 0) {
        score += computeExperimentBonus(true, c.honitsuFit, p.experimentBias ?? 0, p.routePersistence ?? 0);
      }
    }
    // general curiosity bump for yakuman-adjacent shapes even without full commitment
    score += (p.experimentBias ?? 0) * 0.3 * c.yakumanFit;
    return score;
  }

  private commitKyleRouteState(state: Readonly<KyleRouteState>, chosen: KyleRouteCandidate): void {
    let { route, committedTurns } = state;
    const routeBroken =
      (route === "chiitoi" && (chosen.chiitoiFit === 0 || chosen.shanten - Math.min(chosen.shanten, 8) > 3)) ||
      (route === "honitsu" && chosen.honitsuFit === 0);
    if (routeBroken) {
      committedTurns++;
      if (committedTurns > 2) route = null;
    }
    this.experimentRoute = route;
    this.routeCommittedTurns = committedTurns;
  }

  /** Mageuna: classifies this turn's hand-development direction from already-available
   *  candidate info (no separate route engine - just "is this turn's shape pair-heavy
   *  enough to look chiitoi-compatible, or suit-concentrated enough to look honitsu-
   *  compatible, or neither"), compares it against the direction her last few discards
   *  were consistent with, and updates the disruption-signal countdown. Called once per
   *  chooseDiscard, before scoring, so every candidate this turn sees the same state. */
  private updateMageunaState(
    candidates: DiscardCandidate[],
    baseCounts: number[],
    existingMelds: number,
    riichiOpponentCount: number
  ): { route: "chiitoi" | "honitsu" | "standard"; routeConsistent: boolean; disruptionActive: boolean; disruptionTurnsLeft: number } {
    const pairs = existingMelds === 0 ? baseCounts.filter((n) => n >= 2).length : 0;
    const bestHonitsuFit = Math.max(0, ...candidates.map((c) => c.honitsuFit));
    let route: "chiitoi" | "honitsu" | "standard" = "standard";
    if (existingMelds === 0 && pairs >= 3) route = "chiitoi";
    else if (bestHonitsuFit > 0.55) route = "honitsu";

    const routeConsistent = this.mageunaRoute !== null && this.mageunaRoute === route;
    this.mageunaRoute = route;

    const maxDanger = Math.max(0, ...candidates.map((c) => c.danger));
    let signals = 0;
    if (this.mageunaLastSnapshot) {
      if (existingMelds !== this.mageunaLastSnapshot.existingMelds) signals++;
      if (riichiOpponentCount > this.mageunaLastSnapshot.riichiOpponentCount) signals++;
      if (maxDanger - this.mageunaLastSnapshot.maxDanger >= 0.5) signals++;
    }
    this.mageunaLastSnapshot = { existingMelds, riichiOpponentCount, maxDanger };

    if (signals >= 2) this.mageunaDisruptionTurnsLeft = 2;
    else if (this.mageunaDisruptionTurnsLeft > 0) this.mageunaDisruptionTurnsLeft--;

    const result = { route, routeConsistent, disruptionActive: this.mageunaDisruptionTurnsLeft > 0, disruptionTurnsLeft: this.mageunaDisruptionTurnsLeft };
    this._lastMageunaDebug = result;
    return result;
  }

  /** Effie: a candidate tile is "valuable" (attachment-eligible) only when it's already
   *  contributing to a real, already-viable value signal the shared parameters already
   *  recognize - never merely "has been held a while." */
  private isEffieValuable(c: DiscardCandidate): boolean {
    return c.keepValue > 0 || c.chiitoiFit > 0 || c.honitsuFit > 0.4 || (c.kind[0] === "z" && !c.isIsolated);
  }

  /** Effie: bumps the turns-held counter for every currently-valuable kind (capped at 5
   *  turns' worth), and prunes any kind no longer in hand. Called once per chooseDiscard,
   *  before scoring, so this turn's deltas reflect the just-updated levels. */
  private updateEffieAttachment(candidates: DiscardCandidate[], uniqueKinds: TileKind[]): void {
    for (const k of [...this.effieAttachment.keys()]) {
      if (!uniqueKinds.includes(k)) this.effieAttachment.delete(k);
    }
    for (const c of candidates) {
      if (!this.isEffieValuable(c)) continue;
      const cur = this.effieAttachment.get(c.kind) ?? 0;
      this.effieAttachment.set(c.kind, Math.min(5, cur + 1));
    }
  }

  private selectPool(candidates: DiscardCandidate[], p: CharacterProfile): DiscardCandidate[] {
    const bestScore = Math.max(...candidates.map((c) => c.score));
    const tolerance = Math.max(0.05, p.candidateScoreTolerance) * SHANTEN_WEIGHT;
    let pool = candidates.filter((c) => c.score >= bestScore - tolerance);

    if (this.selectionRng.next() < p.mistakeRate) {
      // widen to a moderately (never catastrophically) inferior band
      pool = candidates.filter((c) => c.score >= bestScore - tolerance * 3.5);
    }
    return pool;
  }

  private pickFromPool(pool: DiscardCandidate[], p: CharacterProfile): TileKind {
    let entropy = p.entropy;
    // binaryConfidence/ambiguitySensitivity (Optima-215 only): reinterpret entropy
    // conditionally on the pool's own score spread, rather than using a flat value.
    if (p.binaryConfidence !== undefined) {
      const toleranceUnit = Math.max(0.05, p.candidateScoreTolerance) * SHANTEN_WEIGHT;
      const sortedPool = [...pool].sort((a, b) => b.score - a.score);
      const scoresDescending = sortedPool.map((c) => c.score);
      entropy = computeOptimaEffectiveEntropy(scoresDescending, p.entropy, p.binaryConfidence, p.ambiguitySensitivity ?? 0, toleranceUnit);
      this._lastOptimaEffectiveEntropy = entropy;
      // Infinity here means "only 1 candidate, no second-place score to gap against" -
      // it correctly drives the state classification below (trivially "clear"), but is
      // NOT a real number to hand external tooling, so the exposed scoreGap is null in
      // that case rather than a misleading 0 (which would look like two tied scores).
      const gap = scoresDescending.length > 1 ? scoresDescending[0]! - scoresDescending[1]! : Infinity;
      this._lastOptimaState = gap > toleranceUnit * 0.5 ? "clear" : "ambiguous";
      this._lastOptimaExtras = {
        scoreGap: Number.isFinite(gap) ? gap : null,
        poolSize: pool.length,
        baseEntropy: p.entropy,
        entropyModifier: entropy / Math.max(1e-9, p.entropy),
      };
      this._lastOptimaPoolSortedKinds = sortedPool.map((c) => c.kind);
    }
    return sampleByEntropy(
      pool.map((c) => ({ value: c.kind, score: c.score })),
      entropy,
      this.selectionRng
    );
  }

  private applyOverloadGlitch(
    allCandidates: DiscardCandidate[],
    truePool: DiscardCandidate[],
    ctx: CharacterDecisionContext,
    riichiOpponentCount: number,
    p: CharacterProfile
  ): DiscardCandidate[] {
    const closeCandidateCount = allCandidates.filter((c) => Math.abs(c.score - Math.max(...allCandidates.map((x) => x.score))) < 1.5).length;
    const complexity = clamp(
      riichiOpponentCount * 0.3 + (ctx.wallRemainingLive < 15 ? 0.25 : 0) + closeCandidateCount * 0.05,
      0,
      1
    );
    const glitchProbability = clamp((p.overloadSensitivity ?? 0) * complexity, 0, 0.9);
    if (this.selectionRng.next() >= glitchProbability) {
      this._lastOverloadTriggered = false;
      return truePool;
    }

    // premature commitment: recompute the top pick ignoring the danger term entirely
    // (re-ranking on shanten+ukeire alone, the way a rushed evaluation might skip risk)
    const bestIgnoringDanger = allCandidates.reduce((best, c) =>
      SHANTEN_WEIGHT * -c.shanten + c.ukeire > SHANTEN_WEIGHT * -best.shanten + best.ukeire ? c : best
    );

    const trueBestScore = Math.max(...allCandidates.map((c) => c.score));
    const errorBound = (p.overloadErrorSeverity ?? 0) * SHANTEN_WEIGHT;
    if (bestIgnoringDanger.score < trueBestScore - errorBound) {
      // glitch must stay "moderately defensible" - clamp back to the true pool
      this._lastOverloadTriggered = false;
      return truePool;
    }
    this._lastOverloadTriggered = true;
    return [bestIgnoringDanger];
  }

  private applySandbagging(
    candidates: DiscardCandidate[],
    trueChoice: TileKind,
    ctx: CharacterDecisionContext,
    p: CharacterProfile
  ): TileKind {
    const scoreDeficit = Math.max(0, Math.max(...ctx.opponentScores) - ctx.ownScore);
    const ownMinShanten = Math.min(...candidates.map((c) => c.shanten));
    const interventionPressure = computeInterventionPressure({
      scoreDeficit,
      isLastHandOfGame: ctx.isLastHandOfGame,
      riichiOpponentCount: ctx.riichiOpponentDiscardKinds.length,
      ownMinShanten,
    });
    const interventionThreshold = p.interventionThreshold ?? 1;
    const interventionActive = interventionPressure >= interventionThreshold;

    let finalChoice = trueChoice;
    let sandbagged = false;
    if (!interventionActive && this.selectionRng.next() < (p.sandbagging ?? 0)) {
      const sorted = [...candidates].sort((a, b) => b.score - a.score);
      const trueIdx = sorted.findIndex((c) => c.kind === trueChoice);
      const nextTier = sorted[trueIdx + 1];
      const bestScore = sorted[0]!.score;
      // never drop more than one candidate-quality tier, and never if there's no next tier
      if (nextTier && nextTier.score >= bestScore - SHANTEN_WEIGHT * 0.5) {
        finalChoice = nextTier.kind;
        sandbagged = true;
      }
    }

    this._lastSandbaggingTrace = { trueChoice, finalChoice, sandbagged, interventionPressure, interventionThreshold, interventionActive };
    return finalChoice;
  }

  // -------------------------------------------------------------------------
  // Riichi vs dama
  // -------------------------------------------------------------------------

  shouldDeclareRiichi(hand: Hand, ownScore: number, wallRemainingLive: number, tileIdToDiscard: number, ctx: CharacterDecisionContext): boolean {
    this._lastRiichiTrace = null;
    if (!canDeclareRiichi(hand, ownScore, wallRemainingLive)) return false;
    if (!wouldBeTenpaiAfterDiscard(hand, tileIdToDiscard)) return false;
    const p = this.profile;

    const damaViable = this.isDamaViable(hand, tileIdToDiscard, ctx);
    if (!damaViable) {
      // no other legal way to win - riichi is essentially required. Still populates a
      // trace (informational baseline/adjusted scores, but forced=true and
      // mechanicChangedDecision=false since nothing here could have changed the outcome)
      // so a riichi_decision entry is never silently missing from the replay whenever
      // Sangmin actually reaches a real riichi opportunity, forced or not.
      if (p.commitmentAversion !== undefined) {
        const baselineRiichiScoreForced = p.riichiBias + (p.valueGreed - 0.5) * 0.3 + (p.skill - 0.5) * 0.15;
        const damaScoreForced = p.damaBias;
        const commitmentCostForced = computeSangminRiichiCommitmentCost(p.commitmentAversion);
        const adjustedRiichiScoreForced = baselineRiichiScoreForced - commitmentCostForced;
        this._lastRiichiTrace = {
          riichiScore: adjustedRiichiScoreForced,
          damaScore: damaScoreForced,
          commitmentCost: commitmentCostForced,
          declared: true,
          baselineRiichiScore: baselineRiichiScoreForced,
          baselineDamaScore: damaScoreForced,
          adjustedRiichiScore: adjustedRiichiScoreForced,
          adjustedDamaScore: damaScoreForced,
          baselineDecision: "riichi",
          adjustedDecision: "riichi",
          mechanicChangedDecision: false,
          actualDecision: "riichi",
          forced: true,
        };
      }
      return true;
    }

    const baselineRiichiScore = p.riichiBias + (p.valueGreed - 0.5) * 0.3 + (p.skill - 0.5) * 0.15;
    const damaScore = p.damaBias;

    // commitmentAversion (Jo Sangmin only): a small fixed cost against declaring an
    // irreversible commitment, only ever able to flip a genuinely close decision -
    // riichi is already required above whenever dama has no legal win to fall back on.
    const commitmentCost = p.commitmentAversion !== undefined ? computeSangminRiichiCommitmentCost(p.commitmentAversion) : 0;
    const adjustedRiichiScore = baselineRiichiScore - commitmentCost;

    let riichiScore = adjustedRiichiScore;
    riichiScore += (this.selectionRng.next() - 0.5) * p.entropy * 0.3;
    if (this.selectionRng.next() < p.mistakeRate) riichiScore += (this.selectionRng.next() - 0.5) * 0.4;

    const declared = riichiScore >= damaScore;
    if (p.commitmentAversion !== undefined) {
      const baselineDecision: "riichi" | "dama" = baselineRiichiScore >= damaScore ? "riichi" : "dama";
      const adjustedDecision: "riichi" | "dama" = adjustedRiichiScore >= damaScore ? "riichi" : "dama";
      this._lastRiichiTrace = {
        riichiScore,
        damaScore,
        commitmentCost,
        declared,
        baselineRiichiScore,
        baselineDamaScore: damaScore,
        adjustedRiichiScore,
        adjustedDamaScore: damaScore,
        baselineDecision,
        adjustedDecision,
        mechanicChangedDecision: baselineDecision !== adjustedDecision,
        actualDecision: declared ? "riichi" : "dama",
        forced: false,
      };
    }
    return declared;
  }

  private isDamaViable(hand: Hand, tileIdToDiscard: number, ctx: CharacterDecisionContext): boolean {
    const remaining = hand.concealed.filter((t) => t.id !== tileIdToDiscard);
    const winningKinds = computeWinningTiles(tilesToCounts(remaining), hand.melds.length, ctx.rules);
    return scanAllDamaWaits(winningKinds, (kind) => {
      const winTile: Tile = { id: -1, kind, suit: kind[0] as Tile["suit"], rank: Number(kind.slice(1)), isRed: false };
      const winContext: WinContext = {
        seatWind: ctx.seatWind,
        roundWind: ctx.roundWind,
        isTsumo: false,
        isRiichi: false,
        isDoubleRiichi: false,
        isIppatsu: false,
        isHaitei: false,
        isHoutei: false,
        isRinshan: false,
        isChankan: false,
        isTenhou: false,
        isChiihou: false,
        doraCount: 0,
        uraDoraCount: 0,
        akaDoraCount: 0,
        kanCount: 0,
      };
      const result = evaluateWin({
        concealedTiles: [...remaining, winTile],
        melds: meldsToGroups(hand.melds),
        winTile,
        context: winContext,
        rules: ctx.rules,
        winner: 0,
        dealer: 0,
      });
      return result !== null;
    });
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  shouldCallPon(hand: Hand, discardedKind: TileKind, ctx: CharacterDecisionContext, isYakuhai: boolean): boolean {
    return this.decideCall(hand, discardedKind, 2, isYakuhai, ctx);
  }

  shouldCallDaiminkan(hand: Hand, discardedKind: TileKind, ctx: CharacterDecisionContext, isYakuhai: boolean): boolean {
    return this.decideCall(hand, discardedKind, 3, isYakuhai, ctx);
  }

  shouldDeclareShouminkan(hand: Hand, kind: TileKind, ctx: CharacterDecisionContext): boolean {
    return this.decideKan(hand, kind, "shouminkan", ctx);
  }

  shouldDeclareAnkan(hand: Hand, kind: TileKind, ctx: CharacterDecisionContext): boolean {
    return this.decideKan(hand, kind, "ankan", ctx);
  }

  /** Kita strategy is intentionally untuned: use the same deterministic default as
   * SimpleAI while exposing the same action-selection boundary. */
  shouldDeclareKita(_hand: Hand, _ctx: CharacterDecisionContext): boolean {
    return shouldDeclareKita();
  }

  decideKanFromMetricsForTest(input: StrategicKanInput): boolean {
    return this.applyKanDecision(input);
  }

  private decideKan(hand: Hand, kind: TileKind, kanKind: StrategicKanKind, ctx: CharacterDecisionContext): boolean {
    const currentCounts = tilesToCounts(hand.concealed);
    const currentShanten = bestShanten(currentCounts, hand.melds.length);
    const currentImproving = computeImprovingTiles(currentCounts, hand.melds.length, ctx.rules, currentShanten);
    const visibleCounts = kindsToCounts(ctx.visibleTileKinds);
    const currentUkeireTileCount = computeImprovingTileCount(currentImproving, currentCounts, visibleCounts);

    const afterCounts = currentCounts.slice();
    const slot = kindToSlot(kind);
    afterCounts[slot]! -= kanKind === "ankan" ? 4 : 1;
    const afterMelds = hand.melds.length + (kanKind === "ankan" ? 1 : 0);
    const afterKanShanten = bestShanten(afterCounts, afterMelds);
    const afterImproving = computeImprovingTiles(afterCounts, afterMelds, ctx.rules, afterKanShanten);
    const afterKanUkeireTileCount = computeImprovingTileCount(afterImproving, afterCounts, visibleCounts);

    return this.applyKanDecision({
      kind: kanKind,
      currentShanten,
      afterKanShanten,
      currentUkeire: currentImproving.length,
      afterKanUkeire: afterImproving.length,
      currentUkeireTileCount,
      afterKanUkeireTileCount,
      riichi: hand.riichi,
      riichiOpponentCount: ctx.riichiOpponentDiscardKinds.length,
      wallRemainingLive: ctx.wallRemainingLive,
      defense: this.profile.defense,
      riskTolerance: this.profile.riskTolerance,
    });
  }

  private applyKanDecision(input: StrategicKanInput): boolean {
    this._lastKanTrace = evaluateStrategicKanDecision(
      input,
      this.profile.effortAversion ?? 0,
      this.profile.commitmentAversion ?? 0
    );
    return this._lastKanTrace.declared;
  }

  /**
   * A "concrete strategic advantage" - shanten improvement, a confirmed yaku, or a clear
   * speed (ukeire) gain - can push even a low-callBias/high-defense character over the
   * line, exactly as the spec's "preserve menzen unless calling gives a concrete
   * strategic advantage" implies. Without one, the decision falls back to being almost
   * entirely personality-driven (callBias/aggression/defense), which is why low-callBias
   * characters decline far more often on merely-plausible-but-not-advancing calls.
   */
  private evaluateCallAdvantage(
    hand: Hand,
    discardedKind: TileKind,
    tilesToRemove: number,
    ctx: CharacterDecisionContext
  ): {
    beforeShanten: number;
    afterShanten: number;
    shantenGain: number;
    beforeUkeire: number;
    afterUkeire: number;
    ukeireGain: number;
  } {
    const beforeCounts = tilesToCounts(hand.concealed);
    const beforeShanten = bestShanten(beforeCounts, hand.melds.length);
    const beforeUkeire = computeImprovingTiles(beforeCounts, hand.melds.length, ctx.rules, beforeShanten).length;

    const matchingIds = hand.concealed
      .filter((t) => t.kind === discardedKind)
      .slice(0, tilesToRemove)
      .map((t) => t.id);
    const afterConcealed = hand.concealed.filter((t) => !matchingIds.includes(t.id));
    const afterCounts = tilesToCounts(afterConcealed);
    const meldsAfter = hand.melds.length + 1;
    const afterShanten = bestShanten(afterCounts, meldsAfter);
    const afterUkeire = computeImprovingTiles(afterCounts, meldsAfter, ctx.rules, afterShanten).length;

    return {
      beforeShanten,
      afterShanten,
      shantenGain: beforeShanten - afterShanten,
      beforeUkeire,
      afterUkeire,
      ukeireGain: afterUkeire - beforeUkeire,
    };
  }

  private decideCall(hand: Hand, discardedKind: TileKind, tilesToRemove: number, isYakuhai: boolean, ctx: CharacterDecisionContext): boolean {
    const p = this.profile;
    const progression = this.evaluateCallAdvantage(hand, discardedKind, tilesToRemove, ctx);
    const { shantenGain, ukeireGain } = progression;

    const shantenBonus = shantenGain >= 1 ? 0.55 : 0;
    const ukeireBonus = clamp(ukeireGain, 0, 8) * 0.02;
    const yakuhaiBonus = isYakuhai ? 0.15 : 0;
    const callBiasContribution = (p.callBias - 0.5) * 0.5;
    const aggressionContribution = (p.aggression - 0.5) * 0.15;
    const defenseContribution = -(p.defense - 0.5) * 0.15;
    const concreteScore = shantenBonus + ukeireBonus + yakuhaiBonus;
    const personalityScore = callBiasContribution + aggressionContribution + defenseContribution;

    const baselineCallScore = 0.15 + concreteScore + personalityScore;

    // effortAversion/commitmentAversion (Jo Sangmin only): a small cost against calling,
    // larger when the call doesn't even clearly advance shanten - only ever able to flip
    // a genuinely marginal call, never a call with a real, confirmed advantage (which
    // concreteScore above already pushes well past this cost's small magnitude).
    const sangminActive = p.effortAversion !== undefined || p.commitmentAversion !== undefined;
    const effortModifier = sangminActive && shantenGain < 1 ? (p.effortAversion ?? 0) * 0.12 : 0;
    const commitmentModifier = sangminActive ? (p.commitmentAversion ?? 0) * 0.1 : 0;
    const callCost = effortModifier + commitmentModifier;
    const adjustedCallScore = baselineCallScore - callCost;

    let callScore = adjustedCallScore;
    const entropyJitter = (this.selectionRng.next() - 0.5) * p.entropy * 0.3;
    callScore += entropyJitter;
    let mistakeJitter = 0;
    if (this.selectionRng.next() < p.mistakeRate) {
      mistakeJitter = (this.selectionRng.next() - 0.5) * 0.3;
      callScore += mistakeJitter;
    }
    const called = callScore > 0.5;
    const baselineDecision: "call" | "pass" = baselineCallScore > 0.5 ? "call" : "pass";
    const adjustedDecision: "call" | "pass" = adjustedCallScore > 0.5 ? "call" : "pass";
    this._lastCallTrace = {
      callScore,
      effortAversionCost: callCost,
      beforeShanten: progression.beforeShanten,
      afterShanten: progression.afterShanten,
      shantenGain,
      beforeUkeire: progression.beforeUkeire,
      afterUkeire: progression.afterUkeire,
      ukeireGain,
      openMeldCount: hand.melds.length,
      isYakuhai,
      called,
      callKind: tilesToRemove === 2 ? "pon" : "daiminkan",
      baselineCallScore,
      adjustedCallScore,
      effortModifier,
      commitmentModifier,
      baselineDecision,
      adjustedDecision,
      mechanicChangedDecision: baselineDecision !== adjustedDecision,
      actualDecision: called ? "call" : "pass",
      components: {
        base: 0.15,
        shantenBonus,
        ukeireBonus,
        yakuhaiBonus,
        callBias: callBiasContribution,
        aggression: aggressionContribution,
        defense: jsonSafeTraceNumber(defenseContribution),
        effort: jsonSafeTraceNumber(-effortModifier),
        commitment: jsonSafeTraceNumber(-commitmentModifier),
        entropyJitter: jsonSafeTraceNumber(entropyJitter),
        mistakeJitter: jsonSafeTraceNumber(mistakeJitter),
      },
    };
    return called;
  }

  evaluateChiCandidate(hand: Hand, candidate: ChiCandidate, ctx: CharacterDecisionContext): ChiDecisionEvaluation {
    return evaluateChiDecision(this.profile, hand, candidate, ctx);
  }

  computeOwnWinningTiles(hand: Hand, rules: RuleConfig): TileKind[] {
    return computeWinningTiles(tilesToCounts(hand.concealed), hand.melds.length, rules);
  }
}

// re-exported for tests/plumbing convenience
export { isHonor, isTerminalOrHonor };
