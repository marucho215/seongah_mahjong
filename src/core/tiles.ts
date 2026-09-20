import type { RuleConfig } from "../rules/RuleConfig.js";

export type Suit = "m" | "p" | "s" | "z";

/** Canonical tile kind, e.g. "m1", "p5", "z3" (honors: 1E 2S 3W 4N 5Haku 6Hatsu 7Chun). */
export type TileKind = string;

export interface Tile {
  /** Stable unique id for this physical tile, assigned once at wall-build time. Never reused. */
  readonly id: number;
  readonly kind: TileKind;
  readonly suit: Suit;
  readonly rank: number;
  readonly isRed: boolean;
}

export const HONOR_NAMES = ["East", "South", "West", "North", "Haku", "Hatsu", "Chun"] as const;

export function makeKind(suit: Suit, rank: number): TileKind {
  return `${suit}${rank}`;
}

export function parseKind(kind: TileKind): { suit: Suit; rank: number } {
  const suit = kind[0] as Suit;
  const rank = Number(kind.slice(1));
  return { suit, rank };
}

export function isHonor(kind: TileKind): boolean {
  return kind[0] === "z";
}

export function isTerminal(kind: TileKind): boolean {
  const { suit, rank } = parseKind(kind);
  return suit !== "z" && (rank === 1 || rank === 9);
}

export function isTerminalOrHonor(kind: TileKind): boolean {
  return isHonor(kind) || isTerminal(kind);
}

export function isSimple(kind: TileKind): boolean {
  return !isTerminalOrHonor(kind);
}

/** All kinds that exist in this rule set's wall, before red-five substitution, in canonical order. */
export function allKindsForRules(rules: RuleConfig): TileKind[] {
  const kinds: TileKind[] = [];
  for (const suit of ["m", "p", "s"] as const) {
    for (let rank = 1; rank <= 9; rank++) {
      if (suit === "m" && rules.removeManzu2to8 && rank >= 2 && rank <= 8) continue;
      kinds.push(makeKind(suit, rank));
    }
  }
  for (let rank = 1; rank <= 7; rank++) {
    kinds.push(makeKind("z", rank));
  }
  return kinds;
}

/**
 * Builds the full set of physical tiles for this rule set, unshuffled, in canonical
 * (kind, then copy-index) order. Exactly 4 copies of every kind; red fives are marked
 * via isRed on as many of the rank-5 copies as akaDoraCount specifies.
 */
export function buildTileSet(rules: RuleConfig): Tile[] {
  const tiles: Tile[] = [];
  let nextId = 0;
  const akaBySuit: Record<string, number> = {
    m: rules.akaDoraCount.man,
    p: rules.akaDoraCount.pin,
    s: rules.akaDoraCount.sou,
  };

  for (const kind of allKindsForRules(rules)) {
    const { suit, rank } = parseKind(kind);
    const akaRemainingForKind = rank === 5 && suit !== "z" ? (akaBySuit[suit] ?? 0) : 0;
    for (let copy = 0; copy < 4; copy++) {
      const isRed = copy < akaRemainingForKind;
      tiles.push({ id: nextId++, kind, suit, rank, isRed });
    }
  }
  return tiles;
}

export function totalTileCount(rules: RuleConfig): number {
  return allKindsForRules(rules).length * 4;
}
