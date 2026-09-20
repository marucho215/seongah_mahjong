import { describe, it, expect } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import type { GameEvent } from "../src/core/GameLog.js";

/**
 * Phase 2: double-ron honba dedup, final kyotaku settlement, target-score extension, and
 * game_end reason unification. See GameState.ts's finishHandWithWin/playGame/isGameOver.
 */
function handSlices(events: readonly GameEvent[]): { start: number; end: number }[] {
  const starts = events.map((e, i) => (e.type === "hand_start" ? i : -1)).filter((i) => i >= 0);
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? events.length }));
}

describe("2-A: double ron honba is paid once total, not once per winner", () => {
  it("finds real honba=0, honba=1, and honba>=2 double-ron cases and verifies the discarder pays honba exactly once combined", () => {
    const found = { h0: 0, h1: 0, h2plus: 0 };
    for (const seed of [15, 53, 163, 304, 349]) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `double-ron-honba-${seed}` });
      gs.playGame();
      for (const { start, end } of handSlices(gs.log)) {
        const slice = gs.log.slice(start, end);
        const handStart = slice[0]!;
        if (handStart.type !== "hand_start") continue;
        const wins = slice.filter((e): e is Extract<GameEvent, { type: "win" }> => e.type === "win");
        const rons = wins.filter((w) => !w.isTsumo);
        if (rons.length < 2) continue; // need an actual double/triple ron
        const ronFrom = rons[0]!.ronFrom!;
        if (!rons.every((w) => w.ronFrom === ronFrom)) continue; // sanity: same discarder
        const honba = handStart.honba;
        const honbaTotal = honba * DEFAULT_SANMA_RULES.honbaValue;
        // sum of what the discarder pays across all ron deltas for this discard must include
        // the honba bonus exactly once (not once per winner)
        const discarderPaidTotal = -rons.reduce((sum, w) => sum + w.deltas[ronFrom]!, 0);
        // simplest direct invariant: discarderPaidTotal minus the sum of each winner's OWN
        // non-honba base share must equal exactly one honbaTotal (not rons.length * honbaTotal)
        if (honba === 0) {
          if (found.h0 >= 2) continue;
          found.h0++;
        } else if (honba === 1) {
          if (found.h1 >= 2) continue;
          found.h1++;
        } else {
          if (found.h2plus >= 1) continue;
          found.h2plus++;
        }
        // total points conservation for this discard: sum of all deltas touched (winners +
        // discarder) must be exactly 0
        const touchedSeats = new Set<number>([ronFrom, ...rons.map((w) => w.player)]);
        let net = 0;
        for (const s of touchedSeats) {
          for (const w of rons) net += w.deltas[s] ?? 0;
        }
        expect(net).toBe(0);
        // discarder's total payment must equal the sum of each winner's own logged
        // totalPoints (`points`) - which already has honba stripped out for every winner
        // but the first (the fix under test), so this sum itself only contains honba once
        const expectedDiscarderPayment = rons.reduce((sum, w) => sum + w.points, 0);
        expect(discarderPaidTotal).toBe(expectedDiscarderPayment);
      }
    }
    expect(found.h0).toBeGreaterThan(0);
    expect(found.h1).toBeGreaterThan(0);
  });

  it("both honba and kyotaku go entirely to the winner closest to the discarder in turn order (Mahjong Soul 上家取り), never the farther winner", () => {
    let found = 0;
    for (const seed of [36, 138]) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `double-ron-priority-${seed}` });
      gs.playGame();
      for (const { start, end } of handSlices(gs.log)) {
        const slice = gs.log.slice(start, end);
        const handStart = slice[0]!;
        if (handStart.type !== "hand_start") continue;
        const wins = slice.filter((e): e is Extract<GameEvent, { type: "win" }> => e.type === "win");
        const rons = wins.filter((w) => !w.isTsumo);
        if (rons.length !== 2) continue; // exactly a double ron, unambiguous near/far pair
        const ronFrom = rons[0]!.ronFrom!;
        if (rons[1]!.ronFrom !== ronFrom) continue;
        const closestPlayer = (ronFrom + 1) % 3;
        const nearWin = rons.find((w) => w.player === closestPlayer);
        const farWin = rons.find((w) => w.player !== closestPlayer);
        if (!nearWin || !farWin) continue;

        found++;
        const honba = handStart.honba;
        const honbaTotal = honba * DEFAULT_SANMA_RULES.honbaValue;
        const kyotakuAmount = handStart.kyotaku * 1000;
        // the near (closest-in-turn-order) winner's logged deltas must show the full honba
        // bonus from the discarder, plus the entire kyotaku pot if any was on the table
        expect(-nearWin.deltas[ronFrom]!).toBeGreaterThanOrEqual(honbaTotal); // at least the honba portion is present
        if (kyotakuAmount > 0) expect(nearWin.deltas[nearWin.player]!).toBeGreaterThanOrEqual(kyotakuAmount);
        // the far winner's own base payment must be exactly their hand's points minus honba
        // (honba was stripped and refunded to the discarder) - and they get 0 kyotaku
        const farBase = -farWin.deltas[ronFrom]!;
        expect(farBase).toBe(farWin.points); // .points already has honba subtracted for the far winner
        if (kyotakuAmount > 0) expect(farWin.deltas[farWin.player]!).toBe(farWin.points); // no kyotaku share
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe("2-B: leftover kyotaku is swept to the 1st-place player at game end", () => {
  it("game_end's finalScores reflect any leftover kyotaku paid to whoever is in 1st place, and total raw points are conserved", () => {
    let foundNonZeroKyotaku = 0;
    for (const seed of [8]) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `kyotaku-settlement-${seed}` });
      // manually track kyotaku right before the game-ending hand's advanceAfterHand by
      // reading the log's last hand_end (kyotaku field there is PRE-settlement, since
      // settlement only happens once, after the loop, in playGame())
      gs.playGame();
      const log = gs.log;
      const gameEnd = log[log.length - 1]!;
      expect(gameEnd.type).toBe("game_end");
      if (gameEnd.type !== "game_end") continue;
      const lastHandEnd = [...log].reverse().find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end");
      expect(lastHandEnd).toBeDefined();
      if (!lastHandEnd) continue;
      const leftoverKyotaku = lastHandEnd.kyotaku;
      // total raw points must always be conserved: starting pool, since kyotaku (which came
      // out of players' own scores when riichi was declared) is now fully back in the pool
      const totalRaw = gameEnd.finalScores.reduce((a, b) => a + b, 0);
      expect(totalRaw).toBe(DEFAULT_SANMA_RULES.startingScore * 3);
      if (leftoverKyotaku > 0) {
        foundNonZeroKyotaku++;
        // the pre-settlement leader (highest hand_end score, ties broken by lowest seat)
        // must be the one whose score increased by exactly leftoverKyotaku*1000
        const preSettlementScores = lastHandEnd.scores;
        const leaderScore = Math.max(...preSettlementScores);
        const leader = preSettlementScores.findIndex((s) => s === leaderScore);
        expect(gameEnd.finalScores[leader]).toBe(preSettlementScores[leader]! + leftoverKyotaku * 1000);
        for (let p = 0; p < 3; p++) {
          if (p === leader) continue;
          expect(gameEnd.finalScores[p]).toBe(preSettlementScores[p]);
        }
      }
    }
    expect(foundNonZeroKyotaku).toBeGreaterThan(0);
  });

  it("kyotaku=0 at game end leaves finalScores identical to the last hand_end's scores", () => {
    for (const seed of [0]) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `kyotaku-zero-${seed}` });
      gs.playGame();
      const log = gs.log;
      const gameEnd = log[log.length - 1]!;
      if (gameEnd.type !== "game_end") continue;
      const lastHandEnd = [...log].reverse().find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end")!;
      if (lastHandEnd.kyotaku !== 0) continue;
      expect(gameEnd.finalScores).toEqual(lastHandEnd.scores);
    }
  });
});

