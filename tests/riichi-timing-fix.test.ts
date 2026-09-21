import { describe, it, expect } from "vitest";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { GameState } from "../src/core/GameState.js";
import type { GameEvent } from "../src/core/GameLog.js";

function handSlices(log: readonly GameEvent[]): { start: number; end: number }[] {
  const starts = log.map((e, i) => (e.type === "hand_start" ? i : -1)).filter((i) => i >= 0);
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? log.length }));
}

// Regression coverage for the riichi-timing fix: establishment (hand.riichi = true, the
// 1000-point deposit, kyotaku increment, and ippatsu activation) must happen immediately
// once the declaration discard clears its own ron check - BEFORE any pon/daiminkan on that
// exact discard is even considered, not after the whole call-response chain resolves.

describe("riichi establishes immediately after its own ron check, before any pon/kan is offered", () => {
  it("every riichi-declaring discard is immediately followed by its own establishment event", () => {
    let declarationsChecked = 0;
    for (const seed of [0]) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `riichi-order-${seed}` });
      gs.playGame();
      for (let i = 0; i < gs.log.length - 1; i++) {
        const discardEvt = gs.log[i]!;
        if (discardEvt.type !== "discard" || !discardEvt.riichiDeclaration) continue;
        const next = gs.log[i + 1]!;
        // if the declaration discard was ronned, establishment never happens - that's the
        // other branch, covered by phase4-edgecases.test.ts's "does NOT deposit" test.
        if (next.type === "win") continue;
        declarationsChecked++;
        expect(next.type).toBe("riichi");
        expect((next as Extract<GameEvent, { type: "riichi" }>).player).toBe(discardEvt.player);
      }
    }
    expect(declarationsChecked).toBeGreaterThan(0);
  });
});

describe("a pon on the declaration discard still lets the declarer ron the caller's follow-up with Riichi", () => {
  it("finds and verifies at least one such sequence", () => {
    let found = 0;
    // Seed 82 is the original fixed reproduction. FF-07 intentionally makes a new
    // post-riichi Kita action reachable under the autonomous default policy, which can
    // divert the later self-play trajectory before this timing sequence occurs. Declining
    // only those newly legal post-riichi Kita opportunities preserves the reproduction's
    // pre-FF-07 action path without disabling ordinary non-riichi Kita.
    const gs = new GameState({
      rules: DEFAULT_SANMA_RULES,
      seed: "riichi-pon-ron-82",
      kitaDecisionPolicy: (_seat, hand) => !hand.riichi,
    });
    gs.playGame();
    const log = gs.log;
    for (let i = 0; i < log.length - 4; i++) {
      const discardEvt = log[i]!;
      if (discardEvt.type !== "discard" || !discardEvt.riichiDeclaration) continue;
      const riichiEvt = log[i + 1]!;
      if (riichiEvt.type !== "riichi" || riichiEvt.player !== discardEvt.player) continue;
      const callEvt = log[i + 2]!;
      if (callEvt.type !== "call" || callEvt.call !== "pon") continue;
      // The caller's mandatory follow-up discard is evaluated only after riichi has
      // established, so a legal ron by the original declarer must retain the yaku.
      const callerDiscard = log[i + 3]!;
      if (callerDiscard.type !== "discard" || callerDiscard.player !== callEvt.player) continue;
      const winEvt = log[i + 4]!;
      if (winEvt.type !== "win" || winEvt.isTsumo) continue;
      if (winEvt.player !== discardEvt.player) continue; // must be the original declarer
      if (winEvt.ronFrom !== callEvt.player) continue; // ronning the ponning caller

      found++;
      expect(callEvt.fromPlayer).toBe(discardEvt.player);
      expect(winEvt.yaku.some((y) => y.name === "Riichi" || y.name === "Double Riichi")).toBe(true);
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe("a daiminkan on the declaration discard still deposits the riichi stick", () => {
  it("establishment (and therefore the kyotaku increment) has already happened by the time the daiminkan is processed", () => {
    let found = 0;
    for (const seed of [36, 66]) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `riichi-daiminkan-${seed}` });
      gs.playGame();
      const log = gs.log;
      for (let i = 0; i < log.length - 2; i++) {
        const discardEvt = log[i]!;
        if (discardEvt.type !== "discard" || !discardEvt.riichiDeclaration) continue;
        const riichiEvt = log[i + 1]!;
        if (riichiEvt.type !== "riichi" || riichiEvt.player !== discardEvt.player) continue;
        const callEvt = log[i + 2]!;
        if (callEvt.type !== "call" || callEvt.call !== "kan_open") continue;

        found++;
        // find the enclosing hand and confirm the stick is accounted for one way or another:
        // either carried in kyotaku through to hand_end, or folded into a winner's payout
        // (both paths are only reachable at all because establishment already ran).
        const slice = handSlices(log).find((s) => s.start <= i && i < s.end)!;
        const handStart = log[slice.start] as Extract<GameEvent, { type: "hand_start" }>;
        const handEnd = log[slice.end - 1] as Extract<GameEvent, { type: "hand_end" }>;
        const resolvedByWin = log.slice(slice.start, slice.end).some((e) => e.type === "win");
        if (!resolvedByWin) {
          // exhaustive draw never pays out kyotaku - it must still be sitting there (or more,
          // if other riichi were also declared this hand), never having been silently dropped
          expect(handEnd.kyotaku).toBeGreaterThanOrEqual(handStart.kyotaku + 1);
        }
        // if resolved by a win, finishHandWithWin unconditionally sweeps the full kyotaku
        // pot into the winner - conservation of total points (scores + kyotaku*1000) across
        // the whole game, already asserted elsewhere, would fail if this stick vanished.
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe("ippatsu stays cancelled for the rest of the hand once a pon/daiminkan claims the declaration discard", () => {
  it("no later win by the declarer, in the same hand, ever carries the Ippatsu yaku", () => {
    let found = 0;
    for (const seed of [20, 23, 31]) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `riichi-ippatsu-cancel-${seed}` });
      gs.playGame();
      const log = gs.log;
      for (const { start, end } of handSlices(log)) {
        const slice = log.slice(start, end);
        for (let i = 0; i < slice.length - 2; i++) {
          const discardEvt = slice[i]!;
          if (discardEvt.type !== "discard" || !discardEvt.riichiDeclaration) continue;
          const riichiEvt = slice[i + 1]!;
          if (riichiEvt.type !== "riichi" || riichiEvt.player !== discardEvt.player) continue;
          const callEvt = slice[i + 2]!;
          if (callEvt.type !== "call" || (callEvt.call !== "pon" && callEvt.call !== "kan_open")) continue;

          const declarer = discardEvt.player;
          const laterWin = slice.slice(i + 3).find((e) => e.type === "win" && e.player === declarer);
          if (!laterWin || laterWin.type !== "win") continue;
          found++;
          expect(laterWin.yaku.some((y) => y.name === "Ippatsu")).toBe(false);
        }
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});
