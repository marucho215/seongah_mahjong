import { describe, it, expect } from "vitest";
import { Hand } from "../src/core/Hand.js";
import { Wall } from "../src/core/Wall.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import type { Tile } from "../src/core/tiles.js";
import { chooseDiscard, pickNonRedRepresentative, computeOwnWinningTiles } from "../src/ai/simpleAI.js";

let nextId = 30000;
function t(kind: string, isRed = false): Tile {
  const suit = kind[0] as "m" | "p" | "s" | "z";
  const rank = Number(kind.slice(1));
  return { id: nextId++, kind, suit, rank, isRed };
}

// ---------------------------------------------------------------------------
// 4. Red-five discard handling
// ---------------------------------------------------------------------------
describe("red-five preservation", () => {
  it("prefers the ordinary copy when both a red and ordinary five are in hand", () => {
    const hand = new Hand();
    const normal = t("p5", false);
    const red = t("p5", true);
    hand.dealIn([normal, red, t("m1")]);
    const picked = pickNonRedRepresentative(hand, "p5");
    expect(picked.id).toBe(normal.id);
    expect(picked.isRed).toBe(false);
  });

  it("falls back to the red copy when it's the only one of that kind in hand", () => {
    const hand = new Hand();
    const red = t("p5", true);
    hand.dealIn([red, t("m1")]);
    const picked = pickNonRedRepresentative(hand, "p5");
    expect(picked.id).toBe(red.id);
  });

  it("shanten treats a red five identically to an ordinary one (only discard preference differs)", () => {
    // two hands differing only in whether the 5 is red - both should reach the same shanten
    const withRed = new Hand();
    withRed.dealIn([t("m1"), t("m1"), t("m1"), t("p1"), t("p2"), t("p3"), t("p4"), t("p5", true), t("p6"), t("s7"), t("s8"), t("s9"), t("z1")]);
    const withNormal = new Hand();
    withNormal.dealIn([t("m1"), t("m1"), t("m1"), t("p1"), t("p2"), t("p3"), t("p4"), t("p5", false), t("p6"), t("s7"), t("s8"), t("s9"), t("z1")]);
    const winnersRed = computeOwnWinningTiles(withRed, DEFAULT_SANMA_RULES);
    const winnersNormal = computeOwnWinningTiles(withNormal, DEFAULT_SANMA_RULES);
    expect(winnersRed).toEqual(winnersNormal);
  });
});

// ---------------------------------------------------------------------------
// 8. AI information boundary
// ---------------------------------------------------------------------------
describe("AI information boundary", () => {
  it("chooseDiscard's input shape only carries this player's own hand and opponents' public rivers", () => {
    // structural guarantee: DiscardChoiceContext = { hand: Hand; riichiOpponentDiscardKinds: TileKind[][] }.
    // hand.concealed is this player's own tiles; riichiOpponentDiscardKinds is built exclusively
    // from other players' `discards` (already-public river tiles), never their concealed hands,
    // the Wall, or unrevealed dora indicators - see GameState.ts's chooseDiscard call sites.
    const hand = new Hand();
    hand.dealIn([t("m1"), t("m1"), t("m1"), t("p1"), t("p2"), t("p3"), t("p4"), t("p5"), t("p6"), t("s7"), t("s8"), t("s9"), t("z1"), t("z7")]);
    const id = chooseDiscard({ hand, riichiOpponentDiscardKinds: [] });
    expect(hand.concealed.some((c) => c.id === id)).toBe(true);
  });

  it("never returns a tile id that isn't physically in the given hand, across many real dealt hands", () => {
    for (let i = 0; i < 100; i++) {
      const wall = new Wall(DEFAULT_SANMA_RULES, `ai-boundary-${i}`);
      const [dealt] = wall.dealInitial(3, 13);
      const hand = new Hand();
      hand.dealIn(dealt!);
      hand.addDrawn(wall.drawTile());
      const id = chooseDiscard({ hand, riichiOpponentDiscardKinds: [] });
      expect(hand.concealed.some((c) => c.id === id)).toBe(true);
    }
  });

  it("the engine never trusts a returned action blindly - Hand rejects a discard id it doesn't hold", () => {
    // even if an AI (this one or a future, less careful one) returned a tile id belonging
    // to another player's hand or a stale/already-discarded tile, Hand.discardById is the
    // sole mutation path and enforces physical possession itself.
    const hand = new Hand();
    hand.dealIn([t("m1"), t("p1")]);
    const foreignTileId = 999999;
    expect(() => hand.discardById(foreignTileId, { tsumogiri: false })).toThrow();
  });

  it("computeOwnWinningTiles is a pure function of this hand's own tiles and the rules - no hidden state", () => {
    const handA = new Hand();
    handA.dealIn([t("m1"), t("m1"), t("m1"), t("p1"), t("p2"), t("p3"), t("p4"), t("p5"), t("p6"), t("s7"), t("s8"), t("z1"), t("z1")]);
    const handB = new Hand();
    handB.dealIn(handA.concealed.map((tile) => ({ ...tile, id: tile.id + 100000 }))); // same shape, different ids
    expect(computeOwnWinningTiles(handA, DEFAULT_SANMA_RULES)).toEqual(computeOwnWinningTiles(handB, DEFAULT_SANMA_RULES));
  });
});
