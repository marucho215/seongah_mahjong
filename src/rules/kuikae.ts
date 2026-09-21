import type { ChiCandidate } from "../core/discardResponses.js";
import { makeKind, parseKind, type TileKind } from "../core/tiles.js";
import type { RuleConfig } from "./RuleConfig.js";

/**
 * Tile kinds that may not be discarded immediately after this exact chi.
 * The two consumed tiles determine every tile that could complete the same
 * run: the called kind itself and, for an open-ended pair, the opposite end.
 */
export function forbiddenDiscardsAfterChi(
  rules: RuleConfig,
  candidate: ChiCandidate,
  calledKind: TileKind
): TileKind[] {
  if (!rules.kuikae) return [];

  const parsed = candidate.consumedKinds.map(parseKind);
  if (parsed.some(({ suit }) => suit === "z" || suit !== parsed[0]!.suit)) return [calledKind];

  const suit = parsed[0]!.suit;
  const consumedRanks = parsed.map(({ rank }) => rank);
  const forbidden = new Set<TileKind>([calledKind]);
  for (let rank = 1; rank <= 9; rank++) {
    const ranks = [...consumedRanks, rank].sort((a, b) => a - b);
    if (new Set(ranks).size === 3 && ranks[1] === ranks[0]! + 1 && ranks[2] === ranks[1]! + 1) {
      forbidden.add(makeKind(suit, rank));
    }
  }
  return [...forbidden];
}
