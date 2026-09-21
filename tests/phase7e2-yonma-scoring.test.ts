import { describe, expect, it } from "vitest";
import { GameState } from "../src/core/GameState.js";
import type { GameEvent } from "../src/core/GameLog.js";
import { calculateNotenPayments, settleOrderedWinPayments, shouldDealerContinue } from "../src/rules/settlement.js";
import { MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";
import { computeScore } from "../src/yaku/score.js";

function score(overrides: Partial<Parameters<typeof computeScore>[0]> = {}) {
  return computeScore({
    han: 1,
    fu: 30,
    yakumanUnits: 0,
    winner: 1,
    dealer: 0,
    isTsumo: false,
    ronFrom: 2,
    playerCount: 4,
    rules: MAJSOUL_YONMA_RULES,
    ...overrides,
  });
}

describe("Phase 7E-2 yonma payments", () => {
  it("calculates child and dealer ron", () => {
    const child = score();
    expect(child.payments.deltas).toEqual({ 0: 0, 1: 1000, 2: -1000, 3: 0 });
    const dealer = score({ winner: 0, ronFrom: 2 });
    expect(dealer.payments.deltas).toEqual({ 0: 1500, 1: 0, 2: -1500, 3: 0 });
  });

  it("calculates child tsumo with dealer/non-dealer shares and dealer tsumo with three payers", () => {
    const child = score({ isTsumo: true, ronFrom: undefined });
    expect(child.payments.deltas).toEqual({ 0: -500, 1: 1100, 2: -300, 3: -300 });
    const dealer = score({ winner: 0, isTsumo: true, ronFrom: undefined });
    expect(dealer.payments.deltas).toEqual({ 0: 1500, 1: -500, 2: -500, 3: -500 });
  });

  it("adds ron honba once and tsumo honba as 100 per payer", () => {
    const ron = score({ honba: 2 });
    expect(ron.payments.deltas).toEqual({ 0: 0, 1: 1600, 2: -1600, 3: 0 });
    const tsumo = score({ isTsumo: true, ronFrom: undefined, honba: 2 });
    expect(tsumo.payments.deltas).toEqual({ 0: -700, 1: 1700, 2: -500, 3: -500 });
  });
});

describe("Phase 7E-2 yonma exhaustive draw", () => {
  it("redistributes the 3000-point pool for one, two, or three tenpai players", () => {
    expect(calculateNotenPayments(4, [0], 3000)).toEqual({ 0: 3000, 1: -1000, 2: -1000, 3: -1000 });
    expect(calculateNotenPayments(4, [0, 2], 3000)).toEqual({ 0: 1500, 1: -1500, 2: 1500, 3: -1500 });
    expect(calculateNotenPayments(4, [0, 1, 2], 3000)).toEqual({ 0: 1000, 1: 1000, 2: 1000, 3: -3000 });
  });

  it("moves no points for zero or four tenpai players", () => {
    expect(calculateNotenPayments(4, [], 3000)).toEqual({ 0: 0, 1: 0, 2: 0, 3: 0 });
    expect(calculateNotenPayments(4, [0, 1, 2, 3], 3000)).toEqual({ 0: 0, 1: 0, 2: 0, 3: 0 });
  });

  it("continues on dealer tenpai and rotates on dealer noten", () => {
    const base = {
      dealerSeat: 0,
      isExhaustiveDraw: true,
      renchanOnDealerWin: true,
      renchanOnDealerTenpaiDraw: true,
    } as const;
    expect(shouldDealerContinue({ ...base, tenpaiPlayers: [0, 2] })).toBe(true);
    expect(shouldDealerContinue({ ...base, tenpaiPlayers: [1, 2] })).toBe(false);
  });
});

describe("Phase 7E-2 ordered multi-ron settlement", () => {
  it("keeps double and triple ron while awarding honba and kyotaku only to the closest winner", () => {
    const winner1 = score({ winner: 1, ronFrom: 0, honba: 1 });
    const winner2 = score({ winner: 2, ronFrom: 0, honba: 1 });
    const winner3 = score({ winner: 3, ronFrom: 0, honba: 1 });

    const doubleRon = settleOrderedWinPayments(
      4,
      [
        { seat: 1, ronFrom: 0, score: winner1 },
        { seat: 2, ronFrom: 0, score: winner2 },
      ],
      1,
      300,
      2
    );
    expect(doubleRon.closestWinner).toBe(1);
    expect(doubleRon.combinedDeltas).toEqual({ 0: -2300, 1: 3300, 2: 1000, 3: 0 });

    const tripleRon = settleOrderedWinPayments(
      4,
      [
        { seat: 1, ronFrom: 0, score: winner1 },
        { seat: 2, ronFrom: 0, score: winner2 },
        { seat: 3, ronFrom: 0, score: winner3 },
      ],
      1,
      300,
      0
    );
    expect(tripleRon.combinedDeltas).toEqual({ 0: -3300, 1: 1300, 2: 1000, 3: 1000 });
    expect(Object.values(tripleRon.combinedDeltas).reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it("continues the dealer when any ordered multi-ron winner is the dealer", () => {
    expect(
      shouldDealerContinue({
        dealerSeat: 0,
        isExhaustiveDraw: false,
        winnerSeats: [2, 0, 3],
        renchanOnDealerWin: true,
        renchanOnDealerTenpaiDraw: true,
      })
    ).toBe(true);
  });
});

describe("Phase 7E-2 deterministic yonma integration", () => {
  it("plays a complete four-player game with score conservation and legal progression", () => {
    const gs = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-complete-game" });
    gs.playGame();
    const end = gs.log.at(-1) as Extract<GameEvent, { type: "game_end" }>;
    expect(end.type).toBe("game_end");
    expect(end.finalScores).toHaveLength(4);
    expect(end.finalScores.reduce((sum, value) => sum + value, 0)).toBe(100000);

    const starts = gs.log.filter((event): event is Extract<GameEvent, { type: "hand_start" }> => event.type === "hand_start");
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.every((event) => event.roundHandNumber >= 1 && event.roundHandNumber <= 4)).toBe(true);
    const ends = gs.log.filter((event): event is Extract<GameEvent, { type: "hand_end" }> => event.type === "hand_end");
    expect(ends.every((event) => event.nextDealer >= 0 && event.nextDealer < 4)).toBe(true);
  });

  it("replays the same yonma game identically", () => {
    const a = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-determinism" });
    const b = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-determinism" });
    a.playGame();
    b.playGame();
    expect(a.log).toEqual(b.log);
    expect(a.scores).toEqual(b.scores);
  });
});

describe("Phase 7E-2 yonma progression and game end fixtures", () => {
  function advance(gs: GameState, dealerRepeats: boolean, exhaustive = false): void {
    (gs as unknown as { advanceAfterHand(repeats: boolean, draw: boolean): void }).advanceAfterHand(dealerRepeats, exhaustive);
  }

  it("rotates East 1 through East 4 using four seats", () => {
    const gs = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-rounds" });
    expect([gs.roundWind, gs.roundHandNumber, gs.dealerSeat]).toEqual([1, 1, 0]);
    advance(gs, false);
    expect([gs.roundWind, gs.roundHandNumber, gs.dealerSeat]).toEqual([1, 2, 1]);
    advance(gs, false);
    expect([gs.roundWind, gs.roundHandNumber, gs.dealerSeat]).toEqual([1, 3, 2]);
    advance(gs, false);
    expect([gs.roundWind, gs.roundHandNumber, gs.dealerSeat]).toEqual([1, 4, 3]);
  });

  it("ends after East 4 at target, otherwise enters South extension", () => {
    const reached = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-east4-target" });
    reached.roundHandNumber = 4;
    reached.dealerSeat = 3;
    reached.scores = [30000, 24000, 23000, 23000];
    advance(reached, false);
    expect(reached.isGameOver()).toBe(true);

    const below = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-east4-extension" });
    below.roundHandNumber = 4;
    below.dealerSeat = 3;
    below.scores = [29000, 25000, 24000, 22000];
    advance(below, false);
    expect([below.roundWind, below.roundHandNumber]).toEqual([2, 1]);
    expect(below.isGameOver()).toBe(false);
  });

  it("ends on a target reached in South or at the South 4 cap", () => {
    const target = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-south-target" });
    target.roundWind = 2;
    target.roundHandNumber = 2;
    target.scores = [31000, 24000, 23000, 22000];
    expect(target.isGameOver()).toBe(true);

    const cap = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-south-cap" });
    cap.roundWind = 2;
    cap.roundHandNumber = 4;
    cap.dealerSeat = 3;
    cap.scores = [29000, 25000, 24000, 22000];
    advance(cap, false);
    expect(cap.isGameOver()).toBe(true);
  });

  it("applies dealer agari/tenpai-yame when the last dealer leads at target", () => {
    const gs = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-dealer-yame" });
    gs.roundHandNumber = 4;
    gs.dealerSeat = 0;
    gs.scores = [32000, 28000, 22000, 18000];
    advance(gs, true);
    expect(gs.isGameOver()).toBe(true);
  });

  it("treats negative as tobi, preserves exact zero, and uses starting-seat tie order", () => {
    const busted = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-tobi-negative" });
    busted.scores = [-100, 30100, 35000, 35000];
    advance(busted, false);
    expect(busted.isGameOver()).toBe(true);

    const zero = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-tobi-zero" });
    zero.scores = [0, 30000, 35000, 35000];
    advance(zero, true);
    expect(zero.isGameOver()).toBe(false);

    const tied = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-tie" });
    tied.scores = [25000, 25000, 25000, 25000];
    expect(tied.computeFinalStandings().map((standing) => standing.player)).toEqual([0, 1, 2, 3]);
  });

  it("sweeps leftover kyotaku to the tie-broken first place at game end", () => {
    const gs = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7e2-final-kyotaku" });
    gs.scores = [25000, 25000, 25000, 25000];
    gs.kyotaku = 2;
    (gs as unknown as { tobiTriggered: boolean }).tobiTriggered = true;
    gs.playGame();
    const end = gs.log.at(-1) as Extract<GameEvent, { type: "game_end" }>;
    expect(end.finalScores).toEqual([27000, 25000, 25000, 25000]);
    expect(gs.kyotaku).toBe(0);
  });
});
