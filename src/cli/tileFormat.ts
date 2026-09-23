import { parseKind, type TileKind } from "../core/tiles.js";

/** Display-only Korean tile name, e.g. "1만", "5통(적)" for a red five, "북". This is purely
 *  a human-facing label - internal notation (m1/p5/z4/...) is untouched everywhere else
 *  (engine, log, replay, tests). */
export function koreanTileLabel(kind: TileKind, isRed?: boolean): string {
  const { suit, rank } = parseKind(kind);
  if (suit === "z") {
    const HONOR_KO = ["동", "남", "서", "북", "백", "발", "중"];
    return HONOR_KO[rank - 1] ?? kind;
  }
  const SUIT_KO: Record<string, string> = { m: "만", p: "통", s: "삭" };
  const base = `${rank}${SUIT_KO[suit] ?? suit}`;
  return isRed ? `적${base}` : base;
}

/** Display-only sort order: 만(m) -> 통(p) -> 삭(s) -> 자패(z), ascending rank within each
 *  suit, and 동남서북백발중 order within honors (z1..z7 already match that order). Never
 *  applied to the engine's own Hand.concealed - only to a display copy (see
 *  humanPlayDriver.ts), so tile-id-based selection still maps back to the real hand. */
const SUIT_ORDER: Record<string, number> = { m: 0, p: 1, s: 2, z: 3 };

export function compareTilesForDisplay(a: { kind: TileKind }, b: { kind: TileKind }): number {
  const pa = parseKind(a.kind);
  const pb = parseKind(b.kind);
  const suitDelta = (SUIT_ORDER[pa.suit] ?? 9) - (SUIT_ORDER[pb.suit] ?? 9);
  if (suitDelta !== 0) return suitDelta;
  return pa.rank - pb.rank;
}

/** Whether the last Hangul syllable of `text` has a batchim (final consonant) - used to pick
 *  the correct particle (을/를, 로/으로) for the tile name that precedes it. Returns 0 (no
 *  batchim) for any non-Hangul-syllable trailing character. */
function batchimIndex(text: string): number {
  const code = text.charCodeAt(text.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return 0;
  return (code - 0xac00) % 28;
}

/** "을" after a batchim-final tile name, "를" otherwise - e.g. "북을", "서를". */
export function josaEulReul(text: string): string {
  return batchimIndex(text) !== 0 ? "을" : "를";
}

/** "으로" after a batchim-final tile name (except ㄹ), "로" otherwise - e.g. "북으로", "서로". */
export function josaRo(text: string): string {
  const idx = batchimIndex(text);
  return idx !== 0 && idx !== 8 ? "으로" : "로";
}
