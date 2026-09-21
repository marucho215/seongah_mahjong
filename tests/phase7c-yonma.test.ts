import { describe, expect, it } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { SeededRng } from "../src/core/rng.js";
import { allSeats } from "../src/core/seats.js";
import { buildTileSet } from "../src/core/tiles.js";
import { Wall } from "../src/core/Wall.js";
import { MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";
import { MAJSOUL_YONMA_RULESET } from "../src/rules/RuleSet.js";

describe("Phase 7C yonma physical ruleset", () => {
  it("defines four seats and the full 136-tile set", () => {
    expect(MAJSOUL_YONMA_RULESET.playerCount).toBe(4);
    expect(MAJSOUL_YONMA_RULESET.calls.allowChi).toBe(true);
    expect(MAJSOUL_YONMA_RULESET.calls.allowKita).toBe(false);
    expect(MAJSOUL_YONMA_RULESET.calls.maxKans).toBe(4);
    expect(MAJSOUL_YONMA_RULESET.rounds.handsPerRound).toBe(4);
    expect(MAJSOUL_YONMA_RULESET.wall).toMatchObject({
      layout: "yonma-standard",
      deadWallSize: 14,
      initialReplacementSlots: 4,
      doraIndicatorSlots: 5,
    });
    expect(allSeats(MAJSOUL_YONMA_RULESET.playerCount)).toEqual([0, 1, 2, 3]);

    const tiles = buildTileSet(MAJSOUL_YONMA_RULES);
    expect(tiles).toHaveLength(136);
    const counts = new Map<string, number>();
    for (const tile of tiles) counts.set(tile.kind, (counts.get(tile.kind) ?? 0) + 1);
    expect(counts.size).toBe(34);
    expect([...counts.values()].every((count) => count === 4)).toBe(true);
    for (let rank = 2; rank <= 8; rank++) expect(counts.get(`m${rank}`)).toBe(4);

    const redKinds = tiles.filter((tile) => tile.isRed).map((tile) => tile.kind).sort();
    expect(redKinds).toEqual(["m5", "p5", "s5"]);
  });

  it("uses a 14-tile yonma dead wall with R1-R4 then five dora/ura pairs", () => {
    const seed = "phase7c-yonma-wall-layout";
    const expectedAll = new SeededRng(seed).shuffle(buildTileSet(MAJSOUL_YONMA_RULES));
    const expectedDead = expectedAll.slice(-14);
    const expectedReplacements = expectedDead.slice(0, 4);
    const expectedDora = [expectedDead[4]!, expectedDead[6]!, expectedDead[8]!, expectedDead[10]!, expectedDead[12]!];
    const expectedUra = [expectedDead[5]!, expectedDead[7]!, expectedDead[9]!, expectedDead[11]!, expectedDead[13]!];

    const wall = new Wall(MAJSOUL_YONMA_RULES, seed);
    expect(wall.deadWallTileCount()).toBe(14);
    expect(wall.doraIndicators().map((tile) => tile.id)).toEqual([expectedDora[0]!.id]);
    expect(wall.uraDoraIndicators().map((tile) => tile.id)).toEqual([expectedUra[0]!.id]);

    for (let i = 0; i < 4; i++) {
      const liveBefore = wall.remainingLiveCount();
      expect(wall.canDrawRinshan(MAJSOUL_YONMA_RULES.maxKans)).toBe(true);
      expect(wall.drawRinshan().id).toBe(expectedReplacements[i]!.id);
      expect(wall.remainingLiveCount()).toBe(liveBefore - 1);
      expect(wall.deadWallTileCount()).toBe(14);
      expect(wall.doraIndicators().map((tile) => tile.id)).toEqual(expectedDora.slice(0, i + 2).map((tile) => tile.id));
      expect(wall.uraDoraIndicators().map((tile) => tile.id)).toEqual(expectedUra.slice(0, i + 2).map((tile) => tile.id));
    }

    expect(wall.canDrawRinshan(MAJSOUL_YONMA_RULES.maxKans)).toBe(false);
    expect(() => wall.drawRinshan()).toThrow();
  });

  it("deals 13 tiles to four seats and can perform only the dealer bootstrap draw", () => {
    const gs = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7c-yonma-bootstrap" });
    expect(gs.scores).toEqual([25000, 25000, 25000, 25000]);
    expect(gs.characterProfiles).toHaveLength(4);

    const dealtOnly = gs.bootstrapPhysicalHand();
    expect(dealtOnly.hands).toHaveLength(4);
    expect(dealtOnly.hands.map((hand) => hand.concealed.length)).toEqual([13, 13, 13, 13]);
    expect(dealtOnly.hands.reduce((sum, hand) => sum + hand.concealed.length, 0) + dealtOnly.wall.remainingLiveCount() + dealtOnly.wall.deadWallTileCount()).toBe(136);

    const withDealerDraw = gs.bootstrapPhysicalHand(true);
    expect(withDealerDraw.dealerFirstDraw).toBeDefined();
    expect(withDealerDraw.hands.map((hand) => hand.concealed.length)).toEqual([14, 13, 13, 13]);
    expect(withDealerDraw.hands.reduce((sum, hand) => sum + hand.concealed.length, 0) + withDealerDraw.wall.remainingLiveCount() + withDealerDraw.wall.deadWallTileCount()).toBe(136);
  });

});
