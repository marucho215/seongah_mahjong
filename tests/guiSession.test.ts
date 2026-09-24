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

describe("GuiSession: 잘못된 응답이 진행 중인 국을 망가뜨리지 않는다", () => {
  /** kita 제안 등 discard가 아닌 요청이 먼저 오면 거절로 넘기고, 첫 discard 요청까지 진행한다. */
  function sessionAtFirstDiscard(seed: string) {
    const gs = newHumanGame(seed);
    const session = new GuiSession(gs);
    let req = session.getCurrentRequest()!;
    while (req.type !== "discard") {
      session.respond({ type: req.type, declare: false } as DecisionResponse);
      req = session.getCurrentRequest()!;
    }
    return { gs, session, req: req as Extract<DecisionRequest, { type: "discard" }> };
  }

  it("합법이 아닌 패 응답은 거절되고, 같은 요청이 그대로 남아 이후 올바른 응답으로 정상 진행된다", () => {
    const { gs, session, req } = sessionAtFirstDiscard("gui-session-reject-then-ok");
    const logLength = gs.log.length;

    expect(() => session.respond({ type: "discard", tileId: -999, declareRiichi: false })).toThrow(/not a legal discard/);
    expect(session.getPhase()).toBe("decision");
    expect(session.getCurrentRequest()).toBe(req); // 같은 요청 객체 - 아무것도 진행되지 않았다
    expect(gs.log.length).toBe(logLength);

    session.respond({ type: "discard", tileId: req.legalTileIds[0]!, declareRiichi: false });
    expect(gs.log.length).toBeGreaterThan(logLength);
    // 국이 끝났다면 반드시 결과 이벤트가 있어야 한다 (이벤트 없는 hand_end 상태가 되면 안 된다)
    if (session.getPhase() !== "decision") expect(session.getHandEndEvent()).toBeDefined();
  });

  it("리치가 불가능한 패로 리치를 선언하는 응답은 거절되고 세션은 그대로다", () => {
    const { session, req } = sessionAtFirstDiscard("gui-session-reject-riichi");
    const notRiichi = req.legalTileIds.find((id) => !req.riichiLegalTileIds.includes(id))!;
    expect(() => session.respond({ type: "discard", tileId: notRiichi, declareRiichi: true })).toThrow(/not a legal riichi discard/);
    expect(session.getCurrentRequest()).toBe(req);
  });

  it("요청과 종류가 다른 응답, declare/declareRiichi가 불리언이 아닌 응답은 거절된다", () => {
    const { session, req } = sessionAtFirstDiscard("gui-session-reject-shape");
    expect(() => session.respond({ type: "call_pon", declare: true })).toThrow(/expected a "discard" response/);
    expect(() => session.respond({ type: "discard", tileId: req.legalTileIds[0]!, declareRiichi: undefined as unknown as boolean })).toThrow(/boolean/);
    expect(() => session.respond(null as unknown as DecisionResponse)).toThrow(/expected a "discard" response/);
    expect(session.getCurrentRequest()).toBe(req);
  });

  it("예/아니오 요청에 boolean이 아닌 declare가 오면 거절된다", () => {
    const gs = newHumanGame("gui-session-reject-declare");
    const session = new GuiSession(gs);
    let req = session.getCurrentRequest()!;
    // 이 시드에서 non-discard 요청이 없으면 검증할 대상이 없으므로 다른 시드를 찾는다
    for (let i = 0; req.type === "discard" && i < 400; i++) {
      const g = newHumanGame(`gui-session-find-call-${i}`);
      const s = new GuiSession(g);
      for (let step = 0; step < 60 && s.getPhase() === "decision"; step++) {
        const r = s.getCurrentRequest()!;
        if (r.type !== "discard") {
          expect(() => s.respond({ type: r.type, declare: "yes" as unknown as boolean } as DecisionResponse)).toThrow(/boolean "declare"/);
          expect(s.getCurrentRequest()).toBe(r);
          return;
        }
        s.respond(alwaysPassResponse(r));
      }
    }
    throw new Error("예/아니오 요청을 만나지 못했습니다");
  });

  it("엔진이 예외를 던져 세션이 죽으면, 이후 응답을 조용히 받아들이지 않고 명확히 거절한다", () => {
    const request = { type: "kita", seat: 0, tileKind: "z4", view: {} } as unknown as DecisionRequest;
    const fakeGame = {
      log: [],
      recordHumanDecision: () => {},
      playHandInteractive: function* () {
        yield request;
        throw new Error("boom");
      },
    } as unknown as GameState;
    const session = new GuiSession(fakeGame);
    expect(() => session.respond({ type: "kita", declare: true })).toThrow(/boom/);
    expect(() => session.respond({ type: "kita", declare: true })).toThrow(/stopped after an earlier engine error/);
    expect(() => session.continueToNextHand()).toThrow(/stopped after an earlier engine error/);
  });
});
