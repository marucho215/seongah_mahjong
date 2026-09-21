import { describe, expect, it } from "vitest";
import { FuritenTracker } from "../src/actions/furiten.js";
import { applyKita, canKita, canRiichiKita, chooseKitaAction } from "../src/actions/kita.js";
import { computeWinningTiles } from "../src/actions/winSearch.js";
import { resolveRonBeforeInterruption } from "../src/core/GameState.js";
import { Hand } from "../src/core/Hand.js";
import { tilesToCounts } from "../src/core/tileIndex.js";
import type { Tile, TileKind } from "../src/core/tiles.js";
import { Wall } from "../src/core/Wall.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

let nextId = 107000;
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

describe("FF-07 Mahjong Soul post-riichi Kita", () => {
  it("allows only the physical just-drawn North, not a North locked in the riichi hand", () => {
    const legal = riichiHand(["z4", "p1", "p2"], "z4");
    const unrelatedDraw = riichiHand(["z4", "p1", "p2"], "p9");
    const detachedNorth = tile("z4");

    expect(canKita(legal.hand, true)).toBe(true);
    expect(canRiichiKita(legal.hand, legal.drawn, true)).toBe(true);
    expect(canRiichiKita(unrelatedDraw.hand, unrelatedDraw.drawn, true)).toBe(false);
    expect(canRiichiKita(legal.hand, detachedNorth, true)).toBe(false);
    expect(canRiichiKita(legal.hand, legal.drawn, false)).toBe(false);
  });

  it("can select Kita even when the drawn North is the current winning tile without causing own furiten", () => {
    const frozen: TileKind[] = [
      "m1", "m1", "m9", "m9", "p1", "p1", "p4", "p4", "p7", "p7", "s2", "s2", "z4",
    ];
    const { hand, drawn } = riichiHand(frozen, "z4");
    const waits = computeWinningTiles(tilesToCounts(hand.concealed.filter((held) => held.id !== drawn.id)), 0, DEFAULT_SANMA_RULES);
    const furiten = new FuritenTracker();
    furiten.onDeclareRiichi();

    expect(waits).toContain("z4");
    expect(chooseKitaAction(hand, true, () => true)).toBe("kita");
    applyKita(hand, drawn.id);

    expect(hand.hasTileId(drawn.id)).toBe(false);
    expect(hand.countOfKind("z4")).toBe(1);
    expect(furiten.isFuriten(waits, [])).toBe(false);
  });

  it("passes into the normal riichi tsumogiri path and leaves locked tiles untouched", () => {
    const { hand, drawn } = riichiHand(["z4", "p1", "p2"], "z4");
    const lockedNorth = hand.tilesOfKind("z4").find((held) => held.id !== drawn.id)!;

    expect(chooseKitaAction(hand, true, () => false)).toBe("pass");
    const discarded = hand.discardById(drawn.id, { tsumogiri: true });

    expect(discarded.id).toBe(drawn.id);
    expect(hand.hasTileId(lockedNorth.id)).toBe(true);
    expect(hand.kitaTiles).toHaveLength(0);
  });

  it("offers each consecutive drawn North separately and preserves Kita replacement state", () => {
    const { hand, drawn } = riichiHand(["p1", "p2", "p3"], "z4");
    const decisions = [true, true];
    let decisionCalls = 0;
    const wall = new Wall(DEFAULT_SANMA_RULES, "ff07-consecutive");
    const visibleDoraBefore = wall.doraIndicators().length;
    const liveBefore = wall.remainingLiveCount();

    expect(chooseKitaAction(hand, true, () => decisions[decisionCalls++]!)).toBe("kita");
    applyKita(hand, drawn.id);
    wall.drawKitaReplacement();
    const secondNorth = tile("z4");
    hand.addDrawn(secondNorth);

    expect(canRiichiKita(hand, secondNorth, true)).toBe(true);
    expect(chooseKitaAction(hand, true, () => decisions[decisionCalls++]!)).toBe("kita");
    expect(decisionCalls).toBe(2);
    expect(hand.kitaTiles).toHaveLength(1);
    expect(wall.remainingLiveCount()).toBe(liveBefore - 1);
    expect(wall.doraIndicators()).toHaveLength(visibleDoraBefore);
  });

  it("keeps the ron window before ippatsu interruption and preserves missed-ron furiten", () => {
    let ippatsu = true;
    const ron = resolveRonBeforeInterruption(() => [2], () => { ippatsu = false; });
    expect(ron).toEqual([2]);
    expect(ippatsu).toBe(true);

    const noRon = resolveRonBeforeInterruption(() => [], () => { ippatsu = false; });
    expect(noRon).toEqual([]);
    expect(ippatsu).toBe(false);

    const opponent = new FuritenTracker();
    opponent.onDeclareRiichi();
    opponent.onMissedRonChance();
    expect(opponent.isFuriten(["z4"], [])).toBe(true);
  });

  it("does not enable Kita in yonma and leaves non-riichi FF-06 choice semantics intact", () => {
    const nonRiichi = new Hand();
    nonRiichi.dealIn([tile("z4")]);
    const { hand, drawn } = riichiHand(["p1", "p2", "p3"], "z4");

    expect(chooseKitaAction(nonRiichi, true, () => false)).toBe("pass");
    expect(canRiichiKita(hand, drawn, MAJSOUL_YONMA_RULES.kitaEnabled)).toBe(false);
  });
});
