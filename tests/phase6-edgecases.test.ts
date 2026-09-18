import { describe, it, expect } from "vitest";
import { Wall } from "../src/core/Wall.js";
import { Hand } from "../src/core/Hand.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { canAnkan, applyAnkan } from "../src/actions/calls.js";
import { canKita, applyKita } from "../src/actions/kita.js";
import { GameState } from "../src/core/GameState.js";
import { resolveRonWinners } from "../src/core/ronResolution.js";
import type { Tile } from "../src/core/tiles.js";
import type { GameEvent } from "../src/core/GameLog.js";

let nextId = 40000;
function t(kind: string): Tile {
  const suit = kind[0] as "m" | "p" | "s" | "z";
  const rank = Number(kind.slice(1));
  return { id: nextId++, kind, suit, rank, isRed: false };
}

// ---------------------------------------------------------------------------
// 5. Kan / kita / dead-wall invariants
// ---------------------------------------------------------------------------
describe("kan -> dora -> rinshan -> kita -> rinshan -> exhaustion chain", () => {
  it("keeps total/live/dead-wall/dora-indicator counts valid at every step (Mahjong Soul sanma: 14-tile dead wall at rest, 8-draw shared kan/kita replacement cap)", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "kan-kita-chain");
    const total = wall.totalTiles;
    expect(total).toBe(108);

    wall.dealInitial(3, 13); // 39 tiles dealt
    expect(wall.remainingLiveCount()).toBe(total - 14 - 39); // 55

    // --- step 1: kan (ankan-style replacement draw) ---
    const liveBefore1 = wall.remainingLiveCount();
    const doraBefore1 = wall.doraIndicators().length;
    const rinshan1 = wall.drawRinshan();
    expect(rinshan1).toBeDefined();
    expect(wall.remainingLiveCount()).toBe(liveBefore1 - 1); // live wall shrinks by one extra tile
    expect(wall.doraIndicators().length).toBe(doraBefore1 + 1); // a new kan-dora is revealed
    expect(wall.kanCount()).toBe(1);

    // --- step 2: kita replacement draw (shares the pool, never reveals a new indicator) ---
    const liveBefore2 = wall.remainingLiveCount();
    const doraBefore2 = wall.doraIndicators().length;
    const kitaTile = wall.drawKitaReplacement();
    expect(kitaTile).toBeDefined();
    expect(wall.remainingLiveCount()).toBe(liveBefore2 - 1);
    expect(wall.doraIndicators().length).toBe(doraBefore2); // no new reveal from kita

    // --- step 3: a second kan ---
    const liveBefore3 = wall.remainingLiveCount();
    wall.drawRinshan();
    expect(wall.remainingLiveCount()).toBe(liveBefore3 - 1);
    expect(wall.kanCount()).toBe(2);

    // --- drain the rest of the live wall via normal draws, checking conservation throughout ---
    const drawnIds = new Set<number>();
    while (wall.remainingLiveCount() > 0) {
      const tile = wall.drawTile();
      expect(drawnIds.has(tile.id)).toBe(false); // never the same physical tile twice
      drawnIds.add(tile.id);
    }
    expect(wall.remainingLiveCount()).toBe(0);
    expect(wall.isExhausted()).toBe(true);
    expect(() => wall.drawTile()).toThrow();

    // dead wall's dora indicator count never exceeds its 5-slot reservation, however many
    // kan reveals were requested (kita never adds one)
    expect(wall.doraIndicators().length).toBeLessThanOrEqual(5);
    expect(wall.uraDoraIndicators().length).toBeLessThanOrEqual(5);
  });

  it("regression: kita never throws when the live wall is already exhausted", () => {
    // canDrawKitaReplacement must correctly refuse once there's nothing left to draw -
    // this is what GameState checks before ever calling drawKitaReplacement, so a north
    // tile drawn on the very last live tile doesn't crash.
    const wall = new Wall(DEFAULT_SANMA_RULES, "kita-exhaustion-regression");
    wall.dealInitial(3, 13);
    for (let i = 0; i < 8; i++) wall.drawRinshan(); // exhaust the shared 8-slot pool first
    expect(wall.canDrawKitaReplacement()).toBe(false);
    expect(() => {
      if (wall.canDrawKitaReplacement()) wall.drawKitaReplacement();
    }).not.toThrow();
  });

  it("kan and kita never hand out the same physical tile from the shared 8-slot pool", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "kan-kita-no-duplicate-tiles");
    wall.dealInitial(3, 13);
    const seen = new Set<number>();
    // alternate kan/kita draws to fill all 8 shared slots
    for (let i = 0; i < 4; i++) {
      const kanTile = wall.drawRinshan();
      expect(seen.has(kanTile.id)).toBe(false);
      seen.add(kanTile.id);
      const kitaTile = wall.drawKitaReplacement();
      expect(seen.has(kitaTile.id)).toBe(false);
      seen.add(kitaTile.id);
    }
    expect(seen.size).toBe(8);
    expect(wall.canDrawKitaReplacement()).toBe(false);
    expect(() => wall.drawRinshan()).toThrow();
    expect(() => wall.drawKitaReplacement()).toThrow();
  });

  it("a hand's tile count is conserved through an ankan: -4 concealed, +1 meld of 4, then +1 on replacement draw", () => {
    const hand = new Hand();
    hand.dealIn([t("z5"), t("z5"), t("z5"), t("z5"), t("m1"), t("m9"), t("p1"), t("p2"), t("p3"), t("s1"), t("s2"), t("s3"), t("s4")]);
    const beforeCount = hand.allTileCount();
    expect(beforeCount).toBe(13);
    expect(canAnkan(hand, "z5")).toBe(true);

    applyAnkan(hand, "z5");
    expect(hand.concealed.length).toBe(9);
    expect(hand.melds.length).toBe(1);
    expect(hand.melds[0]!.tiles.length).toBe(4);
    expect(hand.allTileCount()).toBe(beforeCount); // -4 concealed +4 in the meld, net unchanged

    hand.addDrawn(t("z6")); // stand-in for the rinshan replacement draw
    expect(hand.allTileCount()).toBe(beforeCount + 1); // now 14, needs a discard
  });

  it("a hand's tile count is conserved through kita: -1 concealed into kitaTiles, then +1 on replacement draw", () => {
    const hand = new Hand();
    hand.dealIn([t("z4"), t("m1"), t("m9"), t("p1"), t("p2"), t("p3"), t("s1"), t("s2"), t("s3"), t("s4"), t("s5"), t("s6"), t("z1")]);
    const beforeCount = hand.allTileCount();
    expect(beforeCount).toBe(13);
    expect(canKita(hand, true)).toBe(true);

    const northTile = hand.tilesOfKind("z4")[0]!;
    applyKita(hand, northTile.id);
    expect(hand.concealed.length).toBe(12);
    expect(hand.kitaTiles.length).toBe(1);
    expect(hand.allTileCount()).toBe(beforeCount); // -1 concealed, +1 kitaTiles, net unchanged

    hand.addDrawn(t("p9")); // stand-in for the replacement draw
    expect(hand.allTileCount()).toBe(beforeCount + 1);
  });
});

