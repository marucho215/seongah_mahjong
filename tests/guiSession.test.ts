import { describe, expect, it } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { collectAllInvariantViolations } from "../src/validation/invariants.js";
import { GuiSession } from "../src/gui/guiSession.js";
import type { DecisionRequest, DecisionResponse } from "../src/core/decisions.js";
import type { GameEvent } from "../src/core/GameLog.js";

function newHumanGame(seed: string): GameState {
  return new GameState({ rules: DEFAULT_SANMA_RULES, seed, controllers: ["human", undefined, undefined] });
}

function alwaysPassResponse(request: DecisionRequest): DecisionResponse {
  if (request.type === "discard") return { type: "discard", tileId: request.legalTileIds[0]!, declareRiichi: false };
  return { type: request.type, declare: false };
}

/** Drives one hand to completion (phase leaves "decision"), auto-passing every decision. */
function driveOneHand(session: GuiSession): void {
  let steps = 0;
  while (session.getPhase() === "decision") {
    session.respond(alwaysPassResponse(session.getCurrentRequest()!));
    steps++;
    if (steps > 2000) throw new Error("runaway loop guard triggered");
  }
}

/** Drives the whole game (every hand, auto-continuing) until phase is "game_end". */
function driveWholeGame(session: GuiSession): number {
  let handsPlayed = 0;
  let guard = 0;
  for (;;) {
    driveOneHand(session);
    handsPlayed++;
    if (session.getPhase() === "game_end") return handsPlayed;
    session.continueToNextHand();
    guard++;
    if (guard > 200) throw new Error("runaway loop guard triggered");
  }
}

