import type { GameState } from "../core/GameState.js";
import { claimResponseProblem } from "../core/decisions.js";
import type { ClaimDecisionResponse, DiscardDecisionResponse, EngineRequest, EngineResponse, MultiDecisionRequest, SeatDecisionRequest, SeatDecisionResponse } from "../core/decisions.js";
import type { GameEndEvent, GameEvent } from "../core/GameLog.js";
import type { PlayerView } from "../core/playerView.js";

/** AI 턴 도중의 한 장면. 엔진이 타패를 기록할 때마다 사람 좌석마다 하나씩 쌓이며(view.seat가 그 좌석), 표시(재생) 전용이다. */
export interface WatchFrame {
  view: PlayerView;
  /** 행동한 좌석 (타패/울기/리치/화료 등) */
  actor: number;
  /** 이 장면이 만들어진 시점의 game.log 길이 (효과음을 장면에 맞추는 데 쓴다) */
  logLength: number;
}

/**
 * 응답을 엔진(generator)에 넣기 전에 현재 요청과 대조한다. 엔진은 잘못된 응답을 generator 안에서
 * 예외로 거절하는데, generator는 예외가 나면 즉시 종료되어 되살릴 수 없다. 즉 잘못된 클릭 한 번이
 * 진행 중인 국을 망가뜨릴 수 있으므로, 거절은 generator를 건드리기 전에 여기서 해야 한다.
 */
function validateResponse(request: SeatDecisionRequest, response: SeatDecisionResponse): void {
  const got = (response as { type?: unknown } | null)?.type;
  if (got !== request.type) throw new Error(`GuiSession: expected a "${request.type}" response, got "${String(got)}"`);
  if (request.type === "claim") {
    const problem = claimResponseProblem(request, response);
    if (problem) throw new Error(`GuiSession: ${problem}`);
    return;
  }
  if (request.type === "discard") {
    const r = response as DiscardDecisionResponse;
    if (!request.legalTileIds.includes(r.tileId)) throw new Error(`GuiSession: tileId ${String(r.tileId)} is not a legal discard right now`);
    if (typeof r.declareRiichi !== "boolean") throw new Error('GuiSession: a "discard" response needs a boolean "declareRiichi"');
    if (r.declareRiichi && !request.riichiLegalTileIds.includes(r.tileId)) throw new Error(`GuiSession: tileId ${r.tileId} is not a legal riichi discard`);
    return;
  }
  if (request.type === "chi") {
    const optionId = (response as { optionId?: unknown }).optionId;
    if (optionId !== null && !request.options.some((option) => option.id === optionId)) {
      throw new Error(`GuiSession: chi option "${String(optionId)}" is not one of the offered options`);
    }
    return;
  }
  if (typeof (response as { declare?: unknown }).declare !== "boolean") {
    throw new Error(`GuiSession: a "${request.type}" response needs a boolean "declare"`);
  }
}

export type GuiSessionPhase = "decision" | "hand_end" | "game_end";

/**
 * Drives ALL of a game's hands, interactively, over a single GameState instance - not just
 * one hand. Owns the transition GameState.playGame() would otherwise own for a synchronous
 * self-play game, but paced by real decisions instead of a tight while-loop: each hand's
 * playHandInteractive() generator runs to completion, then updateGameContinuationStateAfterHand()
 * + isGameOver() (both public on GameState) decide whether to finalizeGame() or wait for the
 * transport layer to call continueToNextHand(). No new GameState is ever created - the same
 * instance's scores/dealer/honba/kyotaku/round fields carry over exactly as playGame() does.
 *
 * Phases:
 * - "decision": getCurrentRequest() is the pending DecisionRequest; respond() advances it.
 * - "hand_end": a hand just finished and the game is NOT over - getHandEndEvent() is that
 *   hand's result; continueToNextHand() starts the next hand on the same GameState.
 * - "game_end": the game IS over - finalizeGame() has already run, getGameEndEvent() is the
 *   final result. Terminal: there is no next hand and continueToNextHand() will throw.
 */
export class GuiSession {
  private session: Generator<EngineRequest, void, EngineResponse>;
  private current: EngineRequest | null = null;
  /** 여러 사람에게 동시에 묻는 요청(multi)의 좌석별 답. 모두 모이면 한꺼번에 엔진에 넣는다. */
  private multiAnswers: (ClaimDecisionResponse | undefined)[] = [];
  private phase: GuiSessionPhase = "decision";
  private lastHandEndEvent: Extract<GameEvent, { type: "hand_end" }> | undefined;
  private gameEndEvent: GameEndEvent | undefined;
  /** 엔진이 예외를 던져 generator가 죽은 뒤에는 세션을 더 진행하지 않는다 (조용히 잘못된 상태로 이어가지 않기 위해). */
  private broken: Error | undefined;
  private frames: WatchFrame[] = [];

  constructor(readonly game: GameState) {
    game.frameObserver = (view, actor, logLength) => this.frames.push({ view, actor, logLength });
    this.session = game.playHandInteractive();
    this.advance();
  }

