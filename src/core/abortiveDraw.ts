import type { Hand } from "./Hand.js";
import { isTerminalOrHonor } from "./tiles.js";

export type AbortiveDrawReason = "nine_terminals" | "four_winds" | "four_riichi" | "four_kans";

/** Mahjong Soul ranked applicability differs by player count. */
export function isAbortiveDrawReasonEnabled(reason: AbortiveDrawReason, playerCount: number): boolean {
  if (reason === "nine_terminals" || reason === "four_kans") return playerCount === 3 || playerCount === 4;
  return playerCount === 4;
}

export function canDeclareNineTerminals(hand: Hand, firstDraw: boolean, tableInterrupted: boolean): boolean {
  if (!firstDraw || tableInterrupted || hand.discards.length > 0) return false;
  return new Set(hand.concealed.filter((tile) => isTerminalOrHonor(tile.kind)).map((tile) => tile.kind)).size >= 9;
}

export function isFourWindsAbortive(hands: readonly Hand[], tableInterrupted: boolean): boolean {
  if (hands.length !== 4 || tableInterrupted || hands.some((hand) => hand.discards.length !== 1)) return false;
  const first = hands[0]!.discards[0]!.tile.kind;
  return first[0] === "z" && Number(first.slice(1)) <= 4 && hands.every((hand) => hand.discards[0]!.tile.kind === first);
}

export function isFourRiichiAbortive(hands: readonly Hand[]): boolean {
  return hands.length === 4 && hands.every((hand) => hand.riichi);
}

export function isFourKansAbortive(hands: readonly Hand[]): boolean {
  if (hands.length !== 3 && hands.length !== 4) return false;
  const kanCounts = hands.map((hand) => hand.melds.filter((meld) => meld.type.startsWith("kan_")).length);
  return kanCounts.reduce((sum, count) => sum + count, 0) >= 4 && kanCounts.filter((count) => count > 0).length >= 2;
}

/** Ron always resolves before an abortive draw caused by the same discard. */
export function postDiscardAbortiveDrawReason(
  hands: readonly Hand[],
  tableInterrupted: boolean,
  hasRonWinner: boolean,
  playerCount: number = hands.length
): AbortiveDrawReason | null {
  if (hasRonWinner) return null;
  if (isAbortiveDrawReasonEnabled("four_winds", playerCount) && isFourWindsAbortive(hands, tableInterrupted)) {
    return "four_winds";
  }
  if (isAbortiveDrawReasonEnabled("four_kans", playerCount) && isFourKansAbortive(hands)) return "four_kans";
  return null;
}
