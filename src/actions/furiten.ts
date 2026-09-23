import type { TileKind } from "../core/tiles.js";

/**
 * Tracks furiten state across a hand for one player. Furiten rules:
 * - Permanent (own-discard) furiten: any of your current winning tiles is sitting in
 *   your own river. Recomputed fresh every time from the live discard pile - no state needed.
 * - Temporary furiten: you declined a ron chance (your winning tile was discarded by
 *   someone and you chose not to call it, or auto-passed). Clears on your own next draw...
 * - ...unless you're in riichi, in which case any missed ron chance locks you into
 *   furiten for the rest of the hand (drawing no longer clears it).
 */
/** Read-only, cause-by-cause view of one seat's furiten state - safe to hand to a UI, which
 *  must never read FuritenTracker's private fields directly. `active` is exactly what
 *  isFuriten() returns. */
export interface FuritenSnapshot {
  active: boolean;
  selfDiscard: boolean;
  temporary: boolean;
  riichi: boolean;
}

export const NO_FURITEN: FuritenSnapshot = { active: false, selfDiscard: false, temporary: false, riichi: false };

export class FuritenTracker {
  private temporaryUntilNextDraw = false;
  private permanentFromRiichiMiss = false;
  private riichiActive = false;

  onDeclareRiichi(): void {
    this.riichiActive = true;
  }

  onOwnDraw(): void {
    if (!this.permanentFromRiichiMiss) {
      this.temporaryUntilNextDraw = false;
    }
  }

  onMissedRonChance(): void {
    this.temporaryUntilNextDraw = true;
    if (this.riichiActive) this.permanentFromRiichiMiss = true;
  }

  snapshot(winningTiles: TileKind[], ownDiscardKinds: TileKind[]): FuritenSnapshot {
    const selfDiscard = winningTiles.some((k) => ownDiscardKinds.includes(k));
    const temporary = this.temporaryUntilNextDraw;
    const riichi = this.permanentFromRiichiMiss;
    return { active: selfDiscard || temporary || riichi, selfDiscard, temporary, riichi };
  }

  isFuriten(winningTiles: TileKind[], ownDiscardKinds: TileKind[]): boolean {
    return this.snapshot(winningTiles, ownDiscardKinds).active;
  }
}
