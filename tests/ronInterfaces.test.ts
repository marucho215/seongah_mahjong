import { describe, expect, it } from "vitest";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { runInteractiveHand } from "../src/cli/humanPlayDriver.js";
import { createScriptedIO } from "../src/cli/scriptedIO.js";
import { GuiSession } from "../src/gui/guiSession.js";
import { J0, J2, RonFixture, W, ronGame } from "./helpers/ronFixture.js";
import type { RonDecisionRequest } from "../src/core/decisions.js";

const STOP = new Error("scripted stop");

/** CLI answers driven by the printed prompts: discards pick the next wanted tile label out of
 *  the last printed "Concealed:" row; ron prompts consume `ronAnswers` in order. */
function cliPolicy(wantedLabels: string[], ronAnswers: string[]) {
  let lastConcealed = "";
  const wanted = [...wantedLabels];
  const rons = [...ronAnswers];
  return {
    remember(line: string) {
      if (line.startsWith("Concealed:")) lastConcealed = line;
    },
    answer(prompt: string): string {
      if (prompt.startsWith("Discard")) {
        const label = wanted.shift();
        if (!label) throw STOP;
        const index = new RegExp(`\\[(\\d+)\\]${label}(?=\\s|$)`).exec(lastConcealed)?.[1];
        if (index === undefined) throw new Error(`no ${label} in: ${lastConcealed}`);
        return index;
      }
      if (prompt.startsWith("론")) return rons.shift() ?? "n";
      return "n";
    },
  };
}

function scriptedCli(policy: ReturnType<typeof cliPolicy>) {
  const io = createScriptedIO((prompt) => policy.answer(prompt));
  const print = io.print.bind(io);
  io.print = (line: string) => {
    policy.remember(line);
    print(line);
  };
  return io;
}

describe("CLI ron / pass prompt", () => {
  it("shows the engine's preview, and answering y takes the ron", async () => {
    const game = ronGame(DEFAULT_SANMA_RULES, ["human", "human", undefined], [J0, W, J2]);
    const io = scriptedCli(cliPolicy(["8통"], ["y"]));
    await runInteractiveHand(game, io);
    const text = io.transcript.join("\n");
    expect(text).toContain("론 가능!");
    expect(text).toContain("Tanyao");
    expect(game.log.filter((e) => e.type === "win").map((e) => (e.type === "win" ? e.player : -1))).toEqual([1]);
  });

  it("re-prompts on garbage instead of forwarding it, and n is a genuine pass (hand continues)", async () => {
    const game = ronGame(DEFAULT_SANMA_RULES, ["human", "human", undefined], [J0, W, J2], ["p8", "z7"]);
    const io = scriptedCli(cliPolicy(["8통", "중"], ["maybe", "n"]));
    await expect(runInteractiveHand(game, io)).rejects.toBe(STOP);
    const text = io.transcript.join("\n");
    expect(text).toContain('Please answer "y" or "n".');
    expect(game.log.some((e) => e.type === "win")).toBe(false);
    expect(game.log.some((e) => e.type === "discard" && e.player === 1 && e.tile === "z7")).toBe(true);
  });

  it("prints the furiten line (with its cause) for a furiten seat", async () => {
    const game = new RonFixture(
      { rules: DEFAULT_SANMA_RULES, seed: "ron-decision", controllers: ["human", "human", undefined] },
      { hands: [J0, W, J2], draws: ["p5", "z7"], ownDiscards: [[], ["p8"], []] }
    );
    const io = scriptedCli(cliPolicy(["5통", "중"], []));
    await expect(runInteractiveHand(game, io)).rejects.toBe(STOP);
    const text = io.transcript.join("\n");
    expect(text).toContain("Furiten: yes (own discard)");
    expect(text).not.toContain("론 가능!");
  });
});

describe("GUI session ron / pass", () => {
  function sessionAtRonRequest() {
    const game = ronGame(DEFAULT_SANMA_RULES, ["human", "human", undefined], [J0, W, J2]);
    const session = new GuiSession(game);
    const first = session.getCurrentRequest()!;
    if (first.type !== "discard") throw new Error("expected a discard first");
    const p8 = [...first.view.concealedTiles].reverse().find((t) => t.kind === "p8")!;
    session.respond({ type: "discard", tileId: p8.id, declareRiichi: false });
    return { game, session };
  }

  it("surfaces a ron request with the preview and the seat's furiten state, and no opponent concealed tiles", () => {
    const { session } = sessionAtRonRequest();
    const req = session.getCurrentRequest() as RonDecisionRequest;
    expect(req.type).toBe("ron");
    expect(req.seat).toBe(1);
    expect(req.preview.totalPoints).toBeGreaterThan(0);
    expect(req.view.furiten).toEqual({ active: false, selfDiscard: false, temporary: false, riichi: false });
    const wire = JSON.parse(JSON.stringify(req));
    expect(wire.view.opponents.every((o: object) => !("concealedTiles" in o))).toBe(true);
  });

  it("declare:true ends the hand as that seat's win; declare:false continues it", () => {
    const won = sessionAtRonRequest();
    won.session.respond({ type: "ron", declare: true });
    expect(won.session.getPhase()).not.toBe("decision");
    const result = won.session.getHandEndEvent()!.result!;
    expect(result.kind).toBe("agari");
    if (result.kind === "agari") expect(result.winners.map((w) => w.winnerSeat)).toEqual([1]);

    const passed = sessionAtRonRequest();
    passed.session.respond({ type: "ron", declare: false });
    expect(passed.session.getPhase()).toBe("decision");
    expect(passed.session.getCurrentRequest()!.type).not.toBe("ron");
  });

  it("rejects a response of the wrong type instead of silently passing the ron", () => {
    const { session } = sessionAtRonRequest();
    expect(() => session.respond({ type: "call_pon", declare: true })).toThrow(/expected a "ron" response/);
  });
});
