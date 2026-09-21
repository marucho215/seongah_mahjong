import { describe, expect, it } from "vitest";
import { canAnkan } from "../src/actions/calls.js";
import { canRiichiAnkan, riichiWaitSignature } from "../src/actions/riichiAnkan.js";
import { Hand, type Meld } from "../src/core/Hand.js";
import type { Tile, TileKind } from "../src/core/tiles.js";
import { MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

let nextId = 80000;
function tile(kind: TileKind): Tile {
  return {
    id: nextId++,
    kind,
    suit: kind[0] as Tile["suit"],
    rank: Number(kind.slice(1)),
    isRed: false,
  };
}

function riichiHand(frozenKinds: TileKind[], drawnKind: TileKind): { hand: Hand; drawn: Tile } {
  const hand = new Hand();
  hand.dealIn(frozenKinds.map(tile));
  hand.riichi = true;
  const drawn = tile(drawnKind);
  hand.addDrawn(drawn);
  return { hand, drawn };
}

describe("FF-03 Mahjong Soul post-riichi ankan legality", () => {
  it("allows the just-drawn fourth tile when wait kinds and counts are unchanged", () => {
    const { hand, drawn } = riichiHand(
      ["z5", "z5", "z5", "p1", "p2", "p3", "p4", "p5", "p6", "s1", "s2", "s3", "s9"],
      "z5"
    );

    expect(canRiichiAnkan(hand, "z5", drawn, MAJSOUL_YONMA_RULES)).toBe(true);
  });

  it("rejects a drawn-tile kan that removes one of the original wait kinds", () => {
    // 3335666p111456s waits on 4p/5p/7p. Kanning the drawn 6p removes the 7p wait.
    const { hand, drawn } = riichiHand(
      ["p3", "p3", "p3", "p5", "p6", "p6", "p6", "s1", "s1", "s1", "s4", "s5", "s6"],
      "p6"
    );

    expect(canRiichiAnkan(hand, "p6", drawn, MAJSOUL_YONMA_RULES)).toBe(false);
  });

  it("rejects an unchanged wait kind whose theoretical remaining-copy count changes", () => {
    // Both shapes wait on 1p/4p, but the kan changes only the owned 1p count
    // from three to four; the wait-kind set itself stays unchanged.
    const { hand, drawn } = riichiHand(
      ["p1", "p1", "p1", "p2", "p3", "p4", "p4", "s1", "s2", "s3", "s7", "s8", "s9"],
      "p1"
    );
    const beforeConcealed = hand.concealed.filter((held) => held.id !== drawn.id);
    const quadTiles = hand.tilesOfKind("p1");
    const virtualKan: Meld = { type: "kan_closed", tiles: quadTiles };
    const afterConcealed = hand.concealed.filter((held) => held.kind !== "p1");

    const before = riichiWaitSignature(beforeConcealed, [], [], MAJSOUL_YONMA_RULES);
    const after = riichiWaitSignature(afterConcealed, [virtualKan], [], MAJSOUL_YONMA_RULES);

    expect(before).toEqual([
      { kind: "p1", remainingCopies: 1 },
      { kind: "p4", remainingCopies: 2 },
    ]);
    expect(after).toEqual([
      { kind: "p1", remainingCopies: 0 },
      { kind: "p4", remainingCopies: 2 },
    ]);
    expect(before.map((entry) => entry.kind)).toEqual(after.map((entry) => entry.kind));
    expect(before).not.toEqual(after);
    expect(canRiichiAnkan(hand, "p1", drawn, MAJSOUL_YONMA_RULES)).toBe(false);
  });

  it("rejects okuri-kan by requiring the physical current draw in the quad", () => {
    const { hand, drawn } = riichiHand(
      ["z5", "z5", "z5", "z5", "p1", "p2", "p3", "p4", "p5", "p6", "s1", "s2", "s3"],
      "p9"
    );

    expect(canAnkan(hand, "z5")).toBe(true);
    expect(canRiichiAnkan(hand, "z5", drawn, MAJSOUL_YONMA_RULES)).toBe(false);
  });

  it("allows Mahjong Soul's wait-preserving interpretation change", () => {
    // The 3p tiles can participate in another winning interpretation on 4p, but
    // Mahjong Soul permits this kan because the 4p/5p/7p wait signature is unchanged.
    const { hand, drawn } = riichiHand(
      ["p3", "p3", "p3", "p5", "p6", "p6", "p6", "s1", "s1", "s1", "s4", "s5", "s6"],
      "p3"
    );

    expect(canRiichiAnkan(hand, "p3", drawn, MAJSOUL_YONMA_RULES)).toBe(true);
  });

  it("leaves ordinary pre-riichi ankan legality unchanged", () => {
    const { hand } = riichiHand(
      ["z5", "z5", "z5", "p1", "p2", "p3", "p4", "p5", "p6", "s1", "s2", "s3", "s9"],
      "z5"
    );
    hand.riichi = false;

    expect(canAnkan(hand, "z5")).toBe(true);
  });
});
