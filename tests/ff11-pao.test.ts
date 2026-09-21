import { describe, expect, it } from "vitest";
import { applyDaiminkan, applyPon, applyShouminkan } from "../src/actions/calls.js";
import { Hand, type Meld } from "../src/core/Hand.js";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";
import {
  applyPaoSettlement,
  detectPaoLiabilityAfterOpenCall,
  recordPaoLiabilityAfterOpenCall,
} from "../src/rules/pao.js";
import { settleOrderedWinPayments } from "../src/rules/settlement.js";
import {
  DEFAULT_SANMA_RULES,
  MAJSOUL_YONMA_RULES,
  type RuleConfig,
} from "../src/rules/RuleConfig.js";
import { computeScore } from "../src/yaku/score.js";
import type { YakuHit } from "../src/yaku/types.js";

let nextId = 1;
function tile(kind: TileKind): Tile {
  const { suit, rank } = parseKind(kind);
  return { id: nextId++, kind, suit, rank, isRed: false };
}

function meld(type: Meld["type"], kind: TileKind, calledFrom?: number): Meld {
  const count = type.startsWith("kan") ? 4 : 3;
  return {
    type,
    tiles: Array.from({ length: count }, () => tile(kind)),
    ...(calledFrom === undefined ? {} : { calledFrom }),
  };
}

function makeOpenCall(hand: Hand, type: "pon" | "kan_open", kind: TileKind, source: number): void {
  const needed = type === "pon" ? 2 : 3;
  hand.dealIn(Array.from({ length: needed }, () => tile(kind)));
  const called = tile(kind);
  if (type === "pon") applyPon(hand, called, source);
  else applyDaiminkan(hand, called, source);
  recordPaoLiabilityAfterOpenCall(hand, type, kind, source);
}

function yakumanScore(input: {
  rules?: RuleConfig;
  winner?: number;
  dealer?: number;
  units?: number;
  isTsumo?: boolean;
  ronFrom?: number;
  honba?: number;
}) {
  const rules = input.rules ?? MAJSOUL_YONMA_RULES;
  return computeScore({
    han: (input.units ?? 1) * 13,
    fu: 0,
    yakumanUnits: input.units ?? 1,
    winner: input.winner ?? 1,
    dealer: input.dealer ?? 0,
    isTsumo: input.isTsumo ?? true,
    ronFrom: input.ronFrom,
    honba: input.honba ?? 0,
    playerCount: rules.playerCount,
    rules,
  });
}

function pao(input: {
  rules?: RuleConfig;
  yaku?: YakuHit[];
  units?: number;
  winner?: number;
  dealer?: number;
  isTsumo?: boolean;
  ronFrom?: number;
  honba?: number;
  liability?: { daisangen?: number; daisuushii?: number };
}) {
  const rules = input.rules ?? MAJSOUL_YONMA_RULES;
  const units = input.units ?? 1;
  const winner = input.winner ?? 1;
  const dealer = input.dealer ?? 0;
  const isTsumo = input.isTsumo ?? true;
  const honba = input.honba ?? 0;
  return applyPaoSettlement({
    score: yakumanScore({ rules, winner, dealer, units, isTsumo, ronFrom: input.ronFrom, honba }),
    yaku: input.yaku ?? [{ name: "Daisangen", han: 13 }],
    yakumanUnits: units,
    liability: input.liability ?? { daisangen: 2 },
    winner,
    dealer,
    isTsumo,
    ronFrom: input.ronFrom,
    honba,
    rules,
  });
}

describe("FF-11 Mahjong Soul Pao trigger", () => {
  it.each(["pon", "kan_open"] as const)("records the third open dragon group from %s", (callType) => {
    const hand = new Hand();
    hand.melds.push(meld("pon", "z5", 1), meld("kan_added", "z6", 2));
    makeOpenCall(hand, callType, "z7", 3);
    expect(hand.paoLiability).toEqual({ daisangen: 3 });
  });

  it.each(["pon", "kan_open"] as const)("records the fourth open wind group from %s", (callType) => {
    const hand = new Hand();
    hand.melds.push(meld("pon", "z1", 1), meld("kan_open", "z2", 2), meld("kan_added", "z3", 3));
    makeOpenCall(hand, callType, "z4", 2);
    expect(hand.paoLiability).toEqual({ daisuushii: 2 });
  });

  it("does not trigger from Shousuushii, concealed groups, ankan, shouminkan, or ordinary calls", () => {
    const shousuushii = new Hand();
    shousuushii.melds.push(meld("pon", "z1", 1), meld("pon", "z2", 2));
    makeOpenCall(shousuushii, "pon", "z3", 3);
    expect(shousuushii.paoLiability).toEqual({});

    const concealedPrerequisite = new Hand();
    concealedPrerequisite.melds.push(meld("pon", "z5", 1), meld("kan_closed", "z6"));
    makeOpenCall(concealedPrerequisite, "pon", "z7", 3);
    expect(concealedPrerequisite.paoLiability).toEqual({});
    expect(detectPaoLiabilityAfterOpenCall({ hand: concealedPrerequisite, callType: "kan_closed", calledKind: "z6" })).toBeNull();

    const added = new Hand();
    added.melds.push(meld("pon", "z5", 1), meld("pon", "z6", 2));
    added.dealIn([tile("z5")]);
    applyShouminkan(added, added.tilesOfKind("z5")[0]!.id);
    expect(detectPaoLiabilityAfterOpenCall({ hand: added, callType: "kan_added", calledKind: "z5" })).toBeNull();
    expect(detectPaoLiabilityAfterOpenCall({ hand: added, callType: "pon", calledKind: "p5" })).toBeNull();
  });

  it("starts every new hand without liability", () => {
    const hand = new Hand();
    hand.paoLiability.daisangen = 2;
    expect(new Hand().paoLiability).toEqual({});
  });
});

