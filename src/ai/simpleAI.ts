import type { Hand } from "../core/Hand.js";
import type { RuleConfig } from "../rules/RuleConfig.js";
import type { Tile, TileKind } from "../core/tiles.js";
import { tilesToCounts, kindToSlot } from "../core/tileIndex.js";
import { standardShanten, chiitoitsuShanten, kokushiShanten } from "../shanten/shanten.js";
import { computeWinningTiles } from "../actions/winSearch.js";
import { canDeclareRiichi, wouldBeTenpaiAfterDiscard } from "../actions/riichi.js";

function bestShanten(concealedTiles: Tile[], existingMelds: number): number {
  const counts = tilesToCounts(concealedTiles);
  let s = standardShanten(counts, existingMelds);
  if (existingMelds === 0) {
    s = Math.min(s, chiitoitsuShanten(counts), kokushiShanten(counts));
  }
  return s;
}

export interface DiscardChoiceContext {
  hand: Hand;
  /** Discard rivers of opponents currently in riichi (their kind sequence), used for defense. */
  riichiOpponentDiscardKinds: TileKind[][];
  /** Tile kinds excluded by a one-discard rules restriction such as post-chi kuikae. */
  forbiddenDiscardKinds?: readonly TileKind[];
}

/**
 * Picks which tile to discard from a 14-tile hand. Always narrows to the tile(s) that
 * leave the hand at minimum shanten (never intentionally throws away hand progress),
 * then - among ties - defers to `pickAmongTiedCandidates` to choose defensively.
 */
export function chooseDiscard(ctx: DiscardChoiceContext): number {
  const { hand } = ctx;
  const existingMelds = hand.melds.length;
  const forbidden = new Set(ctx.forbiddenDiscardKinds ?? []);
  const uniqueKinds = [...new Set(hand.concealed.map((t) => t.kind))].filter((kind) => !forbidden.has(kind));
  if (uniqueKinds.length === 0) throw new Error("chooseDiscard: no legal discard candidate");

  let bestS = Infinity;
  const scoredByKind = new Map<TileKind, number>();
  for (const kind of uniqueKinds) {
    const tile = hand.concealed.find((t) => t.kind === kind)!;
    const remaining = hand.concealed.filter((t) => t.id !== tile.id);
    const s = bestShanten(remaining, existingMelds);
    scoredByKind.set(kind, s);
    if (s < bestS) bestS = s;
  }

  const tiedKinds = uniqueKinds.filter((k) => scoredByKind.get(k) === bestS);
  const tiedCandidateTiles = tiedKinds.map((k) => pickNonRedRepresentative(hand, k));

  const isSelfTenpai = bestS === 0;
  const chosenTile = pickAmongTiedCandidates(tiedCandidateTiles, ctx, isSelfTenpai);
  return chosenTile.id;
}

/**
 * Picks which physical tile represents a given kind when multiple copies are in hand and
 * any of them would be an equally valid discard for hand-progress purposes (shanten never
 * depends on which specific copy of a kind you discard). Red fives carry a dora point that
 * ordinary fives don't, so when both are available for the same discard decision, the
 * ordinary copy is preferred - keeping the red five in hand for as long as possible.
 */
export function pickNonRedRepresentative(hand: Hand, kind: TileKind): Tile {
  const copies = hand.concealed.filter((t) => t.kind === kind);
  return copies.find((t) => !t.isRed) ?? copies[0]!;
}

/**
 * Among tiles that are equally good for hand progress (`candidates`, all leaving the hand
 * at the same best-achievable shanten), decides which one to actually discard: prioritizes
 * genbutsu safety over pure efficiency when we're not tenpai ourselves and at least one
 * opponent is in riichi, otherwise defers to the caller's already-red-aware tile choice.
 */
function pickAmongTiedCandidates(candidates: Tile[], ctx: DiscardChoiceContext, isSelfTenpai: boolean): Tile {
  const opponentsInRiichi = ctx.riichiOpponentDiscardKinds.length > 0;
  if (!isSelfTenpai && opponentsInRiichi) {
    const safe = candidates.find((tile) =>
      isSafeAgainstAllRiichi({ candidateKind: tile.kind, riichiOpponentDiscardKinds: ctx.riichiOpponentDiscardKinds })
    );
    if (safe) return safe;
  }
  return candidates[0]!;
}

export function shouldDeclareRiichi(hand: Hand, score: number, wallRemainingLive: number, tileIdToDiscard: number): boolean {
  if (!canDeclareRiichi(hand, score, wallRemainingLive)) return false;
  return wouldBeTenpaiAfterDiscard(hand, tileIdToDiscard);
}

/** Whether `kind` is a guaranteed-yaku value tile (dragon, or the caller's seat/round
 *  wind) - shared between SimpleAI's own pon policy and CharacterAI's call evaluation,
 *  which needs the real yakuhai status of the specific tile being offered rather than a
 *  hardcoded assumption. */
export function isYakuhaiTile(kind: TileKind, seatWind: number, roundWind: number): boolean {
  if (kind[0] !== "z") return false;
  const rank = Number(kind.slice(1));
  if (rank === 5 || rank === 6 || rank === 7) return true; // dragons
  return rank === seatWind || rank === roundWind;
}

/** AI only calls pon on value tiles (dragons or seat/round wind) - it guarantees a yaku,
 *  which is the one thing an open sanma hand structurally cannot get "for free". */
export function shouldCallPon(discardedKind: TileKind, seatWind: number, roundWind: number): boolean {
  return isYakuhaiTile(discardedKind, seatWind, roundWind);
}

/** AI declares a closed kan whenever it can - it never opens the hand or costs tempo
 *  in a way that outweighs the extra dora indicator and fu. */
export function shouldDeclareAnkan(): boolean {
  return true;
}

/** AI calls an open kan (daiminkan) on a value tile, same reasoning as shouldCallPon:
 *  it guarantees a yaku source, which an open sanma hand otherwise can't get for free. */
export function shouldCallDaiminkan(discardedKind: TileKind, seatWind: number, roundWind: number): boolean {
  return shouldCallPon(discardedKind, seatWind, roundWind);
}

/** AI always upgrades an existing pon to a kan (shouminkan) when it draws the 4th tile -
 *  same reasoning as ankan: strictly more dora/fu potential, no meaningful downside. */
export function shouldDeclareShouminkan(): boolean {
  return true;
}

/** Default deterministic policy preserves the simulator's historical preference to
 * extract North, while GameState keeps pass as a distinct legal action. */
export function shouldDeclareKita(): boolean {
  return true;
}

export interface WaitDangerInput {
  candidateKind: TileKind;
  riichiOpponentDiscardKinds: TileKind[][];
}

/** True if `candidateKind` is genbutsu (already discarded) against every riichi opponent. */
export function isSafeAgainstAllRiichi(input: WaitDangerInput): boolean {
  return input.riichiOpponentDiscardKinds.every((river) => river.includes(input.candidateKind));
}

export function computeOwnWinningTiles(hand: Hand, rules: RuleConfig): TileKind[] {
  return computeWinningTiles(tilesToCounts(hand.concealed), hand.melds.length, rules);
}
