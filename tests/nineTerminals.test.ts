import { describe, expect, it } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { runInteractiveHand } from "../src/cli/humanPlayDriver.js";
import { createScriptedIO } from "../src/cli/scriptedIO.js";
import { GuiSession } from "../src/gui/guiSession.js";
import { RonFixture, J0, J2, W } from "./helpers/ronFixture.js";
import type { TileKind } from "../src/core/tiles.js";
import type { DecisionRequest, NineTerminalsDecisionRequest } from "../src/core/decisions.js";

// 9 distinct terminal/honor kinds (p1 p9 s1 s9 m1 m9 z1 z2 z3) + the forced z5 draw = 10.
const T0: TileKind[] = ["p1", "p9", "s1", "s9", "m1", "m9", "z1", "z2", "z3", "p3", "p5", "s4", "s6"];

function game(controllers: ("human" | undefined)[], hands = [T0, W, J2], extra: Partial<ConstructorParameters<typeof GameState>[0]> = {}) {
  return new RonFixture(
    { rules: DEFAULT_SANMA_RULES, seed: "nine-terminals", controllers, ...extra },
    { hands, draws: ["z5"] }
  );
}

function firstRequest(g: GameState): { req: DecisionRequest; next: (declare: boolean) => IteratorResult<DecisionRequest, void> } {
  const session = g.playHandInteractive();
  const step = session.next();
  if (step.done) throw new Error("expected a request");
  return { req: step.value, next: (declare) => session.next({ type: "nine_terminals", declare }) };
}

const abortive = (g: GameState) => g.log.filter((e) => e.type === "abortive_draw");

describe("nine terminals - human choice", () => {
  it("asks an eligible human seat, and declaring aborts the hand", () => {
    const g = game(["human", undefined, undefined]);
    const { req, next } = firstRequest(g);
    expect(req.type).toBe("nine_terminals");
    expect((req as NineTerminalsDecisionRequest).distinctTerminalKinds).toBeGreaterThanOrEqual(9);
    expect(next(true).done).toBe(true);
    expect(abortive(g)).toEqual([{ type: "abortive_draw", reason: "nine_terminals" }]);
  });

  it("declining plays on: no abort, and the normal discard decision follows", () => {
    const g = game(["human", undefined, undefined]);
    const { next } = firstRequest(g);
    const step = next(false);
    expect(step.done).toBe(false);
    expect((step as { value: DecisionRequest }).value.type).toBe("discard");
    expect(abortive(g)).toHaveLength(0);
  });

  it("never asks a human whose hand is not eligible", () => {
    const g = game(["human", undefined, undefined], [J0, W, J2]);
    expect(firstRequest(g).req.type).toBe("discard");
  });

  it("rejects a wrong-typed response instead of silently declining", () => {
    const g = game(["human", undefined, undefined]);
    const session = g.playHandInteractive();
    session.next();
    expect(() => session.next({ type: "ron", declare: true })).toThrow(/expected a "nine_terminals" response/);
  });
});

describe("nine terminals - non-human seats keep nineTerminalsPolicy", () => {
  it("default policy still auto-aborts an eligible AI dealer, with no request", () => {
    const g = game([undefined, undefined, undefined]);
    g.playHand(); // throws if anything were yielded
    expect(abortive(g)).toEqual([{ type: "abortive_draw", reason: "nine_terminals" }]);
  });

  it("a custom policy is still consulted (and only for an eligible hand)", () => {
    const seen: number[] = [];
    const g = game([undefined, undefined, undefined], [T0, W, J2], {
      nineTerminalsPolicy: (seat) => {
        seen.push(seat);
        return false;
      },
    });
    g.playHand();
    expect(seen[0]).toBe(0);
    expect(g.log.some((e) => e.type === "abortive_draw")).toBe(false);
  });
});

describe("nine terminals - CLI and GUI", () => {
  it("CLI prompts, re-prompts on garbage, and y aborts", async () => {
    const g = game(["human", undefined, undefined]);
    const answers = ["maybe", "y"];
    const io = createScriptedIO((prompt) => (prompt.includes("구종구패") ? answers.shift()! : "n"));
    await runInteractiveHand(g, io);
    expect(io.transcript.join("\n")).toContain('Please answer "y" or "n".');
    expect(abortive(g)).toHaveLength(1);
  });

  it("GUI session surfaces the request, and declare:false continues the hand", () => {
    const g = game(["human", undefined, undefined]);
    const session = new GuiSession(g);
    const req = session.getCurrentRequest() as NineTerminalsDecisionRequest;
    expect(req.type).toBe("nine_terminals");
    expect(JSON.parse(JSON.stringify(req)).view.opponents.every((o: object) => !("concealedTiles" in o))).toBe(true);
    session.respond({ type: "nine_terminals", declare: false });
    expect(session.getPhase()).toBe("decision");
    expect(session.getCurrentRequest()!.type).toBe("discard");

    const g2 = game(["human", undefined, undefined]);
    const s2 = new GuiSession(g2);
    s2.respond({ type: "nine_terminals", declare: true });
    expect(s2.getPhase()).not.toBe("decision");
    expect(s2.getHandEndEvent()!.result!.kind).toBe("abortive_draw");
  });
});
