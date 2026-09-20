import type { RuleConfig } from "../rules/RuleConfig.js";

function roundUp100(n: number): number {
  return Math.ceil(n / 100) * 100;
}

/** Base points before the ron/tsumo multiplier, per standard han/fu formula with mangan+ caps. */
export function basePoints(han: number, fu: number, yakumanUnits: number, kiriageMangan: boolean): number {
  if (yakumanUnits > 0) return 8000 * yakumanUnits;
  if (han >= 11) return 6000; // sanbaiman
  if (han >= 8) return 4000; // baiman
  if (han >= 6) return 3000; // haneman
  if (han >= 5) return 2000; // mangan
  let base = fu * Math.pow(2, 2 + han);
  // kiriage mangan: a 4han30fu or 3han60fu hand (base 1920) rounds up to a full mangan
  if (kiriageMangan && base >= 1920 && base < 2000) base = 2000;
  if (base > 2000) base = 2000; // 4han40fu+/3han70fu+ etc already reach mangan by formula
  return base;
}

export interface Payment {
  /** playerIndex -> signed point delta (negative = pays, positive = receives). */
  deltas: Record<number, number>;
}

export interface ScoreResult {
  base: number;
  totalPoints: number;
  payments: Payment;
}

/**
 * Computes point movements for a win. `winner`/`dealer` are seat indices (0/1/2).
 * `ronFrom` is the discarder's seat index for a ron win, or undefined for tsumo.
 * `honba` is the current honba count; each one adds rules.honbaValue total to the payout,
 * paid entirely by the discarder on ron or split evenly between the two payers on tsumo.
 */
export function computeScore(opts: {
  han: number;
  fu: number;
  yakumanUnits: number;
  winner: number;
  dealer: number;
  isTsumo: boolean;
  ronFrom?: number;
  honba?: number;
  playerCount: 3;
  rules: RuleConfig;
}): ScoreResult {
  const honba = opts.honba ?? 0;
  const base = basePoints(opts.han, opts.fu, opts.yakumanUnits, opts.rules.kiriageMangan);
  const isDealer = opts.winner === opts.dealer;
  const deltas: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
  const honbaTotal = honba * opts.rules.honbaValue;

  if (!opts.isTsumo) {
    const payer = opts.ronFrom!;
    const amount = roundUp100(base * (isDealer ? 6 : 4)) + honbaTotal;
    deltas[payer]! -= amount;
    deltas[opts.winner]! += amount;
    return { base, totalPoints: amount, payments: { deltas } };
  }

  const honbaEach = honba * (opts.rules.honbaValue / 2);
  const others = [0, 1, 2].filter((p) => p !== opts.winner);
  if (isDealer) {
    const each = roundUp100(base * 2) + honbaEach;
    for (const p of others) {
      deltas[p]! -= each;
      deltas[opts.winner]! += each;
    }
    return { base, totalPoints: each * 2, payments: { deltas } };
  }

  // non-dealer tsumo
  const dealerSeat = opts.dealer;
  const otherNonDealer = others.find((p) => p !== dealerSeat)!;
  let dealerShare: number;
  let otherShare: number;
  if (opts.rules.tsumoSplitEven) {
    dealerShare = roundUp100(base * 2);
    otherShare = roundUp100(base * 2);
  } else {
    dealerShare = roundUp100(base * 2);
    otherShare = roundUp100(base * 1);
  }
  dealerShare += honbaEach;
  otherShare += honbaEach;
  deltas[dealerSeat]! -= dealerShare;
  deltas[otherNonDealer]! -= otherShare;
  deltas[opts.winner]! += dealerShare + otherShare;
  return { base, totalPoints: dealerShare + otherShare, payments: { deltas } };
}
