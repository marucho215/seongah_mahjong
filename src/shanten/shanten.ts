import { SLOT_COUNT } from "../core/tileIndex.js";

/**
 * Standard-form shanten (4 melds + 1 pair), searched by brute-force recursive
 * decomposition over the 34 tile slots. Returns the number of tile exchanges
 * needed to reach tenpai; -1 means the hand (as given) is already a complete win.
 *
 * `existingMelds` accounts for melds already locked in via pon/kan (those don't
 * appear in `counts`, which should hold only the concealed portion of the hand).
 */
export function standardShanten(counts: number[], existingMelds = 0): number {
  let best = 8 - 2 * existingMelds;

  function finalize(melds: number, pairs: number, partial: number): void {
    const blocks = Math.min(melds + partial, 4);
    const usedPartial = Math.max(0, blocks - melds);
    const hasPair = pairs > 0 ? 1 : 0;
    const s = (4 - melds) * 2 - usedPartial - hasPair;
    if (s < best) best = s;
  }

  const work = counts.slice();

  function rec(index: number, melds: number, pairs: number, partial: number): void {
    if (melds + partial >= 5 && pairs === 0) {
      // no more useful blocks possible than the cap allows; still let it finish via skip path
    }
    if (index >= SLOT_COUNT) {
      finalize(melds, pairs, partial);
      return;
    }
    if (work[index] === 0) {
      rec(index + 1, melds, pairs, partial);
      return;
    }
    const suitBase = Math.floor(index / 9);
    const withinSuit = index % 9;
    const isNumbered = suitBase < 3;

    // triplet
    if (work[index]! >= 3) {
      work[index]! -= 3;
      rec(index, melds + 1, pairs, partial);
      work[index]! += 3;
    }
    // sequence (numbered suits only, must not cross the suit boundary)
    if (isNumbered && withinSuit <= 6 && work[index + 1]! > 0 && work[index + 2]! > 0) {
      work[index]!--;
      work[index + 1]!--;
      work[index + 2]!--;
      rec(index, melds + 1, pairs, partial);
      work[index]!++;
      work[index + 1]!++;
      work[index + 2]!++;
    }
    // pair used as THE pair
    if (work[index]! >= 2) {
      work[index]! -= 2;
      rec(index, melds, pairs + 1, partial);
      work[index]! += 2;
      // pair used as a partial set (proto-triplet)
      work[index]! -= 2;
      rec(index, melds, pairs, partial + 1);
      work[index]! += 2;
    }
    // ryanmen/penchan partial (index, index+1)
    if (isNumbered && withinSuit <= 7 && work[index + 1]! > 0) {
      work[index]!--;
      work[index + 1]!--;
      rec(index, melds, pairs, partial + 1);
      work[index]!++;
      work[index + 1]!++;
    }
    // kanchan partial (index, index+2)
    if (isNumbered && withinSuit <= 6 && work[index + 2]! > 0) {
      work[index]!--;
      work[index + 2]!--;
      rec(index, melds, pairs, partial + 1);
      work[index]!++;
      work[index + 2]!++;
    }
    // leave one copy of this tile unused (floating)
    work[index]!--;
    rec(index, melds, pairs, partial);
    work[index]!++;
  }

  rec(0, existingMelds, 0, 0);
  return best;
}

/** Chiitoitsu (seven pairs) shanten. Always a closed-hand-only form (checked by caller). */
export function chiitoitsuShanten(counts: number[]): number {
  let pairs = 0;
  let kinds = 0;
  for (const c of counts) {
    if (c > 0) kinds++;
    if (c >= 2) pairs++;
  }
  return 6 - pairs + Math.max(0, 7 - kinds);
}

/** Kokushi musou (thirteen orphans) shanten: terminals of m/p/s plus all 7 honors. */
const KOKUSHI_SLOTS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

export function kokushiShanten(counts: number[]): number {
  let kinds = 0;
  let hasPair = false;
  for (const slot of KOKUSHI_SLOTS) {
    const c = counts[slot]!;
    if (c > 0) kinds++;
    if (c >= 2) hasPair = true;
  }
  return 13 - kinds - (hasPair ? 1 : 0);
}

/** Minimum shanten across standard, chiitoitsu, and kokushi forms. */
export function minShanten(counts: number[], existingMelds = 0): number {
  let m = standardShanten(counts, existingMelds);
  if (existingMelds === 0) {
    m = Math.min(m, chiitoitsuShanten(counts), kokushiShanten(counts));
  }
  return m;
}

export function isAgariShanten(shanten: number): boolean {
  return shanten <= -1;
}
