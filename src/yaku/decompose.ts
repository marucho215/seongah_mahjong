import { slotToKind } from "../core/tileIndex.js";
import type { Group, StandardDecomposition, WaitType } from "./types.js";

interface RawGroup {
  type: "sequence" | "triplet" | "pair";
  slots: number[];
}

/**
 * Enumerates every way to decompose `counts` (the concealed portion of a winning hand,
 * winning tile included) into complete melds + one pair. Each `concealedMelds` entry
 * represents melds already locked in by calls and is appended to every decomposition
 * unchanged. Returns one entry per distinct valid decomposition (a hand can be
 * interpretable more than one way, e.g. an overlapping run/triplet shape).
 */
export function findStandardDecompositions(counts: number[], existingMelds: Group[]): RawGroup[][] {
  const work = counts.slice();
  const results: RawGroup[][] = [];
  const path: RawGroup[] = [];
  const targetGroups = 4 - existingMelds.length;

  function rec(index: number, groupsFound: number, hasPair: boolean): void {
    if (index >= 34) {
      if (groupsFound === targetGroups && hasPair) {
        results.push(path.slice());
      }
      return;
    }
    if (work[index] === 0) {
      rec(index + 1, groupsFound, hasPair);
      return;
    }
    if (groupsFound >= targetGroups && hasPair) return; // no room left, prune
    const suitBase = Math.floor(index / 9);
    const withinSuit = index % 9;
    const isNumbered = suitBase < 3;

    if (work[index]! >= 3 && groupsFound < targetGroups) {
      work[index]! -= 3;
      path.push({ type: "triplet", slots: [index, index, index] });
      rec(index, groupsFound + 1, hasPair);
      path.pop();
      work[index]! += 3;
    }
    if (isNumbered && withinSuit <= 6 && work[index + 1]! > 0 && work[index + 2]! > 0 && groupsFound < targetGroups) {
      work[index]!--;
      work[index + 1]!--;
      work[index + 2]!--;
      path.push({ type: "sequence", slots: [index, index + 1, index + 2] });
      rec(index, groupsFound + 1, hasPair);
      path.pop();
      work[index]!++;
      work[index + 1]!++;
      work[index + 2]!++;
    }
    if (work[index]! >= 2 && !hasPair) {
      work[index]! -= 2;
      path.push({ type: "pair", slots: [index, index] });
      rec(index, groupsFound, true);
      path.pop();
      work[index]! += 2;
    }
    // no "skip" branch: a full decomposition must consume every tile
  }

  rec(0, 0, false);
  return results;
}

function rawGroupToGroup(raw: RawGroup, concealed: boolean): Group {
  const kind = slotToKind(raw.slots[0]!);
  return { type: raw.type, kind, concealed };
}

/**
 * Builds full Group[] decompositions (existing melds + concealed groups) and, for each,
 * classifies the wait type based on where the winning tile landed.
 */
export function decomposeWinningHand(
  counts: number[],
  existingMelds: Group[],
  winSlot: number
): StandardDecomposition[] {
  const rawDecomps = findStandardDecompositions(counts, existingMelds);
  const out: StandardDecomposition[] = [];

  for (const raw of rawDecomps) {
    const concealedGroups = raw.map((g) => rawGroupToGroup(g, true));
    const groups = [...existingMelds, ...concealedGroups];

    // find which concealed group "contains" the winning slot (there may be several
    // raw groups touching that slot; each yields a distinct wait-type interpretation)
    for (let i = 0; i < raw.length; i++) {
      const rg = raw[i]!;
      if (!rg.slots.includes(winSlot)) continue;
      const waitType = classifyWait(rg, winSlot);
      out.push({
        groups: groups.slice(),
        waitType,
        winGroupIndex: existingMelds.length + i,
      });
    }
  }
  return out;
}

function classifyWait(rg: RawGroup, winSlot: number): WaitType {
  if (rg.type === "pair") return "tanki";
  if (rg.type === "triplet") return "shanpon";
  // sequence
  const [a, , c] = rg.slots as [number, number, number];
  if (winSlot === a + 1) return "kanchan";
  if (winSlot === a) {
    // held (a+1, a+2); penchan only when a+2 is the suit's top (rank 9, i.e. withinSuit===8)
    return c % 9 === 8 ? "penchan" : "ryanmen";
  }
  // winSlot === c, held (a, a+1); penchan only when a is the suit's bottom (rank 1, i.e. withinSuit===0)
  return a % 9 === 0 ? "penchan" : "ryanmen";
}
