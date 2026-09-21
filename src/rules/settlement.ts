import { allSeats } from "../core/seats.js";
import type { Hand } from "../core/Hand.js";
import { isTerminalOrHonor, type TileKind } from "../core/tiles.js";
import type { RuleConfig } from "./RuleConfig.js";
import { computeScore, type ScoreResult } from "../yaku/score.js";

export interface OrderedWinPayment {
  seat: number;
  ronFrom?: number;
  score: ScoreResult;
  /** Defaults to ronFrom; Pao can move honba responsibility to another seat. */
  honbaPayer?: number;
}

export interface OrderedWinSettlement {
  closestWinner: number;
  combinedDeltas: Record<number, number>;
  adjusted: { deltas: Record<number, number>; totalPoints: number }[];
}

/**
 * Combines already ordered ron/tsumo results. In multi-ron only the closest winner keeps
 * honba; kyotaku is also awarded once to that same first winner.
 */
export function settleOrderedWinPayments(
  playerCount: number,
  orderedWinners: readonly OrderedWinPayment[],
  honba: number,
  honbaValue: number,
  kyotaku: number
): OrderedWinSettlement {
  if (orderedWinners.length === 0) throw new Error("settleOrderedWinPayments requires at least one winner");
  const honbaTotal = honba * honbaValue;
  const adjusted = orderedWinners.map((winner, index) => {
    const deltas = { ...winner.score.payments.deltas };
    let totalPoints = winner.score.totalPoints;
    if (index > 0 && winner.ronFrom !== undefined) {
      deltas[winner.seat] = (deltas[winner.seat] ?? 0) - honbaTotal;
      const payer = winner.honbaPayer ?? winner.ronFrom;
      deltas[payer] = (deltas[payer] ?? 0) + honbaTotal;
      totalPoints -= honbaTotal;
    }
    return { deltas, totalPoints };
  });
  const combinedDeltas: Record<number, number> = Object.fromEntries(allSeats(playerCount).map((seat) => [seat, 0]));
  for (const payment of adjusted) {
    for (const [seat, delta] of Object.entries(payment.deltas)) combinedDeltas[Number(seat)]! += delta;
  }
  const closestWinner = orderedWinners[0]!.seat;
  combinedDeltas[closestWinner]! += kyotaku * 1000;
  return { closestWinner, combinedDeltas, adjusted };
}

/** Standard exhaustive-draw redistribution. Returns zero movement for 0/all tenpai. */
export function calculateNotenPayments(
  playerCount: number,
  tenpaiPlayers: readonly number[],
  notenPenaltyTotal: number
): Record<number, number> {
  const seats = allSeats(playerCount);
  const deltas: Record<number, number> = Object.fromEntries(seats.map((seat) => [seat, 0]));
  if (tenpaiPlayers.length === 0 || tenpaiPlayers.length === playerCount) return deltas;
  const tenpai = new Set(tenpaiPlayers);
  const notenPlayers = seats.filter((seat) => !tenpai.has(seat));
  const perReceiver = notenPenaltyTotal / tenpaiPlayers.length;
  const perPayer = notenPenaltyTotal / notenPlayers.length;
  for (const seat of tenpaiPlayers) deltas[seat]! += perReceiver;
  for (const seat of notenPlayers) deltas[seat]! -= perPayer;
  return deltas;
}

/**
 * Mahjong Soul Nagashi Mangan eligibility at a normal exhaustive draw. Calls made by the
 * player do not matter; only their non-empty river, its tile kinds, and whether any of
 * those physical discards was claimed by another player are relevant.
 */
export function findNagashiManganSeats(hands: readonly Hand[]): number[] {
  return hands.flatMap((hand, seat) =>
    hand.discards.length > 0 &&
    hand.discards.every((discard) => isTerminalOrHonor(discard.tile.kind) && !discard.calledAway)
      ? [seat]
      : []
  );
}

/** Combines one independent mangan-tsumo-equivalent payment for every Nagashi seat. */
export function calculateNagashiManganPayments(
  rules: RuleConfig,
  dealerSeat: number,
  nagashiSeats: readonly number[]
): Record<number, number> {
  const deltas: Record<number, number> = Object.fromEntries(
    allSeats(rules.playerCount).map((seat) => [seat, 0])
  );
  for (const winner of nagashiSeats) {
    const payment = computeScore({
      han: 5,
      fu: 20,
      yakumanUnits: 0,
      winner,
      dealer: dealerSeat,
      isTsumo: true,
      honba: 0,
      playerCount: rules.playerCount,
      rules,
    }).payments.deltas;
    for (const seat of allSeats(rules.playerCount)) deltas[seat]! += payment[seat] ?? 0;
  }
  return deltas;
}

export interface ExhaustiveDrawSettlement {
  tenpaiPlayers: number[];
  nagashiManganPlayers: number[];
  deltas: Record<number, number>;
}

/**
 * Pure normal-exhaustive-draw settlement boundary. Nagashi replaces, rather than stacks
 * with, ordinary tenpai/noten redistribution; tenpai is still returned independently for
 * dealer continuation and tenpai-yame.
 */
export function settleExhaustiveDraw(input: {
  rules: RuleConfig;
  dealerSeat: number;
  hands: readonly Hand[];
  winningTilesBySeat: readonly (readonly TileKind[])[];
}): ExhaustiveDrawSettlement {
  const tenpaiPlayers = allSeats(input.rules.playerCount).filter(
    (seat) => (input.winningTilesBySeat[seat]?.length ?? 0) > 0
  );
  const nagashiManganPlayers = findNagashiManganSeats(input.hands);
  const deltas = nagashiManganPlayers.length > 0
    ? calculateNagashiManganPayments(input.rules, input.dealerSeat, nagashiManganPlayers)
    : calculateNotenPayments(input.rules.playerCount, tenpaiPlayers, input.rules.notenPenaltyTotal);
  return { tenpaiPlayers, nagashiManganPlayers, deltas };
}

export function shouldDealerContinue(input: {
  dealerSeat: number;
  isExhaustiveDraw: boolean;
  winnerSeats?: readonly number[];
  tenpaiPlayers?: readonly number[];
  renchanOnDealerWin: boolean;
  renchanOnDealerTenpaiDraw: boolean;
}): boolean {
  if (input.isExhaustiveDraw) {
    return input.renchanOnDealerTenpaiDraw && (input.tenpaiPlayers ?? []).includes(input.dealerSeat);
  }
  return input.renchanOnDealerWin && (input.winnerSeats ?? []).includes(input.dealerSeat);
}
