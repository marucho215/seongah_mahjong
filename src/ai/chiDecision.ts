import type { CharacterProfile } from "./characterProfile.js";
import type { CharacterDecisionContext } from "./characterAI.js";
import type { ChiCandidate } from "../core/discardResponses.js";
import type { Hand } from "../core/Hand.js";
import { isSimple, parseKind, type TileKind } from "../core/tiles.js";
import { tilesToCounts, kindToSlot } from "../core/tileIndex.js";
import { minShanten } from "../shanten/shanten.js";
import { computeImprovingTiles } from "../actions/winSearch.js";

export interface ChiDecisionEvaluation {
  candidate: ChiCandidate;
  beforeShanten: number;
  afterShanten: number;
  shantenGain: number;
  beforeUkeire: number;
  afterUkeire: number;
  ukeireGain: number;
  isFirstOpen: boolean;
  hasOpenYaku: boolean;
  opportunityCost: number;
  components: ChiScoreComponents;
  score: number;
  shouldCall: boolean;
}

export interface ChiStrategicFactors {
  shantenGain: number;
  ukeireGain: number;
  isFirstOpen: boolean;
  hasOpenYaku: boolean;
  riichiPressure: number;
}

export interface ChiStrategicScore {
  score: number;
  opportunityCost: number;
  continuationBonus: number;
  components: ChiScoreComponents;
}