describe("GuiSession", () => {
  it("drives a full hand to completion, same contract as the CLI driver", () => {
    for (let i = 0; i < 15; i++) {
      const gs = newHumanGame(`gui-session-${i}`);
      const session = new GuiSession(gs);
      driveOneHand(session);
      expect(session.getPhase()).not.toBe("decision");
      expect(session.getCurrentRequest()).toBeNull();
      expect(gs.log.some((e) => e.type === "hand_end")).toBe(true);
      const violations = collectAllInvariantViolations({ rules: DEFAULT_SANMA_RULES, events: gs.log });
      expect(violations, `seed gui-session-${i}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });

  it("getHandEndEvent() is undefined before the hand finishes, and the real hand_end after", () => {
    const gs = newHumanGame("gui-session-handend");
    const session = new GuiSession(gs);
    expect(session.getHandEndEvent()).toBeUndefined();
    driveOneHand(session);
    const handEnd = session.getHandEndEvent();
    expect(handEnd).toBeDefined();
    expect(handEnd!.type).toBe("hand_end");
    expect(handEnd).toBe([...gs.log].reverse().find((e) => e.type === "hand_end"));
  });

  it("respond() throws once a hand has ended (phase is no longer \"decision\")", () => {
    const gs = newHumanGame("gui-session-overrespond");
    const session = new GuiSession(gs);
    driveOneHand(session);
    expect(() => session.respond({ type: "discard", tileId: -1, declareRiichi: false })).toThrow(/no decision is currently pending/);
  });

  it("continueToNextHand() throws when a decision is still pending or the game has already ended", () => {
    const gs = newHumanGame("gui-session-continue-misuse");
    const session = new GuiSession(gs);
    expect(session.getPhase()).toBe("decision");
    expect(() => session.continueToNextHand()).toThrow(/cannot continue to the next hand/);
  });

  it("rejects an illegal discard response exactly like the CLI driver does (same underlying GameState validation)", () => {
    const gs = newHumanGame("gui-session-illegal");
    const session = new GuiSession(gs);
    expect(() => session.respond({ type: "discard", tileId: -999999, declareRiichi: false })).toThrow(/not a legal discard/);
  });

  it("continues across multiple hands on the SAME GameState - scores/dealer/round/honba/kyotaku carry over exactly as playGame() would", () => {
    for (const seed of ["gui-multihand-1", "gui-multihand-2"]) {
      const gs = newHumanGame(seed);
      const session = new GuiSession(gs);

      driveOneHand(session);
      expect(session.getPhase()).not.toBe("decision");
      if (session.getPhase() === "game_end") continue; // rare: hit game-end on hand 1 - nothing left to test here

      const handIndexAfterFirst = gs.handIndex;
      const totalPointsAfterFirst = gs.scores.reduce((a, b) => a + b, 0) + gs.kyotaku * 1000;

      session.continueToNextHand();
      expect(session.getPhase()).toBe("decision"); // seat 0 is human every hand, so a fresh decision is expected quickly

      driveOneHand(session);

      // Still the same GameState instance the whole time - no new one was ever constructed,
      // so handIndex/log accumulate and total points (scores + riichi sticks) are conserved
      // across the hand boundary exactly like a synchronous playGame() would.
      expect(gs.handIndex).toBe(handIndexAfterFirst + 1);
      expect(gs.scores.reduce((a, b) => a + b, 0) + gs.kyotaku * 1000).toBe(totalPointsAfterFirst);
      expect(gs.log.filter((e) => e.type === "hand_start").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("reaches \"game_end\" for a full game, with finalizeGame() already applied and no further decisions/continues possible", () => {
    const gs = newHumanGame("gui-fullgame-1");
    const session = new GuiSession(gs);
    const handsPlayed = driveWholeGame(session);

    expect(session.getPhase()).toBe("game_end");
    expect(handsPlayed).toBeGreaterThan(0);
    const gameEnd = session.getGameEndEvent();
    expect(gameEnd).toBeDefined();
    expect(gs.log.filter((e) => e.type === "game_end")).toEqual([gameEnd]);
    expect(() => session.continueToNextHand()).toThrow(/cannot continue to the next hand/);
    expect(() => session.respond({ type: "discard", tileId: -1, declareRiichi: false })).toThrow(/no decision is currently pending/);

    const violations = collectAllInvariantViolations({ rules: DEFAULT_SANMA_RULES, events: gs.log });
    expect(violations).toEqual([]);
  }, 60000);

  it("across many full games, exercises dealer renchan, dealer rotation, exhaustive draw, and kyotaku carryover across a hand boundary - all through GuiSession's own multi-hand loop, not playGame()", () => {
    const found = { renchan: false, rotation: false, exhaustiveDraw: false, kyotakuCarryover: false };
    const reasons = new Set<string>();

    for (let i = 0; i < 10; i++) {
      const gs = newHumanGame(`gui-scenario-search-${i}`);
      const session = new GuiSession(gs);
      driveWholeGame(session);

      const handStarts = gs.log.filter((e): e is Extract<GameEvent, { type: "hand_start" }> => e.type === "hand_start");
      for (let h = 1; h < handStarts.length; h++) {
        const prev = handStarts[h - 1]!;
        const curr = handStarts[h]!;
        if (curr.dealer === prev.dealer) found.renchan = true;
        else found.rotation = true;
        if (prev.kyotaku > 0 && curr.kyotaku > 0) found.kyotakuCarryover = true;
      }
      if (gs.log.some((e) => e.type === "exhaustive_draw")) found.exhaustiveDraw = true;
      const gameEnd = gs.log.find((e): e is Extract<GameEvent, { type: "game_end" }> => e.type === "game_end");
      if (gameEnd) reasons.add(gameEnd.reason);

      // Exactly one game_end per game, regardless of how many hands it took.
      expect(gs.log.filter((e) => e.type === "game_end").length).toBe(1);
      const violations = collectAllInvariantViolations({ rules: DEFAULT_SANMA_RULES, events: gs.log });
      expect(violations, `seed gui-scenario-search-${i}: ${JSON.stringify(violations)}`).toEqual([]);
    }

    expect(found.renchan, "expected at least one dealer-continuation (renchan) hand across the batch").toBe(true);
    expect(found.rotation, "expected at least one dealer-rotation hand across the batch").toBe(true);
    expect(found.exhaustiveDraw, "expected at least one exhaustive draw across the batch").toBe(true);
    expect(found.kyotakuCarryover, "expected at least one hand to start with a nonzero kyotaku carried over from the previous hand").toBe(true);
    console.log("game_end reasons observed across the batch:", [...reasons]);
  }, 60000);
});