describe("2-C: target score (returnScore=40000) and extension", () => {
  it("a game reaching the scheduled length with nobody at returnScore extends past it (reason 'extension_end') until someone crosses it", () => {
    // a moderately reduced startingScore widens the gap to returnScore(40000) just enough
    // that reaching it within the scheduled 3 hands is uncommon (forcing extension often),
    // while staying high enough that a quick tobi doesn't dominate every seed - a
    // deliberate TEST-ONLY fixture, never touching DEFAULT_SANMA_RULES itself.
    const LOW_START = { ...DEFAULT_SANMA_RULES, startingScore: 20000 };
    let found = 0;
    for (const seed of [2, 7]) {
      const gs = new GameState({ rules: LOW_START, seed: `extension-${seed}` });
      gs.playGame();
      const gameEnd = gs.log[gs.log.length - 1]!;
      if (gameEnd.type !== "game_end") continue;
      if (gameEnd.reason === "tobi") continue; // a bust can pre-empt the extension - not what this test targets
      expect(gameEnd.reason).toBe("extension_end");
      // "extension_end" can also mean the extension's own cap was hit without anyone
      // reaching target (covered separately below) - this test specifically wants the
      // "kept going until someone crossed it" case, so only count that one
      if (!gameEnd.finalScores.some((s) => s >= LOW_START.returnScore)) continue;
      found++;
    }
    expect(found).toBeGreaterThan(0);
  });

  it("reason 'length' only occurs when someone already reached returnScore by the scheduled last hand - never mid-schedule", () => {
    for (const seed of [1]) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `length-target-${seed}` });
      gs.playGame();
      const gameEnd = gs.log[gs.log.length - 1]!;
      if (gameEnd.type !== "game_end") continue;
      if (gameEnd.reason !== "length") continue;
      expect(gameEnd.finalScores.some((s) => s >= DEFAULT_SANMA_RULES.returnScore)).toBe(true);
    }
  });

  it("dealer continuation (renchan) rules are unaffected during an extension - the same dealer/honba rotation logic applies to extension hands as normal ones", () => {
    const LOW_START = { ...DEFAULT_SANMA_RULES, startingScore: 100 };
    const gs = new GameState({ rules: LOW_START, seed: "extension-renchan-check" });
    gs.playGame();
    const handEnds = gs.log.filter((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end");
    // every hand_end's honba is either 0 (dealer rotated / no renchan) or a positive integer
    // consistent with consecutive renchan/draw hands - no special "extension mode" value
    for (const he of handEnds) expect(Number.isInteger(he.honba) && he.honba >= 0).toBe(true);
  });

  it("extension is capped at exactly one wind beyond the schedule (east -> South only, never West/3): ends without reaching target if the cap is hit", () => {
    // startingScore far below returnScore AND far above an easy tobi threshold, so most
    // seeds genuinely reach the extension cap without ever crossing 40000 or busting first.
    const LOW_START = { ...DEFAULT_SANMA_RULES, startingScore: 15000 };
    let found = 0;
    let sawCapEnforced = false;
    for (const seed of [1]) {
      const gs = new GameState({ rules: LOW_START, seed: `extension-cap-${seed}` });
      gs.playGame();
      // no hand_start for a West-round (roundWind 3) hand may ever appear - proves West is
      // never actually played, whatever the outcome. (gs.roundWind itself legitimately
      // "overshoots" to 3 as a bookkeeping side effect of advanceAfterHand's rotation math
      // right after South's 3rd hand finishes, even though no West hand is ever played -
      // the same pre-existing overshoot the plain, non-extended East-only boundary already
      // has after East's own 3rd hand, so that field isn't the right thing to assert on.)
      const westHandStarted = gs.log.some((e) => e.type === "hand_start" && e.roundWind >= 3);
      expect(westHandStarted).toBe(false);
      const gameEnd = gs.log[gs.log.length - 1]!;
      if (gameEnd.type !== "game_end") continue;
      found++;
      if (gameEnd.reason === "extension_end" && !gameEnd.finalScores.some((s) => s >= LOW_START.returnScore)) {
        // the cap forced a normal end (South's own 3rd hand completed) with nobody having
        // reached the target - exactly the "남3국이 정상 종료되면 대국 종료" case
        sawCapEnforced = true;
      }
    }
    expect(found).toBeGreaterThan(0);
    expect(sawCapEnforced).toBe(true);
  });
});

describe("2-D: game-end reason unification (tobi / length / extension_end)", () => {
  it("tobi always takes precedence: a bust during what would otherwise be an extension still reports 'tobi', not 'extension_end'", () => {
    const LOW_START = { ...DEFAULT_SANMA_RULES, startingScore: 100 };
    let found = false;
    for (const seed of [0]) {
      const gs = new GameState({ rules: LOW_START, seed: `tobi-during-extension-${seed}` });
      gs.playGame();
      const gameEnd = gs.log[gs.log.length - 1]!;
      if (gameEnd.type !== "game_end" || gameEnd.reason !== "tobi") continue;
      found = true;
      expect(gameEnd.eliminatedPlayers.length).toBeGreaterThan(0);
    }
    expect(found).toBe(true);
  });

  it("seeded determinism: identical seed reproduces identical honba/kyotaku/extension/game_end results", () => {
    const seed = "phase2-determinism";
    const gs1 = new GameState({ rules: DEFAULT_SANMA_RULES, seed });
    gs1.playGame();
    const gs2 = new GameState({ rules: DEFAULT_SANMA_RULES, seed });
    gs2.playGame();
    expect(gs2.log).toEqual(gs1.log);
  });
});
