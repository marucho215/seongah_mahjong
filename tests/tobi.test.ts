import { describe, it, expect } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import type { GameEvent } from "../src/core/GameLog.js";

/**
 * Tobi (bust) game-end: the instant any player's score goes below 0 at the end of a
 * hand's fully-final scoring, the whole game ends immediately - no further hand_start.
 * A low custom startingScore is used here only as a TEST fixture to make tobi reachable
 * within a handful of hands instead of requiring hundreds of real games to organically
 * accumulate a large enough loss - it never touches DEFAULT_SANMA_RULES or any
 * production default.
 */
const LOW_START_RULES = { ...DEFAULT_SANMA_RULES, startingScore: 1000 };

function handSlices(events: readonly GameEvent[]): { start: number; end: number }[] {
  const starts = events.map((e, i) => (e.type === "hand_start" ? i : -1)).filter((i) => i >= 0);
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? events.length }));
}

describe("tobi (bust) ends the game immediately", () => {
  it("a ron that pushes a player below 0 ends the game right after that hand's scoring, with no further hand_start", () => {
    let found = 0;
    for (let seed = 0; seed < 150 && found < 3; seed++) {
      const gs = new GameState({ rules: LOW_START_RULES, seed: `tobi-ron-${seed}` });
      gs.playGame();
      const log = gs.log;
      const gameEnd = log[log.length - 1]!;
      if (gameEnd.type !== "game_end" || gameEnd.reason !== "tobi") continue;

      const slices = handSlices(log);
      const lastSlice = slices[slices.length - 1]!;
      const causingHand = log.slice(lastSlice.start, lastSlice.end);
      const wins = causingHand.filter((e): e is Extract<GameEvent, { type: "win" }> => e.type === "win");
      if (wins.length === 0 || wins.some((w) => w.isTsumo)) continue; // this test wants a ron-caused bust specifically

      found++;
      expect(gameEnd.eliminatedPlayers.length).toBeGreaterThan(0);
      for (const p of gameEnd.eliminatedPlayers) expect(gameEnd.finalScores[p]!).toBeLessThan(0);
      // no hand_start anywhere after the causing hand's own slice
      expect(log.slice(lastSlice.end).some((e) => e.type === "hand_start")).toBe(false);
      // the causing hand's own hand_end scores already reflect the bust (fully final,
      // not a transient mid-hand value) and match the game_end's finalScores exactly
      const handEnd = causingHand.find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end")!;
      expect(handEnd.scores).toEqual(gameEnd.finalScores);
    }
    expect(found).toBeGreaterThan(0);
  });

  it("a tsumo that pushes a player below 0 ends the game immediately", () => {
    let found = 0;
    for (let seed = 0; seed < 150 && found < 3; seed++) {
      const gs = new GameState({ rules: LOW_START_RULES, seed: `tobi-tsumo-${seed}` });
      gs.playGame();
      const log = gs.log;
      const gameEnd = log[log.length - 1]!;
      if (gameEnd.type !== "game_end" || gameEnd.reason !== "tobi") continue;

      const slices = handSlices(log);
      const lastSlice = slices[slices.length - 1]!;
      const causingHand = log.slice(lastSlice.start, lastSlice.end);
      const wins = causingHand.filter((e): e is Extract<GameEvent, { type: "win" }> => e.type === "win");
      if (wins.length === 0 || !wins[0]!.isTsumo) continue; // this test wants a tsumo-caused bust specifically

      found++;
      expect(gameEnd.eliminatedPlayers.length).toBeGreaterThan(0);
      for (const p of gameEnd.eliminatedPlayers) expect(gameEnd.finalScores[p]!).toBeLessThan(0);
      expect(log.slice(lastSlice.end).some((e) => e.type === "hand_start")).toBe(false);
    }
    expect(found).toBeGreaterThan(0);
  });

  it("an exhaustive draw's noten penalty that pushes a player below 0 ends the game immediately", () => {
    let found = 0;
    for (let seed = 0; seed < 150 && found < 3; seed++) {
      const gs = new GameState({ rules: LOW_START_RULES, seed: `tobi-draw-${seed}` });
      gs.playGame();
      const log = gs.log;
      const gameEnd = log[log.length - 1]!;
      if (gameEnd.type !== "game_end" || gameEnd.reason !== "tobi") continue;

      const slices = handSlices(log);
      const lastSlice = slices[slices.length - 1]!;
      const causingHand = log.slice(lastSlice.start, lastSlice.end);
      const draw = causingHand.find((e) => e.type === "exhaustive_draw");
      if (!draw) continue; // this test wants an exhaustive-draw-caused bust specifically

      found++;
      expect(gameEnd.eliminatedPlayers.length).toBeGreaterThan(0);
      for (const p of gameEnd.eliminatedPlayers) expect(gameEnd.finalScores[p]!).toBeLessThan(0);
      expect(log.slice(lastSlice.end).some((e) => e.type === "hand_start")).toBe(false);
    }
    expect(found).toBeGreaterThan(0);
  });

  it("does NOT end the game when a noten payment lands a player at exactly 0 (only score < 0 counts)", () => {
    // notenPenaltyTotal (2000) split among exactly 2 noten payers = 1000 each exactly;
    // with startingScore=1000, that payer lands at precisely 0 - confirmed not a bust.
    let found = 0;
    for (let seed = 0; seed < 200 && found < 3; seed++) {
      const gs = new GameState({ rules: LOW_START_RULES, seed: `tobi-exact-zero-${seed}` });
      gs.playGame();
      const log = gs.log;

      for (const { start, end } of handSlices(log)) {
        const slice = log.slice(start, end);
        const draw = slice.find((e): e is Extract<GameEvent, { type: "exhaustive_draw" }> => e.type === "exhaustive_draw");
        if (!draw) continue;
        const notenPlayers = [0, 1, 2].filter((p) => !draw.tenpaiPlayers.includes(p));
        if (notenPlayers.length !== 2) continue; // need the 1000-per-payer split specifically
        const handEnd = slice.find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end")!;
        const zeroedPlayer = notenPlayers.find((p) => handEnd.scores[p] === 0);
        if (zeroedPlayer === undefined) continue;
        // the OTHER noten payer may independently have gone negative this same hand (a real,
        // separate bust scenario already covered by the exhaustive-draw tobi test above) -
        // that's irrelevant to what this test checks, so only accept a case where the
        // zeroed-at-exactly-0 player's own hand did not also trigger a whole-game bust
        if (!handEnd.scores.every((s) => s >= 0)) continue;

        found++;
        // exact 0 must not itself trigger tobi: whatever comes right after this hand is
        // either another hand_start (game continues) or a "length" game_end - never "tobi"
        const next = log[end];
        expect(next).toBeDefined();
        if (next!.type === "game_end") expect(next!.reason).toBe("length");
        else expect(next!.type).toBe("hand_start");
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it("game_end's reason stays internally consistent with real starting scores (35000): \"length\" iff no score went negative", () => {
    // With DEFAULT_SANMA_RULES's real 35000 starting score, a bust is rare but not
    // impossible over a real east-only hanchan with AI play (a big hand plus mounting
    // honba can do it) - so this checks internal consistency between reason/
    // eliminatedPlayers/finalScores for whichever outcome actually occurs, rather than
    // assuming every seed lands on "length".
    for (let seed = 0; seed < 5; seed++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `tobi-normal-${seed}` });
      gs.playGame();
      const gameEnd = gs.log[gs.log.length - 1]!;
      expect(gameEnd.type).toBe("game_end");
      if (gameEnd.type !== "game_end") continue;
      if (gameEnd.reason === "length") {
        expect(gameEnd.eliminatedPlayers).toEqual([]);
        expect(gameEnd.finalScores.every((s) => s >= 0)).toBe(true);
      } else {
        expect(gameEnd.reason).toBe("tobi");
        expect(gameEnd.eliminatedPlayers.length).toBeGreaterThan(0);
        for (const p of gameEnd.eliminatedPlayers) expect(gameEnd.finalScores[p]!).toBeLessThan(0);
      }
    }
  });

  it("replay: final scores and placement are computed the normal way from the tobi-time scores (no special-case ranking)", () => {
    let found = false;
    for (let seed = 0; seed < 150 && !found; seed++) {
      const gs = new GameState({ rules: LOW_START_RULES, seed: `tobi-placement-${seed}` });
      gs.playGame();
      const gameEnd = gs.log[gs.log.length - 1]!;
      if (gameEnd.type !== "game_end" || gameEnd.reason !== "tobi") continue;
      found = true;

      const standings = gs.computeFinalStandings();
      // placement is a straightforward descending sort of the raw (possibly negative) scores
      const sortedByScore = [...standings].sort((a, b) => b.rawScore - a.rawScore);
      expect(standings.map((s) => s.player)).toEqual(sortedByScore.map((s) => s.player));
      for (let i = 0; i < standings.length; i++) expect(standings[i]!.placement).toBe(i + 1);
      // the busted player(s) always rank below every non-negative player
      for (const bustedPlayer of gameEnd.eliminatedPlayers) {
        const busted = standings.find((s) => s.player === bustedPlayer)!;
        for (const other of standings) {
          if (other.player === bustedPlayer) continue;
          if (other.rawScore >= 0) expect(busted.placement).toBeGreaterThan(other.placement);
        }
      }
    }
    expect(found).toBe(true);
  });

  it("is seeded-deterministic: the same seed produces an identical tobi outcome and log", () => {
    let found = false;
    for (let seed = 0; seed < 150 && !found; seed++) {
      const label = `tobi-determinism-${seed}`;
      const gs1 = new GameState({ rules: LOW_START_RULES, seed: label });
      gs1.playGame();
      const end1 = gs1.log[gs1.log.length - 1]!;
      if (end1.type !== "game_end" || end1.reason !== "tobi") continue;
      found = true;

      const gs2 = new GameState({ rules: LOW_START_RULES, seed: label });
      gs2.playGame();
      expect(gs2.log).toEqual(gs1.log);
    }
    expect(found).toBe(true);
  });
});