// ---------------------------------------------------------------------------
// 7. Full-round state
// ---------------------------------------------------------------------------
function handSlices(log: readonly GameEvent[]): { start: number; end: number }[] {
  const starts = log.map((e, i) => (e.type === "hand_start" ? i : -1)).filter((i) => i >= 0);
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? log.length }));
}

describe("dealer continuation, rotation, and honba across many played hands", () => {
  it("matches renchan rules for every hand actually resolved, in both game lengths", () => {
    let handsChecked = 0;
    for (const rules of [DEFAULT_SANMA_RULES, { ...DEFAULT_SANMA_RULES, gameLength: "east-south" as const }]) {
      for (let seed = 0; seed < 4; seed++) {
        const gs = new GameState({ rules, seed: `dealer-rotation-${rules.gameLength}-${seed}` });
        gs.playGame();
        for (const { start, end } of handSlices(gs.log)) {
          const startEvt = gs.log[start];
          const endEvt = gs.log[end - 1];
          if (startEvt?.type !== "hand_start" || endEvt?.type !== "hand_end") continue;
          const resolution = gs.log.slice(start, end).find((e) => e.type === "win" || e.type === "exhaustive_draw");
          if (!resolution) continue;

          let dealerRepeats: boolean;
          if (resolution.type === "win") {
            const winnersThisHand = gs.log.slice(start, end).filter((e) => e.type === "win");
            dealerRepeats = winnersThisHand.some((w) => w.type === "win" && w.player === startEvt.dealer) && rules.renchanOnDealerWin;
          } else {
            dealerRepeats = resolution.tenpaiPlayers.includes(startEvt.dealer) && rules.renchanOnDealerTenpaiDraw;
          }

          const expectedNextDealer = dealerRepeats ? startEvt.dealer : (startEvt.dealer + 1) % 3;
          expect(endEvt.nextDealer).toBe(expectedNextDealer);
          // Mahjong Soul sanma: an exhaustive draw always carries honba forward, even when
          // the dealer was noten and dealership rotates - only a WIN resets honba to 0 when
          // the dealer changes (a win always resolves the hand cleanly, an exhaustive draw
          // never "resets the counter", it just keeps incrementing).
          const expectedHonba = resolution.type === "exhaustive_draw" ? startEvt.honba + 1 : dealerRepeats ? startEvt.honba + 1 : 0;
          expect(endEvt.honba).toBe(expectedHonba);
          handsChecked++;
        }
      }
    }
    expect(handsChecked).toBeGreaterThan(5);
  });
});

