import { describe, it, expect } from "vitest";
import { Hand } from "../src/core/Hand.js";
import { Wall } from "../src/core/Wall.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import type { Tile } from "../src/core/tiles.js";
import { tilesToCounts } from "../src/core/tileIndex.js";
import { computeWinningTiles, isTenpai } from "../src/actions/winSearch.js";
import { FuritenTracker } from "../src/actions/furiten.js";
import { canDeclareRiichi, riichiDiscardCandidates } from "../src/actions/riichi.js";
import {
  canChi,
  canPon,
  applyPon,
  canDaiminkan,
  applyDaiminkan,
  canAnkan,
  applyAnkan,
  canShouminkan,
  applyShouminkan,
  canDeclareAnyKan,
} from "../src/actions/calls.js";
import { canKita, applyKita } from "../src/actions/kita.js";

let nextId = 1000;
function t(kind: string): Tile {
  const suit = kind[0] as "m" | "p" | "s" | "z";
  const rank = Number(kind.slice(1));
  return { id: nextId++, kind, suit, rank, isRed: false };
}
function tiles(kinds: string[]): Tile[] {
  return kinds.map(t);
}

describe("winning tile search", () => {
  it("finds the correct wait set for a ryanmen tenpai hand", () => {
    const hand = tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "z1", "z1"]);
    const winners = computeWinningTiles(tilesToCounts(hand), 0, DEFAULT_SANMA_RULES);
    expect(winners.sort()).toEqual(["s6", "s9"]);
  });

  it("finds a tanki wait set of exactly one kind", () => {
    const hand = tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "s9", "z1"]);
    const winners = computeWinningTiles(tilesToCounts(hand), 0, DEFAULT_SANMA_RULES);
    expect(winners).toEqual(["z1"]);
  });

  it("isTenpai is false for a hand two away from tenpai", () => {
    const hand = tiles(["m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "z3", "z4", "z5", "z6", "p5"]);
    expect(isTenpai(tilesToCounts(hand), 0, DEFAULT_SANMA_RULES)).toBe(false);
  });
});

describe("furiten", () => {
  it("is furiten permanently if a winning tile is in the player's own river", () => {
    const tracker = new FuritenTracker();
    expect(tracker.isFuriten(["s6", "s9"], ["p1", "s6"])).toBe(true);
  });

  it("is not furiten when no winning tile is in the river and nothing was missed", () => {
    const tracker = new FuritenTracker();
    expect(tracker.isFuriten(["s6", "s9"], ["p1", "p2"])).toBe(false);
  });

  it("clears temporary furiten on the player's own next draw", () => {
    const tracker = new FuritenTracker();
    tracker.onMissedRonChance();
    expect(tracker.isFuriten(["s6"], [])).toBe(true);
    tracker.onOwnDraw();
    expect(tracker.isFuriten(["s6"], [])).toBe(false);
  });

  it("locks furiten permanently for the rest of the hand once riichi has missed a ron", () => {
    const tracker = new FuritenTracker();
    tracker.onDeclareRiichi();
    tracker.onMissedRonChance();
    expect(tracker.isFuriten(["s6"], [])).toBe(true);
    tracker.onOwnDraw();
    expect(tracker.isFuriten(["s6"], [])).toBe(true); // riichi furiten does not clear
  });
});

describe("riichi eligibility", () => {
  it("allows riichi on a closed tenpai hand with enough score and wall tiles", () => {
    const hand = new Hand();
    hand.dealIn(tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "s9", "z1"]));
    expect(canDeclareRiichi(hand, 25000, 10)).toBe(true);
  });

  it("forbids riichi on an open hand", () => {
    const hand = new Hand();
    hand.dealIn(tiles(["p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "s9", "z1"]));
    hand.melds.push({ type: "pon", tiles: tiles(["m1", "m1", "m1"]) });
    expect(canDeclareRiichi(hand, 25000, 10)).toBe(false);
  });

  it("forbids riichi with insufficient score", () => {
    const hand = new Hand();
    hand.dealIn(tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "s9", "z1"]));
    expect(canDeclareRiichi(hand, 500, 10)).toBe(false);
  });

  it("finds correct riichi discard candidates from a 14-tile hand", () => {
    const hand = new Hand();
    // 14 tiles: discarding z2 keeps tenpai (waits s6/s9); discarding anything else breaks it
    hand.dealIn(tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "z1", "z1", "z2"]));
    const candidateIds = riichiDiscardCandidates(hand);
    const candidateKinds = candidateIds.map((id) => hand.concealed.find((c) => c.id === id)!.kind);
    expect(candidateKinds).toEqual(["z2"]);
  });
});

