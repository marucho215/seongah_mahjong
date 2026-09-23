import type { GameState } from "../core/GameState.js";
import type { DecisionRequest, DecisionResponse } from "../core/decisions.js";
import type { GameEndEvent, GameEvent } from "../core/GameLog.js";

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
  private session: Generator<DecisionRequest, void, DecisionResponse>;
  private current: DecisionRequest | null = null;
  private phase: GuiSessionPhase = "decision";
  private lastHandEndEvent: Extract<GameEvent, { type: "hand_end" }> | undefined;
  private gameEndEvent: GameEndEvent | undefined;

  constructor(readonly game: GameState) {
    this.session = game.playHandInteractive();
    this.advance();
  }

  private advance(response?: DecisionResponse): void {
    const step = response === undefined ? this.session.next() : this.session.next(response);
    if (step.done) {
      this.onHandFinished();
    } else {
      this.current = step.value;
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

  getPhase(): GuiSessionPhase {
    return this.phase;
  }

  getCurrentRequest(): DecisionRequest | null {
    return this.current;
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

  respond(response: DecisionResponse): void {
    if (this.phase !== "decision") {
      throw new Error(`GuiSession: no decision is currently pending (phase is "${this.phase}")`);
    }
    this.advance(response);
  }

  /** Starts the next hand on the SAME GameState (scores/dealer/honba/kyotaku/round carry
   *  over untouched) - only valid from "hand_end". Throws instead of silently continuing a
   *  finished game or restarting a hand still in progress, so a stray double-click or an
   *  out-of-order client message can't corrupt the sequence. */
  continueToNextHand(): void {
    if (this.phase !== "hand_end") {
      throw new Error(`GuiSession: cannot continue to the next hand from phase "${this.phase}"`);
    }
    this.session = this.game.playHandInteractive();
    this.advance();
  }
}
