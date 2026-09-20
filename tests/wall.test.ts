import { describe, it, expect } from "vitest";
import { Wall } from "../src/core/Wall.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { GameState } from "../src/core/GameState.js";
import type { GameEvent } from "../src/core/GameLog.js";

/**
 * Phase 1: dead wall = 14 tiles at rest = R1..R8 (initial designated replacement sequence,
 * offsets 0-7) + D0,U0,K1,U1,K2,U2 (offsets 8-13). Every replacement draw returns the next
 * R-tile and absorbs one live-wall-tail tile; absorbedTiles[0..3] later source K3,U3,K4,U4
 * once kansDrawn reaches 3/4. See src/core/Wall.ts for the full index map.
 */
describe("Wall: 14-tile dead wall, R1..R8 fixed at shuffle time", () => {
  it("1. initial dead wall = 14: live wall count is totalTiles - 14", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-initial");
    expect(wall.remainingLiveCount()).toBe(wall.totalTiles - 14);
  });

  it("2/3. R1..R8 identity is fixed at construction: replaying the same seed and drawing replacements in a different position still yields the same R-sequence values", () => {
    const seed = "wall-r-sequence";
    const wA = new Wall(DEFAULT_SANMA_RULES, seed);
    const rA = [1, 2, 3, 4, 5, 6, 7, 8].map(() => wA.drawRinshan().id);

    // same seed, but insert normal draws before starting replacements - R1..R8 must be
    // unaffected, since they were fixed at shuffle time, not drawn from the live wall
    const wB = new Wall(DEFAULT_SANMA_RULES, seed);
    wB.drawTile();
    wB.drawTile();
    wB.drawTile();
    const rB = [1, 2, 3, 4, 5, 6, 7, 8].map(() => wB.drawRinshan().id);
    expect(rB).toEqual(rA);
  });

  it("4. the 5th replacement is NOT whatever tile currently sits at the live wall's tail - it's R5, fixed at shuffle time", () => {
    const seed = "wall-r5-not-live-tail";
    const wA = new Wall(DEFAULT_SANMA_RULES, seed);
    for (let i = 0; i < 4; i++) wA.drawRinshan();
    const r5A = wA.drawRinshan().id;

    const wB = new Wall(DEFAULT_SANMA_RULES, seed);
    for (let i = 0; i < 4; i++) wB.drawRinshan();
    wB.drawTile();
    wB.drawTile();
    wB.drawTile(); // changes what the live tail currently is, but must not change R5
    const r5B = wB.drawRinshan().id;

    expect(r5B).toBe(r5A);
  });

  it("5. each replacement draw shrinks live drawable count by exactly 1 (R1..R8 and beyond)", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-live-shrink");
    let before = wall.remainingLiveCount();
    for (let i = 0; i < 8; i++) {
      wall.drawKitaReplacement();
      expect(wall.remainingLiveCount()).toBe(before - 1);
      before = wall.remainingLiveCount();
    }
  });

  it("6/7. D0/U0 and K1/U1, K2/U2 initial indicator positions are correct and non-overlapping with R1..R8 or each other", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-initial-indicators");
    expect(wall.doraIndicators().length).toBe(1); // D0 only, no kans yet
    expect(wall.uraDoraIndicators().length).toBe(1); // U0 only
    const rIds = new Set<number>();
    for (let i = 0; i < 8; i++) rIds.add(wall.drawRinshan().id);
    // after 8 replacements (all real kans here), kansDrawn caps dora reveal at 5 (DORA_INDICATOR_SLOTS)
    const dora = wall.doraIndicators().map((t) => t.id);
    const ura = wall.uraDoraIndicators().map((t) => t.id);
    expect(dora.length).toBe(5);
    expect(ura.length).toBe(5);
    // no overlap: R-tiles (already drawn out) never reappear as indicators, dora != ura
    for (const id of dora) expect(rIds.has(id)).toBe(false);
    for (const id of ura) expect(rIds.has(id)).toBe(false);
    expect(new Set([...dora, ...ura]).size).toBe(10); // all 10 distinct
  });

  it("8. K3/U3 and K4/U4 (post-absorption indicators) appear only once kansDrawn reaches 3/4, and are distinct real tiles", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-absorbed-indicators");
    wall.drawRinshan(); // kan 1
    wall.drawRinshan(); // kan 2
    expect(wall.doraIndicators().length).toBe(3);
    expect(wall.uraDoraIndicators().length).toBe(3);
    wall.drawRinshan(); // kan 3 -> K3/U3 should now exist
    expect(wall.doraIndicators().length).toBe(4);
    expect(wall.uraDoraIndicators().length).toBe(4);
    wall.drawRinshan(); // kan 4 -> K4/U4
    expect(wall.doraIndicators().length).toBe(5);
    expect(wall.uraDoraIndicators().length).toBe(5);
    const allIds = new Set([...wall.doraIndicators().map((t) => t.id), ...wall.uraDoraIndicators().map((t) => t.id)]);
    expect(allIds.size).toBe(10); // K3,U3,K4,U4 distinct from each other and from D0/U0/K1/U1/K2/U2
  });

  it("9/10. kita consumes a replacement but never increments kanCount/dora reveal; kan does both", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-kita-vs-kan");
    wall.drawKitaReplacement();
    expect(wall.kanCount()).toBe(0);
    expect(wall.doraIndicators().length).toBe(1);
    wall.drawRinshan();
    expect(wall.kanCount()).toBe(1);
    expect(wall.doraIndicators().length).toBe(2);
  });

  it("11. mixed kan/kita sequence: no replacement tile ever repeats, live count -1 per draw, dora cadence tracks kan count only", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-mixed-sequence");
    const sequence: Array<"kita" | "kan"> = ["kita", "kita", "kan", "kita", "kan", "kan", "kita", "kan"];
    let liveBefore = wall.remainingLiveCount();
    let kansSoFar = 0;
    const seen = new Set<number>();
    for (const action of sequence) {
      const tile = action === "kan" ? wall.drawRinshan() : wall.drawKitaReplacement();
      if (action === "kan") kansSoFar++;
      expect(seen.has(tile.id)).toBe(false);
      seen.add(tile.id);
      expect(wall.remainingLiveCount()).toBe(liveBefore - 1);
      liveBefore = wall.remainingLiveCount();
      expect(wall.doraIndicators().length).toBe(Math.min(1 + kansSoFar, 5));
    }
    const doraIds = new Set(wall.doraIndicators().map((t) => t.id));
    const uraIds = new Set(wall.uraDoraIndicators().map((t) => t.id));
    for (const id of seen) {
      expect(doraIds.has(id)).toBe(false);
      expect(uraIds.has(id)).toBe(false);
    }
  });

  it("12. seeded determinism: identical seed + action sequence -> identical replacement/indicator/live-count results", () => {
    const seed = "wall-determinism";
    const w1 = new Wall(DEFAULT_SANMA_RULES, seed);
    const w2 = new Wall(DEFAULT_SANMA_RULES, seed);
    for (let i = 0; i < 20; i++) expect(w1.drawTile().id).toBe(w2.drawTile().id);
    expect(w1.drawRinshan().id).toBe(w2.drawRinshan().id);
    expect(w1.drawKitaReplacement().id).toBe(w2.drawKitaReplacement().id);
    expect(w1.doraIndicators().map((t) => t.id)).toEqual(w2.doraIndicators().map((t) => t.id));
    expect(w1.remainingLiveCount()).toBe(w2.remainingLiveCount());
  });

  it("a 9th replacement is refused (capacity=8 by default) and throws if forced", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-nine");
    for (let i = 0; i < 8; i++) wall.drawKitaReplacement();
    expect(wall.canDrawKitaReplacement()).toBe(false);
    expect(() => wall.drawKitaReplacement()).toThrow();
  });

  it("capacity is derived from rules (maxKans + 4 North copies), not a bare constant; raising maxKans extends beyond R8 via live-tail borrow", () => {
    const wall6 = new Wall({ ...DEFAULT_SANMA_RULES, maxKans: 6 }, "wall-cap-6");
    for (let i = 0; i < 10; i++) wall6.drawKitaReplacement(); // 6 + 4 = 10
    expect(wall6.canDrawKitaReplacement()).toBe(false);
    expect(() => wall6.drawKitaReplacement()).toThrow();
  });

  it("once the live wall is empty, no further replacement is possible (R1..R8 also require a live tile to absorb)", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-live-exhausted");
    while (wall.remainingLiveCount() > 0) wall.drawTile();
    expect(wall.canDrawRinshan(99)).toBe(false);
    expect(() => wall.drawRinshan()).toThrow();
  });

  it("full game completes without a live-wall-exhaustion crash, using the new 4-tile-larger live wall", () => {
    for (let seed = 0; seed < 10; seed++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `wall-exhaustive-${seed}` });
      gs.playGame();
      const draws = gs.log.filter((e): e is Extract<GameEvent, { type: "draw" }> => e.type === "draw" && e.source === "wall");
      expect(draws.length).toBeGreaterThan(0);
    }
  });
});
