import type { GameState } from "../core/GameState.js";
import type { DecisionRequest, DecisionResponse } from "../core/decisions.js";
import type { GameEvent } from "../core/GameLog.js";

/**
 * Thin wrapper around GameState.playHandInteractive() for a server transport (SSE/HTTP)
 * instead of the CLI's text prompts. Holds exactly the current DecisionRequest (or "done")
 * so a transport layer can push it to a client and later call respond() with whatever comes
 * back - no rendering or parsing lives here, unlike humanPlayDriver.ts's CLI driver. Both
 * drivers ultimately consume the same GameState.playHandInteractive() generator contract.
 */
export class GuiSession {
  private readonly session: Generator<DecisionRequest, void, DecisionResponse>;
  private current: DecisionRequest | null = null;
  private finished = false;

  constructor(readonly game: GameState) {
    this.session = game.playHandInteractive();
    this.advance();
  }

  private advance(response?: DecisionResponse): void {
    const step = response === undefined ? this.session.next() : this.session.next(response);
    if (step.done) {
      this.finished = true;
      this.current = null;
    } else {
      this.current = step.value;
    }
  }

  getCurrentRequest(): DecisionRequest | null {
    return this.current;
  }

  isFinished(): boolean {
    return this.finished;
  }

  /** The authoritative hand_end event, once isFinished() is true - undefined until then. */
  getHandEndEvent(): Extract<GameEvent, { type: "hand_end" }> | undefined {
    if (!this.finished) return undefined;
    return [...this.game.log].reverse().find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end");
  }

  respond(response: DecisionResponse): void {
    if (this.finished) {
      throw new Error("GuiSession: hand has already finished, no further response is expected");
    }
    this.advance(response);
  }
}
