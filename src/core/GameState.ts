import type { RuleConfig } from "../rules/RuleConfig.js";
import { Wall } from "./Wall.js";
import { Hand } from "./Hand.js";
import { allKindsForRules, type Tile, type TileKind } from "./tiles.js";
import { tilesToCounts } from "./tileIndex.js";
import { FuritenTracker } from "../actions/furiten.js";
import { computeWinningTiles } from "../actions/winSearch.js";
import { canAnkan, applyAnkan, canPon, applyPon, canDaiminkan, applyDaiminkan, canShouminkan, applyShouminkan } from "../actions/calls.js";
import { applyKita, canKita, canRiichiKita, type KitaAction } from "../actions/kita.js";
import { canRiichiAnkan } from "../actions/riichiAnkan.js";
import { canDeclareRiichi, riichiDiscardCandidates } from "../actions/riichi.js";
import type { CallDecisionRequest, CallDecisionResponse, DecisionRequest, DecisionResponse, DiscardDecisionRequest, DiscardDecisionResponse, RonDecisionContext, RonDecisionRequest, RonDecisionResponse } from "./decisions.js";
import { buildPlayerView, type PlayerView } from "./playerView.js";
import { isKokushiAnkanRon } from "../actions/kokushiAnkan.js";
import {
  chooseDiscard,
  shouldDeclareRiichi,
  shouldCallPon,
  shouldDeclareAnkan,
  shouldCallDaiminkan,
  shouldDeclareShouminkan,
  shouldDeclareKita,
  isYakuhaiTile,
} from "../ai/simpleAI.js";
import type { CharacterProfile } from "../ai/characterProfile.js";
import { CharacterAI, type CallDecisionTrace, type CharacterDecisionContext } from "../ai/characterAI.js";
import type { ChiDecisionEvaluation } from "../ai/chiDecision.js";
import {
  buildCallDecisionEntry,
  buildDiscardDecisionEntry,
  buildRiichiDecisionEntry,
} from "../ai/decisionTraceFactory.js";
import { meldsToGroups } from "../yaku/meldConvert.js";
import { buildWinContext } from "../yaku/winContext.js";
import { evaluateInitialDealerWin, evaluateWin, type FullWinResult } from "../yaku/evaluate.js";
import { buildDoraBreakdown, tileToRef } from "../yaku/doraBreakdown.js";
import { buildWinSnapshot } from "../yaku/winSnapshot.js";
import type { GameEvent, AiDecisionEntry, AuditableWinResult, GameEndEvent, HandResultSnapshot } from "./GameLog.js";
import { resolveRonWinners } from "./ronResolution.js";
import { allSeats, nextSeat, seatDistance, seatsInTurnOrder } from "./seats.js";
import { computeRoundProgression } from "./roundProgression.js";
import { MAJSOUL_SANMA_RULESET, MAJSOUL_YONMA_RULESET } from "../rules/RuleSet.js";
import { settleExhaustiveDraw, settleOrderedWinPayments, shouldDealerContinue } from "../rules/settlement.js";
import {
  arbitrateDiscardResponses,
  generateDiscardResponseCandidates,
  type NonWinningCallCandidate,
} from "./discardResponses.js";
import { applySelectedDiscardResponse } from "./applyDiscardResponse.js";
import {
  canDeclareNineTerminals,
  isAbortiveDrawReasonEnabled,
  isFourRiichiAbortive,
  postDiscardAbortiveDrawReason,
  type AbortiveDrawReason,
} from "./abortiveDraw.js";
import { applyPaoSettlement, recordPaoLiabilityAfterOpenCall } from "../rules/pao.js";
import { collectVisibleTileKinds } from "../ai/visibleTiles.js";

/**
 * Who decides this seat's actions - independent of `characterProfiles` (which is identity:
 * "who/what this seat is", not "who controls it"). "customAI" is reserved for a future
 * pluggable AI and is rejected at construction time today - it is not implemented yet.
 */
export type ControllerKind = "simpleAI" | "characterAI" | "human" | "customAI";

export interface GameStateOptions {
  rules: RuleConfig;
  seed: string;
  /** Optional per-seat character identity (personality/flavor), independent of who actually
   *  controls the seat - see `controllers`. A "characterAI"-controlled seat needs a profile
   *  here; a "human" seat may still carry one purely for identity/display purposes, and
   *  having one never forces AI control (see `controllers`' doc comment). */
  characterProfiles?: (CharacterProfile | null | undefined)[];
  /** Explicit per-seat controller assignment - the source of truth for who decides this
   *  seat's actions. A seat left undefined here defaults to "human" if listed in
   *  `humanSeats`, else "characterAI" if it has a characterProfile, else "simpleAI" - so
   *  existing `characterProfiles`-only callers are unaffected. An explicit entry here always
   *  wins over both defaults, so e.g. `characterProfiles: [minaProfile]` + `controllers:
   *  ["human"]` gives seat 0 Mina's identity under human control instead of CharacterAI. */
  controllers?: (ControllerKind | undefined)[];
  /** Optional deterministic non-winning call selector, primarily for yonma fixtures.
   *  Omit to retain SimpleAI's pon/daiminkan decisions and decline automatic chi. */
  discardResponsePolicy?: (options: readonly NonWinningCallCandidate[]) => NonWinningCallCandidate | undefined;
  /** 九種九牌 is optional for the player. Autonomous games declare by default. */
  nineTerminalsPolicy?: (seat: number, hand: Hand) => boolean;
  /** Optional actor choice for each legal Kita opportunity. Each extraction is offered
   *  separately; false passes only the current action window. */
  kitaDecisionPolicy?: (seat: number, hand: Hand, extractedThisTurn: number) => boolean;
  /** Compatibility shorthand for `controllers: [...seat => "human"...]` - see `controllers`'
   *  doc comment for the exact precedence. Kept for the Milestone 1 API surface; new callers
   *  should prefer `controllers` directly. Milestone 1 scope regardless of how a human seat
   *  is designated: ron stays auto-declared for every seat - only discard+riichi, pon,
   *  daiminkan, ankan, kakan, and kita are ever asked of a human seat. */
  humanSeats?: number[];
}

/** seatWind: 1=East, 2=South, 3=West, relative to who is dealer this hand. */
function seatWindFor(player: number, dealer: number, playerCount: number): number {
  return seatDistance(dealer, player, playerCount) + 1;
}

/** Runs the ron/chankan window while ippatsu is still live. Only an action that survives
 *  that window and lets the hand continue commits the interruption/cancellation. */
export function resolveRonBeforeInterruption<T>(offerRon: () => T[], commitInterruption: () => void): T[] {
  const winners = offerRon();
  if (winners.length === 0) commitInterruption();
  return winners;
}

/** Same contract as resolveRonBeforeInterruption, for an offer that may yield a human ron
 *  decision. Kept separate so the synchronous exported helper's signature (and its direct
 *  callers/tests) never changes. */
export function* resolveRonBeforeInterruptionInteractive<T>(
  offerRon: () => Generator<DecisionRequest, T[], DecisionResponse>,
  commitInterruption: () => void
): Generator<DecisionRequest, T[], DecisionResponse> {
  const winners = yield* offerRon();
  if (winners.length === 0) commitInterruption();
  return winners;
}

export interface FinalStanding {
  player: number;
  rawScore: number;
  placement: number; // 1 through rules.playerCount
  uma: number; // placement bonus in game-score units (e.g. +15, not +15000)
  points: number; // (rawScore - returnScore) / 1000 + uma, in "score units" (not raw points)
}

export interface PhysicalHandBootstrap {
  wall: Wall;
  hands: Hand[];
  dealerFirstDraw?: Tile;
}

type PendingHandResult =
  | {
      kind: "agari";
      winners: AuditableWinResult[];
      kyotakuRecipient: number | null;
      kyotakuAwarded: number;
      scoresBeforeSettlement: number[];
      pointDeltas: Record<number, number>;
      kyotakuBefore: number;
    }
  | {
      kind: "exhaustive_draw";
      tenpaiSeats: number[];
      notenSeats: number[];
      nagashiManganSeats: number[];
      scoresBeforeSettlement: number[];
      pointDeltas: Record<number, number>;
      kyotakuBefore: number;
    }
  | {
      kind: "abortive_draw";
      reason: AbortiveDrawReason;
      scoresBeforeSettlement: number[];
      pointDeltas: Record<number, number>;
      kyotakuBefore: number;
    };

