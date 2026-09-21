import { describe, expect, it } from "vitest";
import { applyKita, canKita, chooseKitaAction } from "../src/actions/kita.js";
import { CharacterAI } from "../src/ai/characterAI.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import { shouldDeclareKita } from "../src/ai/simpleAI.js";
import { GameState } from "../src/core/GameState.js";
import { Hand } from "../src/core/Hand.js";
import type { Tile, TileKind } from "../src/core/tiles.js";
import { Wall } from "../src/core/Wall.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";

let nextId = 98000;
function tile(kind: TileKind): Tile {
  return { id: nextId++, kind, suit: kind[0] as Tile["suit"], rank: Number(kind.slice(1)), isRed: false };
}

function handWith(...kinds: TileKind[]): Hand {
  const hand = new Hand();
  hand.dealIn(kinds.map(tile));
  return hand;
}

describe("FF-06 optional non-riichi Kita", () => {
  it("keeps a legal North concealed when the actor passes, without replacement or state mutation", () => {
    const hand = handWith("z4", "p1", "p2");
    const wall = new Wall(DEFAULT_SANMA_RULES, "ff06-pass");
    const liveBefore = wall.remainingLiveCount();

    expect(canKita(hand, true)).toBe(true);
    expect(chooseKitaAction(hand, true, () => false)).toBe("pass");
    expect(hand.countOfKind("z4")).toBe(1);
    expect(hand.kitaTiles).toHaveLength(0);
    expect(wall.remainingLiveCount()).toBe(liveBefore);

    const north = hand.tilesOfKind("z4")[0]!;
    expect(hand.discardById(north.id, { tsumogiri: false }).kind).toBe("z4");
  });

  it("uses the existing extraction and replacement flow when Kita is selected", () => {
    const hand = handWith("z4", "p1", "p2");
    const wall = new Wall(DEFAULT_SANMA_RULES, "ff06-kita");
    const liveBefore = wall.remainingLiveCount();

    expect(chooseKitaAction(hand, true, () => true)).toBe("kita");
    applyKita(hand, hand.tilesOfKind("z4")[0]!.id);
    const replacement = wall.drawKitaReplacement();
    hand.addDrawn(replacement);

    expect(hand.countOfKind("z4")).toBe(replacement.kind === "z4" ? 1 : 0);
    expect(hand.kitaTiles).toHaveLength(1);
    expect(wall.remainingLiveCount()).toBe(liveBefore - 1);
  });

  it("asks again after each extraction and stops immediately when the next North is passed", () => {
    const hand = handWith("z4", "z4", "p1");
    const wall = new Wall(DEFAULT_SANMA_RULES, "ff06-two-norths");
    const decisions = [true, false];
    let calls = 0;
    let replacementWasNorth = false;

    while (
      wall.canDrawKitaReplacement() &&
      chooseKitaAction(hand, true, () => decisions[calls++] ?? false) === "kita"
    ) {
      applyKita(hand, hand.tilesOfKind("z4")[0]!.id);
      const replacement = wall.drawKitaReplacement();
      replacementWasNorth = replacement.kind === "z4";
      hand.addDrawn(replacement);
    }

    expect(calls).toBe(2);
    expect(hand.kitaTiles).toHaveLength(1);
    expect(hand.countOfKind("z4")).toBe(replacementWasNorth ? 2 : 1);
    expect(chooseKitaAction(hand, true, () => true)).toBe("kita");
  });

  it("routes SimpleAI and CharacterAI through deterministic Kita decisions without RNG", () => {
    const hand = handWith("z4");
    const character = new CharacterAI(getCharacterProfile("jegalmina"), "ff06-character");
    const simpleGame = new GameState({
      rules: DEFAULT_SANMA_RULES,
      seed: "ff06-simple-pass",
      kitaDecisionPolicy: () => false,
    });
    const characterGame = new GameState({
      rules: DEFAULT_SANMA_RULES,
      seed: "ff06-character-pass",
      characterProfiles: [getCharacterProfile("jegalmina"), null, null],
      kitaDecisionPolicy: () => false,
    });

    expect(shouldDeclareKita()).toBe(true);
    expect(character.shouldDeclareKita(hand, {} as never)).toBe(true);
    expect(simpleGame.kitaDecisionPolicy?.(0, hand, 0)).toBe(false);
    expect(characterGame.kitaDecisionPolicy?.(0, hand, 0)).toBe(false);
    expect(chooseKitaAction(hand, true, () => false)).toBe("pass");
    expect(chooseKitaAction(hand, false, () => true)).toBe("unavailable");
  });
});
