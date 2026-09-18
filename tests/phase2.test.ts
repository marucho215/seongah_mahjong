import { describe, it, expect } from "vitest";
import { standardShanten, chiitoitsuShanten, kokushiShanten, minShanten } from "../src/shanten/shanten.js";
import { tilesToCounts } from "../src/core/tileIndex.js";
import type { Tile } from "../src/core/tiles.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { Wall } from "../src/core/Wall.js";

function kindsToTiles(kinds: string[]): Tile[] {
  return kinds.map((kind, i) => {
    const suit = kind[0] as "m" | "p" | "s" | "z";
    const rank = Number(kind.slice(1));
    return { id: i, kind, suit, rank, isRed: false };
  });
}

describe("standard shanten", () => {
  it("recognizes a complete standard hand as a win (shanten -1)", () => {
    const tiles = kindsToTiles([
      "m1", "m1", "m1",
      "p1", "p2", "p3",
      "p4", "p5", "p6",
      "s7", "s8", "s9",
      "z1", "z1",
    ]);
    expect(standardShanten(tilesToCounts(tiles))).toBe(-1);
  });

  it("recognizes a tanki tenpai hand as shanten 0", () => {
    const tiles = kindsToTiles([
      "m1", "m1", "m1",
      "p1", "p2", "p3",
      "p4", "p5", "p6",
      "s7", "s8", "s9",
      "z1",
    ]);
    expect(standardShanten(tilesToCounts(tiles))).toBe(0);
  });

  it("recognizes a ryanmen tenpai hand as shanten 0", () => {
    // waiting on p3/p6 to complete the last run
    const tiles = kindsToTiles([
      "m1", "m1", "m1",
      "p1", "p2",
      "p4", "p5", "p6",
      "s7", "s8", "s9",
      "z1", "z1",
    ]);
    expect(standardShanten(tilesToCounts(tiles))).toBe(0);
  });

  it("increases shanten as the hand gets further from tenpai", () => {
    const tenpai = kindsToTiles([
      "m1", "m1", "m1",
      "p1", "p2", "p3",
      "p4", "p5", "p6",
      "s7", "s8", "s9",
      "z1",
    ]);
    const oneAway = tilesToCounts(tenpai);
    const twoAway = tilesToCounts(
      kindsToTiles(["m1", "m1", "z2", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "s9", "z1"])
    );
    expect(standardShanten(twoAway)).toBeGreaterThan(standardShanten(oneAway));
  });

  it("accounts for already-called melds via existingMelds", () => {
    // 1 meld called (pon m1), concealed 10 tiles form 3 sets + pair - 1 = tenpai
    const concealed = kindsToTiles([
      "p1", "p2", "p3",
      "p4", "p5", "p6",
      "s7", "s8", "s9",
      "z1",
    ]);
    expect(standardShanten(tilesToCounts(concealed), 1)).toBe(0);
  });
});

describe("chiitoitsu shanten", () => {
  it("recognizes seven pairs as a win", () => {
    const tiles = kindsToTiles(["m1", "m1", "m9", "m9", "p1", "p1", "p9", "p9", "s1", "s1", "s9", "s9", "z1", "z1"]);
    expect(chiitoitsuShanten(tilesToCounts(tiles))).toBe(-1);
  });

  it("penalizes duplicate-heavy hands that can't reach 7 distinct pairs", () => {
    // four of a kind only helps toward one pair; still need 6 more distinct pairs
    const tiles = kindsToTiles(["m1", "m1", "m1", "m1", "p1", "p2", "s1", "s2", "z1", "z2", "z3", "z4", "z5"]);
    const shanten = chiitoitsuShanten(tilesToCounts(tiles));
    expect(shanten).toBeGreaterThan(0);
  });
});

describe("kokushi shanten", () => {
  it("recognizes thirteen orphans as a win", () => {
    const tiles = kindsToTiles(["m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "z3", "z4", "z5", "z6", "z6", "z7"]);
    expect(kokushiShanten(tilesToCounts(tiles))).toBe(-1);
  });

  it("counts distance correctly for a partial kokushi hand", () => {
    const tiles = kindsToTiles(["m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "z3", "z4", "z5", "z6", "p5"]);
    // 12 distinct terminal/honor kinds present, no pair among them -> shanten = 13-12-0 = 1
    expect(kokushiShanten(tilesToCounts(tiles))).toBe(1);
  });
});

describe("minShanten picks the best form", () => {
  it("prefers chiitoitsu when it's closer than standard", () => {
    const tiles = kindsToTiles(["m1", "m1", "m9", "m9", "p1", "p1", "p9", "p9", "s1", "s1", "s9", "s9", "z1", "z2"]);
    const counts = tilesToCounts(tiles);
    expect(chiitoitsuShanten(counts)).toBeLessThan(standardShanten(counts));
    expect(minShanten(counts)).toBe(chiitoitsuShanten(counts));
  });
});

describe("shanten performance", () => {
  it("computes shanten for many real dealt hands quickly", () => {
    const start = Date.now();
    for (let i = 0; i < 200; i++) {
      const wall = new Wall(DEFAULT_SANMA_RULES, `perf-${i}`);
      const hands = wall.dealInitial(3, 13);
      for (const hand of hands) {
        minShanten(tilesToCounts(hand));
      }
    }
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(5000);
  });
});
