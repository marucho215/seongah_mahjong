import type { RuleConfig } from "../rules/RuleConfig.js";
import { Wall } from "./Wall.js";
import { Hand } from "./Hand.js";
import { allKindsForRules, type Tile, type TileKind } from "./tiles.js";
import { tilesToCounts } from "./tileIndex.js";
import { FuritenTracker } from "../actions/furiten.js";
import { computeWinningTiles } from "../actions/winSearch.js";
import { canAnkan, applyAnkan, canPon, applyPon, canDaiminkan, applyDaiminkan, canShouminkan, applyShouminkan } from "../actions/calls.js";
import { canKita, applyKita } from "../actions/kita.js";
import {
  chooseDiscard,
  shouldDeclareRiichi,
  shouldCallPon,
  shouldDeclareAnkan,
  shouldCallDaiminkan,
  shouldDeclareShouminkan,
} from "../ai/simpleAI.js";
import type { CharacterProfile } from "../ai/characterProfile.js";
import { CharacterAI, type CharacterDecisionContext } from "../ai/characterAI.js";
import { meldsToGroups } from "../yaku/meldConvert.js";
import { countDora, countAkaDora, countNukidora } from "../yaku/dora.js";
import { evaluateWin, type FullWinResult } from "../yaku/evaluate.js";
import type { WinContext } from "../yaku/types.js";
import type { GameEvent, AiDecisionEntry } from "./GameLog.js";
import { resolveRonWinners } from "./ronResolution.js";

export interface GameStateOptions {
  rules: RuleConfig;
  seed: string;
  /** Optional per-seat character personality. A seat left null/undefined plays with the
   *  engine's default SimpleAI, completely unaffected by this feature - see CharacterAI. */
  characterProfiles?: (CharacterProfile | null | undefined)[];
}

/** seatWind: 1=East, 2=South, 3=West, relative to who is dealer this hand. */
function seatWindFor(player: number, dealer: number): number {
  return ((player - dealer + 3) % 3) + 1;
}

export interface FinalStanding {
  player: number;
  rawScore: number;
  placement: number; // 1-3
  points: number; // (rawScore - returnScore) / 1000 + uma, in "score units" (not raw points)
}

export class GameState {
  readonly rules: RuleConfig;
  readonly baseSeed: string;
  readonly characterProfiles: (CharacterProfile | null)[];
  scores: [number, number, number];
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

  constructor(opts: GameStateOptions) {
    this.rules = opts.rules;
    this.baseSeed = opts.seed;
    this.characterProfiles = [0, 1, 2].map((i) => opts.characterProfiles?.[i] ?? null);
    this.scores = [opts.rules.startingScore, opts.rules.startingScore, opts.rules.startingScore];
  }

  isGameOver(): boolean {
    if (this.tobiTriggered) return true;
    const maxWind = this.rules.gameLength === "east" ? 1 : 2;
    return this.roundWind > maxWind || (this.roundWind === maxWind && this.roundHandNumber > 3);
  }

  /** Best-effort "this is the last named hand" signal (ignores any renchan extension that
   *  hasn't happened yet) - used only as a soft pressure signal for Tosuke's intervention check. */
  private isLastNamedHand(): boolean {
    const maxWind = this.rules.gameLength === "east" ? 1 : 2;
    return this.roundWind === maxWind && this.roundHandNumber === 3;
  }

  playGame(): void {
    let guard = 0;
    while (!this.isGameOver()) {
      this.playHand();
      guard++;
      if (guard > 200) throw new Error("GameState.playGame: runaway loop guard triggered");
    }
    const eliminatedPlayers = [0, 1, 2].filter((p) => this.scores[p]! < 0);
    this.log.push({
      type: "game_end",
      finalScores: [...this.scores],
      reason: this.tobiTriggered ? "tobi" : "length",
      eliminatedPlayers,
    });
  }

