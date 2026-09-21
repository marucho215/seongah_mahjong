import { describe, expect, it } from "vitest";
import { CharacterAI, type CharacterDecisionContext } from "../src/ai/characterAI.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import { chooseDiscard } from "../src/ai/simpleAI.js";
import { applySelectedDiscardResponse, type DiscardResponseApplicationState } from "../src/core/applyDiscardResponse.js";
import { chiCandidatesForDiscard } from "../src/core/discardResponses.js";
import { Hand } from "../src/core/Hand.js";
import type { Tile, TileKind } from "../src/core/tiles.js";
import { Wall } from "../src/core/Wall.js";
import { forbiddenDiscardsAfterChi } from "../src/rules/kuikae.js";
import { cloneRuleConfig, DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

function tile(id: number, kind: TileKind): Tile {
  return { id, kind, suit: kind[0] as Tile["suit"], rank: Number(kind.slice(1)), isRed: false };
}

function state(seed: string, kuikae = true): DiscardResponseApplicationState {
  const rules = cloneRuleConfig(MAJSOUL_YONMA_RULES);
  rules.kuikae = kuikae;
  return {
    rules,
    hands: [new Hand(), new Hand(), new Hand(), new Hand()],
    wall: new Wall(rules, seed),
    currentPlayer: 0,
    ippatsuEligible: [false, false, false, false],
    appliedDiscardIds: new Set<number>(),
  };
}

function discardedFrom(hand: Hand, value: Tile): Tile {
  hand.dealIn([value]);
  return hand.discardById(value.id, { tsumogiri: false });
}

function characterContext(): CharacterDecisionContext {
  return {
    rules: MAJSOUL_YONMA_RULES,
    riichiOpponentDiscardKinds: [],
    doraIndicatorKinds: [],
    visibleTileKinds: [],
    seatWind: 2,
    roundWind: 1,
    wallRemainingLive: 40,
    ownScore: 25000,
    opponentScores: [25000, 25000, 25000],
    opponentSeats: [0, 2, 3],
    riichiOpponentSeats: [],
    isLastHandOfGame: false,
    isDealer: false,
  };
}

describe("FF-01 Mahjong Soul yonma kuikae", () => {
  it("derives same-kind and opposite-end restrictions from the two consumed tiles", () => {
    expect(MAJSOUL_YONMA_RULES.kuikae).toBe(true);
    expect(forbiddenDiscardsAfterChi(
      MAJSOUL_YONMA_RULES,
      { type: "chi", seat: 1, sequence: ["m3", "m4", "m5"], consumedKinds: ["m3", "m4"] },
      "m5"
    )).toEqual(["m5", "m2"]);
    expect(forbiddenDiscardsAfterChi(
      MAJSOUL_YONMA_RULES,
      { type: "chi", seat: 1, sequence: ["m3", "m4", "m5"], consumedKinds: ["m3", "m5"] },
      "m4"
    )).toEqual(["m4"]);
    expect(forbiddenDiscardsAfterChi(
      MAJSOUL_YONMA_RULES,
      { type: "chi", seat: 1, sequence: ["m1", "m2", "m3"], consumedKinds: ["m1", "m2"] },
      "m3"
    )).toEqual(["m3"]);
  });

  it("applies the restriction only to the immediate discard after the selected chi", () => {
    const fixture = state("ff01-selected-chi");
    fixture.hands[1]!.dealIn([tile(101, "m4"), tile(102, "m5"), tile(103, "m3"), tile(104, "m6"), tile(105, "p9")]);
    const discarded = discardedFrom(fixture.hands[0]!, tile(100, "m3"));
    const applied = applySelectedDiscardResponse(
      fixture,
      { type: "chi", seat: 1, sequence: ["m3", "m4", "m5"], consumedKinds: ["m4", "m5"] },
      0,
      discarded
    );

    expect(applied.forbiddenDiscardKinds).toEqual(["m3", "m6"]);
    const simpleChoice = chooseDiscard({
      hand: fixture.hands[1]!,
      riichiOpponentDiscardKinds: [],
      forbiddenDiscardKinds: applied.forbiddenDiscardKinds,
    });
    expect(fixture.hands[1]!.concealed.find((entry) => entry.id === simpleChoice)?.kind).toBe("p9");

    const characterChoice = new CharacterAI(getCharacterProfile("seiyakouri"), "ff01-character")
      .chooseDiscard(fixture.hands[1]!, characterContext(), applied.forbiddenDiscardKinds);
    expect(fixture.hands[1]!.concealed.find((entry) => entry.id === characterChoice)?.kind).toBe("p9");

    const nextTurn = new Hand();
    nextTurn.dealIn([tile(200, "m3")]);
    expect(chooseDiscard({ hand: nextTurn, riichiOpponentDiscardKinds: [] })).toBe(200);
  });

  it("keeps kuikae disabled configurations, pon, daiminkan, and sanma unaffected", () => {
    const disabled = state("ff01-disabled", false);
    disabled.hands[1]!.dealIn([tile(301, "m4"), tile(302, "m5"), tile(303, "m3")]);
    const chiDiscard = discardedFrom(disabled.hands[0]!, tile(300, "m3"));
    const chi = applySelectedDiscardResponse(
      disabled,
      { type: "chi", seat: 1, sequence: ["m3", "m4", "m5"], consumedKinds: ["m4", "m5"] },
      0,
      chiDiscard
    );
    expect(chi.forbiddenDiscardKinds).toEqual([]);

    const ponState = state("ff01-pon");
    ponState.hands[2]!.dealIn([tile(401, "p5"), tile(402, "p5"), tile(403, "p5")]);
    const ponDiscard = discardedFrom(ponState.hands[0]!, tile(400, "p5"));
    const pon = applySelectedDiscardResponse(ponState, { type: "pon", seat: 2, kind: "p5" }, 0, ponDiscard);
    expect(pon.forbiddenDiscardKinds).toEqual([]);

    const kanState = state("ff01-daiminkan");
    kanState.hands[3]!.dealIn([tile(501, "s7"), tile(502, "s7"), tile(503, "s7"), tile(504, "s7")]);
    const kanDiscard = discardedFrom(kanState.hands[0]!, tile(500, "s7"));
    const kan = applySelectedDiscardResponse(kanState, { type: "daiminkan", seat: 3, kind: "s7" }, 0, kanDiscard);
    expect(kan.forbiddenDiscardKinds).toEqual([]);

    expect(DEFAULT_SANMA_RULES.kuikae).toBe(false);
    expect(chiCandidatesForDiscard(DEFAULT_SANMA_RULES, 1, ["p2", "p3"], "p1")).toEqual([]);
  });
});
