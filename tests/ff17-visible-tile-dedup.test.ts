import { describe, expect, it } from "vitest";
import { computeImprovingTileCount } from "../src/actions/winSearch.js";
import { collectVisibleTileKinds } from "../src/ai/visibleTiles.js";
import { Hand } from "../src/core/Hand.js";
import { kindsToCounts } from "../src/core/tileIndex.js";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";

let nextId = 170000;
function tile(kind: TileKind): Tile {
  const parsed = parseKind(kind);
  return { id: nextId++, kind, suit: parsed.suit, rank: parsed.rank, isRed: false };
}

describe("FF-17 CharacterAI visible physical tile accounting", () => {
  it("counts a called-away discard through the caller's meld exactly once", () => {
    const discarder = new Hand();
    const caller = new Hand();
    const called = tile("p6");
    discarder.dealIn([called]);
    discarder.discardById(called.id, { tsumogiri: false });
    discarder.markDiscardCalledAway(called.id);
    caller.melds.push({
      type: "pon",
      tiles: [tile("p6"), tile("p6"), called],
      calledFrom: 0,
      calledTile: called,
    });

    const visible = collectVisibleTileKinds([discarder, caller], []);

    expect(visible.filter((kind) => kind === "p6")).toHaveLength(3);
    expect(computeImprovingTileCount(["p6"], kindsToCounts([]), kindsToCounts(visible))).toBe(1);
  });

  it("continues to count an unclaimed river tile", () => {
    const hand = new Hand();
    const discarded = tile("s4");
    hand.dealIn([discarded]);
    hand.discardById(discarded.id, { tsumogiri: false });

    expect(collectVisibleTileKinds([hand], [])).toEqual(["s4"]);
  });

  it("keeps called-away history for furiten while deduplicating only AI visibility", () => {
    const discarder = new Hand();
    const called = tile("z5");
    discarder.dealIn([called]);
    discarder.discardById(called.id, { tsumogiri: false });
    discarder.markDiscardCalledAway(called.id);

    expect(discarder.discards).toEqual([expect.objectContaining({ tile: called, calledAway: true })]);
    expect(collectVisibleTileKinds([discarder], [])).toEqual([]);
  });

  it("still includes meld, Kita, and dora-indicator tiles deterministically", () => {
    const hand = new Hand();
    hand.melds.push({ type: "chi", tiles: [tile("m1"), tile("m2"), tile("m3")] });
    hand.kitaTiles.push(tile("z4"));

    expect(collectVisibleTileKinds([hand], ["p5"])).toEqual(["m1", "m2", "m3", "z4", "p5"]);
  });
});