  private advance(response?: EngineResponse): void {
    let step: IteratorResult<EngineRequest, void>;
    try {
      step = response === undefined ? this.session.next() : this.session.next(response);
    } catch (err) {
      this.broken = err instanceof Error ? err : new Error(String(err));
      throw err;
    }
    if (step.done) {
      this.onHandFinished();
    } else {
      this.current = step.value;
      this.multiAnswers = step.value.type === "multi" ? step.value.requests.map(() => undefined) : [];
      this.phase = "decision";
    }
  }

  private onHandFinished(): void {
    this.current = null;
    this.lastHandEndEvent = [...this.game.log]
      .reverse()
      .find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end");
    // Same timing playGame()'s own loop has always used: evaluate continuation state (has
    // the schedule already been exceeded?) right at this hand boundary, before deciding
    // whether the game is over.
    this.game.updateGameContinuationStateAfterHand();
    if (this.game.isGameOver()) {
      this.gameEndEvent = this.game.finalizeGame();
      this.phase = "game_end";
    } else {
      this.phase = "hand_end";
    }
  }

  /** 마지막으로 가져간 뒤 쌓인 장면들을 돌려주고 비운다. */
  takeFrames(): WatchFrame[] {
    const out = this.frames;
    this.frames = [];
    return out;
  }

  getPhase(): GuiSessionPhase {
    return this.phase;
  }

  /** 엔진이 지금 기다리는 요청 (한 좌석의 결정, 또는 여러 좌석에 동시에 묻는 묶음) */
  getCurrentRequest(): EngineRequest | null {
    return this.current;
  }

  /** 아직 답하지 않은 좌석별 요청 (묶음이면 답하지 않은 claim들, 아니면 지금 요청 하나) */
  pendingSeatRequests(): SeatDecisionRequest[] {
    if (this.phase !== "decision" || !this.current) return [];
    if (this.current.type !== "multi") return [this.current];
    return this.current.requests.filter((_, i) => this.multiAnswers[i] === undefined);
  }

  /** 이 좌석이 지금 답할 요청 (없으면 null) */
  requestForSeat(seat: number): SeatDecisionRequest | null {
    return this.pendingSeatRequests().find((r) => r.seat === seat) ?? null;
  }

  /** The hand that most recently finished - defined throughout "hand_end" and "game_end"
   *  (the very last hand also finishes normally before finalizeGame() runs), undefined
   *  before any hand has finished yet. */
  getHandEndEvent(): Extract<GameEvent, { type: "hand_end" }> | undefined {
    return this.lastHandEndEvent;
  }

  /** Defined only once phase is "game_end". */
  getGameEndEvent(): GameEndEvent | undefined {
    return this.gameEndEvent;
  }

  /** 결정에 답한다. `seat`는 여러 좌석에 동시에 묻는 중일 때 누가 답하는지 (한 좌석만 남았거나 묶음이 아니면 생략 가능). */
  respond(response: SeatDecisionResponse, seat?: number): void {
    this.assertNotBroken();
    if (this.phase !== "decision" || this.current === null) {
      throw new Error(`GuiSession: no decision is currently pending (phase is "${this.phase}")`);
    }
    if (this.current.type !== "multi") {
      if (seat !== undefined && seat !== this.current.seat) throw new Error(`GuiSession: seat ${seat} is not being asked right now`);
      validateResponse(this.current, response); // 거절되면 세션 상태는 그대로 (같은 요청이 계속 대기)
      this.game.recordHumanDecision(this.current, response);
      this.advance(response as Exclude<SeatDecisionResponse, ClaimDecisionResponse>);
      return;
    }
    this.respondToMulti(this.current, response, seat);
  }

  private respondToMulti(multi: MultiDecisionRequest, response: SeatDecisionResponse, seat: number | undefined): void {
    const open = multi.requests.map((r, i) => ({ r, i })).filter(({ i }) => this.multiAnswers[i] === undefined);
    const target = seat === undefined ? (open.length === 1 ? open[0] : undefined) : open.find(({ r }) => r.seat === seat);
    if (!target) {
      throw new Error(seat === undefined ? "GuiSession: several seats are being asked - say which seat answers" : `GuiSession: seat ${seat} has nothing to answer right now`);
    }
    validateResponse(target.r, response);
    this.multiAnswers[target.i] = response as ClaimDecisionResponse;
    if (this.multiAnswers.some((a) => a === undefined)) return; // 다른 사람의 답을 기다린다
    // 모두 답했다: 좌석 순서(요청 순서)대로 기록하고 한꺼번에 엔진에 넣는다
    const responses = this.multiAnswers as ClaimDecisionResponse[];
    multi.requests.forEach((r, i) => this.game.recordHumanDecision(r, responses[i]!));
    this.advance({ type: "multi", responses });
  }

  private assertNotBroken(): void {
    if (this.broken) throw new Error(`GuiSession: session stopped after an earlier engine error: ${this.broken.message}`);
  }

  /** Starts the next hand on the SAME GameState (scores/dealer/honba/kyotaku/round carry
   *  over untouched) - only valid from "hand_end". Throws instead of silently continuing a
   *  finished game or restarting a hand still in progress, so a stray double-click or an
   *  out-of-order client message can't corrupt the sequence. */
  continueToNextHand(): void {
    this.assertNotBroken();
    if (this.phase !== "hand_end") {
      throw new Error(`GuiSession: cannot continue to the next hand from phase "${this.phase}"`);
    }
    this.session = this.game.playHandInteractive();
    this.advance();
  }
}
