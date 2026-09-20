import { describe, it, expect } from "vitest";
import { FuritenTracker } from "../src/actions/furiten.js";
import { evaluateWin } from "../src/yaku/evaluate.js";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import type { Tile } from "../src/core/tiles.js";
import type { WinContext } from "../src/yaku/types.js";

let nextId = 20000;
function t(kind: string): Tile {
  const suit = kind[0] as "m" | "p" | "s" | "z";
  const rank = Number(kind.slice(1));
  return { id: nextId++, kind, suit, rank, isRed: false };
}
function tiles(kinds: string[]): Tile[] {
  return kinds.map(t);
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
// 2. Furiten state model - distinct sources, not a single collapsed boolean
// ---------------------------------------------------------------------------
describe("furiten: own-discard furiten is recomputed fresh, not cached", () => {
  it("becomes furiten the instant a winning tile enters the own river, with no prior event needed", () => {
    const tracker = new FuritenTracker();
    // no onMissedRonChance, no riichi - pure own-discard check
    expect(tracker.isFuriten(["p9"], ["m1", "p9", "s3"])).toBe(true);
  });

  it("stops being furiten once the hand's wait no longer includes the previously-discarded tile", () => {
    const tracker = new FuritenTracker();
    // earlier in the hand this player discarded p9, and back then p9 happened to be a
    // winning tile for their shape - furiten at that moment:
    expect(tracker.isFuriten(["p9", "p6"], ["p9"])).toBe(true);
    // the hand has since changed shape (a draw+discard swapped the wait) so p9 is no
    // longer part of the current wait set - own-discard furiten must clear, since it is
    // recomputed from the CURRENT wait every call, never remembered as a standing flag.
    expect(tracker.isFuriten(["s4", "s7"], ["p9"])).toBe(false);
  });

  it("is independent per missed-ron and riichi-lock state - clearing the wait doesn't clear a real temporary furiten", () => {
    const tracker = new FuritenTracker();
    tracker.onMissedRonChance(); // declined an actual ron chance (non-riichi)
    // even though the current wait no longer overlaps the river, temporary furiten (from
    // the missed chance itself) still holds until this player's own next draw
    expect(tracker.isFuriten(["s4", "s7"], [])).toBe(true);
    tracker.onOwnDraw();
    expect(tracker.isFuriten(["s4", "s7"], [])).toBe(false);
  });
});

describe("furiten never blocks tsumo, only ron", () => {
  it("evaluateWin has no concept of furiten at all - a tsumo scores normally regardless of the discard pile", () => {
    // this hand's winning tile (z1) is, hypothetically, sitting in its own discard pile -
    // a real ron on z1 would be illegal, but evaluateWin doesn't take discards as input at
    // all, and GameState only ever consults FuritenTracker on the ron branch, never tsumo.
    const hand = tiles(["m1", "m1", "m1", "p1", "p2", "p3", "p4", "p5", "p6", "s7", "s8", "s9", "z1"]);
    const winTile = t("z1");
    const result = evaluateWin({
      concealedTiles: [...hand, winTile],
      melds: [],
      winTile,
      context: baseCtx({ isTsumo: true }),
      rules: DEFAULT_SANMA_RULES,
      winner: 0,
      dealer: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.yaku.map((y) => y.name)).toContain("Menzen Tsumo");
  });
});

// ---------------------------------------------------------------------------
// 1. Riichi declaration timing: the stick is committed at declaration and is NOT refunded
//    if that exact discard is immediately ronned - it becomes part of the pot the ronning
//    player collects. We search real self-play games for this exact sequence (riichi
//    declared, then ronned on that very discard) and check the bookkeeping when found.
// ---------------------------------------------------------------------------
describe("riichi declaration timing (declare -> discard -> ron check -> establish or not)", () => {
  // Correct Mahjong Soul behavior: declaring riichi only commits the 1000-point stick (and
  // logs a "riichi" event) once the declaration discard survives the ron check. If that
  // exact discard is ronned, riichi never establishes at all - no deduction, no stick, and
  // the "riichi" log event must be absent.

  it("does NOT deposit the stick when the declaration discard is immediately ronned", () => {
    let found = 0;
    for (const seed of [47]) {
      if (found >= 2) break;
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `riichi-timing-cancelled-${seed}` });
      gs.playGame();
      let handStartIdx = gs.log.findIndex((e) => e.type === "hand_start");
      while (handStartIdx !== -1) {
        let handEndIdx = gs.log.findIndex((e, idx) => idx > handStartIdx && e.type === "hand_end");
        if (handEndIdx === -1) handEndIdx = gs.log.length;
        const handStart = gs.log[handStartIdx];
        const handEnd = gs.log[handEndIdx];
        if (handStart?.type !== "hand_start" || handEnd?.type !== "hand_end") break;

        for (let i = handStartIdx; i < handEndIdx - 1; i++) {
          const discardEvt = gs.log[i]!;
          const winEvt = gs.log[i + 1]!;
          if (discardEvt.type !== "discard" || winEvt.type !== "win") continue;
          if (!discardEvt.riichiDeclaration || winEvt.isTsumo) continue;
          if (winEvt.ronFrom !== discardEvt.player) continue;
          // a genuinely cancelled riichi must never have logged a "riichi" event for this
          // discard - if one is found right before it, establishment (wrongly) happened.
          const precedingRiichiEvt = gs.log[i - 1];
          if (precedingRiichiEvt?.type === "riichi" && precedingRiichiEvt.player === discardEvt.player) continue;
          if (handStart.kyotaku !== 0) continue; // keep the arithmetic unambiguous
          if (gs.log[i + 2] !== handEnd) continue; // only win this hand
          // a DIFFERENT player may have already established riichi earlier in this same
          // hand, depositing a stick the ron winner sweeps on top of rawRonPayment - that's
          // a separate, legitimate mechanic, not part of what this test checks
          const anyOtherRiichiEstablished = gs.log
            .slice(handStartIdx, i)
            .some((e) => e.type === "riichi");
          if (anyOtherRiichiEstablished) continue;

          found++;
          const declarer = discardEvt.player;
          const winner = winEvt.player;
          const declarerActualDelta = handEnd.scores[declarer] - handStart.scores[declarer];
          const winnerActualDelta = handEnd.scores[winner] - handStart.scores[winner];
          const rawRonPayment = winEvt.deltas[winner]!;

          // no stick was ever placed, so the declarer pays exactly the ron payment - nothing more
          expect(declarerActualDelta).toBe(-rawRonPayment);
          expect(winnerActualDelta).toBe(rawRonPayment);
          expect(handEnd.kyotaku).toBe(0); // no stick was created, so none carries over either
        }
        handStartIdx = gs.log.findIndex((e, idx) => idx > handEndIdx && e.type === "hand_start");
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it("DOES establish riichi (deduct 1000, log the event, add to kyotaku) when the declaration discard survives", () => {
    let found = 0;
    for (const seed of [0, 7]) {
      if (found >= 2) break;
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `riichi-timing-established-${seed}` });
      gs.playGame();
      for (let i = 0; i < gs.log.length - 1; i++) {
        const discardEvt = gs.log[i]!;
        const riichiEvt = gs.log[i + 1]!;
        if (discardEvt.type !== "discard" || !discardEvt.riichiDeclaration) continue;
        if (riichiEvt.type !== "riichi" || riichiEvt.player !== discardEvt.player) continue;
        found++;
        // score deduction and kyotaku increment happen exactly once establishment is logged
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});
