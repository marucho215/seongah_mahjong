import { parseKind, type TileKind } from "../core/tiles.js";
import {
  isChinroutouHand,
  isRyuuiisouHand,
  isTsuuiisouHand,
} from "./tileFacts.js";
import type { Group, WaitType, WinContext } from "./types.js";

const DRAGON_KINDS = ["z5", "z6", "z7"];
const WIND_KINDS = ["z1", "z2", "z3", "z4"];
const KOKUSHI_KINDS = ["m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "z3", "z4", "z5", "z6", "z7"];

export interface YakumanHit {
  name: string;
  units: number; // 1 = single yakuman, 2 = double yakuman
}

function countConcealedTriplets(groups: Group[]): number {
  return groups.filter((g) => (g.type === "triplet" || g.type === "quad") && g.concealed).length;
}

function windState(groups: Group[]): "none" | "shou" | "dai" {
  const windTriplets = groups.filter((g) => (g.type === "triplet" || g.type === "quad") && WIND_KINDS.includes(g.kind));
  const windPair = groups.find((g) => g.type === "pair" && WIND_KINDS.includes(g.kind));
  if (windTriplets.length === 4) return "dai";
  if (windTriplets.length === 3 && windPair) return "shou";
  return "none";
}

/** Yakuman checks that apply to a standard (4 melds + pair) decomposition. */
export function standardYakuman(
  groups: Group[],
  waitType: WaitType,
  allKinds: TileKind[],
  winKind: TileKind,
  isMenzen: boolean,
  ctx: WinContext
): YakumanHit[] {
  const hits: YakumanHit[] = [];

  const dragonTriplets = groups.filter((g) => (g.type === "triplet" || g.type === "quad") && DRAGON_KINDS.includes(g.kind));
  if (dragonTriplets.length === 3) hits.push({ name: "Daisangen", units: 1 });

  const winds = windState(groups);
  if (winds === "dai") hits.push({ name: "Daisuushii", units: 2 });
  else if (winds === "shou") hits.push({ name: "Shousuushii", units: 1 });

  const concealedTriplets = countConcealedTriplets(groups);
  if (concealedTriplets === 4) hits.push({ name: waitType === "tanki" ? "Suuankou Tanki" : "Suuankou", units: waitType === "tanki" ? 2 : 1 });

  if (isTsuuiisouHand(allKinds)) hits.push({ name: "Tsuuiisou", units: 1 });
  if (isChinroutouHand(allKinds)) hits.push({ name: "Chinroutou", units: 1 });
  if (isRyuuiisouHand(allKinds)) hits.push({ name: "Ryuuiisou", units: 1 });

  const quadCount = groups.filter((g) => g.type === "quad").length;
  if (quadCount === 4) hits.push({ name: "Suukantsu", units: 1 });

  const chuuren = isMenzen ? chuurenCheck(allKinds, winKind) : null;
  if (chuuren) hits.push(chuuren);

  if (ctx.isTenhou) hits.push({ name: "Tenhou", units: 1 });
  if (ctx.isChiihou) hits.push({ name: "Chiihou", units: 1 });

  return hits;
}

/**
 * Chuuren Poutou requires a closed, single-suit hand whose 13-tile PRE-WIN shape is
 * exactly {1,1,1,2,3,4,5,6,7,8,9,9,9} - the unique tenpai shape that waits on all nine
 * ranks of the suit. Junsei (9-sided wait, double yakuman) is when the actual winning
 * tile could have been any of those nine ranks, i.e. the pre-win shape itself (not the
 * post-win counts) matches that pattern exactly. Checking post-win counts directly (as an
 * earlier version of this function did) is structurally impossible to satisfy: whichever
 * rank the winning tile lands on always pushes that rank's count above the "exactly 1"
 * (or "exactly 3" for 1/9) pattern, since the winning tile is included in those counts.
 */
function chuurenCheck(allKinds: TileKind[], winKind: TileKind): YakumanHit | null {
  const suits = new Set(allKinds.filter((k) => k[0] !== "z").map((k) => k[0]));
  const hasHonor = allKinds.some((k) => k[0] === "z");
  if (suits.size !== 1 || hasHonor) return null;
  if (allKinds.length !== 14) return null;

  const counts = new Array(10).fill(0);
  for (const k of allKinds) counts[parseKind(k).rank]!++;
  if (counts[1]! < 3 || counts[9]! < 3) return null;
  for (let r = 2; r <= 8; r++) if (counts[r]! < 1) return null;

  const winRank = parseKind(winKind).rank;
  const preWin = counts.slice();
  preWin[winRank]!--;
  const pure = preWin[1] === 3 && preWin[9] === 3 && [2, 3, 4, 5, 6, 7, 8].every((r) => preWin[r] === 1);
  return { name: pure ? "Junsei Chuuren Poutou" : "Chuuren Poutou", units: pure ? 2 : 1 };
}

/** Kokushi musou check, given the full 14-kind hand and which kind was the winning tile. */
export function kokushiYakuman(allKinds: TileKind[], winKind: TileKind): YakumanHit | null {
  const counts = new Map<string, number>();
  for (const k of allKinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const k of allKinds) if (!KOKUSHI_KINDS.includes(k)) return null;
  if (counts.size !== 13) return null;

  const preWinCount = (counts.get(winKind) ?? 0) - 1;
  // pre-win count 1 means this kind was already a single among all 13 kinds held ->
  // the hand was waiting on any of the 13 kinds to form the pair (13-wait, double yakuman).
  // pre-win count 0 means this kind was entirely missing -> a narrow single-kind wait.
  const thirteenWait = preWinCount === 1;
  return { name: thirteenWait ? "Kokushi Musou (13-wait)" : "Kokushi Musou", units: thirteenWait ? 2 : 1 };
}
