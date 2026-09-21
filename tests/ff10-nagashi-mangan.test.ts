import { describe, expect, it } from "vitest";
import { Hand, type Meld } from "../src/core/Hand.js";
import { GameState } from "../src/core/GameState.js";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";
import { computeRoundProgression } from "../src/core/roundProgression.js";
import {
  calculateNagashiManganPayments,
  findNagashiManganSeats,
  settleExhaustiveDraw,
  shouldDealerContinue,
} from "../src/rules/settlement.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

let nextTileId = 1;
function tile(kind: TileKind): Tile {
  const { suit, rank } = parseKind(kind);
  return { id: nextTileId++, kind, suit, rank, isRed: false };
}

function discard(hand: Hand, kind: TileKind, calledAway = false): void {
  const value = tile(kind);
  hand.addDrawn(value);
  hand.discardById(value.id, { tsumogiri: true });
  if (calledAway) hand.markDiscardCalledAway(value.id);
}

function hands(count: number): Hand[] {
  return Array.from({ length: count }, () => new Hand());
}

function waits(count: number, tenpaiSeats: readonly number[] = []): TileKind[][] {
  return Array.from({ length: count }, (_, seat) => tenpaiSeats.includes(seat) ? ["p1"] : []);
}

describe("FF-10 Mahjong Soul Nagashi Mangan", () => {
  it("requires a non-empty unclaimed terminal/honor-only river", () => {
    const state = hands(4);
    discard(state[0]!, "m1");
    discard(state[0]!, "z7");
    discard(state[1]!, "m1");
    discard(state[1]!, "p5");
    discard(state[2]!, "s9", true);

    expect(findNagashiManganSeats(state)).toEqual([0]);
    expect(findNagashiManganSeats(hands(4))).toEqual([]);
  });

  it("does not invalidate Nagashi for the player's own open call, ankan, or Kita", () => {
    const state = hands(4);
    discard(state[0]!, "m9");
    discard(state[0]!, "z1");
    const openPon: Meld = {
      type: "pon",
      tiles: [tile("p5"), tile("p5"), tile("p5")],
      calledFrom: 1,
    };
    const ankan: Meld = {
      type: "kan_closed",
      tiles: [tile("s3"), tile("s3"), tile("s3"), tile("s3")],
    };
    state[0]!.melds.push(openPon, ankan);
    state[0]!.kitaTiles.push(tile("z4"));

    expect(findNagashiManganSeats(state)).toEqual([0]);
  });

  it("replaces ordinary noten payment at a normal exhaustive draw", () => {
    const state = hands(4);
    discard(state[1]!, "m1");
    discard(state[1]!, "z5");
    const result = settleExhaustiveDraw({
      rules: MAJSOUL_YONMA_RULES,
      dealerSeat: 0,
      hands: state,
      winningTilesBySeat: waits(4, [0]),
    });

    expect(result.tenpaiPlayers).toEqual([0]);
    expect(result.nagashiManganPlayers).toEqual([1]);
    expect(result.deltas).toEqual({ 0: -4000, 1: 8000, 2: -2000, 3: -2000 });
    expect(result.deltas).not.toEqual({ 0: 3000, 1: -1000, 2: -1000, 3: -1000 });
  });

  it("retains ordinary noten payment when nobody qualifies", () => {
    const result = settleExhaustiveDraw({
      rules: MAJSOUL_YONMA_RULES,
      dealerSeat: 0,
      hands: hands(4),
      winningTilesBySeat: waits(4, [0]),
    });
    expect(result.nagashiManganPlayers).toEqual([]);
    expect(result.deltas).toEqual({ 0: 3000, 1: -1000, 2: -1000, 3: -1000 });
  });

  it("uses exact yonma dealer and non-dealer mangan-tsumo payments", () => {
    expect(calculateNagashiManganPayments(MAJSOUL_YONMA_RULES, 0, [0])).toEqual({
      0: 12000, 1: -4000, 2: -4000, 3: -4000,
    });
    expect(calculateNagashiManganPayments(MAJSOUL_YONMA_RULES, 0, [1])).toEqual({
      0: -4000, 1: 8000, 2: -2000, 3: -2000,
    });
  });

  it("uses the existing Mahjong Soul sanma tsumo-loss payments", () => {
    expect(calculateNagashiManganPayments(DEFAULT_SANMA_RULES, 0, [0])).toEqual({
      0: 8000, 1: -4000, 2: -4000,
    });
    expect(calculateNagashiManganPayments(DEFAULT_SANMA_RULES, 0, [1])).toEqual({
      0: -4000, 1: 6000, 2: -2000,
    });
  });

  it("nets every independent payment when multiple players qualify", () => {
    const deltas = calculateNagashiManganPayments(MAJSOUL_YONMA_RULES, 0, [0, 1]);
    expect(deltas).toEqual({ 0: 8000, 1: 4000, 2: -6000, 3: -6000 });
    expect(Object.values(deltas).reduce((sum, delta) => sum + delta, 0)).toBe(0);
  });

  it("bases dealer continuation on actual tenpai, not the Nagashi recipient", () => {
    expect(shouldDealerContinue({
      dealerSeat: 0,
      isExhaustiveDraw: true,
      tenpaiPlayers: [1],
      renchanOnDealerWin: true,
      renchanOnDealerTenpaiDraw: true,
    })).toBe(false);
    expect(shouldDealerContinue({
      dealerSeat: 0,
      isExhaustiveDraw: true,
      tenpaiPlayers: [0],
      renchanOnDealerWin: true,
      renchanOnDealerTenpaiDraw: true,
    })).toBe(true);
  });

  it("keeps draw honba progression and leaves kyotaku outside Nagashi settlement", () => {
    const progression = computeRoundProgression({
      rules: DEFAULT_SANMA_RULES,
      scores: [35000, 35000, 35000],
      dealerSeat: 0,
      roundWind: 1,
      roundHandNumber: 1,
      honba: 2,
      dealerRepeats: false,
      isExhaustiveDraw: true,
      allowDealerEnd: true,
    });
    expect(progression.nextHonba).toBe(3);
    expect(calculateNagashiManganPayments(DEFAULT_SANMA_RULES, 0, [1])).toEqual({
      0: -4000, 1: 6000, 2: -2000,
    });
  });

  it.each(["nine_terminals", "four_kans"] as const)(
    "does not run normal exhaustive/Nagashi settlement for abortive draw %s",
    (reason) => {
      const game = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `ff10-abortive-${reason}` });
      game.kyotaku = 2;
      const scoresBefore = [...game.scores];
      game.applyAbortiveDraw(reason);

      expect(game.log.some((event) => event.type === "exhaustive_draw")).toBe(false);
      expect(game.log).toContainEqual({ type: "abortive_draw", reason });
      expect(game.scores).toEqual(scoresBefore);
      expect(game.kyotaku).toBe(2);
    }
  );

  it("applies existing post-settlement tobi semantics: negative busts, exact zero survives", () => {
    const negative = computeRoundProgression({
      rules: DEFAULT_SANMA_RULES,
      scores: [-100, 65100, 40000],
      dealerSeat: 0,
      roundWind: 1,
      roundHandNumber: 1,
      honba: 0,
      dealerRepeats: false,
      isExhaustiveDraw: true,
      allowDealerEnd: true,
    });
    const zero = computeRoundProgression({
      rules: DEFAULT_SANMA_RULES,
      scores: [0, 65000, 40000],
      dealerSeat: 0,
      roundWind: 1,
      roundHandNumber: 1,
      honba: 0,
      dealerRepeats: false,
      isExhaustiveDraw: true,
      allowDealerEnd: true,
    });
    expect(negative.tobiTriggered).toBe(true);
    expect(zero.tobiTriggered).toBe(false);
  });
});
