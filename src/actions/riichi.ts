import type { Hand } from "../core/Hand.js";
import { tilesToCounts } from "../core/tileIndex.js";
import { standardShanten, chiitoitsuShanten, kokushiShanten } from "../shanten/shanten.js";

/** Base eligibility (not yet tied to a specific discard candidate). */
export function canDeclareRiichi(hand: Hand, score: number, wallRemainingLive: number): boolean {
  if (!hand.isConcealed()) return false;
  if (hand.riichi) return false;
  if (score < 1000) return false;
  if (wallRemainingLive < 4) return false;
  return true;
}

/** Discarding `tileId` would leave the hand tenpai (any winning form), a prerequisite for riichi. */
export function wouldBeTenpaiAfterDiscard(hand: Hand, tileId: number): boolean {
  const remaining = hand.concealed.filter((t) => t.id !== tileId);
  const counts = tilesToCounts(remaining);
  const existingMelds = hand.melds.length;
  const s = Math.min(
    standardShanten(counts, existingMelds),
    existingMelds === 0 ? chiitoitsuShanten(counts) : Infinity,
    existingMelds === 0 ? kokushiShanten(counts) : Infinity
  );
  return s === 0;
}

/** Every tile in the concealed hand that could be discarded while keeping (or reaching) tenpai. */
export function riichiDiscardCandidates(hand: Hand): number[] {
  return hand.concealed.filter((t) => wouldBeTenpaiAfterDiscard(hand, t.id)).map((t) => t.id);
}
