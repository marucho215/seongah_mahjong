import { isHonor, isTerminalOrHonor, parseKind, type TileKind } from "../core/tiles.js";
import { pairFu } from "./fu.js";
import type { Group, WaitType, WinContext, YakuHit } from "./types.js";
import { isTanyaoHand, isHonitsuHand, isChinitsuHand, isHonroutouHand } from "./tileFacts.js";

const DRAGON_KINDS = ["z5", "z6", "z7"];

export function isPinfu(groups: Group[], waitType: WaitType, isMenzen: boolean, ctx: WinContext): boolean {
  if (!isMenzen) return false;
  if (waitType !== "ryanmen") return false;
  if (groups.some((g) => g.type !== "sequence" && g.type !== "pair")) return false;
  const pair = groups.find((g) => g.type === "pair")!;
  return pairFu(pair.kind, ctx.seatWind, ctx.roundWind) === 0;
}

/**
 * Chanta requires every group to contain a terminal/honor AND at least one sequence -
 * an all-triplet/pair terminal-honor hand is Honroutou (and/or Toitoi/Chiitoitsu)
 * territory, not Chanta, even though it technically satisfies the "every group qualifies"
 * condition on its own.
 */
function chantaCheck(groups: Group[]): { chanta: boolean; junchan: boolean } {
  let allQualify = true;
  let anyHonor = false;
  let anySequence = false;
  for (const g of groups) {
    if (g.type === "sequence") {
      anySequence = true;
      const rank = parseKind(g.kind).rank;
      if (rank !== 1 && rank !== 7) allQualify = false;
    } else {
      if (!isTerminalOrHonor(g.kind)) allQualify = false;
      if (isHonor(g.kind)) anyHonor = true;
    }
  }
  const chanta = allQualify && anySequence;
  return { chanta, junchan: chanta && !anyHonor };
}

