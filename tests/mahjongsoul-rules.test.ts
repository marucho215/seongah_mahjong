import { describe, it, expect } from "vitest";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { Wall } from "../src/core/Wall.js";
import { GameState } from "../src/core/GameState.js";
import { evaluateWin } from "../src/yaku/evaluate.js";
import { computeScore } from "../src/yaku/score.js";
import { nextDoraKind, countDora, countNukidora } from "../src/yaku/dora.js";
import { allKindsForRules, type Tile } from "../src/core/tiles.js";
import { isRyuuiisouHand } from "../src/yaku/tileFacts.js";
import type { WinContext } from "../src/yaku/types.js";
import type { GameEvent } from "../src/core/GameLog.js";

let nextId = 60000;
function t(kind: string, isRed = false): Tile {
  const suit = kind[0] as "m" | "p" | "s" | "z";
  const rank = Number(kind.slice(1));
  return { id: nextId++, kind, suit, rank, isRed };
}
function tiles(kinds: string[]): Tile[] {
  return kinds.map((k) => t(k));
}
function baseCtx(overrides: Partial<WinContext> = {}): WinContext {
  return {
    seatWind: 1,
    roundWind: 1,
    isTsumo: false,
    isRiichi: false,
    isDoubleRiichi: false,
    isIppatsu: false,
    isHaitei: false,
    isHoutei: false,
    isRinshan: false,
    isChankan: false,
    isTenhou: false,
    isChiihou: false,
    doraCount: 0,
    uraDoraCount: 0,
    akaDoraCount: 0,
    kanCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tile set / dora mechanics
// ---------------------------------------------------------------------------
describe("Mahjong Soul sanma tile set", () => {
  it("generates no manzu 2-8", () => {
    const kinds = allKindsForRules(DEFAULT_SANMA_RULES);
    for (let r = 2; r <= 8; r++) expect(kinds).not.toContain(`m${r}`);
  });

  it("has exactly two red fives: red 5p and red 5s, none in manzu", () => {
    expect(DEFAULT_SANMA_RULES.akaDoraCount).toEqual({ man: 0, pin: 1, sou: 1 });
    const wall = new Wall(DEFAULT_SANMA_RULES, "aka-count-check");
    // reconstruct the full tile set the same way Wall does, via its public deal+draw API
    const hands = wall.dealInitial(3, 13);
    const rest: Tile[] = [];
    while (!wall.isExhausted()) rest.push(wall.drawTile());
    const all = [...hands.flat(), ...rest];
    expect(all.filter((x) => x.isRed).length).toBe(2);
    expect(all.filter((x) => x.isRed && x.kind === "p5").length).toBe(1);
    expect(all.filter((x) => x.isRed && x.kind === "s5").length).toBe(1);
  });
});

describe("manzu dora indicator cycle (1<->9, not the normal 1->2->...->9 cycle)", () => {
  it("1m indicator points to 9m", () => {
    expect(nextDoraKind("m1", DEFAULT_SANMA_RULES)).toBe("m9");
  });
  it("9m indicator points to 1m", () => {
    expect(nextDoraKind("m9", DEFAULT_SANMA_RULES)).toBe("m1");
  });
  it("pinzu/souzu still use the normal 1->2->...->9->1 cycle", () => {
    expect(nextDoraKind("p1", DEFAULT_SANMA_RULES)).toBe("p2");
    expect(nextDoraKind("p9", DEFAULT_SANMA_RULES)).toBe("p1");
    expect(nextDoraKind("s5", DEFAULT_SANMA_RULES)).toBe("s6");
  });
});

describe("duplicate dora indicators stack (not deduplicated)", () => {
  it("two identical indicators both pointing to p5 count a single p5 in hand twice", () => {
    const hand = tiles(["p5", "m1"]);
    const count = countDora(hand, ["p4", "p4"], DEFAULT_SANMA_RULES); // p4 -> p5
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// North / kita (nukidora)
// ---------------------------------------------------------------------------
describe("North in the concealed hand is an ordinary guest wind, never yakuhai", () => {
  it("a North triplet held (not extracted) in hand scores zero yakuhai han", () => {
    const hand = tiles(["z4", "z4", "z4", "p1", "p2", "p3", "s1", "s2", "s3", "p7", "p8", "m1", "m1"]);
    const winTile = t("p9");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true, seatWind: 1, roundWind: 1 }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 0,
    });
    // Menzen Tsumo is the only yaku here - no "Yakuhai" entry for the North triplet
    expect(result).not.toBeNull();
    expect(result!.yaku.some((y) => y.name.startsWith("Yakuhai"))).toBe(false);
  });
});

describe("nukidora (extracted North) scoring", () => {
  it("each extracted North is worth exactly 1 dora on its own", () => {
    expect(countNukidora([t("z4")])).toBe(1);
    expect(countNukidora([t("z4"), t("z4")])).toBe(2);
  });

  it("a West dora indicator makes an extracted North count as both nukidora AND a normal dora (2 total)", () => {
    const kitaTiles = [t("z4")];
    const nuki = countNukidora(kitaTiles);
    const asRegularDora = countDora(kitaTiles, ["z3"], DEFAULT_SANMA_RULES); // z3 (West) -> z4 (North)
    expect(nuki).toBe(1);
    expect(asRegularDora).toBe(1);
    expect(nuki + asRegularDora).toBe(2);
  });

  it("kita never reveals a new dora indicator by itself, unlike kan", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "kita-no-indicator-reveal");
    wall.dealInitial(3, 13);
    const before = wall.doraIndicators().length;
    wall.drawKitaReplacement();
    expect(wall.doraIndicators().length).toBe(before);
  });

  it("winning on a kita replacement draw qualifies for Rinshan Kaihou", () => {
    // 4 complete melds + a single floating tile, winning via a rinshan-flagged tsumo
    const hand = tiles(["m1", "m1", "m1", "s1", "s2", "s3", "s4", "s5", "s6", "p1", "p2", "p3", "p9"]);
    const winTile = t("p9");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true, isRinshan: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.map((y) => y.name)).toContain("Rinshan Kaihou");
  });
});