export interface ChiScoreComponents {
  shantenBonus: number;
  ukeireBonus: number;
  callBias: number;
  aggression: number;
  yakuBonus: number;
  opportunityCost: number;
  noYakuCost: number;
  neutralShantenCost: number;
  defense: number;
  continuationBonus: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function jsonSafeTraceNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Chi-specific strategy score. Personality fields remain shared with the existing call
 * system, but callBias is centered so it cannot make every neutral chi positive by itself.
 */
export function scoreChiStrategicFactors(
  profile: CharacterProfile,
  factors: ChiStrategicFactors
): ChiStrategicScore {
  const aggression = profile.aggression ?? 0.5;
  const valueGreed = profile.valueGreed ?? 0.5;
  const riichiBias = profile.riichiBias ?? 0.5;
  const damaBias = profile.damaBias ?? 0.5;
  const callBiasContribution = ((profile.callBias ?? 0.5) - 0.5) * 0.8;
  const aggressionContribution = (aggression - 0.5) * 0.2;
  const personalityScore = callBiasContribution + aggressionContribution;
  const shantenBonus = factors.shantenGain * (1.15 + aggression * 0.45);
  const ukeireBonus = clamp(factors.ukeireGain, -12, 12) * 0.035;
  const progressScore = shantenBonus + ukeireBonus;
  const opportunityCost = factors.isFirstOpen
    ? 0.55 + valueGreed * 0.55 + riichiBias * 0.35 + damaBias * 0.15
    : 0.1 + valueGreed * 0.1;
  const noYakuCost = factors.hasOpenYaku ? 0 : 0.3 + valueGreed * 0.3;
  const neutralShantenCost = factors.shantenGain === 0 ? 0.3 : 0;
  const yakuBonus = factors.hasOpenYaku ? 0.3 : 0;
  const continuationBonus =
    !factors.isFirstOpen &&
    factors.hasOpenYaku &&
    factors.shantenGain === 0 &&
    factors.ukeireGain >= 6
      ? 0.15
      : 0;
  const openDefenseCost = factors.riichiPressure * (profile.defense ?? 0);
  const score =
    progressScore +
    personalityScore +
    yakuBonus -
    opportunityCost -
    noYakuCost -
    neutralShantenCost -
    openDefenseCost +
    continuationBonus;
  return {
    score,
    opportunityCost,
    continuationBonus,
    components: {
      shantenBonus,
      ukeireBonus,
      callBias: callBiasContribution,
      aggression: aggressionContribution,
      yakuBonus,
      opportunityCost: jsonSafeTraceNumber(-opportunityCost),
      noYakuCost: jsonSafeTraceNumber(-noYakuCost),
      neutralShantenCost: jsonSafeTraceNumber(-neutralShantenCost),
      defense: jsonSafeTraceNumber(-openDefenseCost),
      continuationBonus,
    },
  };
}

function remainingImprovingCount(
  counts: number[],
  improving: readonly TileKind[],
  visibleKinds: readonly TileKind[]
): number {
  const visibleCounts = new Map<TileKind, number>();
  for (const kind of visibleKinds) visibleCounts.set(kind, (visibleCounts.get(kind) ?? 0) + 1);
  let total = 0;
  for (const kind of improving) {
    const own = counts[kindToSlot(kind)] ?? 0;
    total += Math.max(0, 4 - own - (visibleCounts.get(kind) ?? 0));
  }
  return total;
}

function progressAfterChi(
  hand: Hand,
  candidate: ChiCandidate,
  ctx: CharacterDecisionContext
): { shanten: number; ukeire: number; concealedKinds: TileKind[] } {
  const remaining = [...hand.concealed];
  for (const kind of candidate.consumedKinds) {
    const index = remaining.findIndex((tile) => tile.kind === kind);
    if (index < 0) return { shanten: Number.POSITIVE_INFINITY, ukeire: 0, concealedKinds: [] };
    remaining.splice(index, 1);
  }

  let bestShanten = Number.POSITIVE_INFINITY;
  let bestUkeire = 0;
  let bestConcealedKinds: TileKind[] = [];
  const seen = new Set<TileKind>();
  for (const discard of remaining) {
    if (seen.has(discard.kind)) continue;
    seen.add(discard.kind);
    const afterDiscard = remaining.filter((tile) => tile.id !== discard.id);
    const counts = tilesToCounts(afterDiscard);
    const shanten = minShanten(counts, hand.melds.length + 1);
    const improving = computeImprovingTiles(counts, hand.melds.length + 1, ctx.rules);
    const ukeire = remainingImprovingCount(counts, improving, ctx.visibleTileKinds);
    if (shanten < bestShanten || (shanten === bestShanten && ukeire > bestUkeire)) {
      bestShanten = shanten;
      bestUkeire = ukeire;
      bestConcealedKinds = afterDiscard.map((tile) => tile.kind);
    }
  }
  return { shanten: bestShanten, ukeire: bestUkeire, concealedKinds: bestConcealedKinds };
}

function isYakuhai(kind: TileKind, ctx: CharacterDecisionContext): boolean {
  const { suit, rank } = parseKind(kind);
  return suit === "z" && (rank >= 5 || rank === ctx.seatWind || rank === ctx.roundWind);
}

function hasGuaranteedOpenYaku(
  hand: Hand,
  candidate: ChiCandidate,
  concealedKinds: readonly TileKind[],
  ctx: CharacterDecisionContext
): boolean {
  const hasYakuhaiMeld = hand.melds.some(
    (meld) => meld.type !== "chi" && isYakuhai(meld.tiles[0]!.kind, ctx)
  );
  if (hasYakuhaiMeld) return true;
  if (!ctx.rules.kuitan) return false;
  const openKinds = [
    ...concealedKinds,
    ...hand.melds.flatMap((meld) => meld.tiles.map((tile) => tile.kind)),
    ...candidate.sequence,
  ];
  return openKinds.length > 0 && openKinds.every(isSimple);
}

/** Pure evaluation: no RNG and no CharacterAI route-state mutation. */
export function evaluateChiDecision(
  profile: CharacterProfile,
  hand: Hand,
  candidate: ChiCandidate,
  ctx: CharacterDecisionContext
): ChiDecisionEvaluation {
  const beforeCounts = tilesToCounts(hand.concealed);
  const beforeShanten = minShanten(beforeCounts, hand.melds.length);
  const beforeImproving = computeImprovingTiles(beforeCounts, hand.melds.length, ctx.rules);
  const beforeUkeire = remainingImprovingCount(beforeCounts, beforeImproving, ctx.visibleTileKinds);
  const after = progressAfterChi(hand, candidate, ctx);
  const shantenGain = beforeShanten - after.shanten;
  const ukeireGain = after.ukeire - beforeUkeire;
  const riichiPressure = ctx.riichiOpponentDiscardKinds.length / Math.max(1, ctx.opponentScores.length);
  const isFirstOpen = hand.isConcealed();
  const hasOpenYaku = hasGuaranteedOpenYaku(hand, candidate, after.concealedKinds, ctx);
  const strategic = scoreChiStrategicFactors(profile, {
    shantenGain,
    ukeireGain,
    isFirstOpen,
    hasOpenYaku,
    riichiPressure,
  });
  return {
    candidate,
    beforeShanten,
    afterShanten: after.shanten,
    shantenGain,
    beforeUkeire,
    afterUkeire: after.ukeire,
    ukeireGain,
    isFirstOpen,
    hasOpenYaku,
    opportunityCost: strategic.opportunityCost,
    components: strategic.components,
    score: strategic.score,
    shouldCall: Number.isFinite(after.shanten) && strategic.score > 0,
  };
}