function findIipeikouPairs(groups: Group[]): number {
  const seqKinds = groups.filter((g) => g.type === "sequence").map((g) => g.kind);
  const counts = new Map<string, number>();
  for (const k of seqKinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  let pairs = 0;
  for (const c of counts.values()) pairs += Math.floor(c / 2);
  return pairs;
}

function isIttsuu(groups: Group[]): boolean {
  for (const suit of ["m", "p", "s"]) {
    const kinds = new Set(groups.filter((g) => g.type === "sequence" && g.kind[0] === suit).map((g) => g.kind));
    if (kinds.has(`${suit}1`) && kinds.has(`${suit}4`) && kinds.has(`${suit}7`)) return true;
  }
  return false;
}

function isSanshokuDoukou(groups: Group[]): boolean {
  const triplets = groups.filter((g) => g.type === "triplet" || g.type === "quad");
  const byRank = new Map<number, Set<string>>();
  for (const g of triplets) {
    const { suit, rank } = parseKind(g.kind);
    if (suit === "z") continue;
    if (!byRank.has(rank)) byRank.set(rank, new Set());
    byRank.get(rank)!.add(suit);
  }
  for (const suits of byRank.values()) if (suits.size === 3) return true;
  return false;
}

function isSanshokuDoujun(groups: Group[]): boolean {
  const byStartRank = new Map<number, Set<string>>();
  for (const group of groups) {
    if (group.type !== "sequence") continue;
    const { suit, rank } = parseKind(group.kind);
    if (suit === "z") continue;
    if (!byStartRank.has(rank)) byStartRank.set(rank, new Set());
    byStartRank.get(rank)!.add(suit);
  }
  for (const suits of byStartRank.values()) if (suits.size === 3) return true;
  return false;
}

function countConcealedTriplets(groups: Group[]): number {
  return groups.filter((g) => (g.type === "triplet" || g.type === "quad") && g.concealed).length;
}

function shousangenState(groups: Group[]): "none" | "shou" | "dai" {
  const dragonTriplets = groups.filter((g) => (g.type === "triplet" || g.type === "quad") && DRAGON_KINDS.includes(g.kind));
  const dragonPair = groups.find((g) => g.type === "pair" && DRAGON_KINDS.includes(g.kind));
  if (dragonTriplets.length === 3) return "dai";
  if (dragonTriplets.length === 2 && dragonPair) return "shou";
  return "none";
}

/**
 * Non-yakuman yaku for a standard (4 melds + pair) decomposition. Yakuman-tier hands
 * (daisangen, suuankou, tsuuiisou, etc.) are evaluated separately in yakuman.ts and,
 * when present, take priority over this list entirely.
 */
export function evaluateStandardYaku(
  groups: Group[],
  waitType: WaitType,
  isMenzen: boolean,
  allKinds: TileKind[],
  ctx: WinContext,
  kuitanAllowed: boolean,
  northIsYakuhai = false
): YakuHit[] {
  const hits: YakuHit[] = [];

  if (ctx.isDoubleRiichi) hits.push({ name: "Double Riichi", han: 2 });
  else if (ctx.isRiichi) hits.push({ name: "Riichi", han: 1 });
  if (ctx.isRiichi && ctx.isIppatsu) hits.push({ name: "Ippatsu", han: 1 });
  if (ctx.isTsumo && isMenzen) hits.push({ name: "Menzen Tsumo", han: 1 });
  if (ctx.isHaitei) hits.push({ name: "Haitei Raoyue", han: 1 });
  if (ctx.isHoutei) hits.push({ name: "Houtei Raoyui", han: 1 });
  if (ctx.isRinshan) hits.push({ name: "Rinshan Kaihou", han: 1 });
  if (ctx.isChankan) hits.push({ name: "Chankan", han: 1 });

  if (isPinfu(groups, waitType, isMenzen, ctx)) hits.push({ name: "Pinfu", han: 1 });

  if (isTanyaoHand(allKinds) && (isMenzen || kuitanAllowed)) hits.push({ name: "Tanyao", han: 1 });

  for (const g of groups) {
    if (g.type !== "triplet" && g.type !== "quad") continue;
    if (DRAGON_KINDS.includes(g.kind)) hits.push({ name: `Yakuhai (${g.kind})`, han: 1 });
    else if (isHonor(g.kind)) {
      const rank = parseKind(g.kind).rank;
      if (rank === ctx.seatWind) hits.push({ name: "Yakuhai (seat wind)", han: 1 });
      if (rank === ctx.roundWind) hits.push({ name: "Yakuhai (round wind)", han: 1 });
      // In sanma, North cannot match a seat wind because only E/S/W are seated. In yonma,
      // a North seat is handled normally by the seat-wind check above. northIsYakuhai is
      // the separate policy for treating North as yakuhai regardless of seat/round wind.
      if (northIsYakuhai && rank === 4) hits.push({ name: "Yakuhai (North)", han: 1 });
    }
  }

  if (isSanshokuDoujun(groups)) hits.push({ name: "Sanshoku Doujun", han: isMenzen ? 2 : 1 });
  if (isSanshokuDoukou(groups)) hits.push({ name: "Sanshoku Doukou", han: 2 });
  if (isIttsuu(groups)) hits.push({ name: "Ittsuu", han: isMenzen ? 2 : 1 });

  const { chanta, junchan } = chantaCheck(groups);
  if (junchan) hits.push({ name: "Junchan", han: isMenzen ? 3 : 2 });
  else if (chanta) hits.push({ name: "Chanta", han: isMenzen ? 2 : 1 });

  if (isHonroutouHand(allKinds)) hits.push({ name: "Honroutou", han: 2 });

  if (groups.filter((g) => g.type === "triplet" || g.type === "quad").length === 4) {
    hits.push({ name: "Toitoi", han: 2 });
  }

  const kanCount = groups.filter((g) => g.type === "quad").length;
  if (kanCount === 3) hits.push({ name: "Sankantsu", han: 2 });

  const sanankouCount = countConcealedTriplets(groups);
  if (sanankouCount >= 3) hits.push({ name: "Sanankou", han: 2 });

  if (isMenzen && isHonitsuHand(allKinds)) hits.push({ name: "Honitsu", han: 3 });
  else if (isHonitsuHand(allKinds)) hits.push({ name: "Honitsu", han: 2 });
  if (isMenzen && isChinitsuHand(allKinds)) hits.push({ name: "Chinitsu", han: 6 });
  else if (isChinitsuHand(allKinds)) hits.push({ name: "Chinitsu", han: 5 });

  if (isMenzen) {
    const iipeikouPairs = findIipeikouPairs(groups);
    if (iipeikouPairs >= 2) hits.push({ name: "Ryanpeikou", han: 3 });
    else if (iipeikouPairs === 1) hits.push({ name: "Iipeikou", han: 1 });
  }

  if (shousangenState(groups) === "shou") hits.push({ name: "Shousangen", han: 2 });

  return hits;
}