export class GameState {
  readonly rules: RuleConfig;
  readonly baseSeed: string;
  readonly characterProfiles: (CharacterProfile | null)[];
  readonly discardResponsePolicy?: GameStateOptions["discardResponsePolicy"];
  readonly nineTerminalsPolicy: NonNullable<GameStateOptions["nineTerminalsPolicy"]>;
  readonly kitaDecisionPolicy?: GameStateOptions["kitaDecisionPolicy"];
  /** Per-seat controller assignment - see ControllerKind and GameStateOptions.controllers
   *  for the exact derivation/precedence. This, not characterProfiles, is the source of
   *  truth for who decides a seat's actions. */
  readonly controllers: ControllerKind[];
  scores: number[];
  dealerSeat = 0;
  roundWind = 1;
  roundHandNumber = 1;
  honba = 0;
  kyotaku = 0;
  handIndex = 0;
  readonly log: GameEvent[] = [];
  /** CharacterAI decision-debug entries (see AiDecisionEntry) - a separate, purely
   *  additive instrumentation layer. Empty for any game with no character profiles. */
  readonly aiDecisionLog: AiDecisionEntry[] = [];
  /** Set the instant any player's score goes below 0 (tobi/bust), checked once per hand
   *  in advanceAfterHand right after that hand's win/exhaustive-draw scoring is fully
   *  final - never mid-hand. Once true, isGameOver() is true regardless of round/hand
   *  count, so playGame()'s loop never starts another hand. Exactly 0 is NOT a bust. */
  private tobiTriggered = false;
  /** Set once the game has actually played a hand beyond its scheduled length (see
   *  isPastNormalLength) because nobody had reached rules.targetScore yet at that point -
   *  the configured "extension" (play past the normal last hand until someone crosses the
   *  target score). Only ever set true from inside playGame()'s loop, never
   *  read as a game-over condition itself - isGameOver() derives continuation from the
   *  live scores every time, this just records *whether* that happened for game_end's
   *  reason field. */
  private extended = false;
  private dealerContinuationPending = false;
  private dealerEndTriggered = false;
  /** Set once finalizeGame() has actually run - makes it safe to call more than once
   *  (double-submit, reconnect, etc.) without re-sweeping kyotaku or double-logging
   *  game_end. See finalizeGame()'s own comment for the exact contract. */
  private finalizedGameEnd: GameEndEvent | undefined;

  constructor(opts: GameStateOptions) {
    this.rules = opts.rules;
    this.baseSeed = opts.seed;
    this.characterProfiles = allSeats(opts.rules.playerCount).map((i) => opts.characterProfiles?.[i] ?? null);
    this.discardResponsePolicy = opts.discardResponsePolicy;
    this.nineTerminalsPolicy = opts.nineTerminalsPolicy ?? (() => true);
    this.kitaDecisionPolicy = opts.kitaDecisionPolicy;
    const humanSeatSet = new Set(opts.humanSeats ?? []);
    this.controllers = allSeats(opts.rules.playerCount).map((i) => {
      const explicit = opts.controllers?.[i];
      if (explicit) return explicit;
      if (humanSeatSet.has(i)) return "human";
      return this.characterProfiles[i] ? "characterAI" : "simpleAI";
    });
    if (this.controllers.some((c) => c === "customAI")) {
      throw new Error('GameState: controller kind "customAI" is not implemented yet');
    }
    this.scores = allSeats(opts.rules.playerCount).map(() => opts.rules.startingScore);
  }

  /**
   * Physical hand setup shared by sanma and yonma: create seats, deal 13 tiles each, and
   * optionally perform the dealer's first draw. No calls, scoring, or round progression.
   */
  bootstrapPhysicalHand(drawDealerFirstTile = false): PhysicalHandBootstrap {
    const wallSeed = `${this.baseSeed}::hand${this.handIndex}`;
    const wall = new Wall(this.rules, wallSeed);
    const seats = allSeats(this.rules.playerCount);
    const hands = seats.map(() => new Hand());
    const dealt = wall.dealInitial(this.rules.playerCount, 13);
    for (const seat of seats) hands[seat]!.dealIn(dealt[seat]!);
    if (!drawDealerFirstTile) return { wall, hands };
    const dealerFirstDraw = wall.drawTile();
    hands[this.dealerSeat]!.addDrawn(dealerFirstDraw);
    return { wall, hands, dealerFirstDraw };
  }

  private assertFullGameplaySupported(): void {
    if (
      this.rules.playerCount !== MAJSOUL_SANMA_RULESET.playerCount &&
      this.rules.playerCount !== MAJSOUL_YONMA_RULESET.playerCount
    ) {
      throw new Error(`GameState: unsupported player count ${this.rules.playerCount}`);
    }
  }

  /** Whether the regularly scheduled hands (e.g. East1-3 for gameLength "east") have all
   *  been played. This boundary is independent of both final-score conversion and the
   *  target-score gate used after the scheduled last hand. */
  private isPastNormalLength(): boolean {
    const maxWind = this.rules.gameLength === "east" ? 1 : 2;
    return this.roundWind > maxWind || (this.roundWind === maxWind && this.roundHandNumber > this.rules.handsPerRound);
  }

  /** The built-in rules cap extension at one wind beyond the normal schedule (e.g.
   *  "east" extends into South but never West - 남입은 허용, 서입은 금지) - once that
   *  extra wind's final configured hand finishes normally, the game ends regardless of whether
   *  anyone has reached the target score yet. */
  private isPastExtensionCap(): boolean {
    const extensionCapWind = (this.rules.gameLength === "east" ? 1 : 2) + this.rules.maxExtensionRounds;
    return this.roundWind > extensionCapWind || (this.roundWind === extensionCapWind && this.roundHandNumber > this.rules.handsPerRound);
  }

  isGameOver(): boolean {
    if (this.tobiTriggered) return true;
    if (this.dealerEndTriggered) return true;
    if (this.dealerContinuationPending) return false;
    if (!this.isPastNormalLength()) return false;
    if (this.isPastExtensionCap()) return true;
    // Ruleset target-score extension: once the schedule is exhausted, keep playing
    // (dealer continuation/renchan rules apply exactly as during a normal hand) until
    // someone's raw score has reached rules.targetScore, up to the cap above.
    return this.scores.some((s) => s >= this.rules.targetScore);
  }

  /** Best-effort "this is the last named hand" signal (ignores any renchan extension that
   *  hasn't happened yet) - used only as a soft pressure signal for Tosuke's intervention check. */
  private isLastNamedHand(): boolean {
    const maxWind = this.rules.gameLength === "east" ? 1 : 2;
    return this.roundWind === maxWind && this.roundHandNumber === this.rules.handsPerRound;
  }

  /** Evaluated once at each hand boundary, exactly where playGame()'s loop always checked it
   *  (before deciding whether to play another hand) - marks `extended` permanently true the
   *  first time the schedule has already been exceeded. Extracted verbatim (same timing, same
   *  condition) so GuiSession's own interactive multi-hand loop can call it identically after
   *  each hand's playHandInteractive() generator finishes, instead of duplicating this check. */
  updateGameContinuationStateAfterHand(): void {
    if (this.isPastNormalLength()) this.extended = true;
  }

  playGame(): void {
    this.assertFullGameplaySupported();
    let guard = 0;
    while (!this.isGameOver()) {
      this.updateGameContinuationStateAfterHand();
      this.playHand();
      guard++;
      if (guard > 200) throw new Error("GameState.playGame: runaway loop guard triggered");
    }
    this.finalizeGame();
  }

  /**
   * The game-end wrap-up (final kyotaku settlement, reason computation, `game_end` log
   * event) - extracted from playGame()'s former inline tail so an interactive multi-hand
   * driver (GuiSession) can call the exact same logic once its own loop observes
   * isGameOver(), without reimplementing it. Throws if the game genuinely hasn't ended yet
   * (isGameOver() false) rather than silently no-op'ing. Safe to call more than once - a
   * second call returns the same event unchanged, so a double-submit/reconnect/retry can
   * never re-sweep kyotaku or double-log game_end.
   */
  finalizeGame(): GameEndEvent {
    this.assertFullGameplaySupported();
    if (this.finalizedGameEnd) return this.finalizedGameEnd;
    if (!this.isGameOver()) {
      throw new Error("GameState.finalizeGame: cannot finalize a game that has not ended (isGameOver() is false)");
    }
    const reason: GameEndEvent["reason"] = this.tobiTriggered ? "tobi" : this.extended ? "extension_end" : "length";
    // Final kyotaku settlement: any riichi sticks still on the table when the game ends go
    // entirely to whoever is currently in 1st place by raw score - same tie-break (lowest
    // seat index) computeFinalStandings() uses, applied last, after tobi/length/extension is
    // already decided, so it can never itself flip which outcome triggered game end.
    if (this.kyotaku > 0) {
      const leaderScore = Math.max(...this.scores);
      const leader = this.scores.findIndex((s) => s === leaderScore);
      this.scores[leader]! += this.kyotaku * 1000;
      this.kyotaku = 0;
    }
    const eliminatedPlayers = allSeats(this.rules.playerCount).filter((p) => this.scores[p]! < 0);
    const event: GameEndEvent = {
      type: "game_end",
      finalScores: [...this.scores],
      reason,
      eliminatedPlayers,
    };
    this.log.push(event);
    this.finalizedGameEnd = event;
    return event;
  }

  /** Final ranked standings: raw score is untouched (kept for the conservation invariant),
   *  `points` applies the return-score baseline and uma placement bonus for display/ranking. */
  computeFinalStandings(): FinalStanding[] {
    this.assertFullGameplaySupported();
    const order = allSeats(this.rules.playerCount).sort(
      (a, b) => this.scores[b]! - this.scores[a]! || seatDistance(0, a, this.rules.playerCount) - seatDistance(0, b, this.rules.playerCount)
    );
    return order.map((player, i) => ({
      player,
      rawScore: this.scores[player]!,
      placement: i + 1,
      uma: this.rules.uma[i]! / 1000,
      points: (this.scores[player]! - this.rules.returnScore) / 1000 + this.rules.uma[i]! / 1000,
    }));
  }

  /** Common no-payment transition for Mahjong Soul abortive draws. */
  applyAbortiveDraw(reason: AbortiveDrawReason): void {
    this.log.push({ type: "abortive_draw", reason });
    this.advanceAfterHand(true, true, false, {
      kind: "abortive_draw",
      reason,
      scoresBeforeSettlement: [...this.scores],
      pointDeltas: Object.fromEntries(allSeats(this.rules.playerCount).map((seat) => [seat, 0])),
      kyotakuBefore: this.kyotaku,
    });
  }

