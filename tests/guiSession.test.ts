import { describe, expect, it } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { collectAllInvariantViolations } from "../src/validation/invariants.js";
import { GuiSession } from "../src/gui/guiSession.js";
import type { DecisionRequest, DecisionResponse } from "../src/core/decisions.js";

function newHumanGame(seed: string): GameState {
  return new GameState({ rules: DEFAULT_SANMA_RULES, seed, controllers: ["human", undefined, undefined] });
}

function alwaysPassResponse(request: DecisionRequest): DecisionResponse {
  if (request.type === "discard") return { type: "discard", tileId: request.legalTileIds[0]!, declareRiichi: false };
  return { type: request.type, declare: false };
}

describe("GuiSession", () => {
  it("drives a full hand to completion, same contract as the CLI driver", () => {
    for (let i = 0; i < 15; i++) {
      const gs = newHumanGame(`gui-session-${i}`);
      const session = new GuiSession(gs);
      let steps = 0;
      while (!session.isFinished()) {
        const request = session.getCurrentRequest();
        expect(request).not.toBeNull();
        session.respond(alwaysPassResponse(request!));
        steps++;
        if (steps > 2000) throw new Error("runaway loop guard triggered");
      }
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
    while (!session.isFinished()) {
      session.respond(alwaysPassResponse(session.getCurrentRequest()!));
    }
    const handEnd = session.getHandEndEvent();
    expect(handEnd).toBeDefined();
    expect(handEnd!.type).toBe("hand_end");
    expect(handEnd).toBe([...gs.log].reverse().find((e) => e.type === "hand_end"));
  });

  it("throws instead of silently accepting a response after the hand has already finished", () => {
    const gs = newHumanGame("gui-session-overrespond");
    const session = new GuiSession(gs);
    while (!session.isFinished()) {
      session.respond(alwaysPassResponse(session.getCurrentRequest()!));
    }
    expect(() => session.respond({ type: "discard", tileId: -1, declareRiichi: false })).toThrow(/already finished/);
  });

  it("rejects an illegal discard response exactly like the CLI driver does (same underlying GameState validation)", () => {
    const gs = newHumanGame("gui-session-illegal");
    const session = new GuiSession(gs);
    expect(() => session.respond({ type: "discard", tileId: -999999, declareRiichi: false })).toThrow(/not a legal discard/);
  });
});