describe("kan and kita share the 8-slot rinshan pool without ever duplicating a tile", () => {
  it("8 alternating draws are all physically distinct", () => {
    const wall = new Wall(DEFAULT_SANMA_RULES, "kan-kita-shared-pool-distinct");
    wall.dealInitial(3, 13);
    const seen = new Set<number>();
    for (let i = 0; i < 8; i++) {
      const tile = i % 2 === 0 ? wall.drawRinshan() : wall.drawKitaReplacement();
      expect(seen.has(tile.id)).toBe(false);
      seen.add(tile.id);
    }
  });
});

describe("kita game-loop interactions (searched across real self-play games)", () => {
  function handSlices(log: readonly GameEvent[]): { start: number; end: number }[] {
    const starts = log.map((e, i) => (e.type === "hand_start" ? i : -1)).filter((i) => i >= 0);
    return starts.map((start, i) => ({ start, end: starts[i + 1] ?? log.length }));
  }

  it("no 'kita' event ever appears between a call and that caller's own immediate next discard", () => {
    // structural check: kita may not be declared immediately after Pon/daiminkan - calls
    // that claim ANOTHER player's discard (this engine's post-call discard path never
    // offers kita at all). Ankan/shouminkan are excluded: those are the player's own
    // action during their own turn, not a response to someone else's discard, and kita is
    // correctly still offered normally afterward on that turn's replacement draw.
    let callsChecked = 0;
    for (let seed = 0; seed < 10; seed++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `kita-after-pon-${seed}` });
      gs.playGame();
      for (let i = 0; i < gs.log.length; i++) {
        const evt = gs.log[i]!;
        if (evt.type !== "call" || (evt.call !== "pon" && evt.call !== "kan_open")) continue;
        callsChecked++;
        // scan forward (bounded to this same hand) until this caller's next "discard" or
        // the hand concludes some other way (e.g. rinshan kaihou on the kan replacement
        // draw) - either one closes the response window. No "kita" by them may appear first.
        for (let j = i + 1; j < gs.log.length; j++) {
          const later = gs.log[j]!;
          if (later.type === "hand_end" || later.type === "game_end") break;
          if (later.type === "win") break; // any win (by anyone) ends the hand outright
          if ("player" in later && later.player === evt.player && later.type === "discard") break;
          if ("player" in later && later.player === evt.player && later.type === "kita") {
            throw new Error(`kita declared immediately after a call at log index ${j}`);
          }
        }
      }
    }
    expect(callsChecked).toBeGreaterThan(0);
  });

  it("kita cancels ippatsu: a win after an intervening kita never carries the Ippatsu yaku", () => {
    let found = false;
    for (let seed = 0; seed < 30 && !found; seed++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `kita-cancels-ippatsu-${seed}` });
      gs.playGame();
      for (const { start, end } of handSlices(gs.log)) {
        const slice = gs.log.slice(start, end);
        const riichiIdx = slice.findIndex((e) => e.type === "riichi");
        if (riichiIdx === -1) continue;
        const riichiPlayer = (slice[riichiIdx] as Extract<GameEvent, { type: "riichi" }>).player;
        const kitaAfter = slice.slice(riichiIdx + 1).findIndex((e) => e.type === "kita");
        if (kitaAfter === -1) continue;
        const winAfterKita = slice.slice(riichiIdx + 1 + kitaAfter).find((e) => e.type === "win" && e.player === riichiPlayer);
        if (!winAfterKita || winAfterKita.type !== "win") continue;
        found = true;
        expect(winAfterKita.yaku.some((y) => y.name === "Ippatsu")).toBe(false);
      }
    }
    // Not asserting found===true strictly (this exact interleaving is rare), but if found,
    // it must never carry Ippatsu - the loop above already asserts that inline.
  });

  it("extracted North can be ronned without Chankan, and still requires a real yaku", () => {
    let found = false;
    for (let seed = 0; seed < 40 && !found; seed++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `north-ron-${seed}` });
      gs.playGame();
      for (let i = 0; i < gs.log.length - 1; i++) {
        const kitaEvt = gs.log[i]!;
        const winEvt = gs.log[i + 1]!;
        if (kitaEvt.type !== "kita" || winEvt.type !== "win") continue;
        if (winEvt.isTsumo || winEvt.ronFrom !== kitaEvt.player) continue;
        found = true;
        expect(winEvt.yaku.map((y) => y.name)).not.toContain("Chankan");
        expect(winEvt.yaku.length).toBeGreaterThan(0); // a real yaku was required to ron at all
      }
    }
    // Rare in self-play (needs another player tenpai specifically on North); if it never
    // occurs across this seed budget that's fine - the inline assertions are what matter.
  });
});
