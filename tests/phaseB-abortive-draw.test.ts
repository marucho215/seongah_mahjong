import { describe, expect, it } from "vitest";
import {
  canDeclareNineTerminals,
  isFourKansAbortive,
  isFourRiichiAbortive,
  isFourWindsAbortive,
  postDiscardAbortiveDrawReason,
  type AbortiveDrawReason,
} from "../src/core/abortiveDraw.js";
import { GameState } from "../src/core/GameState.js";
import { Hand, type Meld } from "../src/core/Hand.js";
import type { Tile } from "../src/core/tiles.js";
import { MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

let nextId = 990000;
function tile(kind: string): Tile {
  return { id: nextId++, kind, suit: kind[0] as "m" | "p" | "s" | "z", rank: Number(kind.slice(1)), isRed: false };
}

function discardedHand(kind: string): Hand {
  const hand = new Hand();
  hand.dealIn([tile(kind)]);
  hand.discardById(hand.concealed[0]!.id, { tsumogiri: true });
  return hand;
}

function kan(kind: string): Meld {
  return { type: "kan_closed", tiles: [tile(kind), tile(kind), tile(kind), tile(kind)] };
}

describe("Phase B abortive-draw conditions", () => {
  it("recognizes optional nine terminals only on an uninterrupted first draw", () => {
    const hand = new Hand();
    hand.dealIn(["m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "z3", "p5", "p6", "s5", "s6", "z5"].map(tile));
    expect(canDeclareNineTerminals(hand, true, false)).toBe(true);
    expect(canDeclareNineTerminals(hand, false, false)).toBe(false);
    expect(canDeclareNineTerminals(hand, true, true)).toBe(false);

    const duplicateKinds = new Hand();
    duplicateKinds.dealIn(["m1", "m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "p5", "p6", "p7", "s5", "s6"].map(tile));
    expect(canDeclareNineTerminals(duplicateKinds, true, false)).toBe(false);
  });

  it("recognizes four identical first wind discards without an interruption", () => {
    const hands = [0, 1, 2, 3].map(() => discardedHand("z3"));
    expect(isFourWindsAbortive(hands, false)).toBe(true);
    expect(isFourWindsAbortive(hands, true)).toBe(false);
    hands[3] = discardedHand("z2");
    expect(isFourWindsAbortive(hands, false)).toBe(false);

    const dragons = [0, 1, 2, 3].map(() => discardedHand("z5"));
    expect(isFourWindsAbortive(dragons, false)).toBe(false);
  });

  it("recognizes four established riichi players", () => {
    const hands = [0, 1, 2, 3].map(() => new Hand());
    hands.forEach((hand) => { hand.riichi = true; });
    expect(isFourRiichiAbortive(hands)).toBe(true);
    hands[3]!.riichi = false;
    expect(isFourRiichiAbortive(hands)).toBe(false);
  });

  it("recognizes four kans split among players but preserves a single player's Suukantsu route", () => {
    const split = [0, 1, 2, 3].map(() => new Hand());
    split[0]!.melds.push(kan("m1"), kan("p1"));
    split[1]!.melds.push(kan("s1"), kan("z1"));
    expect(isFourKansAbortive(split)).toBe(true);

    split[1]!.melds.pop();
    expect(isFourKansAbortive(split)).toBe(false);

    const single = [0, 1, 2, 3].map(() => new Hand());
    single[0]!.melds.push(kan("m1"), kan("p1"), kan("s1"), kan("z1"));
    expect(isFourKansAbortive(single)).toBe(false);
  });

  it("gives ron priority over a post-discard abortive draw", () => {
    const hands = [0, 1, 2, 3].map(() => discardedHand("z1"));
    expect(postDiscardAbortiveDrawReason(hands, false, true)).toBeNull();
    expect(postDiscardAbortiveDrawReason(hands, false, false)).toBe("four_winds");
  });
});

describe("Phase B abortive-draw settlement", () => {
  const reasons: AbortiveDrawReason[] = ["nine_terminals", "four_winds", "four_riichi", "four_kans"];

  it.each(reasons)("settles %s through the common no-payment transition", (reason) => {
    const game = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "abortive-settlement" });
    game.scores = [22000, 21000, 31000, 22000];
    game.dealerSeat = 2;
    game.roundHandNumber = 4;
    game.honba = 3;
    game.kyotaku = 4;

    game.applyAbortiveDraw(reason);

    expect(game.scores).toEqual([22000, 21000, 31000, 22000]);
    expect(game.scores.reduce((sum, score) => sum + score, 0) + game.kyotaku * 1000).toBe(100000);
    expect(game.dealerSeat).toBe(2);
    expect(game.roundHandNumber).toBe(4);
    expect(game.honba).toBe(4);
    expect(game.kyotaku).toBe(4);
    expect(game.handIndex).toBe(1);
    expect(game.log.at(-2)).toEqual({ type: "abortive_draw", reason });
    expect(game.log.at(-1)).toMatchObject({ type: "hand_end", nextDealer: 2, honba: 4, kyotaku: 4 });
    expect(game.isGameOver()).toBe(false);
  });
});