  /**
   * The actual hand state machine. Yields a DecisionRequest exactly at the decision points
   * listed in GameStateOptions.controllers' doc comment, for any seat whose controller is
   * "human" - every other seat (characterAI or simpleAI) is decided synchronously exactly
   * as before, so a game with no human-controlled seat never yields at all: `playHand()`
   * below still drives it to completion in one `.next()` call, unchanged.
   */
  private *playHandSession(): Generator<DecisionRequest, void, DecisionResponse> {
    this.assertFullGameplaySupported();
    const wallSeed = `${this.baseSeed}::hand${this.handIndex}`;
    const { wall, hands } = this.bootstrapPhysicalHand();
    const seats = allSeats(this.rules.playerCount);
    const dealt = hands.map((hand) => [...hand.concealed]);
    const furiten = seats.map(() => new FuritenTracker());

    // ippatsu window per player, and whether the hand's very first go-around has been
    // interrupted by any call (governs double riichi / tenhou / chiihou eligibility).
    const ippatsuEligible = seats.map(() => false);
    const appliedDiscardIds = new Set<number>();
    let tableInterrupted = false;
    const drawCountByPlayer = seats.map(() => 0);

    this.log.push({
      type: "hand_start",
      handIndex: this.handIndex,
      roundWind: this.roundWind,
      roundHandNumber: this.roundHandNumber,
      dealer: this.dealerSeat,
      honba: this.honba,
      kyotaku: this.kyotaku,
      scores: [...this.scores],
      wallSeed: wall.seed,
    });
    this.log.push({
      type: "deal",
      hands: dealt.map((playerTiles) => playerTiles.map((t) => t.kind)),
      doraIndicator: wall.doraIndicators()[0]!.kind,
    });
    this.log.push({
      type: "dora_indicator_revealed",
      source: "initial",
      indicator: tileToRef(wall.doraIndicators()[0]!),
    });
    // Fires a "dora_indicator_revealed" event for every indicator that has newly become
    // visible since the last call - covers both immediate (ankan) and deferred
    // (open/added kan, revealed only after the caller's discard) reveal timing without
    // ever re-emitting an already-revealed indicator. Index 0 (initial) is emitted above.
    let revealedDoraIndicatorCount = 1;
    const emitNewlyRevealedDoraIndicators = () => {
      const indicators = wall.doraIndicators();
      while (revealedDoraIndicatorCount < indicators.length) {
        this.log.push({
          type: "dora_indicator_revealed",
          source: "kan",
          indicator: tileToRef(indicators[revealedDoraIndicatorCount]!),
        });
        revealedDoraIndicatorCount++;
      }
    };

    const cachedWinningTiles: TileKind[][] = seats.map(() => []);
    const refreshWinningTiles = (p: number) => {
      cachedWinningTiles[p] = computeWinningTiles(tilesToCounts(hands[p]!.concealed), hands[p]!.melds.length, this.rules);
    };
    for (const p of seats) refreshWinningTiles(p);

    const scoringContextFor = (
      player: number,
      isTsumo: boolean,
      isRinshan: boolean,
      isHaitei: boolean,
      isHoutei: boolean,
      isChankan: boolean,
      isTenhou: boolean,
      isChiihou: boolean
    ) => {
      const hand = hands[player]!;
      return buildWinContext({
        hand,
        rules: this.rules,
        player,
        dealer: this.dealerSeat,
        playerCount: this.rules.playerCount,
        roundWind: this.roundWind,
        ippatsuEligible: ippatsuEligible[player]!,
        doraIndicatorKinds: wall.doraIndicators().map((tile) => tile.kind),
        uraDoraIndicatorKinds: hand.riichi ? wall.uraDoraIndicators().map((tile) => tile.kind) : [],
        isTsumo,
        isHaitei,
        isHoutei,
        isRinshan,
        isChankan,
        isTenhou,
        isChiihou,
      });
    };

    const tryEvaluate = (
      player: number,
      winTile: Tile,
      isTsumo: boolean,
      ronFrom: number | undefined,
      isRinshan: boolean,
      isHaitei: boolean,
      isHoutei: boolean,
      isChankan = false
    ): FullWinResult | null => {
      const hand = hands[player]!;
      const isTenhou = isTsumo && player === this.dealerSeat && drawCountByPlayer[player] === 0 && !tableInterrupted;
      const isChiihou = isTsumo && player !== this.dealerSeat && drawCountByPlayer[player] === 0 && !tableInterrupted;
      const ctx = scoringContextFor(player, isTsumo, isRinshan, isHaitei, isHoutei, isChankan, isTenhou, isChiihou);
      const input = {
        concealedTiles: hand.concealed,
        melds: meldsToGroups(hand.melds),
        context: ctx,
        rules: this.rules,
        winner: player,
        dealer: this.dealerSeat,
        ronFrom,
        honba: this.honba,
      };
      return isTenhou
        ? evaluateInitialDealerWin(input)
        : evaluateWin({ ...input, winTile });
    };

    const tryRon = (player: number, tile: Tile, ronFrom: number, isHoutei: boolean, isChankan = false): FullWinResult | null => {
      const h = hands[player]!;
      h.concealed.push(tile);
      try {
        return tryEvaluate(player, tile, false, ronFrom, false, false, isHoutei, isChankan);
      } finally {
        h.concealed.pop();
      }
    };

    const ronPlayerCount = this.rules.playerCount;
    const ronDoubleRonMode = this.rules.doubleRonMode;

    /** Offers `tile` (from `fromSeat`) to the other players for ron, in turn order (closest
     *  to the discarder first), one candidate at a time.
     *  - Any player whose shape matches but who has no yaku becomes temporarily furiten -
     *    the "atozuke" case where a hand-completing tile legally can't be ronned.
     *  - A furiten seat is skipped entirely (never asked, never a new miss).
     *  - A non-human seat with a valid ron always takes it (unchanged auto-ron). A human seat
     *    is asked; passing is a genuine missed chance (onMissedRonChance).
     *  - "atamahane": the first accepted ron ends the offer, so later candidates are never
     *    evaluated - being head-bumped is not a pass and grants no furiten. "all": every
     *    candidate is handled independently. With no human seat this never yields. */
    function* offerRon(
      fromSeat: number,
      tile: Tile,
      isHoutei: boolean,
      isChankan: boolean,
      context: RonDecisionContext,
      restriction: "any" | "kokushi-ankan" = "any"
    ): Generator<DecisionRequest, { player: number; result: FullWinResult }[], DecisionResponse> {
      const order = seatsInTurnOrder(fromSeat, ronPlayerCount);
      const accepted: { player: number; result: FullWinResult }[] = [];
      for (const p of order) {
        const otherHand = hands[p]!;
        const winningTiles = cachedWinningTiles[p]!;
        if (!winningTiles.includes(tile.kind)) continue;
        const ownDiscardKinds = otherHand.discards.map((d) => d.tile.kind);
        if (furiten[p]!.isFuriten(winningTiles, ownDiscardKinds)) continue;
        const result = tryRon(p, tile, fromSeat, isHoutei, isChankan);
        if (result && (restriction === "any" || isKokushiAnkanRon(result))) {
          let takesRon = true;
          if (isHumanSeat(p)) {
            const response = (yield {
              type: "ron",
              seat: p,
              fromSeat,
              winningTile: tileToRef(tile),
              context,
              preview: {
                yaku: result.yaku.map((y) => ({ name: y.name, han: y.han })),
                han: result.han,
                fu: result.fu,
                yakumanUnits: result.yakumanUnits,
                totalPoints: result.score.totalPoints,
              },
              view: buildViewFor(p),
            } satisfies RonDecisionRequest) as RonDecisionResponse;
            if (response.type !== "ron") {
              throw new Error(`GameState: expected a "ron" response for seat ${p}, got "${response.type}"`);
            }
            takesRon = response.declare === true;
            if (!takesRon) furiten[p]!.onMissedRonChance();
          }
          if (takesRon) {
            accepted.push({ player: p, result });
            if (ronDoubleRonMode === "atamahane") break;
          }
        } else if (!result && restriction === "any") {
          // shape-complete, no legal yaku (atozuke) - this counts as a missed ron chance
          furiten[p]!.onMissedRonChance();
        }
      }
      return resolveRonWinners(accepted, ronDoubleRonMode);
    }

    const finishHandWithWin = (winners: { player: number; result: FullWinResult; ronFrom?: number }[]) => {
      const scoresBeforeSettlement = [...this.scores];
      const kyotakuBefore = this.kyotaku;
      const paoAdjusted = winners.map((winner) => {
        const adjusted = applyPaoSettlement({
          score: winner.result.score,
          yaku: winner.result.yaku,
          yakumanUnits: winner.result.yakumanUnits,
          liability: hands[winner.player]!.paoLiability,
          winner: winner.player,
          dealer: this.dealerSeat,
          isTsumo: winner.ronFrom === undefined,
          ronFrom: winner.ronFrom,
          honba: this.honba,
          rules: this.rules,
        });
        return {
          ...winner,
          result: { ...winner.result, score: adjusted.score },
          honbaPayer: adjusted.honbaPayer,
        };
      });
      // Double/triple ron: evaluateWin computed each winner's payment independently, so
      // every one of them separately added the full honba bonus onto the discarder's
      // payment - the discarder would otherwise pay honba N times instead of once. Only the
      // winner closest to the discarder in turn order (winners[0], the same precedence
      // already used for the riichi-stick payout below) keeps it; strip it back out of every
      // other winner's own deltas and credit it back to the discarder.
      const settlement = settleOrderedWinPayments(
        this.rules.playerCount,
        paoAdjusted.map((winner) => ({
          seat: winner.player,
          ronFrom: winner.ronFrom,
          score: winner.result.score,
          honbaPayer: winner.honbaPayer,
        })),
        this.honba,
        this.rules.honbaValue,
        this.kyotaku
      );
      const adjustedWinners = paoAdjusted.map((winner, index) => ({
        ...winner,
        result: {
          ...winner.result,
          score: {
            ...winner.result.score,
            totalPoints: settlement.adjusted[index]!.totalPoints,
            payments: { deltas: settlement.adjusted[index]!.deltas },
          },
        },
      }));
      const deltas = settlement.combinedDeltas;
      this.kyotaku = 0;
      for (const p of seats) this.scores[p]! += deltas[p]!;

      for (const w of adjustedWinners) {
        this.log.push({
          type: "win",
          player: w.player,
          isTsumo: w.ronFrom === undefined,
          ronFrom: w.ronFrom,
          yaku: w.result.yaku,
          han: w.result.han,
          fu: w.result.fu,
          yakumanUnits: w.result.yakumanUnits,
          points: w.result.score.totalPoints,
          deltas: w.result.score.payments.deltas,
        });
      }

      // Same wall state every winner (of a possible multi-ron) was scored against - no kan
      // can occur between offering ron and finishing the hand, so re-reading here is safe.
      const doraIndicatorsAtWin = wall.doraIndicators();
      const uraDoraIndicatorsAtWin = wall.uraDoraIndicators();

      const auditableWinners: AuditableWinResult[] = adjustedWinners.map((winner) => {
        const hand = hands[winner.player]!;
        const isTsumo = winner.ronFrom === undefined;
        // For tsumo the winning tile is already in hand.concealed (added by the normal
        // draw step). For ron it deliberately is NOT (tryRon pops it back out after
        // evaluation - see WinSnapshot's definition), yet it still legitimately counts
        // toward dora matching exactly as it did during real scoring (tryRon had it pushed
        // in at evaluation time) - so it's added to the dora-matching pool only here, never
        // into the snapshot's concealedTiles.
        const scoringTiles = isTsumo
          ? [...hand.concealed, ...hand.melds.flatMap((meld) => meld.tiles)]
          : [...hand.concealed, ...hand.melds.flatMap((meld) => meld.tiles), winner.result.winningTile];
        const doraBreakdown = buildDoraBreakdown({
          scoringTiles,
          kitaTiles: hand.kitaTiles,
          doraIndicators: doraIndicatorsAtWin,
          uraDoraIndicators: winner.result.context.isRiichi ? uraDoraIndicatorsAtWin : [],
          rules: this.rules,
        });
        const snapshot = buildWinSnapshot({
          hand,
          winningTile: winner.result.winningTile,
          isTsumo,
        });
        return {
          winnerSeat: winner.player,
          loserSeat: winner.ronFrom ?? null,
          method: winner.ronFrom === undefined ? "tsumo" : "ron",
          winningTile: { kind: winner.result.winningTile.kind, id: winner.result.winningTile.id },
          isDealer: winner.player === this.dealerSeat,
          yaku: winner.result.yaku.map((hit) => ({ ...hit })),
          han: winner.result.han,
          fu: winner.result.fu,
          yakumanUnits: winner.result.yakumanUnits,
          basePoints: winner.result.score.base,
          totalPoints: winner.result.score.totalPoints,
          paymentDeltas: { ...winner.result.score.payments.deltas },
          scoringFlags: {
            riichi: winner.result.context.isRiichi,
            doubleRiichi: winner.result.context.isDoubleRiichi,
            ippatsu: winner.result.context.isIppatsu,
            rinshan: winner.result.context.isRinshan,
            chankan: winner.result.context.isChankan,
            haitei: winner.result.context.isHaitei,
            houtei: winner.result.context.isHoutei,
            tenhou: winner.result.context.isTenhou,
            chiihou: winner.result.context.isChiihou,
          },
          doraBreakdown,
          snapshot,
        };
      });

      this.advanceAfterHand(
        shouldDealerContinue({
          dealerSeat: this.dealerSeat,
          isExhaustiveDraw: false,
          winnerSeats: winners.map((winner) => winner.player),
          renchanOnDealerWin: this.rules.renchanOnDealerWin,
          renchanOnDealerTenpaiDraw: this.rules.renchanOnDealerTenpaiDraw,
        }),
        false,
        true,
        {
          kind: "agari",
          winners: auditableWinners,
          kyotakuRecipient: kyotakuBefore > 0 ? settlement.closestWinner : null,
          kyotakuAwarded: kyotakuBefore * 1000,
          scoresBeforeSettlement,
          pointDeltas: { ...deltas },
          kyotakuBefore,
        }
      );
    };

    const finishExhaustiveDraw = () => {
      const scoresBeforeSettlement = [...this.scores];
      const kyotakuBefore = this.kyotaku;
      const { tenpaiPlayers, nagashiManganPlayers, deltas } = settleExhaustiveDraw({
        rules: this.rules,
        dealerSeat: this.dealerSeat,
        hands,
        winningTilesBySeat: cachedWinningTiles,
      });
      for (const p of seats) this.scores[p]! += deltas[p]!;
      this.log.push({ type: "exhaustive_draw", tenpaiPlayers, deltas });

      this.advanceAfterHand(
        shouldDealerContinue({
          dealerSeat: this.dealerSeat,
          isExhaustiveDraw: true,
          tenpaiPlayers,
          renchanOnDealerWin: this.rules.renchanOnDealerWin,
          renchanOnDealerTenpaiDraw: this.rules.renchanOnDealerTenpaiDraw,
        }),
        true,
        true,
        {
          kind: "exhaustive_draw",
          tenpaiSeats: [...tenpaiPlayers],
          notenSeats: seats.filter((seat) => !tenpaiPlayers.includes(seat)),
          nagashiManganSeats: [...nagashiManganPlayers],
          scoresBeforeSettlement,
          pointDeltas: { ...deltas },
          kyotakuBefore,
        }
      );
    };

    const finishAbortiveDraw = (reason: AbortiveDrawReason) => {
      this.applyAbortiveDraw(reason);
    };

    const riichiOpponentDiscards = (player: number): TileKind[][] =>
      seats.filter((p) => p !== player && hands[p]!.riichi).map((p) => hands[p]!.discards.map((d) => d.tile.kind));

    const opponentSeats = (player: number): number[] => seats.filter((p) => p !== player);
    const riichiOpponentSeats = (player: number): number[] =>
      seats.filter((p) => p !== player && hands[p]!.riichi);

    /** Recomputed as rivers/melds/Kita/dora grow; called-away river entries are represented
     *  by their caller's meld and are deliberately not counted a second time. */
    const allVisibleTileKinds = (): TileKind[] =>
      collectVisibleTileKinds(hands, wall.doraIndicators().map((tile) => tile.kind));

    // A CharacterAI instance exists only for a seat whose controller is actually
    // "characterAI" - a "human" seat that also happens to carry a characterProfile (for
    // identity/display only) correctly gets no AI instance here, and every decide* wrapper
    // below routes it through the human decision path instead. Any other controller
    // ("simpleAI", or "human" with no profile) keeps using the plain SimpleAI functions
    // exactly as before.
    const ais: (CharacterAI | null)[] = seats.map((p) => {
      if (this.controllers[p] !== "characterAI") return null;
      const profile = this.characterProfiles[p];
      if (!profile) {
        throw new Error(`GameState: seat ${p} has controller "characterAI" but no characterProfile was provided`);
      }
      return new CharacterAI(profile, `${wallSeed}::ai${p}`);
    });
    for (const ai of ais) ai?.onHandStart();

    const seatCtx = (player: number): CharacterDecisionContext => ({
      rules: this.rules,
      riichiOpponentDiscardKinds: riichiOpponentDiscards(player),
      doraIndicatorKinds: wall.doraIndicators().map((t) => t.kind),
      visibleTileKinds: allVisibleTileKinds(),
      seatWind: seatWindFor(player, this.dealerSeat, this.rules.playerCount),
      roundWind: this.roundWind,
      wallRemainingLive: wall.remainingLiveCount(),
      ownScore: this.scores[player]!,
      opponentScores: opponentSeats(player).map((p) => this.scores[p]!),
      opponentSeats: opponentSeats(player),
      riichiOpponentSeats: riichiOpponentSeats(player),
      isLastHandOfGame: this.isLastNamedHand(),
      isDealer: player === this.dealerSeat,
    });

    const chooseDiscardFor = (player: number, hand: Hand, forbiddenDiscardKinds: readonly TileKind[] = []): number => {
      const ai = ais[player];
      if (ai) {
        const id = ai.chooseDiscard(hand, seatCtx(player), forbiddenDiscardKinds);
        const debug = ai.lastDiscardDebug;
        if (debug) {
          this.aiDecisionLog.push(buildDiscardDecisionEntry({
            handIndex: this.handIndex,
            player,
            characterId: this.characterProfiles[player]!.characterId,
          }, debug));
        }
        return id;
      }
      return chooseDiscard({
        hand,
        riichiOpponentDiscardKinds: riichiOpponentDiscards(player),
        forbiddenDiscardKinds,
      });
    };

    const shouldDeclareRiichiFor = (player: number, hand: Hand, discardId: number): boolean => {
      const ai = ais[player];
      if (ai) {
        const declared = ai.shouldDeclareRiichi(hand, this.scores[player]!, wall.remainingLiveCount(), discardId, seatCtx(player));
        const trace = ai.lastRiichiTrace;
        if (trace) {
          this.aiDecisionLog.push(buildRiichiDecisionEntry({
            handIndex: this.handIndex,
            player,
            characterId: this.characterProfiles[player]!.characterId,
          }, trace));
        }
        return declared;
      }
      return shouldDeclareRiichi(hand, this.scores[player]!, wall.remainingLiveCount(), discardId);
    };

    const logCallTrace = (
      player: number,
      fromPlayer: number,
      tile: TileKind,
      trace: CallDecisionTrace | null,
      actualCalled: boolean
    ): void => {
      if (!trace) return;
      this.aiDecisionLog.push(buildCallDecisionEntry({
        meta: {
          handIndex: this.handIndex,
          player,
          characterId: this.characterProfiles[player]!.characterId,
        },
        fromPlayer,
        tile,
        actualCalled,
        decision: { source: "character", trace },
      }));
    };

    /** A seat with no CharacterAI profile keeps SimpleAI's own conservative, yakuhai-only
     *  pon/kan policy exactly as before. A CharacterAI seat evaluates every structurally
     *  legal call itself (decideCall: shanten/ukeire gain, real yaku viability via
     *  isYakuhai, callBias/aggression/defense) - SimpleAI's yakuhai-only plausibility check
     *  is NOT applied as a pre-filter for it, since that previously blocked CharacterAI
     *  from ever even seeing a non-yakuhai pon/kan candidate. Structural legality (canPon/
     *  canDaiminkan at the call sites below) still gates both paths identically. */
    const evaluatePonFor = (player: number, hand: Hand, discardedKind: TileKind): { called: boolean; trace: CallDecisionTrace | null } => {
      const seatWind = seatWindFor(player, this.dealerSeat, this.rules.playerCount);
      const ai = ais[player];
      if (!ai) return { called: shouldCallPon(discardedKind, seatWind, this.roundWind), trace: null };
      const isYakuhai = isYakuhaiTile(discardedKind, seatWind, this.roundWind);
      const called = ai.shouldCallPon(hand, discardedKind, seatCtx(player), isYakuhai);
      return { called, trace: ai.lastCallTrace };
    };

    const evaluateDaiminkanFor = (player: number, hand: Hand, discardedKind: TileKind): { called: boolean; trace: CallDecisionTrace | null } => {
      const seatWind = seatWindFor(player, this.dealerSeat, this.rules.playerCount);
      const ai = ais[player];
      if (!ai) return { called: shouldCallDaiminkan(discardedKind, seatWind, this.roundWind), trace: null };
      const isYakuhai = isYakuhaiTile(discardedKind, seatWind, this.roundWind);
      const called = ai.shouldCallDaiminkan(hand, discardedKind, seatCtx(player), isYakuhai);
      return { called, trace: ai.lastCallTrace };
    };

    const shouldDeclareShouminkanFor = (player: number, hand: Hand, kind: TileKind): boolean => {
      const ai = ais[player];
      return ai ? ai.shouldDeclareShouminkan(hand, kind, seatCtx(player)) : shouldDeclareShouminkan();
    };

    const shouldDeclareAnkanFor = (player: number, hand: Hand, kind: TileKind): boolean => {
      const ai = ais[player];
      return ai ? ai.shouldDeclareAnkan(hand, kind, seatCtx(player)) : shouldDeclareAnkan();
    };

    const shouldDeclareKitaFor = (player: number, hand: Hand, extractedThisTurn: number): boolean => {
      if (this.kitaDecisionPolicy) return this.kitaDecisionPolicy(player, hand, extractedThisTurn);
      const ai = ais[player];
      return ai ? ai.shouldDeclareKita(hand, seatCtx(player)) : shouldDeclareKita();
    };

    /** Source of truth: GameState.controllers, not characterProfiles - a "human" seat with
     *  a characterProfile still routes through the human decision path. Milestone 1 scope:
     *  this never applies to ron. */
    const isHumanSeat = (player: number): boolean => this.controllers[player] === "human";

    /** Seat-filtered snapshot handed to a human decision request - see PlayerView. Never
     *  reads any other seat's concealed tiles. */
    const buildViewFor = (seat: number): PlayerView =>
      buildPlayerView({
        seat,
        furiten: furiten[seat]!.snapshot(
          cachedWinningTiles[seat]!,
          hands[seat]!.discards.map((d) => d.tile.kind)
        ),
        hands,
        doraIndicators: wall.doraIndicators(),
        scores: this.scores,
        dealerSeat: this.dealerSeat,
        roundWind: this.roundWind,
        roundHandNumber: this.roundHandNumber,
        honba: this.honba,
        kyotaku: this.kyotaku,
        wallRemainingLive: wall.remainingLiveCount(),
      });

    // --- Human decision points (Milestone 1: discard+riichi, pon, daiminkan, ankan, kakan,
    // kita). Each wrapper below defers to the existing AI/SimpleAI function unchanged - byte
    // for byte the same call, same RNG consumption - whenever the seat isn't human-driven,
    // and only yields a DecisionRequest for an actual human seat. None of these ever run for
    // an all-AI game, so playHand() (the synchronous AI-only entry point) never sees a yield.

    function* decidePon(
      player: number,
      hand: Hand,
      discardedKind: TileKind,
      fromPlayer: number,
      human: boolean
    ): Generator<DecisionRequest, { called: boolean; trace: CallDecisionTrace | null }, DecisionResponse> {
      if (!human) return evaluatePonFor(player, hand, discardedKind);
      const response = (yield {
        type: "call_pon",
        seat: player,
        tileKind: discardedKind,
        fromPlayer,
        view: buildViewFor(player),
      } satisfies CallDecisionRequest) as CallDecisionResponse;
      return { called: response.declare, trace: null };
    }

    function* decideDaiminkan(
      player: number,
      hand: Hand,
      discardedKind: TileKind,
      fromPlayer: number,
      human: boolean
    ): Generator<DecisionRequest, { called: boolean; trace: CallDecisionTrace | null }, DecisionResponse> {
      if (!human) return evaluateDaiminkanFor(player, hand, discardedKind);
      const response = (yield {
        type: "call_daiminkan",
        seat: player,
        tileKind: discardedKind,
        fromPlayer,
        view: buildViewFor(player),
      } satisfies CallDecisionRequest) as CallDecisionResponse;
      return { called: response.declare, trace: null };
    }

    function* decideShouminkan(
      player: number,
      hand: Hand,
      kind: TileKind,
      human: boolean
    ): Generator<DecisionRequest, boolean, DecisionResponse> {
      if (!human) return shouldDeclareShouminkanFor(player, hand, kind);
      const response = (yield { type: "kakan", seat: player, tileKind: kind, view: buildViewFor(player) } satisfies CallDecisionRequest) as CallDecisionResponse;
      return response.declare;
    }

    function* decideAnkan(
      player: number,
      hand: Hand,
      kind: TileKind,
      human: boolean
    ): Generator<DecisionRequest, boolean, DecisionResponse> {
      if (!human) return shouldDeclareAnkanFor(player, hand, kind);
      const response = (yield { type: "ankan", seat: player, tileKind: kind, view: buildViewFor(player) } satisfies CallDecisionRequest) as CallDecisionResponse;
      return response.declare;
    }

    function* decideKita(
      player: number,
      hand: Hand,
      kitaEnabled: boolean,
      extractedThisTurn: number,
      human: boolean
    ): Generator<DecisionRequest, KitaAction, DecisionResponse> {
      if (!canKita(hand, kitaEnabled)) return "unavailable";
      if (!human) return shouldDeclareKitaFor(player, hand, extractedThisTurn) ? "kita" : "pass";
      const response = (yield { type: "kita", seat: player, tileKind: "z4", view: buildViewFor(player) } satisfies CallDecisionRequest) as CallDecisionResponse;
      return response.declare ? "kita" : "pass";
    }

    /** Discard and riichi are answered together: riichi is a property of a specific
     *  discard, not an independent decision - see DiscardDecisionRequest. AI/SimpleAI seats
     *  keep the exact existing two-call sequence (chooseDiscardFor then
     *  shouldDeclareRiichiFor) unchanged; only a human seat gets the combined contract. */
    function* decideDiscardAndRiichi(
      player: number,
      hand: Hand,
      human: boolean,
      score: number,
      wallRemainingLive: number,
      forbiddenDiscardKinds: readonly TileKind[] = []
    ): Generator<DecisionRequest, { discardId: number; declaringRiichi: boolean }, DecisionResponse> {
      if (!human) {
        const discardId = chooseDiscardFor(player, hand, forbiddenDiscardKinds);
        const declaringRiichi = shouldDeclareRiichiFor(player, hand, discardId);
        return { discardId, declaringRiichi };
      }
      const legalTileIds = hand.concealed.filter((t) => !forbiddenDiscardKinds.includes(t.kind)).map((t) => t.id);
      const riichiLegalTileIds = canDeclareRiichi(hand, score, wallRemainingLive)
        ? riichiDiscardCandidates(hand).filter((id) => legalTileIds.includes(id))
        : [];
      const response = (yield {
        type: "discard",
        seat: player,
        legalTileIds,
        riichiLegalTileIds,
        view: buildViewFor(player),
      } satisfies DiscardDecisionRequest) as DiscardDecisionResponse;
      if (!legalTileIds.includes(response.tileId)) {
        throw new Error(
          `GameState: human decision response chose tileId ${response.tileId}, which is not a legal discard for seat ${player}`
        );
      }
      if (response.declareRiichi && !riichiLegalTileIds.includes(response.tileId)) {
        throw new Error(
          `GameState: human decision response declared riichi discarding tileId ${response.tileId}, which is not a legal riichi discard for seat ${player}`
        );
      }
      return { discardId: response.tileId, declaringRiichi: response.declareRiichi };
    }

    type DiscardResponseFlow = { ended: boolean; from: number; resumePostDrawSeat?: number };
    let pendingCalledKanDraw: { player: number; tile: Tile } | undefined;

    /**
     * Checks daiminkan/pon calls on `discardedTile` (ron on it must already have been
     * ruled out by the caller - see handleDiscardResponses and the riichi-declaration
     * branch below, which both check ron first before ever reaching this). A call chains
     * into that caller's own immediate discard and recurses through handleDiscardResponses.
     * Returns "ended" once a win concludes the hand, or the seat whose discard resolved
     * with no call, so the caller knows who to advance play from.
     */
    const offerCallsForDiscard: (
      discarderSeat: number,
      discardedTile: Tile
    ) => Generator<DecisionRequest, DiscardResponseFlow, DecisionResponse> = (function* (
      this: GameState,
      discarderSeat: number,
      discardedTile: Tile
    ): Generator<DecisionRequest, DiscardResponseFlow, DecisionResponse> {
      if (this.rules.playerCount === MAJSOUL_YONMA_RULESET.playerCount) {
        const generated = generateDiscardResponseCandidates({
          rules: this.rules,
          discarderSeat,
          discardedKind: discardedTile.kind,
          concealedKindsBySeat: hands.map((candidateHand) => candidateHand.concealed.map((tile) => tile.kind)),
          riichiSeats: seats.filter((seat) => hands[seat]!.riichi),
        });
        const willing: NonWinningCallCandidate[] = [];
        const evaluatedCalls: Array<{
          candidate: Extract<NonWinningCallCandidate, { type: "pon" | "daiminkan" }>;
          trace: CallDecisionTrace | null;
        }> = [];
        for (const candidate of generated) {
          if (candidate.type === "ron") continue;
          if (candidate.type === "chi") {
            willing.push(candidate);
            continue;
          }
          if (candidate.type === "daiminkan" && !wall.canDrawRinshan(this.rules.maxKans)) continue;
          const evaluation = candidate.type === "pon"
            ? evaluatePonFor(candidate.seat, hands[candidate.seat]!, discardedTile.kind)
            : evaluateDaiminkanFor(candidate.seat, hands[candidate.seat]!, discardedTile.kind);
          evaluatedCalls.push({ candidate, trace: evaluation.trace });
          if (evaluation.called) willing.push(candidate);
        }
        const resolution = arbitrateDiscardResponses(discarderSeat, this.rules.playerCount, willing);
        if (resolution.type !== "call") {
          for (const entry of evaluatedCalls) {
            logCallTrace(entry.candidate.seat, discarderSeat, discardedTile.kind, entry.trace, false);
          }
          return { ended: false, from: discarderSeat };
        }
        const selectedByPolicy = this.discardResponsePolicy?.(resolution.candidates);
        const defaultNonChi = resolution.candidates.find((candidate) => candidate.type !== "chi");
        const chiEvaluations = resolution.candidates
          .filter((candidate): candidate is Extract<NonWinningCallCandidate, { type: "chi" }> => candidate.type === "chi")
          .map((candidate) => ({ candidate, evaluation: ais[candidate.seat]?.evaluateChiCandidate(hands[candidate.seat]!, candidate, seatCtx(candidate.seat)) }))
          .filter((entry): entry is { candidate: Extract<NonWinningCallCandidate, { type: "chi" }>; evaluation: ChiDecisionEvaluation } => entry.evaluation !== undefined)
          .sort((a, b) => b.evaluation.score - a.evaluation.score);
        const selectedChi = chiEvaluations.find((entry) => entry.evaluation.shouldCall);
        const selected = selectedByPolicy ?? defaultNonChi ?? selectedChi?.candidate;
        for (const entry of evaluatedCalls) {
          const actualCalled = selected?.type === entry.candidate.type && selected.seat === entry.candidate.seat;
          logCallTrace(entry.candidate.seat, discarderSeat, discardedTile.kind, entry.trace, actualCalled);
        }
        for (const entry of chiEvaluations) {
          const actualCalled = selected?.type === "chi" && selected.sequence.join(",") === entry.candidate.sequence.join(",");
          this.aiDecisionLog.push(buildCallDecisionEntry({
            meta: {
              handIndex: this.handIndex,
              player: entry.candidate.seat,
              characterId: this.characterProfiles[entry.candidate.seat]!.characterId,
            },
            fromPlayer: discarderSeat,
            tile: discardedTile.kind,
            actualCalled,
            decision: {
              source: "chi",
              candidate: entry.candidate,
              evaluation: entry.evaluation,
              openMeldCount: hands[entry.candidate.seat]!.melds.length,
            },
          }));
        }
        if (!selected) return { ended: false, from: discarderSeat };
        if (!resolution.candidates.includes(selected)) {
          throw new Error("discardResponsePolicy selected a candidate outside the arbitrated options");
        }

        const applied = applySelectedDiscardResponse(
          {
            rules: this.rules,
            hands,
            wall,
            currentPlayer: discarderSeat,
            ippatsuEligible,
            appliedDiscardIds,
          },
          selected,
          discarderSeat,
          discardedTile
        );
        tableInterrupted = true;
        this.log.push({
          type: "call",
          call: selected.type === "daiminkan" ? "kan_open" : selected.type,
          player: selected.seat,
          kind: discardedTile.kind,
          fromPlayer: discarderSeat,
        });

        if (applied.replacementTile) {
          pendingCalledKanDraw = { player: selected.seat, tile: applied.replacementTile };
          return { ended: false, from: selected.seat, resumePostDrawSeat: selected.seat };
        }

        const discardId = chooseDiscardFor(selected.seat, hands[selected.seat]!, applied.forbiddenDiscardKinds);
        const newTile = hands[selected.seat]!.discardById(discardId, { tsumogiri: false, isRiichiDeclaration: false });
        this.log.push({ type: "discard", player: selected.seat, tile: newTile.kind, tsumogiri: false, riichiDeclaration: false });
        wall.revealPendingKanDora();
        emitNewlyRevealedDoraIndicators();
        refreshWinningTiles(selected.seat);
        return yield* handleDiscardResponses(selected.seat, newTile, wall.isExhausted());
      }

      const order = seatsInTurnOrder(discarderSeat, this.rules.playerCount);

      for (const p of order) {
        if (hands[p]!.riichi) continue;
        if (!canDaiminkan(hands[p]!, discardedTile.kind)) continue;
        const evaluation = yield* decideDaiminkan(p, hands[p]!, discardedTile.kind, discarderSeat, isHumanSeat(p));
        const actualCalled = evaluation.called && wall.canDrawRinshan(this.rules.maxKans);
        logCallTrace(p, discarderSeat, discardedTile.kind, evaluation.trace, actualCalled);
        if (actualCalled) {
          hands[discarderSeat]!.markDiscardCalledAway(discardedTile.id);
          applyDaiminkan(hands[p]!, discardedTile, discarderSeat);
          recordPaoLiabilityAfterOpenCall(hands[p]!, "kan_open", discardedTile.kind, discarderSeat);
          this.log.push({ type: "call", call: "kan_open", player: p, kind: discardedTile.kind, fromPlayer: discarderSeat });
          tableInterrupted = true;
          ippatsuEligible.fill(false);
          wall.commitKan("after-discard");
          const replacement = wall.drawCommittedRinshan();
          hands[p]!.addDrawn(replacement);
          pendingCalledKanDraw = { player: p, tile: replacement };
          return { ended: false, from: p, resumePostDrawSeat: p };
        }
      }

      for (const p of order) {
        if (hands[p]!.riichi) continue;
        if (!canPon(hands[p]!, discardedTile.kind)) continue;
        const evaluation = yield* decidePon(p, hands[p]!, discardedTile.kind, discarderSeat, isHumanSeat(p));
        logCallTrace(p, discarderSeat, discardedTile.kind, evaluation.trace, evaluation.called);
        if (evaluation.called) {
          hands[discarderSeat]!.markDiscardCalledAway(discardedTile.id);
          applyPon(hands[p]!, discardedTile, discarderSeat);
          recordPaoLiabilityAfterOpenCall(hands[p]!, "pon", discardedTile.kind, discarderSeat);
          this.log.push({ type: "call", call: "pon", player: p, kind: discardedTile.kind, fromPlayer: discarderSeat });
          tableInterrupted = true;
          ippatsuEligible.fill(false);
          // kita may not be declared immediately after a pon - go straight to discard (riichi
          // is structurally impossible here too: the hand is open now, canDeclareRiichi's
          // concealment check will always fail, so decideDiscardAndRiichi degrades to a
          // plain discard for a human seat exactly as it does for AI/SimpleAI).
          const { discardId } = yield* decideDiscardAndRiichi(p, hands[p]!, isHumanSeat(p), this.scores[p]!, wall.remainingLiveCount());
          const newTile = hands[p]!.discardById(discardId, { tsumogiri: false, isRiichiDeclaration: false });
          this.log.push({ type: "discard", player: p, tile: newTile.kind, tsumogiri: false, riichiDeclaration: false });
          refreshWinningTiles(p);
          return yield* handleDiscardResponses(p, newTile, wall.isExhausted());
        }
      }

      return { ended: false, from: discarderSeat };
    }).bind(this);

    /**
     * Handles everything that can happen in response to `discardedTile` (just discarded by
     * `discarderSeat`): ron first (always legal, even on the final discard), then - unless
     * this was the final discard, where only ron may occur - offerCallsForDiscard.
     */
    const handleDiscardResponses: (
      discarderSeat: number,
      discardedTile: Tile,
      isHoutei: boolean
    ) => Generator<DecisionRequest, DiscardResponseFlow, DecisionResponse> = (function* (
      this: GameState,
      discarderSeat: number,
      discardedTile: Tile,
      isHoutei: boolean
    ): Generator<DecisionRequest, DiscardResponseFlow, DecisionResponse> {
      const winners = yield* offerRon(discarderSeat, discardedTile, isHoutei, false, "discard");
      const abortiveReason = postDiscardAbortiveDrawReason(
        hands,
        tableInterrupted,
        winners.length > 0,
        this.rules.playerCount
      );
      if (winners.length > 0) {
        finishHandWithWin(winners.map((w) => ({ player: w.player, result: w.result, ronFrom: discarderSeat })));
        return { ended: true, from: discarderSeat };
      }
      if (abortiveReason) {
        finishAbortiveDraw(abortiveReason);
        return { ended: true, from: discarderSeat };
      }
      if (isHoutei) return { ended: false, from: discarderSeat }; // no calls on the final discard
      return yield* offerCallsForDiscard(discarderSeat, discardedTile);
    }).bind(this);

    let current = this.dealerSeat;
    let pendingRinshan = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const hand = hands[current]!;
      let drawnTile: Tile;
      let isRinshan = false;
      let tileAlreadyInHand = false;
      if (pendingCalledKanDraw) {
        if (pendingCalledKanDraw.player !== current) {
          throw new Error("GameState: resumed daiminkan draw belongs to a different player");
        }
        drawnTile = pendingCalledKanDraw.tile;
        pendingCalledKanDraw = undefined;
        isRinshan = true;
        tileAlreadyInHand = true;
      } else if (pendingRinshan) {
        drawnTile = wall.drawCommittedRinshan();
        isRinshan = true;
        pendingRinshan = false;
      } else {
        if (wall.isExhausted()) {
          finishExhaustiveDraw();
          return;
        }
        drawnTile = wall.drawTile();
      }
      if (!tileAlreadyInHand) hand.addDrawn(drawnTile);
      furiten[current]!.onOwnDraw();
      this.log.push({ type: "draw", player: current, tile: drawnTile.kind, source: isRinshan ? "rinshan" : "wall" });
      // Covers "immediate" reveal timing (ankan): commitKan("immediate") bumps
      // revealedKanDoraCount before this kan's own replacement draw has happened, so
      // wall.doraIndicators() isn't safely callable until right here, after the draw that
      // just absorbed the tile K3/K4 may need. "after-discard" timing is unaffected - those
      // reveals are emitted separately at their own discard, not here (see below).
      emitNewlyRevealedDoraIndicators();

      const isHaitei = !isRinshan && wall.isExhausted();
      // tenhou/chiihou eligibility (drawCountByPlayer[current]===0 means "this is their
      // first draw") is read by tryEvaluate itself - the increment below MUST happen
      // after that check, or every draw would look like a "later" draw to it.
      let extractedThisTurn = 0;
      let queuedRiichiKitaAction: KitaAction | undefined;
      if (
        hand.riichi &&
        wall.canDrawKitaReplacement() &&
        canRiichiKita(hand, drawnTile, this.rules.kitaEnabled)
      ) {
        queuedRiichiKitaAction = yield* decideKita(current, hand, this.rules.kitaEnabled, extractedThisTurn, isHumanSeat(current));
      }
      // TODO(milestone 3): tsumo is still auto-declared for every seat, human included -
      // a human "tsumo / skip" decision is deliberately out of Milestone 2's scope.
      const tsumoResult = tryEvaluate(current, drawnTile, true, undefined, isRinshan, isHaitei, false);
      if (!isRinshan) drawCountByPlayer[current] = drawCountByPlayer[current]! + 1;
      if (tsumoResult && queuedRiichiKitaAction !== "kita") {
        finishHandWithWin([{ player: current, result: tsumoResult }]);
        return;
      }

      if (
        isAbortiveDrawReasonEnabled("nine_terminals", this.rules.playerCount) &&
        canDeclareNineTerminals(hand, drawCountByPlayer[current] === 1, tableInterrupted) &&
        this.nineTerminalsPolicy(current, hand)
      ) {
        finishAbortiveDraw("nine_terminals");
        return;
      }

      let latestDrawnTile = drawnTile;

      // North tiles may chain (a Kita replacement draw can itself be another north tile).
      // Once in riichi, only the physical tile drawn in the current replacement step is legal.
      while (wall.canDrawKitaReplacement()) {
        const kitaLegal = hand.riichi
          ? canRiichiKita(hand, latestDrawnTile, this.rules.kitaEnabled)
          : canKita(hand, this.rules.kitaEnabled);
        if (!kitaLegal) break;

        const kitaAction = queuedRiichiKitaAction ?? (yield* decideKita(current, hand, this.rules.kitaEnabled, extractedThisTurn, isHumanSeat(current)));
        queuedRiichiKitaAction = undefined;
        if (kitaAction !== "kita") break;

        const northTile = hand.riichi ? latestDrawnTile : hand.tilesOfKind("z4")[0]!;
        applyKita(hand, northTile.id);
        extractedThisTurn++;
        this.log.push({ type: "kita", player: current, tile: "z4" });

        // the extracted north tile can be ronned (not chankan) by a player waiting on it
        const northWinners = yield* resolveRonBeforeInterruptionInteractive(
          () => offerRon(current, northTile, false, false, "kita"),
          () => {
            tableInterrupted = true;
            ippatsuEligible.fill(false);
            // Mahjong Soul treats a Kita declared from an open/added-kan rinshan draw as
            // the next post-kan action, so the earlier deferred kan indicator is visible
            // before the Kita replacement tile can be scored.
            wall.revealPendingKanDora();
          }
        );
        if (northWinners.length > 0) {
          finishHandWithWin(northWinners.map((w) => ({ player: w.player, result: w.result, ronFrom: current })));
          return;
        }

        const replacement = wall.drawKitaReplacement();
        hand.addDrawn(replacement);
        latestDrawnTile = replacement;
        this.log.push({ type: "draw", player: current, tile: replacement.kind, source: "rinshan" });
        // Emitted here, after the rinshan draw event rather than right after
        // revealPendingKanDora() above, so "kita" stays immediately followed by its
        // rinshan draw - an existing invariant (checkRiichiIppatsuKita) depends on that
        // exact adjacency and this event must stay purely additive to it.
        emitNewlyRevealedDoraIndicators();

        if (
          hand.riichi &&
          wall.canDrawKitaReplacement() &&
          canRiichiKita(hand, replacement, this.rules.kitaEnabled)
        ) {
          queuedRiichiKitaAction = yield* decideKita(current, hand, this.rules.kitaEnabled, extractedThisTurn, isHumanSeat(current));
        }
        const kitaTsumo = tryEvaluate(current, replacement, true, undefined, true, false, false);
        if (kitaTsumo && queuedRiichiKitaAction !== "kita") {
          finishHandWithWin([{ player: current, result: kitaTsumo }]);
          return;
        }
      }

      // shouminkan: upgrading an existing pon with a matching tile now in the concealed hand
      if (!hand.riichi) {
        const shouminkanKind = allKindsForRules(this.rules).find((k) => canShouminkan(hand, k));
        // Order matters (matches the original `&&` chain): the decision must still run
        // before the rinshan-capacity check even though a human seat's yield now sits in
        // the middle, so RNG/call-order for AI seats is byte-for-byte unaffected.
        const shouminkanDeclared = shouminkanKind ? yield* decideShouminkan(current, hand, shouminkanKind, isHumanSeat(current)) : false;
        if (shouminkanKind && shouminkanDeclared && wall.canDrawRinshan(this.rules.maxKans)) {
          const addedTile = hand.tilesOfKind(shouminkanKind)[0]!;
          applyShouminkan(hand, addedTile.id);
          this.log.push({ type: "call", call: "kan_added", player: current, kind: shouminkanKind });

          // chankan: the added tile can be robbed by ron before the kan completes
          const chankanWinners = yield* resolveRonBeforeInterruptionInteractive(
            () => offerRon(current, addedTile, false, true, "chankan"),
            () => {
              tableInterrupted = true;
              ippatsuEligible.fill(false);
            }
          );
          if (chankanWinners.length > 0) {
            finishHandWithWin(chankanWinners.map((w) => ({ player: w.player, result: w.result, ronFrom: current })));
            return;
          }

          wall.commitKan("after-discard");
          const replacement = wall.drawCommittedRinshan();
          hand.addDrawn(replacement);
          latestDrawnTile = replacement;
          this.log.push({ type: "draw", player: current, tile: replacement.kind, source: "rinshan" });
          const rinshanTsumo = tryEvaluate(current, replacement, true, undefined, true, false, false);
          if (rinshanTsumo) {
            finishHandWithWin([{ player: current, result: rinshanTsumo }]);
            return;
          }
        }
      }

      const ankanKind = allKindsForRules(this.rules).find(
        (kind) => canAnkan(hand, kind) && (!hand.riichi || canRiichiAnkan(hand, kind, latestDrawnTile, this.rules))
      );
      // Order matters (matches the original `&&` chain) - see the shouminkan comment above.
      const ankanDeclared = ankanKind ? yield* decideAnkan(current, hand, ankanKind, isHumanSeat(current)) : false;
      if (ankanKind && ankanDeclared && wall.canDrawRinshan(this.rules.maxKans)) {
        const robbedTile = hand.tilesOfKind(ankanKind)[0]!;
        const kokushiWinners = yield* resolveRonBeforeInterruptionInteractive(
          () => offerRon(current, robbedTile, false, true, "kokushi_ankan", "kokushi-ankan"),
          () => {
            tableInterrupted = true;
            ippatsuEligible.fill(false);
          }
        );
        if (kokushiWinners.length > 0) {
          finishHandWithWin(kokushiWinners.map((winner) => ({
            player: winner.player,
            result: winner.result,
            ronFrom: current,
          })));
          return;
        }

        applyAnkan(hand, ankanKind);
        // Not emitted here: an ankan reveals "immediately" (see Wall.commitKan), but its
        // own replacement tile hasn't been drawn yet at this point, and a K3/K4 indicator
        // can depend on that exact draw having absorbed a tile first. Emitted instead right
        // after the pendingRinshan draw below completes, at the top of the next loop turn.
        wall.commitKan("immediate");
        this.log.push({ type: "call", call: "kan_closed", player: current, kind: ankanKind });
        pendingRinshan = true;
        continue;
      }

      // riichi / discard decision
      let discardId: number;
      let declaringRiichi = false;
      if (!hand.riichi) {
        const decision = yield* decideDiscardAndRiichi(
          current,
          hand,
          isHumanSeat(current),
          this.scores[current]!,
          wall.remainingLiveCount()
        );
        discardId = decision.discardId;
        declaringRiichi = decision.declaringRiichi;
      } else {
        discardId = latestDrawnTile.id; // must discard the drawn tile (tsumogiri) once in riichi
      }

      const isHoutei = wall.isExhausted();
      const tsumogiri = discardId === latestDrawnTile.id;
      const discardedTile = hand.discardById(discardId, { tsumogiri, isRiichiDeclaration: declaringRiichi });
      this.log.push({
        type: "discard",
        player: current,
        tile: discardedTile.kind,
        tsumogiri,
        riichiDeclaration: declaringRiichi,
      });
      wall.revealPendingKanDora();
      emitNewlyRevealedDoraIndicators();
      refreshWinningTiles(current);

      if (declaringRiichi) {
        // riichi intent is declared and the tile is out, but the deposit is only
        // committed once we know this exact discard survives the ron check - if it gets
        // ronned, riichi never actually establishes and no points move for it. Critically,
        // establishment must happen the instant the ron check clears, BEFORE any pon/kan
        // is offered on this discard: otherwise a pon/daiminkan on the declaration tile
        // would still see hand.riichi===false during its own chained response window
        // (missing "Riichi" - and Ippatsu - on a ron the declarer should be able to make
        // there), and the 1000-point stick/kyotaku increment would be delayed past a point
        // where the hand could otherwise end (e.g. a daiminkan leading into an exhaustive
        // draw) without ever having been committed.
        const wasFirstGoAround = hand.discards.length === 1 && !tableInterrupted;
        const ronWinners = yield* offerRon(current, discardedTile, isHoutei, false, "riichi_discard");
        const abortiveReason = postDiscardAbortiveDrawReason(
          hands,
          tableInterrupted,
          ronWinners.length > 0,
          this.rules.playerCount
        );
        if (ronWinners.length > 0) {
          finishHandWithWin(ronWinners.map((w) => ({ player: w.player, result: w.result, ronFrom: current })));
          return;
        }

        // The declaration discard has survived ron, but riichi is not established yet.
        // If that discard itself completes four winds or follows the fourth multi-player
        // kan, the abortive draw takes precedence and no fourth riichi stick is deposited.
        if (abortiveReason) {
          finishAbortiveDraw(abortiveReason);
          return;
        }

        hand.riichi = true;
        hand.doubleRiichi = wasFirstGoAround;
        ippatsuEligible[current] = true;
        furiten[current]!.onDeclareRiichi();
        this.scores[current]! -= 1000;
        this.kyotaku += 1;
        this.log.push({ type: "riichi", player: current });

        if (
          isAbortiveDrawReasonEnabled("four_riichi", this.rules.playerCount) &&
          isFourRiichiAbortive(hands)
        ) {
          finishAbortiveDraw("four_riichi");
          return;
        }

        if (isHoutei) {
          finishExhaustiveDraw();
          return;
        }
        // pon/daiminkan on the declaration tile is checked only now, after riichi is
        // already established - if one happens, it correctly cancels ippatsu (the
        // pon/daiminkan branches in offerCallsForDiscard already clear ippatsuEligible).
        const result = yield* offerCallsForDiscard(current, discardedTile);
        if (result.ended) return;
        if (result.resumePostDrawSeat !== undefined) {
          current = result.resumePostDrawSeat;
          continue;
        }
        current = nextSeat(result.from, this.rules.playerCount);
        continue;
      }

      const result = yield* handleDiscardResponses(current, discardedTile, isHoutei);
      if (result.ended) return;
      if (result.resumePostDrawSeat !== undefined) {
        current = result.resumePostDrawSeat;
        continue;
      }
      if (isHoutei) {
        finishExhaustiveDraw();
        return;
      }

      ippatsuEligible[current] = false; // this player's own return-turn window (if any) has now closed
      current = nextSeat(result.from, this.rules.playerCount);
    }
  }

  /**
   * AI-only synchronous compatibility entry point - unchanged behavior and signature from
   * before playHandSession() was extracted. Every existing caller (playGame(), self-play,
   * validation, replay tooling, tests) keeps calling this exactly as before, and never sees
   * a yield as long as no seat's controller (see GameStateOptions.controllers) is "human".
   *
   * Throws rather than silently feeding `undefined` back into a yielded DecisionRequest
   * (which would corrupt that seat's turn) if a human-controlled seat's hand is ever driven
   * through this synchronous entry point by mistake - use playHandInteractive() instead.
   */
  playHand(): void {
    const session = this.playHandSession();
    const result = session.next();
    if (!result.done) {
      throw new Error(
        "GameState.playHand: the hand session yielded a decision request, meaning a human-controlled " +
          "seat is configured for this game. Use playHandInteractive() instead of playHand() " +
          "when any seat is human-controlled."
      );
    }
  }

  /**
   * Interactive entry point for a hand with one or more human-controlled seats (see
   * GameStateOptions.controllers). Returns the raw generator so a driver (CLI, test, future
   * UI) can pump it directly:
   *
   *   const session = gs.playHandInteractive();
   *   let step = session.next();
   *   while (!step.done) {
   *     const response = await getResponseFor(step.value); // step.value: DecisionRequest
   *     step = session.next(response);
   *   }
   *
   * Works identically for an all-AI hand too (the loop above just never executes its body),
   * but playHand() remains the simpler call for that case.
   */
  playHandInteractive(): Generator<DecisionRequest, void, DecisionResponse> {
    return this.playHandSession();
  }

  private advanceAfterHand(
    dealerRepeats: boolean,
    isExhaustiveDraw: boolean,
    allowDealerEnd = true,
    pendingResult?: PendingHandResult
  ): void {
    const progression = computeRoundProgression({
      rules: this.rules,
      scores: this.scores,
      dealerSeat: this.dealerSeat,
      roundWind: this.roundWind,
      roundHandNumber: this.roundHandNumber,
      honba: this.honba,
      dealerRepeats,
      isExhaustiveDraw,
      allowDealerEnd,
    });
    const transition = pendingResult ? {
      roundWind: this.roundWind,
      roundHandNumber: this.roundHandNumber,
      dealerSeat: this.dealerSeat,
      dealerContinues: progression.dealerContinuationPending,
      nextDealer: progression.nextDealer,
      nextRoundWind: progression.nextRoundWind,
      nextRoundHandNumber: progression.nextRoundHandNumber,
      honbaBefore: this.honba,
      honbaAfter: progression.nextHonba,
      kyotakuBefore: pendingResult.kyotakuBefore,
      kyotakuAfter: this.kyotaku,
      scoresBeforeSettlement: [...pendingResult.scoresBeforeSettlement],
      scoresAfterSettlement: [...this.scores],
      pointDeltas: { ...pendingResult.pointDeltas },
    } : undefined;
    const result: HandResultSnapshot | undefined = pendingResult && transition
      ? { ...pendingResult, ...transition } as HandResultSnapshot
      : undefined;
    this.log.push({
      type: "hand_end",
      scores: [...this.scores],
      nextDealer: progression.nextDealer,
      honba: progression.nextHonba,
      kyotaku: this.kyotaku,
      ...(result ? { result } : {}),
    });
    // Tobi check: this.scores is already fully final at this point for every path that
    // reaches advanceAfterHand (finishHandWithWin and finishExhaustiveDraw both apply
    // every delta - win/ron/tsumo/double-ron payments, or noten-penalty payments - to
    // this.scores before calling here), so this can never fire on a mid-hand/transient
    // score. Exactly 0 is not a bust (score < 0 only).
    if (progression.tobiTriggered) this.tobiTriggered = true;
    this.dealerContinuationPending = progression.dealerContinuationPending;
    if (progression.dealerEndTriggered) {
      this.dealerEndTriggered = true;
    }
    this.honba = progression.nextHonba;
    if (!dealerRepeats) {
      this.dealerSeat = progression.nextDealer;
      this.roundHandNumber = progression.nextRoundHandNumber;
      this.roundWind = progression.nextRoundWind;
    }
    this.handIndex++;
  }
}