describe("riichi-stick (kyotaku) carryover on exhaustive draw", () => {
  it("carries every declared-but-unpaid stick into the next hand's starting kyotaku", () => {
    let checked = 0;
    for (let seed = 0; seed < 15; seed++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `kyotaku-carryover-${seed}` });
      gs.playGame();
      for (const { start, end } of handSlices(gs.log)) {
        const startEvt = gs.log[start];
        const endEvt = gs.log[end - 1];
        if (startEvt?.type !== "hand_start" || endEvt?.type !== "hand_end") continue;
        const slice = gs.log.slice(start, end);
        const isDraw = slice.some((e) => e.type === "exhaustive_draw");
        if (!isDraw) continue;
        const riichiCount = slice.filter((e) => e.type === "riichi").length;
        expect(endEvt.kyotaku).toBe(startEvt.kyotaku + riichiCount);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("tenpai/noten exhaustive-draw payments match the 2000-point pot formula exactly (Mahjong Soul sanma)", () => {
  it("splits the pot evenly among tenpai players, paid evenly by noten players", () => {
    let checked = 0;
    for (let seed = 0; seed < 15; seed++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `noten-payment-${seed}` });
      gs.playGame();
      for (const evt of gs.log) {
        if (evt.type !== "exhaustive_draw") continue;
        checked++;
        const n = evt.tenpaiPlayers.length;
        if (n === 0 || n === 3) {
          for (let p = 0; p < 3; p++) expect(evt.deltas[p]).toBe(0);
          continue;
        }
        const pot = DEFAULT_SANMA_RULES.notenPenaltyTotal;
        const perReceiver = pot / n;
        const perPayer = pot / (3 - n);
        for (let p = 0; p < 3; p++) {
          const expected = evt.tenpaiPlayers.includes(p) ? perReceiver : -perPayer;
          expect(evt.deltas[p]).toBe(expected);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("one tenpai player receives the full 2000 pot, split 1000/1000 from the two noten players", () => {
    let found = false;
    for (let seed = 0; seed < 20 && !found; seed++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `noten-1v2-${seed}` });
      gs.playGame();
      for (const evt of gs.log) {
        if (evt.type !== "exhaustive_draw" || evt.tenpaiPlayers.length !== 1) continue;
        found = true;
        const tenpaiP = evt.tenpaiPlayers[0]!;
        expect(evt.deltas[tenpaiP]).toBe(2000);
        for (let p = 0; p < 3; p++) if (p !== tenpaiP) expect(evt.deltas[p]).toBe(-1000);
      }
    }
    expect(found).toBe(true);
  });
});

describe("double-ron / atamahane policy (unit level, exact)", () => {
  it("atamahane keeps only the closest eligible player", () => {
    const winners = resolveRonWinners([{ player: 1 }, { player: 2 }], "atamahane");
    expect(winners).toEqual([{ player: 1 }]);
  });

  it("'all' mode pays out every eligible player", () => {
    const winners = resolveRonWinners([{ player: 1 }, { player: 2 }], "all");
    expect(winners).toEqual([{ player: 1 }, { player: 2 }]);
  });

  it("either mode returns nothing when nobody is eligible", () => {
    expect(resolveRonWinners([], "atamahane")).toEqual([]);
    expect(resolveRonWinners([], "all")).toEqual([]);
  });

  it("GameState actually honors 'all' mode when configured (no crash across many games)", () => {
    const rules = { ...DEFAULT_SANMA_RULES, doubleRonMode: "all" as const };
    for (let seed = 0; seed < 5; seed++) {
      const gs = new GameState({ rules, seed: `all-ron-mode-${seed}` });
      expect(() => gs.playGame()).not.toThrow();
    }
  });
});
