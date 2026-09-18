import { isHonor, isSimple, isTerminal, isTerminalOrHonor, type TileKind } from "../core/tiles.js";

// z6 = Hatsu (Green Dragon). z2 is South wind - NOT green; a prior version of this list
// mistakenly included z2 instead of z6, which would have accepted a Ryuuiisou hand
// containing the South wind and rejected one containing the Green Dragon.
const GREEN_KINDS = new Set(["s2", "s3", "s4", "s6", "s8", "z6"]);

export function isTanyaoHand(kinds: TileKind[]): boolean {
  return kinds.every(isSimple);
}

export function suitsUsed(kinds: TileKind[]): Set<string> {
  return new Set(kinds.map((k) => k[0]!));
}

export function isHonitsuHand(kinds: TileKind[]): boolean {
  const numberSuits = new Set(kinds.filter((k) => k[0] !== "z").map((k) => k[0]));
  const hasHonor = kinds.some(isHonor);
  return numberSuits.size === 1 && hasHonor;
}

export function isChinitsuHand(kinds: TileKind[]): boolean {
  const numberSuits = new Set(kinds.filter((k) => k[0] !== "z").map((k) => k[0]));
  const hasHonor = kinds.some(isHonor);
  return numberSuits.size === 1 && !hasHonor;
}

export function isHonroutouHand(kinds: TileKind[]): boolean {
  return kinds.every(isTerminalOrHonor);
}

export function isTsuuiisouHand(kinds: TileKind[]): boolean {
  return kinds.every(isHonor);
}

export function isChinroutouHand(kinds: TileKind[]): boolean {
  return kinds.every(isTerminal);
}

export function isRyuuiisouHand(kinds: TileKind[]): boolean {
  return kinds.every((k) => GREEN_KINDS.has(k));
}
