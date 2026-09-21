import { describe, expect, it } from "vitest";
import { applySelectedDiscardResponse, type DiscardResponseApplicationState } from "../src/core/applyDiscardResponse.js";
import { Hand } from "../src/core/Hand.js";
import type { Tile } from "../src/core/tiles.js";
import { Wall } from "../src/core/Wall.js";
import { MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

function tile(id: number, kind: string): Tile {
  return {
    id,
    kind,
    suit: kind[0] as "m" | "p" | "s" | "z",
    rank: Number(kind.slice(1)),
    isRed: false,
  };
}

function fixture(seed: string): DiscardResponseApplicationState {
  return {
    rules: MAJSOUL_YONMA_RULES,
    hands: [new Hand(), new Hand(), new Hand(), new Hand()],
    wall: new Wall(MAJSOUL_YONMA_RULES, seed),
    currentPlayer: 0,
    ippatsuEligible: [true, true, true, true],
    appliedDiscardIds: new Set<number>(),
  };
}

function makeDiscard(state: DiscardResponseApplicationState, seat: number, discarded: Tile): Tile {
  state.hands[seat]!.dealIn([discarded]);
  return state.hands[seat]!.discardById(discarded.id, {
    tsumogiri: false,
    isRiichiDeclaration: false,
  });
}

function conservedTotal(state: DiscardResponseApplicationState, externalDiscardCount: number): number {
  return (
    state.hands.reduce((sum, hand) => sum + hand.allTileCount(), 0) +
    state.wall.remainingLiveCount() +
    state.wall.deadWallTileCount() +
    externalDiscardCount
  );
}

describe("Phase 7E-1 selected call application", () => {
  it("applies the exact selected chi without drawing and transfers the turn to the caller", () => {
    const state = fixture("phase7e1-chi");
    state.hands[1]!.dealIn([tile(101, "m1"), tile(102, "m2"), tile(103, "p9")]);
    const discarded = makeDiscard(state, 0, tile(100, "m3"));
    const liveBefore = state.wall.remainingLiveCount();
    const totalBefore = conservedTotal(state, 1);

    const result = applySelectedDiscardResponse(
      state,
      { type: "chi", seat: 1, sequence: ["m1", "m2", "m3"], consumedKinds: ["m1", "m2"] },
      0,
      discarded
    );

    expect(state.hands[1]!.concealed.map((entry) => entry.kind)).toEqual(["p9"]);
    expect(state.hands[1]!.melds).toHaveLength(1);
    expect(state.hands[1]!.melds[0]).toMatchObject({ type: "chi", calledFrom: 0, calledTile: discarded });
    expect(state.hands[1]!.melds[0]!.tiles.map((entry) => entry.kind).sort()).toEqual(["m1", "m2", "m3"]);
    expect(state.currentPlayer).toBe(1);
    expect(result.mustDiscard).toBe(true);
    expect(result.replacementTile).toBeUndefined();
    expect(state.wall.remainingLiveCount()).toBe(liveBefore);
    expect(state.ippatsuEligible).toEqual([false, false, false, false]);
    expect(conservedTotal(state, 0)).toBe(totalBefore);
  });

  it("applies pon, skips intervening seats, and requires the caller's discard next", () => {
    const state = fixture("phase7e1-pon");
    state.hands[3]!.dealIn([tile(201, "p5"), tile(202, "p5"), tile(203, "s9")]);
    const discarded = makeDiscard(state, 0, tile(200, "p5"));
    const liveBefore = state.wall.remainingLiveCount();
    const totalBefore = conservedTotal(state, 1);

    const result = applySelectedDiscardResponse(state, { type: "pon", seat: 3, kind: "p5" }, 0, discarded);

    expect(state.hands[3]!.concealed.map((entry) => entry.kind)).toEqual(["s9"]);
    expect(state.hands[3]!.melds[0]).toMatchObject({ type: "pon", calledFrom: 0, calledTile: discarded });
    expect(state.hands[3]!.melds[0]!.tiles).toHaveLength(3);
    expect(state.currentPlayer).toBe(3);
    expect(result.currentPlayer).toBe(3);
    expect(result.mustDiscard).toBe(true);
    expect(state.wall.remainingLiveCount()).toBe(liveBefore);
    expect(state.ippatsuEligible).toEqual([false, false, false, false]);
    expect(conservedTotal(state, 0)).toBe(totalBefore);
  });

  it("applies daiminkan, draws exactly one rinshan tile, and preserves tile count", () => {
    const state = fixture("phase7e1-daiminkan");
    state.hands[2]!.dealIn([tile(301, "s7"), tile(302, "s7"), tile(303, "s7"), tile(304, "m1")]);
    const discarded = makeDiscard(state, 0, tile(300, "s7"));
    const liveBefore = state.wall.remainingLiveCount();
    const totalBefore = conservedTotal(state, 1);

    const result = applySelectedDiscardResponse(state, { type: "daiminkan", seat: 2, kind: "s7" }, 0, discarded);

    expect(state.hands[2]!.melds[0]).toMatchObject({ type: "kan_open", calledFrom: 0, calledTile: discarded });
    expect(state.hands[2]!.melds[0]!.tiles).toHaveLength(4);
    expect(result.replacementTile).toBeDefined();
    expect(state.hands[2]!.concealed).toContainEqual(result.replacementTile);
    expect(state.wall.kanCount()).toBe(1);
    expect(state.wall.remainingLiveCount()).toBe(liveBefore - 1);
    expect(state.currentPlayer).toBe(2);
    expect(result.mustDiscard).toBe(true);
    expect(state.ippatsuEligible).toEqual([false, false, false, false]);
    expect(conservedTotal(state, 0)).toBe(totalBefore);
  });

  it("prevents the same physical discard from being applied twice", () => {
    const state = fixture("phase7e1-duplicate");
    state.hands[1]!.dealIn([tile(401, "z5"), tile(402, "z5")]);
    const discarded = makeDiscard(state, 0, tile(400, "z5"));
    const candidate = { type: "pon", seat: 1, kind: "z5" } as const;
    applySelectedDiscardResponse(state, candidate, 0, discarded);
    expect(() => applySelectedDiscardResponse(state, candidate, 0, discarded)).toThrow(/already applied/);
  });

  it("produces the same transition for the same fixture and candidate", () => {
    const run = () => {
      const state = fixture("phase7e1-deterministic");
      state.hands[1]!.dealIn([tile(501, "m4"), tile(502, "m6"), tile(503, "p1")]);
      const discarded = makeDiscard(state, 0, tile(500, "m5"));
      const result = applySelectedDiscardResponse(
        state,
        { type: "chi", seat: 1, sequence: ["m4", "m5", "m6"], consumedKinds: ["m4", "m6"] },
        0,
        discarded
      );
      return {
        currentPlayer: state.currentPlayer,
        ippatsuEligible: state.ippatsuEligible,
        concealed: state.hands[1]!.concealed.map((entry) => entry.id),
        meld: result.meld.tiles.map((entry) => entry.id),
        live: state.wall.remainingLiveCount(),
      };
    };
    expect(run()).toEqual(run());
  });
});
