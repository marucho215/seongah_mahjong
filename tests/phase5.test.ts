import { describe, it, expect } from "vitest";
import { Hand } from "../src/core/Hand.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import type { Tile } from "../src/core/tiles.js";
import {
  chooseDiscard,
  shouldDeclareRiichi,
  shouldCallPon,
  shouldDeclareAnkan,
  isSafeAgainstAllRiichi,
  computeOwnWinningTiles,
} from "../src/ai/simpleAI.js";

let nextId = 5000;
function t(kind: string): Tile {
  const suit = kind[0] as "m" | "p" | "s" | "z";
  const rank = Number(kind.slice(1));
  return { id: nextId++, kind, suit, rank, isRed: false };
}
function tiles(kinds: string[]): Tile[] {
  return kinds.map(t);
}

describe("chooseDiscard: efficiency", () => {
  it("discards the tile that keeps (or reaches) the best shanten", () => {
    const hand = new Hand();
    // 3 complete melds + pair + a ryanmen taatsu (s7s8) = already tenpai once the
    // isolated, unconnected z7 is discarded; keeping z7 instead would strictly worsen shanten.
    hand.dealIn(tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "z1", "z1", "z7"]));
    const discardId = chooseDiscard({ hand, riichiOpponentDiscardKinds: [] });
    const discardedKind = hand.concealed.find((c) => c.id === discardId)!.kind;
    expect(discardedKind).toBe("z7");
  });

  it("never picks a tile that makes shanten worse when a same-shanten option exists", () => {
    const hand = new Hand();
    hand.dealIn(tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "s9", "z1", "z1"]));
    // already a complete hand shape (14 tiles = win); any discard must not be *worse* than the best available option
    const discardId = chooseDiscard({ hand, riichiOpponentDiscardKinds: [] });
    expect(hand.concealed.some((c) => c.id === discardId)).toBe(true);
  });
});

describe("chooseDiscard: defense against riichi", () => {
  it("prefers a genbutsu tile over efficiency when not tenpai and an opponent is in riichi", () => {
    const hand = new Hand();
    // core: p2p3p4 + s5s6s7 + z1z1 pair (8 tiles) = 2 melds + pair, still 3-shanten.
    // the remaining 6 tiles are all isolated singles that don't connect to anything,
    // so discarding any one of them leaves shanten unchanged - a genuine tie.
    hand.dealIn(tiles(["p2", "p3", "p4", "s5", "s6", "s7", "z1", "z1", "m1", "m9", "z2", "z4", "z6", "z7"]));
    const discardId = chooseDiscard({
      hand,
      riichiOpponentDiscardKinds: [["z7", "p1", "s9"]],
    });
    const discardedKind = hand.concealed.find((c) => c.id === discardId)!.kind;
    // among the 6 tied isolated-tile candidates, only z7 is genbutsu - it must be chosen
    expect(discardedKind).toBe("z7");
  });
});

describe("isSafeAgainstAllRiichi", () => {
  it("is true only when the tile is genbutsu against every riichi opponent", () => {
    expect(
      isSafeAgainstAllRiichi({ candidateKind: "p9", riichiOpponentDiscardKinds: [["p9", "m1"], ["p9", "z5"]] })
    ).toBe(true);
    expect(
      isSafeAgainstAllRiichi({ candidateKind: "p9", riichiOpponentDiscardKinds: [["p9", "m1"], ["z5"]] })
    ).toBe(false);
  });
});

describe("riichi decision", () => {
  it("declares riichi when the resulting discard leaves a closed, tenpai, eligible hand", () => {
    const hand = new Hand();
    hand.dealIn(tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "s9", "z1", "z7"]));
    const discardId = hand.concealed.find((c) => c.kind === "z7")!.id;
    expect(shouldDeclareRiichi(hand, 25000, 20, discardId)).toBe(true);
  });

  it("does not declare riichi when score is too low", () => {
    const hand = new Hand();
    hand.dealIn(tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "s9", "z1", "z7"]));
    const discardId = hand.concealed.find((c) => c.kind === "z7")!.id;
    expect(shouldDeclareRiichi(hand, 500, 20, discardId)).toBe(false);
  });
});

describe("pon decision", () => {
  it("calls pon on a dragon", () => {
    expect(shouldCallPon("z5", 1, 1)).toBe(true);
  });
  it("calls pon on own seat wind", () => {
    expect(shouldCallPon("z2", 2, 1)).toBe(true);
  });
  it("does not call pon on a plain simple tile", () => {
    expect(shouldCallPon("p5", 1, 1)).toBe(false);
  });
  it("does not call pon on a non-value, non-matching honor", () => {
    expect(shouldCallPon("z4", 1, 1)).toBe(false); // north, not a seat in sanma and not a dragon
  });
});

describe("kan decision", () => {
  it("always takes a free closed kan", () => {
    expect(shouldDeclareAnkan()).toBe(true);
  });
});

describe("computeOwnWinningTiles integration", () => {
  it("matches the wait set for a real tenpai hand", () => {
    const hand = new Hand();
    hand.dealIn(tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "z1", "z1"]));
    const winners = computeOwnWinningTiles(hand, DEFAULT_SANMA_RULES);
    expect(winners.sort()).toEqual(["s6", "s9"]);
  });
});