describe("sanma forbids chi", () => {
  it("canChi always returns false", () => {
    expect(canChi(DEFAULT_SANMA_RULES)).toBe(false);
  });
});

describe("pon", () => {
  it("allows pon with two matching concealed tiles and removes them correctly", () => {
    const hand = new Hand();
    hand.dealIn(tiles(["p5", "p5", "m1", "m9"]));
    const discarded = t("p5");
    expect(canPon(hand, "p5")).toBe(true);
    const meld = applyPon(hand, discarded, 2);
    expect(meld.tiles.length).toBe(3);
    expect(hand.concealed.length).toBe(2);
    expect(hand.melds.length).toBe(1);
  });

  it("forbids pon without two matching tiles", () => {
    const hand = new Hand();
    hand.dealIn(tiles(["p5", "m1", "m9"]));
    expect(canPon(hand, "p5")).toBe(false);
  });
});

describe("kan variants", () => {
  it("open kan (daiminkan) takes 3 concealed + the discard", () => {
    const hand = new Hand();
    hand.dealIn(tiles(["z5", "z5", "z5", "m1"]));
    expect(canDaiminkan(hand, "z5")).toBe(true);
    const meld = applyDaiminkan(hand, t("z5"), 1);
    expect(meld.type).toBe("kan_open");
    expect(meld.tiles.length).toBe(4);
    expect(hand.concealed.length).toBe(1);
  });

  it("closed kan (ankan) takes all 4 from concealed hand", () => {
    const hand = new Hand();
    hand.dealIn(tiles(["z5", "z5", "z5", "z5", "m1"]));
    expect(canAnkan(hand, "z5")).toBe(true);
    const meld = applyAnkan(hand, "z5");
    expect(meld.type).toBe("kan_closed");
    expect(meld.tiles.length).toBe(4);
    expect(hand.concealed.length).toBe(1);
  });

  it("added kan (shouminkan) upgrades an existing pon using the drawn tile", () => {
    const hand = new Hand();
    hand.dealIn(tiles(["p5", "p5", "m1"]));
    applyPon(hand, t("p5"), 0);
    const drawn = t("p5");
    hand.addDrawn(drawn);
    expect(canShouminkan(hand, "p5")).toBe(true);
    const meld = applyShouminkan(hand, drawn.id);
    expect(meld.type).toBe("kan_added");
    expect(meld.tiles.length).toBe(4);
  });

  it("enforces the configured max-kan limit (a rule about kan specifically, separate from the shared 8-slot rinshan pool)", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "kan-limit-test");
    wall.dealInitial(3, 13);
    for (let i = 0; i < DEFAULT_SANMA_RULES.maxKans; i++) {
      expect(canDeclareAnyKan(wall, DEFAULT_SANMA_RULES)).toBe(true);
      wall.drawRinshan();
    }
    // maxKans (4) is reached, but the physical shared pool (8 slots, kan+kita) still has
    // room - canDeclareAnyKan correctly refuses on the rule, even though the Wall itself
    // would still physically permit a draw at this point.
    expect(canDeclareAnyKan(wall, DEFAULT_SANMA_RULES)).toBe(false);
    expect(wall.kanCount()).toBe(DEFAULT_SANMA_RULES.maxKans);
  });

  it("throws once the shared 8-slot rinshan pool itself is physically exhausted", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "rinshan-pool-exhaustion-test");
    wall.dealInitial(3, 13);
    for (let i = 0; i < 8; i++) wall.drawRinshan();
    expect(() => wall.drawRinshan()).toThrow();
  });
});

describe("kita (north extraction)", () => {
  it("removes the north tile into kitaTiles and draws a replacement without consuming live-wall boundary", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "kita-test");
    const [h0] = wall.dealInitial(3, 13);
    const hand = new Hand();
    hand.dealIn(h0!);
    // force a north tile into the hand for this test regardless of what was dealt
    const northTile = t("z4");
    hand.concealed.push(northTile);

    expect(canKita(hand, DEFAULT_SANMA_RULES.kitaEnabled)).toBe(true);
    const before = wall.remainingLiveCount();
    applyKita(hand, northTile.id);
    expect(hand.kitaTiles.length).toBe(1);
    expect(hand.concealed.some((t) => t.id === northTile.id)).toBe(false);

    const replacement = wall.drawKitaReplacement();
    expect(replacement).toBeDefined();
    expect(wall.remainingLiveCount()).toBe(before - 1);
    // Mahjong Soul rule: kita never reveals a new dora indicator by itself
    expect(wall.doraIndicators().length).toBe(1);
  });

  it("is unavailable when kita is disabled by rule config", () => {
    const hand = new Hand();
    hand.dealIn([t("z4")]);
    expect(canKita(hand, false)).toBe(false);
  });
});
