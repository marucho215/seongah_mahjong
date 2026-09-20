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

  isFuriten(winningTiles: TileKind[], ownDiscardKinds: TileKind[]): boolean {
    if (winningTiles.some((k) => ownDiscardKinds.includes(k))) return true;
    return this.temporaryUntilNextDraw || this.permanentFromRiichiMiss;
  }
}