describe("FF-11 Mahjong Soul Pao payments", () => {
  it("makes the liable yonma seat fund the entire Daisangen tsumo portion", () => {
    expect(pao({}).score.payments.deltas).toEqual({ 0: 0, 1: 32000, 2: -32000, 3: 0 });
  });

  it("splits Daisangen ron between a different discarder and liable seat, or charges one shared seat fully", () => {
    expect(pao({ isTsumo: false, ronFrom: 3 }).score.payments.deltas).toEqual({
      0: 0, 1: 32000, 2: -16000, 3: -16000,
    });
    expect(pao({ isTsumo: false, ronFrom: 2 }).score.payments.deltas).toEqual({
      0: 0, 1: 32000, 2: -32000, 3: 0,
    });
  });

  it("uses the evaluator's Daisuushii multiplier and respects the double-yakuman toggle", () => {
    const double = pao({
      units: 2,
      yaku: [{ name: "Daisuushii", han: 26 }],
      liability: { daisuushii: 2 },
    });
    const singleRules = { ...MAJSOUL_YONMA_RULES, doubleYakumanEnabled: false };
    const single = pao({
      rules: singleRules,
      units: 1,
      yaku: [{ name: "Daisuushii", han: 13 }],
      liability: { daisuushii: 2 },
    });
    expect(double.score.payments.deltas).toEqual({ 0: 0, 1: 64000, 2: -64000, 3: 0 });
    expect(single.score.payments.deltas).toEqual({ 0: 0, 1: 32000, 2: -32000, 3: 0 });
  });

  it("redistributes only the covered unit in a composite yakuman", () => {
    const result = pao({
      units: 2,
      isTsumo: false,
      ronFrom: 3,
      yaku: [{ name: "Daisangen", han: 13 }, { name: "Tsuuiisou", han: 13 }],
    });
    expect(result.coveredYakumanUnits).toBe(1);
    expect(result.score.payments.deltas).toEqual({ 0: 0, 1: 64000, 2: -16000, 3: -48000 });
  });

  it("uses sanma tsumo-loss total for Pao tsumo and ordinary ron value for Pao ron", () => {
    const rules = DEFAULT_SANMA_RULES;
    expect(pao({ rules, winner: 1, dealer: 0 }).score.payments.deltas).toEqual({
      0: 0, 1: 24000, 2: -24000,
    });
    expect(pao({ rules, winner: 1, dealer: 0, isTsumo: false, ronFrom: 0, liability: { daisangen: 2 } }).score.payments.deltas).toEqual({
      0: -16000, 1: 32000, 2: -16000,
    });
  });

  it("keeps the ordinary sanma composite portion on its normal payer", () => {
    const result = pao({
      rules: DEFAULT_SANMA_RULES,
      winner: 1,
      dealer: 0,
      units: 2,
      isTsumo: true,
      yaku: [{ name: "Daisangen", han: 13 }, { name: "Tsuuiisou", han: 13 }],
      liability: { daisangen: 2 },
    });
    expect(result.score.payments.deltas).toEqual({ 0: -16000, 1: 48000, 2: -32000 });
  });

  it("charges all honba to the liable seat without involving kyotaku", () => {
    const result = pao({ isTsumo: false, ronFrom: 3, honba: 2 });
    expect(result.honbaPayer).toBe(2);
    expect(result.score.payments.deltas).toEqual({ 0: 0, 1: 32600, 2: -16600, 3: -16000 });
    expect(result.score.totalPoints).toBe(32600);
  });

  it("preserves closest-winner honba/kyotaku and applies Pao only to its winner in multi-ron", () => {
    const paoWinner = pao({ isTsumo: false, ronFrom: 0, winner: 1, liability: { daisangen: 3 }, honba: 1 });
    const ordinary = yakumanScore({ winner: 2, dealer: 0, isTsumo: false, ronFrom: 0, honba: 1 });
    const settlement = settleOrderedWinPayments(4, [
      { seat: 1, ronFrom: 0, score: paoWinner.score, honbaPayer: paoWinner.honbaPayer },
      { seat: 2, ronFrom: 0, score: ordinary },
    ], 1, 300, 2);

    expect(settlement.closestWinner).toBe(1);
    expect(settlement.combinedDeltas).toEqual({ 0: -48000, 1: 34300, 2: 32000, 3: -16300 });
    expect(Object.values(settlement.combinedDeltas).reduce((sum, delta) => sum + delta, 0)).toBe(2000);
  });

  it("does not apply liability without the matching evaluated yakuman", () => {
    const score = yakumanScore({ units: 1 });
    const result = applyPaoSettlement({
      score,
      yaku: [{ name: "Suukantsu", han: 13 }],
      yakumanUnits: 1,
      liability: { daisangen: 2 },
      winner: 1,
      dealer: 0,
      isTsumo: true,
      honba: 0,
      rules: MAJSOUL_YONMA_RULES,
    });
    expect(result.coveredYakumanUnits).toBe(0);
    expect(result.score).toBe(score);
  });
});
