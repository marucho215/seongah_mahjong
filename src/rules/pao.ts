import type { Hand, MeldType, PaoLiability } from "../core/Hand.js";
import { allSeats } from "../core/seats.js";
import type { TileKind } from "../core/tiles.js";
import type { RuleConfig } from "./RuleConfig.js";
import { computeScore, type ScoreResult } from "../yaku/score.js";
import type { YakuHit } from "../yaku/types.js";

export type PaoYakuman = "daisangen" | "daisuushii";

const DRAGONS = new Set<TileKind>(["z5", "z6", "z7"]);
const WINDS = new Set<TileKind>(["z1", "z2", "z3", "z4"]);

function visibleHonorGroups(hand: Hand, kinds: ReadonlySet<TileKind>): Set<TileKind> {
  return new Set(
    hand.melds
      .filter((meld) => meld.type !== "kan_closed" && kinds.has(meld.tiles[0]!.kind))
      .map((meld) => meld.tiles[0]!.kind)
  );
}

/** Detects only the current decisive opponent-discard Pon/Daiminkan. */
export function detectPaoLiabilityAfterOpenCall(input: {
  hand: Hand;
  callType: MeldType;
  calledKind: TileKind;
}): PaoYakuman | null {
  if (input.callType !== "pon" && input.callType !== "kan_open") return null;
  if (DRAGONS.has(input.calledKind) && visibleHonorGroups(input.hand, DRAGONS).size === 3) {
    return "daisangen";
  }
  if (WINDS.has(input.calledKind) && visibleHonorGroups(input.hand, WINDS).size === 4) {
    return "daisuushii";
  }
  return null;
}

/** Commits a newly detected liability without replacing an earlier provider. */
export function recordPaoLiabilityAfterOpenCall(
  hand: Hand,
  callType: MeldType,
  calledKind: TileKind,
  sourceSeat: number
): void {
  const yakuman = detectPaoLiabilityAfterOpenCall({ hand, callType, calledKind });
  if (yakuman && hand.paoLiability[yakuman] === undefined) hand.paoLiability[yakuman] = sourceSeat;
}

function yakuUnits(hit: YakuHit): number {
  return hit.han / 13;
}

function addDeltas(target: Record<number, number>, source: Readonly<Record<number, number>>): void {
  for (const [seat, delta] of Object.entries(source)) target[Number(seat)]! += delta;
}

export interface PaoAdjustedScore {
  score: ScoreResult;
  /** Seat that funded this winner's honba; used when multi-ron removes it from farther winners. */
  honbaPayer?: number;
  coveredYakumanUnits: number;
}

/**
 * Redistributes only the yakuman units covered by recorded Pao. Ordinary composite units
 * keep their normal ron/tsumo payment, while honba is funded wholly by the liable seat.
 */
export function applyPaoSettlement(input: {
  score: ScoreResult;
  yaku: readonly YakuHit[];
  yakumanUnits: number;
  liability: Readonly<PaoLiability>;
  winner: number;
  dealer: number;
  isTsumo: boolean;
  ronFrom?: number;
  honba: number;
  rules: RuleConfig;
}): PaoAdjustedScore {
  const covered = [
    { name: "Daisangen", liable: input.liability.daisangen },
    { name: "Daisuushii", liable: input.liability.daisuushii },
  ].flatMap(({ name, liable }) => {
    const hit = input.yaku.find((candidate) => candidate.name === name);
    return hit && liable !== undefined ? [{ units: yakuUnits(hit), liable }] : [];
  });
  const coveredYakumanUnits = covered.reduce((sum, entry) => sum + entry.units, 0);
  if (input.yakumanUnits <= 0 || coveredYakumanUnits <= 0) {
    return { score: input.score, coveredYakumanUnits: 0 };
  }

  const deltas: Record<number, number> = Object.fromEntries(
    allSeats(input.rules.playerCount).map((seat) => [seat, 0])
  );
  const ordinaryUnits = input.yakumanUnits - coveredYakumanUnits;
  if (ordinaryUnits > 0) {
    addDeltas(deltas, computeScore({
      han: ordinaryUnits * 13,
      fu: 0,
      yakumanUnits: ordinaryUnits,
      winner: input.winner,
      dealer: input.dealer,
      isTsumo: input.isTsumo,
      ronFrom: input.ronFrom,
      honba: 0,
      playerCount: input.rules.playerCount,
      rules: input.rules,
    }).payments.deltas);
  }

  for (const entry of covered) {
    const ordinaryCovered = computeScore({
      han: entry.units * 13,
      fu: 0,
      yakumanUnits: entry.units,
      winner: input.winner,
      dealer: input.dealer,
      isTsumo: input.isTsumo,
      ronFrom: input.ronFrom,
      honba: 0,
      playerCount: input.rules.playerCount,
      rules: input.rules,
    });
    const amount = ordinaryCovered.totalPoints;
    if (input.isTsumo || entry.liable === input.ronFrom) {
      deltas[entry.liable]! -= amount;
    } else {
      const half = amount / 2;
      deltas[entry.liable]! -= half;
      deltas[input.ronFrom!]! -= half;
    }
    deltas[input.winner]! += amount;
  }

  const honbaPayer = covered[0]!.liable;
  const honbaTotal = input.honba * input.rules.honbaValue;
  deltas[honbaPayer]! -= honbaTotal;
  deltas[input.winner]! += honbaTotal;
  return {
    score: {
      base: input.score.base,
      totalPoints: deltas[input.winner]!,
      payments: { deltas },
    },
    honbaPayer,
    coveredYakumanUnits,
  };
}
