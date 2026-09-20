import type { Tile, TileKind } from "./tiles.js";

/**
 * Canonical 34-slot index used by shanten/yaku calculations:
 * 0-8 = m1-m9, 9-17 = p1-p9, 18-26 = s1-s9, 27-33 = z1-z7.
 * Sanma hands simply always have zero count at indices 1-7 (m2-m8).
 */
export const SLOT_COUNT = 34;

const SUIT_OFFSET: Record<string, number> = { m: 0, p: 9, s: 18, z: 27 };

export function kindToSlot(kind: TileKind): number {
  const suit = kind[0]!;
  const rank = Number(kind.slice(1));
  return SUIT_OFFSET[suit]! + (rank - 1);
}

export function slotToKind(slot: number): TileKind {
  if (slot < 9) return `m${slot + 1}`;
  if (slot < 18) return `p${slot - 9 + 1}`;
  if (slot < 27) return `s${slot - 18 + 1}`;
  return `z${slot - 27 + 1}`;
}

export function tilesToCounts(tiles: readonly Tile[]): number[] {
  const counts = new Array(SLOT_COUNT).fill(0);
  for (const t of tiles) counts[kindToSlot(t.kind)]++;
  return counts;
}

/** Same as tilesToCounts, but for plain kinds (no physical Tile objects) - used where only
 *  a kind list is available, e.g. tiles visible elsewhere on the table (opponents' discards/
 *  melds/kita, dora indicators) rather than tiles actually held. */
export function kindsToCounts(kinds: readonly TileKind[]): number[] {
  const counts = new Array(SLOT_COUNT).fill(0);
  for (const k of kinds) counts[kindToSlot(k)]++;
  return counts;
}

export function countsToTileKinds(counts: number[]): TileKind[] {
  const out: TileKind[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    for (let c = 0; c < counts[i]!; c++) out.push(slotToKind(i));
  }
  return out;
}