  /** Final ranked standings: raw score is untouched (kept for the conservation invariant),
   *  `points` applies the return-score baseline and uma placement bonus for display/ranking. */
  computeFinalStandings(): FinalStanding[] {
    const order = [0, 1, 2].sort((a, b) => this.scores[b]! - this.scores[a]! || a - b);
    return order.map((player, i) => ({
      player,
      rawScore: this.scores[player]!,
      placement: i + 1,
      points: (this.scores[player]! - this.rules.returnScore) / 1000 + this.rules.uma[i]! / 1000,
    }));
  }

  playHand(): void {
    const wallSeed = `${this.baseSeed}::hand${this.handIndex}`;
    const wall = new Wall(this.rules, wallSeed);
    const hands: [Hand, Hand, Hand] = [new Hand(), new Hand(), new Hand()];
    const dealt = wall.dealInitial(3, 13);
    for (let p = 0; p < 3; p++) hands[p]!.dealIn(dealt[p]!);
    const furiten = [new FuritenTracker(), new FuritenTracker(), new FuritenTracker()];

    // ippatsu window per player, and whether the hand's very first go-around has been
    // interrupted by any call (governs double riichi / tenhou / chiihou eligibility).
    const ippatsuEligible: [boolean, boolean, boolean] = [false, false, false];
    let tableInterrupted = false;
    const drawCountByPlayer: [number, number, number] = [0, 0, 0];

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
      hands: [dealt[0]!.map((t) => t.kind), dealt[1]!.map((t) => t.kind), dealt[2]!.map((t) => t.kind)],
      doraIndicator: wall.doraIndicators()[0]!.kind,
    });

    const cachedWinningTiles: TileKind[][] = [[], [], []];
    const refreshWinningTiles = (p: number) => {
      cachedWinningTiles[p] = computeWinningTiles(tilesToCounts(hands[p]!.concealed), hands[p]!.melds.length, this.rules);
    };
    for (let p = 0; p < 3; p++) refreshWinningTiles(p);

    const buildContext = (
      player: number,
      isTsumo: boolean,
      isRinshan: boolean,
      isHaitei: boolean,
      isHoutei: boolean,
      isChankan: boolean,
      isTenhou: boolean,
      isChiihou: boolean
    ): WinContext => {
      const hand = hands[player]!;
      const meldTiles = hand.melds.flatMap((m) => m.tiles);
      const forDora = [...hand.concealed, ...meldTiles];
      const doraIndicatorKinds: TileKind[] = wall.doraIndicators().map((t) => t.kind);
      const nukidora = countNukidora(hand.kitaTiles);
      const nukidoraAsRegularDora = countDora(hand.kitaTiles, doraIndicatorKinds, this.rules);
      const uraCount = hand.riichi
        ? countDora(forDora, wall.uraDoraIndicators().map((t) => t.kind), this.rules) +
          countDora(hand.kitaTiles, wall.uraDoraIndicators().map((t) => t.kind), this.rules)
        : 0;
      return {
        seatWind: seatWindFor(player, this.dealerSeat),
        roundWind: this.roundWind,
        isTsumo,
        isRiichi: hand.riichi,
        isDoubleRiichi: hand.doubleRiichi,
        isIppatsu: ippatsuEligible[player]!,
        isHaitei,
        isHoutei,
        isRinshan,
        isChankan,
        isTenhou,
        isChiihou,
        doraCount: countDora(forDora, doraIndicatorKinds, this.rules) + nukidoraAsRegularDora,
        uraDoraCount: uraCount,
        akaDoraCount: countAkaDora(forDora),
        kanCount: wall.kanCount(),
        // nukidora itself is folded into doraCount here since WinContext has no separate
        // field for it; see the "+nukidora" addition below.
      };
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
      const ctx = buildContext(player, isTsumo, isRinshan, isHaitei, isHoutei, isChankan, isTenhou, isChiihou);
      // nukidora: fold the flat "1 per extracted tile" count into doraCount here, since
      // buildContext only computed the "also matches the live indicator" portion.
      ctx.doraCount += countNukidora(hand.kitaTiles);
      return evaluateWin({
        concealedTiles: hand.concealed,
        melds: meldsToGroups(hand.melds),
        winTile,
        context: ctx,
        rules: this.rules,
        winner: player,
        dealer: this.dealerSeat,
        ronFrom,
        honba: this.honba,
      });
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

    /** Offers `tile` (from `fromSeat`) to the other two players for ron, in turn order.
     *  Any player whose shape matches but who has no yaku becomes temporarily furiten -
     *  this is the "atozuke" case where a hand-completing tile legally can't be ronned. */
    const offerRon = (fromSeat: number, tile: Tile, isHoutei: boolean, isChankan: boolean): { player: number; result: FullWinResult }[] => {
      const order = [(fromSeat + 1) % 3, (fromSeat + 2) % 3];
      const eligible: { player: number; result: FullWinResult }[] = [];
      for (const p of order) {
        const otherHand = hands[p]!;
        const winningTiles = cachedWinningTiles[p]!;
        if (!winningTiles.includes(tile.kind)) continue;
        const ownDiscardKinds = otherHand.discards.map((d) => d.tile.kind);
        if (furiten[p]!.isFuriten(winningTiles, ownDiscardKinds)) continue;
        const result = tryRon(p, tile, fromSeat, isHoutei, isChankan);
        if (result) {
          eligible.push({ player: p, result });
        } else {
          // shape-complete, no legal yaku (atozuke) - this counts as a missed ron chance
          furiten[p]!.onMissedRonChance();
        }
      }
      return resolveRonWinners(eligible, this.rules.doubleRonMode);
    };

    const finishHandWithWin = (winners: { player: number; result: FullWinResult; ronFrom?: number }[]) => {
      const deltas: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
      for (const w of winners) {
        for (const [seat, delta] of Object.entries(w.result.score.payments.deltas)) {
          deltas[Number(seat)]! += delta;
        }
      }
      // riichi sticks on the table go entirely to the winner closest in turn order to the
      // discarder (winners[] is already ordered that way by resolveRonWinners); for tsumo
      // there's only one winner, so this is simply "the winner".
      const firstWinner = winners[0]!.player;
      deltas[firstWinner]! += this.kyotaku * 1000;
      this.kyotaku = 0;
      for (let p = 0; p < 3; p++) this.scores[p]! += deltas[p]!;

      for (const w of winners) {
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

      const dealerWon = winners.some((w) => w.player === this.dealerSeat);
      this.advanceAfterHand(dealerWon && this.rules.renchanOnDealerWin, false);
    };

    const finishExhaustiveDraw = () => {
      const tenpaiPlayers: number[] = [];
      for (let p = 0; p < 3; p++) {
        if (cachedWinningTiles[p]!.length > 0) tenpaiPlayers.push(p);
      }
      const deltas: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
      if (tenpaiPlayers.length > 0 && tenpaiPlayers.length < 3) {
        const pot = this.rules.notenPenaltyTotal;
        const perReceiver = pot / tenpaiPlayers.length;
        const notenPlayers = [0, 1, 2].filter((p) => !tenpaiPlayers.includes(p));
        const perPayer = pot / notenPlayers.length;
        for (const p of tenpaiPlayers) deltas[p]! += perReceiver;
        for (const p of notenPlayers) deltas[p]! -= perPayer;
      }
      for (let p = 0; p < 3; p++) this.scores[p]! += deltas[p]!;
      this.log.push({ type: "exhaustive_draw", tenpaiPlayers, deltas });

      const dealerTenpai = tenpaiPlayers.includes(this.dealerSeat);
      this.advanceAfterHand(dealerTenpai && this.rules.renchanOnDealerTenpaiDraw, true);
    };

    const riichiOpponentDiscards = (player: number): TileKind[][] =>
      [0, 1, 2].filter((p) => p !== player && hands[p]!.riichi).map((p) => hands[p]!.discards.map((d) => d.tile.kind));

    // Optional per-seat CharacterAI. A seat with no assigned profile keeps using the plain
    // SimpleAI functions below exactly as before - this feature is purely additive.
    const ais: (CharacterAI | null)[] = [0, 1, 2].map((p) => {
      const profile = this.characterProfiles[p];
      return profile ? new CharacterAI(profile, `${wallSeed}::ai${p}`) : null;
    });
    for (const ai of ais) ai?.onHandStart();

    const seatCtx = (player: number): CharacterDecisionContext => ({
      rules: this.rules,
      riichiOpponentDiscardKinds: riichiOpponentDiscards(player),
      doraIndicatorKinds: wall.doraIndicators().map((t) => t.kind),
      seatWind: seatWindFor(player, this.dealerSeat),
      roundWind: this.roundWind,
      wallRemainingLive: wall.remainingLiveCount(),
      ownScore: this.scores[player]!,
      opponentScores: [0, 1, 2].filter((p) => p !== player).map((p) => this.scores[p]!) as [number, number],
      isLastHandOfGame: this.isLastNamedHand(),
      isDealer: player === this.dealerSeat,
    });

    const chooseDiscardFor = (player: number, hand: Hand): number => {
      const ai = ais[player];
      if (ai) {
        const id = ai.chooseDiscard(hand, seatCtx(player));
        const debug = ai.lastDiscardDebug;
        if (debug) {
          this.aiDecisionLog.push({
            type: "discard_decision",
            handIndex: this.handIndex,
            player,
            characterId: this.characterProfiles[player]!.characterId,
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
        return id;
      }
      return chooseDiscard({ hand, riichiOpponentDiscardKinds: riichiOpponentDiscards(player) });
    };

    const shouldDeclareRiichiFor = (player: number, hand: Hand, discardId: number): boolean => {
      const ai = ais[player];
      if (ai) {
        const declared = ai.shouldDeclareRiichi(hand, this.scores[player]!, wall.remainingLiveCount(), discardId, seatCtx(player));
        const trace = ai.lastRiichiTrace;
        if (trace) {
          this.aiDecisionLog.push({
            type: "riichi_decision",
            handIndex: this.handIndex,
            player,
            characterId: this.characterProfiles[player]!.characterId,
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
        return declared;
      }
      return shouldDeclareRiichi(hand, this.scores[player]!, wall.remainingLiveCount(), discardId);
    };

    const logCallTrace = (player: number, ai: CharacterAI, callKind: "pon" | "daiminkan"): void => {
      const trace = ai.lastCallTrace;
      if (!trace) return;
      this.aiDecisionLog.push({
        type: "call_decision",
        handIndex: this.handIndex,
        player,
        characterId: this.characterProfiles[player]!.characterId,
        callKind,
        callScore: trace.callScore,
        effortAversionCost: trace.effortAversionCost,
        shantenGain: trace.shantenGain,
        called: trace.called,
        baselineCallScore: trace.baselineCallScore,
        adjustedCallScore: trace.adjustedCallScore,
        effortModifier: trace.effortModifier,
        commitmentModifier: trace.commitmentModifier,
        baselineDecision: trace.baselineDecision,
        adjustedDecision: trace.adjustedDecision,
        mechanicChangedDecision: trace.mechanicChangedDecision,
        actualDecision: trace.actualDecision,
      });
    };

    /** SimpleAI's plausibility gate always runs first (unaffected by personality); a
     *  CharacterAI seat only decides whether to act on an already-plausible call. */
    const shouldCallPonFor = (player: number, hand: Hand, discardedKind: TileKind): boolean => {
      const plausible = shouldCallPon(discardedKind, seatWindFor(player, this.dealerSeat), this.roundWind);
      if (!plausible) return false;
      const ai = ais[player];
      if (!ai) return true;
      const called = ai.shouldCallPon(hand, discardedKind, seatCtx(player), true);
      logCallTrace(player, ai, "pon");
      return called;
    };

    const shouldCallDaiminkanFor = (player: number, hand: Hand, discardedKind: TileKind): boolean => {
      const plausible = shouldCallDaiminkan(discardedKind, seatWindFor(player, this.dealerSeat), this.roundWind);
      if (!plausible) return false;
      const ai = ais[player];
      if (!ai) return true;
      const called = ai.shouldCallDaiminkan(hand, discardedKind, seatCtx(player), true);
      logCallTrace(player, ai, "daiminkan");
      return called;
    };

    const shouldDeclareShouminkanFor = (player: number): boolean => {
      const ai = ais[player];
      return ai ? ai.shouldDeclareShouminkan() : shouldDeclareShouminkan();
    };

    const shouldDeclareAnkanFor = (player: number): boolean => {
      const ai = ais[player];
      return ai ? ai.shouldDeclareAnkan() : shouldDeclareAnkan();
    };

    /**
     * Checks daiminkan/pon calls on `discardedTile` (ron on it must already have been
     * ruled out by the caller - see handleDiscardResponses and the riichi-declaration
     * branch below, which both check ron first before ever reaching this). A call chains
     * into that caller's own immediate discard and recurses through handleDiscardResponses.
     * Returns "ended" once a win concludes the hand, or the seat whose discard resolved
     * with no call, so the caller knows who to advance play from.
     */
    const offerCallsForDiscard = (discarderSeat: number, discardedTile: Tile): { ended: boolean; from: number } => {
      const order = [(discarderSeat + 1) % 3, (discarderSeat + 2) % 3];

      for (const p of order) {
        if (canDaiminkan(hands[p]!, discardedTile.kind) && shouldCallDaiminkanFor(p, hands[p]!, discardedTile.kind) && wall.canDrawRinshan(this.rules.maxKans)) {
          hands[discarderSeat]!.markDiscardCalledAway(discardedTile.id);
          applyDaiminkan(hands[p]!, discardedTile, discarderSeat);
          this.log.push({ type: "call", call: "kan_open", player: p, kind: discardedTile.kind, fromPlayer: discarderSeat });
          tableInterrupted = true;
          ippatsuEligible[0] = ippatsuEligible[1] = ippatsuEligible[2] = false;
          const replacement = wall.drawRinshan();
          hands[p]!.addDrawn(replacement);
          this.log.push({ type: "draw", player: p, tile: replacement.kind, source: "rinshan" });
          const rinshanTsumo = tryEvaluate(p, replacement, true, undefined, true, false, false);
          if (rinshanTsumo) {
            finishHandWithWin([{ player: p, result: rinshanTsumo }]);
            return { ended: true, from: p };
          }
          const discardId = chooseDiscardFor(p, hands[p]!);
          const newTile = hands[p]!.discardById(discardId, { tsumogiri: false, isRiichiDeclaration: false });
          this.log.push({ type: "discard", player: p, tile: newTile.kind, tsumogiri: false, riichiDeclaration: false });
          refreshWinningTiles(p);
          return handleDiscardResponses(p, newTile, wall.isExhausted());
        }
      }

      for (const p of order) {
        if (canPon(hands[p]!, discardedTile.kind) && shouldCallPonFor(p, hands[p]!, discardedTile.kind)) {
          hands[discarderSeat]!.markDiscardCalledAway(discardedTile.id);
          applyPon(hands[p]!, discardedTile, discarderSeat);
          this.log.push({ type: "call", call: "pon", player: p, kind: discardedTile.kind, fromPlayer: discarderSeat });
          tableInterrupted = true;
          ippatsuEligible[0] = ippatsuEligible[1] = ippatsuEligible[2] = false;
          // kita may not be declared immediately after a pon - go straight to discard
          const discardId = chooseDiscardFor(p, hands[p]!);
          const newTile = hands[p]!.discardById(discardId, { tsumogiri: false, isRiichiDeclaration: false });
          this.log.push({ type: "discard", player: p, tile: newTile.kind, tsumogiri: false, riichiDeclaration: false });
          refreshWinningTiles(p);
          return handleDiscardResponses(p, newTile, wall.isExhausted());
        }
      }

      return { ended: false, from: discarderSeat };
    };

    /**
     * Handles everything that can happen in response to `discardedTile` (just discarded by
     * `discarderSeat`): ron first (always legal, even on the final discard), then - unless
     * this was the final discard, where only ron may occur - offerCallsForDiscard.
     */
    const handleDiscardResponses = (discarderSeat: number, discardedTile: Tile, isHoutei: boolean): { ended: boolean; from: number } => {
      const winners = offerRon(discarderSeat, discardedTile, isHoutei, false);
      if (winners.length > 0) {
        finishHandWithWin(winners.map((w) => ({ player: w.player, result: w.result, ronFrom: discarderSeat })));
        return { ended: true, from: discarderSeat };
      }
      if (isHoutei) return { ended: false, from: discarderSeat }; // no calls on the final discard
      return offerCallsForDiscard(discarderSeat, discardedTile);
    };

    let current = this.dealerSeat;
    let pendingRinshan = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const hand = hands[current]!;
      let drawnTile: Tile;
      let isRinshan = false;
      if (pendingRinshan) {
        drawnTile = wall.drawRinshan();
        isRinshan = true;
        pendingRinshan = false;
      } else {
        if (wall.isExhausted()) {
          finishExhaustiveDraw();
          return;
        }
        drawnTile = wall.drawTile();
      }
      hand.addDrawn(drawnTile);
      furiten[current]!.onOwnDraw();
      this.log.push({ type: "draw", player: current, tile: drawnTile.kind, source: isRinshan ? "rinshan" : "wall" });

      const isHaitei = !isRinshan && wall.isExhausted();
      // tenhou/chiihou eligibility (drawCountByPlayer[current]===0 means "this is their
      // first draw") is read by tryEvaluate itself - the increment below MUST happen
      // after that check, or every draw would look like a "later" draw to it.
      const tsumoResult = tryEvaluate(current, drawnTile, true, undefined, isRinshan, isHaitei, false);
      if (!isRinshan) drawCountByPlayer[current] = drawCountByPlayer[current]! + 1;
      if (tsumoResult) {
        finishHandWithWin([{ player: current, result: tsumoResult }]);
        return;
      }

      let latestDrawnTile = drawnTile;

      // Kita and ankan both change what's physically in the concealed hand, which would
      // violate a riichi'd hand's frozen shape - simplification: neither is offered once
      // the player is in riichi (real rulesets allow a narrow ankan exception; skipped here).
      if (!hand.riichi) {
        // north tiles may chain (a kita replacement draw can itself be another north tile)
        while (canKita(hand, this.rules.kitaEnabled) && wall.canDrawKitaReplacement()) {
          const northTile = hand.tilesOfKind("z4")[0]!;
          applyKita(hand, northTile.id);
          this.log.push({ type: "kita", player: current, tile: "z4" });
          tableInterrupted = true;
          ippatsuEligible[0] = ippatsuEligible[1] = ippatsuEligible[2] = false;

          // the extracted north tile can be ronned (not chankan) by a player waiting on it
          const northWinners = offerRon(current, northTile, false, false);
          if (northWinners.length > 0) {
            finishHandWithWin(northWinners.map((w) => ({ player: w.player, result: w.result, ronFrom: current })));
            return;
          }

          const replacement = wall.drawKitaReplacement();
          hand.addDrawn(replacement);
          latestDrawnTile = replacement;
          this.log.push({ type: "draw", player: current, tile: replacement.kind, source: "rinshan" });
          const kitaTsumo = tryEvaluate(current, replacement, true, undefined, true, false, false);
          if (kitaTsumo) {
            finishHandWithWin([{ player: current, result: kitaTsumo }]);
            return;
          }
        }
      }

      // shouminkan: upgrading an existing pon with a matching tile now in the concealed hand
      if (!hand.riichi) {
        const shouminkanKind = allKindsForRules(this.rules).find((k) => canShouminkan(hand, k));
        if (shouminkanKind && shouldDeclareShouminkanFor(current) && wall.canDrawRinshan(this.rules.maxKans)) {
          const addedTile = hand.tilesOfKind(shouminkanKind)[0]!;
          applyShouminkan(hand, addedTile.id);
          this.log.push({ type: "call", call: "kan_added", player: current, kind: shouminkanKind });
          tableInterrupted = true;
          ippatsuEligible[0] = ippatsuEligible[1] = ippatsuEligible[2] = false;

          // chankan: the added tile can be robbed by ron before the kan completes
          const chankanWinners = offerRon(current, addedTile, false, true);
          if (chankanWinners.length > 0) {
            finishHandWithWin(chankanWinners.map((w) => ({ player: w.player, result: w.result, ronFrom: current })));
            return;
          }

          const replacement = wall.drawRinshan();
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

      const ankanKind = hand.riichi ? undefined : allKindsForRules(this.rules).find((k) => canAnkan(hand, k));
      if (ankanKind && shouldDeclareAnkanFor(current) && wall.canDrawRinshan(this.rules.maxKans)) {
        applyAnkan(hand, ankanKind);
        this.log.push({ type: "call", call: "kan_closed", player: current, kind: ankanKind });
        tableInterrupted = true;
        ippatsuEligible[0] = ippatsuEligible[1] = ippatsuEligible[2] = false;
        pendingRinshan = true;
        continue;
      }

      // riichi / discard decision
      let discardId: number;
      let declaringRiichi = false;
      if (!hand.riichi) {
        discardId = chooseDiscardFor(current, hand);
        if (shouldDeclareRiichiFor(current, hand, discardId)) {
          declaringRiichi = true;
        }
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
        const ronWinners = offerRon(current, discardedTile, isHoutei, false);
        if (ronWinners.length > 0) {
          finishHandWithWin(ronWinners.map((w) => ({ player: w.player, result: w.result, ronFrom: current })));
          return;
        }

        hand.riichi = true;
        hand.doubleRiichi = wasFirstGoAround;
        ippatsuEligible[current] = true;
        furiten[current]!.onDeclareRiichi();
        this.scores[current]! -= 1000;
        this.kyotaku += 1;
        this.log.push({ type: "riichi", player: current });

        if (isHoutei) {
          finishExhaustiveDraw();
          return;
        }
        // pon/daiminkan on the declaration tile is checked only now, after riichi is
        // already established - if one happens, it correctly cancels ippatsu (the
        // pon/daiminkan branches in offerCallsForDiscard already clear ippatsuEligible).
        const result = offerCallsForDiscard(current, discardedTile);
        if (result.ended) return;
        current = (result.from + 1) % 3;
        continue;
      }

      const result = handleDiscardResponses(current, discardedTile, isHoutei);
      if (result.ended) return;
      if (isHoutei) {
        finishExhaustiveDraw();
        return;
      }

      ippatsuEligible[current] = false; // this player's own return-turn window (if any) has now closed
      current = (result.from + 1) % 3;
    }
  }

  private advanceAfterHand(dealerRepeats: boolean, isExhaustiveDraw: boolean): void {
    const newHonba = isExhaustiveDraw ? this.honba + 1 : dealerRepeats ? this.honba + 1 : 0;
    this.log.push({
      type: "hand_end",
      scores: [...this.scores],
      nextDealer: dealerRepeats ? this.dealerSeat : (this.dealerSeat + 1) % 3,
      honba: newHonba,
      kyotaku: this.kyotaku,
    });
    // Tobi check: this.scores is already fully final at this point for every path that
    // reaches advanceAfterHand (finishHandWithWin and finishExhaustiveDraw both apply
    // every delta - win/ron/tsumo/double-ron payments, or noten-penalty payments - to
    // this.scores before calling here), so this can never fire on a mid-hand/transient
    // score. Exactly 0 is not a bust (score < 0 only).
    if (this.scores.some((s) => s < 0)) this.tobiTriggered = true;
    this.honba = newHonba;
    if (!dealerRepeats) {
      this.dealerSeat = (this.dealerSeat + 1) % 3;
      this.roundHandNumber++;
      if (this.roundHandNumber > 3) {
        this.roundHandNumber = 1;
        this.roundWind++;
      }
    }
    this.handIndex++;
  }
}
