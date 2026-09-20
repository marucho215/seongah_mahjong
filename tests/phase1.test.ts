import { describe, it, expect } from "vitest";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { buildTileSet, totalTileCount, allKindsForRules } from "../src/core/tiles.js";
import { Wall } from "../src/core/Wall.js";
import { Hand } from "../src/core/Hand.js";
import { SeededRng } from "../src/core/rng.js";

describe("tile generation", () => {
  it("produces exactly 4 copies of every valid kind, no more no less", () => {
    const tiles = buildTileSet(DEFAULT_SANMA_RULES);
    const counts = new Map<string, number>();
    for (const t of tiles) counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);
    for (const [kind, count] of counts) {
      expect(count, `kind ${kind} should have exactly 4 copies`).toBe(4);
    }
    expect(tiles.length).toBe(totalTileCount(DEFAULT_SANMA_RULES));
  });

  it("removes manzu 2-8 under standard sanma rules", () => {
    const kinds = allKindsForRules(DEFAULT_SANMA_RULES);
    for (let rank = 2; rank <= 8; rank++) {
      expect(kinds).not.toContain(`m${rank}`);
    }
    expect(kinds).toContain("m1");
    expect(kinds).toContain("m9");
    // 2 manzu kinds + 9 pinzu + 9 souzu + 7 honors = 27 kinds -> 108 tiles
    expect(kinds.length).toBe(27);
    expect(totalTileCount(DEFAULT_SANMA_RULES)).toBe(108);
  });

  it("keeps full manzu suit when removeManzu2to8 is disabled", () => {
    const rules = { ...DEFAULT_SANMA_RULES, removeManzu2to8: false };
    const kinds = allKindsForRules(rules);
    expect(kinds.length).toBe(34);
    expect(totalTileCount(rules)).toBe(136);
  });

  it("assigns every tile a unique id", () => {
    const tiles = buildTileSet(DEFAULT_SANMA_RULES);
    const ids = new Set(tiles.map((t) => t.id));
    expect(ids.size).toBe(tiles.length);
  });

  it("marks exactly the configured number of red fives per suit", () => {
    const tiles = buildTileSet(DEFAULT_SANMA_RULES);
    const redPin5 = tiles.filter((t) => t.kind === "p5" && t.isRed);
    const redSou5 = tiles.filter((t) => t.kind === "s5" && t.isRed);
    expect(redPin5.length).toBe(DEFAULT_SANMA_RULES.akaDoraCount.pin);
    expect(redSou5.length).toBe(DEFAULT_SANMA_RULES.akaDoraCount.sou);
  });
});

describe("seeded RNG determinism", () => {
  it("produces identical sequences for identical seeds", () => {
    const a = new SeededRng("test-seed-123");
    const b = new SeededRng("test-seed-123");
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = new SeededRng("seed-a");
    const b = new SeededRng("seed-b");
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("numeric and string seeds both work and are stable", () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    expect(a.next()).toBe(b.next());
  });
});

describe("Wall determinism and integrity", () => {
  it("same seed produces the same wall order", () => {
    const w1 = new Wall(DEFAULT_SANMA_RULES, "riichi-seed-1");
    const w2 = new Wall(DEFAULT_SANMA_RULES, "riichi-seed-1");
    const hands1 = w1.dealInitial(3, 13);
    const hands2 = w2.dealInitial(3, 13);
    expect(hands1.map((h) => h.map((t) => t.id))).toEqual(hands2.map((h) => h.map((t) => t.id)));
    expect(w1.doraIndicators().map((t) => t.id)).toEqual(w2.doraIndicators().map((t) => t.id));
  });

  it("different seeds produce different walls", () => {
    const w1 = new Wall(DEFAULT_SANMA_RULES, "seed-A");
    const w2 = new Wall(DEFAULT_SANMA_RULES, "seed-B");
    const hands1 = w1.dealInitial(3, 13);
    const hands2 = w2.dealInitial(3, 13);
    expect(hands1.map((h) => h.map((t) => t.id))).not.toEqual(hands2.map((h) => h.map((t) => t.id)));
  });

  it("deals 13 tiles to each of 3 players with no overlap", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "deal-test");
    const hands = wall.dealInitial(3, 13);
    expect(hands.length).toBe(3);
    for (const h of hands) expect(h.length).toBe(13);
    const allIds = hands.flat().map((t) => t.id);
    expect(new Set(allIds).size).toBe(39);
  });

  it("never deals the same physical tile twice, and total tiles are conserved", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "conservation-test");
    const total = wall.totalTiles;
    expect(total).toBe(108);
    const hands = wall.dealInitial(3, 13);
    const drawn: number[] = hands.flat().map((t) => t.id);
    let remaining = wall.remainingLiveCount();
    while (remaining > 0) {
      const tile = wall.drawTile();
      drawn.push(tile.id);
      remaining = wall.remainingLiveCount();
    }
    // dead wall at rest is the standard 14 tiles (4 physical rinshan + 5 dora + 5 ura);
    // everything else is drawable as a normal live tile (39 dealt + the rest via drawTile)
    expect(drawn.length).toBe(total - 14);
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it("throws instead of drawing from an empty live wall", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "empty-test");
    wall.dealInitial(3, 13);
    while (wall.remainingLiveCount() > 0) wall.drawTile();
    expect(() => wall.drawTile()).toThrow();
  });

  it("rinshan draws shrink the live wall boundary by one extra tile per kan", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "kan-test");
    wall.dealInitial(3, 13);
    const before = wall.remainingLiveCount();
    wall.drawRinshan();
    const after = wall.remainingLiveCount();
    expect(after).toBe(before - 1);
    expect(wall.doraIndicators().length).toBe(2);
  });
});

describe("Hand discard validation", () => {
  it("allows discarding a tile that is in hand", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "hand-test");
    const [h0] = wall.dealInitial(3, 13);
    const hand = new Hand();
    hand.dealIn(h0!);
    const tileId = hand.concealed[0]!.id;
    const discarded = hand.discardById(tileId, { tsumogiri: false });
    expect(discarded.id).toBe(tileId);
    expect(hand.concealed.length).toBe(12);
    expect(hand.discards.length).toBe(1);
  });

  it("throws when discarding a tile not in hand", () => {
    const hand = new Hand();
    hand.dealIn([{ id: 0, kind: "p1", suit: "p", rank: 1, isRed: false }]);
    expect(() => hand.discardById(999, { tsumogiri: false })).toThrow();
  });

  it("cannot discard the same physical tile twice", () => {
    const hand = new Hand();
    hand.dealIn([{ id: 0, kind: "p1", suit: "p", rank: 1, isRed: false }]);
    hand.discardById(0, { tsumogiri: false });
    expect(() => hand.discardById(0, { tsumogiri: false })).toThrow();
  });
});
