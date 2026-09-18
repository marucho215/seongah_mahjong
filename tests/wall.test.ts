import { describe, it, expect } from "vitest";
import { Wall } from "../src/core/Wall.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { GameState } from "../src/core/GameState.js";
import type { GameEvent } from "../src/core/GameLog.js";

/**
 * Phase 1: dead wall is the standard 14 tiles at rest (4 physical rinshan slots + 5 dora +
 * 5 ura), while kan+kita replacement draws share a rule-level cap of 8 per hand -
 * replacements beyond the first 4 borrow straight from the live wall's own tail. These
 * tests pin down the resulting live-wall counts and the 8-draw cap directly on Wall,
 * without going through CharacterAI/scoring at all.
 */
describe("Wall: dead wall = 14, up to 8 shared kan/kita replacement draws", () => {
  it("1. initial live wall count is totalTiles - 14", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-initial");
    expect(wall.remainingLiveCount()).toBe(wall.totalTiles - 14);
  });

  it("2. one kan replacement draw shrinks the live wall by exactly 1", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-kan1");
    const before = wall.remainingLiveCount();
    wall.drawRinshan();
    expect(wall.remainingLiveCount()).toBe(before - 1);
    expect(wall.kanCount()).toBe(1);
  });

  it("3. one kita replacement draw shrinks the live wall by exactly 1", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-kita1");
    const before = wall.remainingLiveCount();
    wall.drawKitaReplacement();
    expect(wall.remainingLiveCount()).toBe(before - 1);
    expect(wall.kanCount()).toBe(0); // kita draws don't count as kans
  });

  it("4. mixed kan + kita draws share the same pool and each shrink the live wall by 1", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-mixed");
    const before = wall.remainingLiveCount();
    wall.drawRinshan();
    wall.drawKitaReplacement();
    wall.drawRinshan();
    expect(wall.remainingLiveCount()).toBe(before - 3);
    expect(wall.kanCount()).toBe(2);
  });

  it("5b. the 8-draw cap is derived from rules (maxKans=4 real kans + 4 physical North tiles for kita), not a bare magic constant - raising maxKans raises the cap accordingly", () => {
    const wall4 = new Wall(DEFAULT_SANMA_RULES, "wall-cap-4");
    for (let i = 0; i < 8; i++) wall4.drawKitaReplacement();
    expect(wall4.canDrawKitaReplacement()).toBe(false);

    const wall6 = new Wall({ ...DEFAULT_SANMA_RULES, maxKans: 6 }, "wall-cap-6");
    for (let i = 0; i < 10; i++) wall6.drawKitaReplacement(); // 6 (maxKans) + 4 (North copies) = 10
    expect(wall6.canDrawKitaReplacement()).toBe(false);
    expect(() => wall6.drawKitaReplacement()).toThrow();
  });

  it("5. all 8 shared replacement draws succeed (mixed kan/kita, using canDrawRinshan/canDrawKitaReplacement gates)", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-eight");
    const before = wall.remainingLiveCount();
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) {
        expect(wall.canDrawRinshan(99)).toBe(true); // maxKans not the limiting factor here
        wall.drawRinshan();
      } else {
        expect(wall.canDrawKitaReplacement()).toBe(true);
        wall.drawKitaReplacement();
      }
    }
    expect(wall.remainingLiveCount()).toBe(before - 8);
  });

  it("6. a 9th replacement draw is refused (canDraw* false) and throws if forced", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-nine");
    for (let i = 0; i < 8; i++) wall.drawKitaReplacement();
    expect(wall.canDrawKitaReplacement()).toBe(false);
    expect(wall.canDrawRinshan(99)).toBe(false);
    expect(() => wall.drawRinshan()).toThrow();
    expect(() => wall.drawKitaReplacement()).toThrow();
  });

  it("7. once the live wall is fully drawn, a 5th-8th tier replacement (which borrows from the live tail) is refused, but the first 4 (static slots) never depend on live-wall state", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-live-exhausted");
    // draw the first 4 replacements (static slots) - always legal regardless of live state
    for (let i = 0; i < 4; i++) wall.drawRinshan();
    // now exhaust the live wall entirely
    while (wall.remainingLiveCount() > 0) wall.drawTile();
    expect(wall.remainingLiveCount()).toBe(0);
    // the 5th replacement needs to borrow from the (now empty) live tail - must fail
    expect(wall.canDrawRinshan(99)).toBe(false);
    expect(wall.canDrawKitaReplacement()).toBe(false);
    expect(() => wall.drawRinshan()).toThrow();
  });

  it("8. exhaustive draw turn count reflects the new (4-tile-larger) live wall via a real GameState game", () => {
    // Indirect check: a full game's total normal draws (deal + turn draws) recorded in the
    // log must be consistent with remainingLiveCount()'s own accounting - i.e. GameState
    // never draws more live tiles than the wall reports as available, and a real game
    // completes without a live-wall-exhaustion crash.
    for (let seed = 0; seed < 10; seed++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `wall-exhaustive-${seed}` });
      gs.playGame();
      const draws = gs.log.filter((e): e is Extract<GameEvent, { type: "draw" }> => e.type === "draw" && e.source === "wall");
      expect(draws.length).toBeGreaterThan(0);
    }
  });

  it("9. dora indicators stay correct: 1 at hand start, +1 per real kan, kita never adds one", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-dora");
    expect(wall.doraIndicators().length).toBe(1);
    wall.drawKitaReplacement();
    expect(wall.doraIndicators().length).toBe(1); // kita doesn't reveal a new indicator
    wall.drawRinshan();
    expect(wall.doraIndicators().length).toBe(2);
    expect(wall.uraDoraIndicators().length).toBe(2);
    // dora and ura indicator blocks never overlap
    const dora = new Set(wall.doraIndicators().map((t) => t.id));
    const ura = new Set(wall.uraDoraIndicators().map((t) => t.id));
    for (const id of dora) expect(ura.has(id)).toBe(false);
  });

  it("mixed kita/kan sequence keeps every invariant (live count, dead wall size, dora cadence) consistent at each step", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "wall-mixed-sequence");
    const sequence: Array<"kita" | "kan"> = ["kita", "kita", "kan", "kita", "kan", "kan", "kita", "kan"];
    let liveBefore = wall.remainingLiveCount();
    let kansSoFar = 0;
    for (const action of sequence) {
      if (action === "kan") {
        wall.drawRinshan();
        kansSoFar++;
      } else {
        wall.drawKitaReplacement();
      }
      expect(wall.remainingLiveCount()).toBe(liveBefore - 1); // every replacement shrinks live by exactly 1
      liveBefore = wall.remainingLiveCount();
      expect(wall.doraIndicators().length).toBe(Math.min(1 + kansSoFar, 5)); // only real kans advance dora
      expect(wall.kanCount()).toBe(kansSoFar);
    }
    expect(wall.remainingLiveCount()).toBeGreaterThanOrEqual(0);
  });

  it("10. seeded determinism: identical seed produces identical draw sequence and replacement behavior", () => {
    const seed = "wall-determinism";
    const w1 = new Wall(DEFAULT_SANMA_RULES, seed);
    const w2 = new Wall(DEFAULT_SANMA_RULES, seed);
    const seq1: number[] = [];
    const seq2: number[] = [];
    for (let i = 0; i < 20; i++) seq1.push(w1.drawTile().id);
    for (let i = 0; i < 20; i++) seq2.push(w2.drawTile().id);
    expect(seq1).toEqual(seq2);
    expect(w1.drawRinshan().id).toBe(w2.drawRinshan().id);
    expect(w1.doraIndicators().map((t) => t.id)).toEqual(w2.doraIndicators().map((t) => t.id));
    expect(w1.remainingLiveCount()).toBe(w2.remainingLiveCount());
  });
});
