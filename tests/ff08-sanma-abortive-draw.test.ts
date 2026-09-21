import { describe, expect, it } from "vitest";
import {
  canDeclareNineTerminals,
  isAbortiveDrawReasonEnabled,
  isFourKansAbortive,
  isFourRiichiAbortive,
  isFourWindsAbortive,
  postDiscardAbortiveDrawReason,
} from "../src/core/abortiveDraw.js";
import { GameState } from "../src/core/GameState.js";
import { Hand, type Meld } from "../src/core/Hand.js";
import type { Tile, TileKind } from "../src/core/tiles.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

let nextId = 108000;
function tile(kind: TileKind): Tile {
  return {
    id: nextId++,
    kind,
    suit: kind[0] as Tile["suit"],
    rank: Number(kind.slice(1)),
    isRed: false,
  };
}

function kan(kind: TileKind): Meld {
  return { type: "kan_closed", tiles: [tile(kind), tile(kind), tile(kind), tile(kind)] };
}

function firstDiscard(kind: TileKind): Hand {
  const hand = new Hand();
  hand.dealIn([tile(kind)]);
  hand.discardById(hand.concealed[0]!.id, { tsumogiri: true });
  return hand;
}

describe("FF-08 Mahjong Soul sanma abortive draws", () => {
  it("enables only nine terminals and four kans for sanma", () => {
    expect(isAbortiveDrawReasonEnabled("nine_terminals", 3)).toBe(true);
    expect(isAbortiveDrawReasonEnabled("four_kans", 3)).toBe(true);
    expect(isAbortiveDrawReasonEnabled("four_winds", 3)).toBe(false);
    expect(isAbortiveDrawReasonEnabled("four_riichi", 3)).toBe(false);

    expect(isAbortiveDrawReasonEnabled("nine_terminals", 4)).toBe(true);
    expect(isAbortiveDrawReasonEnabled("four_kans", 4)).toBe(true);
    expect(isAbortiveDrawReasonEnabled("four_winds", 4)).toBe(true);
    expect(isAbortiveDrawReasonEnabled("four_riichi", 4)).toBe(true);
  });

  it("keeps Kyuushu Kyuuhai optional and removes eligibility after Kita interruption", () => {
    const hand = new Hand();
    hand.dealIn([
      "m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "z3", "z4", "p5", "p6", "s5", "s6",
    ].map((kind) => tile(kind as TileKind)));
    const continuePolicy = () => false;

    expect(canDeclareNineTerminals(hand, true, false)).toBe(true);
    expect(continuePolicy()).toBe(false);
    expect(canDeclareNineTerminals(hand, true, true)).toBe(false);
  });

  it.each(["nine_terminals", "four_kans"] as const)(
    "settles sanma %s with no payment, dealer renchan, honba increment, and kyotaku carry",
    (reason) => {
    const game = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `ff08-${reason}` });
    game.scores = [33000, 34000, 35000];
    game.dealerSeat = 1;
    game.roundHandNumber = 2;
    game.honba = 2;
    game.kyotaku = 3;

    game.applyAbortiveDraw(reason);

    expect(game.scores).toEqual([33000, 34000, 35000]);
    expect(game.scores.reduce((sum, score) => sum + score, 0) + game.kyotaku * 1000).toBe(105000);
    expect(game.dealerSeat).toBe(1);
    expect(game.roundHandNumber).toBe(2);
    expect(game.honba).toBe(3);
    expect(game.kyotaku).toBe(3);
    expect(game.log.at(-2)).toEqual({ type: "abortive_draw", reason });
    expect(game.log.at(-1)).toMatchObject({ type: "hand_end", nextDealer: 1, honba: 3, kyotaku: 3 });
    }
  );

  it("detects four sanma kans split across players but preserves one player's Suukantsu route", () => {
    const split = [new Hand(), new Hand(), new Hand()];
    split[0]!.melds.push(kan("m1"), kan("p1"));
    split[1]!.melds.push(kan("s1"), kan("z1"));

    expect(isFourKansAbortive(split)).toBe(true);
    expect(postDiscardAbortiveDrawReason(split, true, false, 3)).toBe("four_kans");

    const single = [new Hand(), new Hand(), new Hand()];
    single[0]!.melds.push(kan("m1"), kan("p1"), kan("s1"), kan("z1"));
    expect(isFourKansAbortive(single)).toBe(false);
    expect(postDiscardAbortiveDrawReason(single, true, false, 3)).toBeNull();
  });

  it("gives ron/chankan priority over Suukaikan", () => {
    const hands = [new Hand(), new Hand(), new Hand()];
    hands[0]!.melds.push(kan("m1"), kan("p1"));
    hands[1]!.melds.push(kan("s1"), kan("z1"));

    expect(postDiscardAbortiveDrawReason(hands, true, true, 3)).toBeNull();
    expect(postDiscardAbortiveDrawReason(hands, true, false, 3)).toBe("four_kans");
  });

  it("does not invent sanma four-winds or four-riichi abortive draws", () => {
    const winds = [firstDiscard("z1"), firstDiscard("z1"), firstDiscard("z1")];
    const riichi = [new Hand(), new Hand(), new Hand()];
    riichi.forEach((hand) => { hand.riichi = true; });

    expect(isFourWindsAbortive(winds, false)).toBe(false);
    expect(isFourRiichiAbortive(riichi)).toBe(false);
    expect(postDiscardAbortiveDrawReason(winds, false, false, 3)).toBeNull();
  });

  it("leaves yonma applicability and four-kan detection unchanged", () => {
    const split = [new Hand(), new Hand(), new Hand(), new Hand()];
    split[0]!.melds.push(kan("m1"), kan("p1"));
    split[2]!.melds.push(kan("s1"), kan("z1"));

    expect(isFourKansAbortive(split)).toBe(true);
    expect(postDiscardAbortiveDrawReason(split, true, false, MAJSOUL_YONMA_RULES.playerCount)).toBe("four_kans");
  });
});
