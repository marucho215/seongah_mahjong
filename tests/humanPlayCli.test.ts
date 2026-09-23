import { describe, expect, it } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import { collectAllInvariantViolations } from "../src/validation/invariants.js";
import { runInteractiveHand } from "../src/cli/humanPlayDriver.js";
import { createScriptedIO } from "../src/cli/scriptedIO.js";
import { compareTilesForDisplay } from "../src/cli/tileFormat.js";
import { parseKind } from "../src/core/tiles.js";

function newHumanGame(seed: string): GameState {
  return new GameState({
    rules: DEFAULT_SANMA_RULES,
    seed,
    characterProfiles: [null, getCharacterProfile("jegalmina"), getCharacterProfile("jegalnahui")],
    controllers: ["human", undefined, undefined],
  });
}

/** Always answers "n" to any yes/no call prompt, and discards index 0 (never riichi) - the
 *  CLI-parser equivalent of the always-pass policy used for the engine-level tests. */
function alwaysPassPolicy(prompt: string): string {
  if (prompt.startsWith("Discard")) return "0";
  return "n";
}

describe("CLI human-play driver (scripted IO, no real stdin)", () => {
  it("completes a full sanma hand start-to-finish via scripted terminal input, with zero invariant violations", async () => {
    for (let i = 0; i < 15; i++) {
      const gs = newHumanGame(`cli-smoke-${i}`);
      const io = createScriptedIO(alwaysPassPolicy);
      await runInteractiveHand(gs, io);
      expect(gs.log.some((e) => e.type === "hand_end")).toBe(true);
      const violations = collectAllInvariantViolations({ rules: DEFAULT_SANMA_RULES, events: gs.log });
      expect(violations, `seed cli-smoke-${i}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });

  it("never prints an opponent's concealed tile - only seat 0's own hand is ever labeled Concealed/Melds/Kita under 'Your hand'", async () => {
    const gs = newHumanGame("cli-leak-check");
    const io = createScriptedIO(alwaysPassPolicy);
    await runInteractiveHand(gs, io);
    expect(io.transcript.length).toBeGreaterThan(0);
    // The "Seat N: ..." opponent lines only ever carry discards/melds/riichi/kitaCount -
    // never a "Concealed:" field, which is exclusively the seat-0 "Your hand" section's own
    // label. This is a direct structural check on what actually got rendered (not just on
    // PlayerView's type, which tests/humanPlay.test.ts already covers at the data level).
    for (const line of io.transcript) {
      if (line.startsWith("Seat ")) {
        expect(line).not.toContain("Concealed");
        expect(line).toMatch(/^Seat \d+: discards=\[.*\] melds=\[.*\] riichi=(yes|no) kitaCount=\d+$/);
      }
      if (line.startsWith("--- Your hand")) {
        expect(line).toBe("--- Your hand (seat 0) ---");
      }
    }
  });

  it("re-prompts instead of forwarding an out-of-range discard index to the engine", async () => {
    const gs = newHumanGame("cli-illegal-index");
    let discardPromptCount = 0;
    const io = createScriptedIO((prompt) => {
      if (prompt.startsWith("Discard")) {
        discardPromptCount++;
        return discardPromptCount === 1 ? "999" : "0"; // out of range, then valid
      }
      return "n";
    });
    await runInteractiveHand(gs, io);
    expect(gs.log.some((e) => e.type === "hand_end")).toBe(true);
    expect(io.transcript.some((l) => l.includes("No tile at index 999"))).toBe(true);
  });

  it("re-prompts instead of forwarding garbage input to a yes/no call decision", async () => {
    const gs = newHumanGame("cli-illegal-yn");
    const seenCallPrompts = new Set<string>();
    const io = createScriptedIO((prompt) => {
      if (prompt.startsWith("Discard")) return "0";
      const isFirstTimeForThisPrompt = !seenCallPrompts.has(prompt);
      seenCallPrompts.add(prompt);
      return isFirstTimeForThisPrompt ? "maybe" : "n";
    });
    await runInteractiveHand(gs, io);
    expect(gs.log.some((e) => e.type === "hand_end")).toBe(true);
    expect(io.transcript.some((l) => l.includes('Please answer "y" or "n".'))).toBe(true);
  });

  it("lets a scripted human seat actually declare riichi through the CLI's own text parsing", async () => {
    let sawRiichiEvent = false;
    for (let i = 0; i < 40 && !sawRiichiEvent; i++) {
      const gs = newHumanGame(`cli-riichi-${i}`);
      const io = createScriptedIO((prompt) => {
        if (prompt.startsWith("Discard")) {
          const riichiLine = [...io.transcript].reverse().find((l) => l.startsWith("Riichi-legal indices:"));
          const match = riichiLine ? /Riichi-legal indices: \[(\d+)/.exec(riichiLine) : null;
          return match ? `r ${match[1]}` : "0";
        }
        return "n";
      });
      await runInteractiveHand(gs, io);
      if (gs.log.some((e) => e.type === "riichi" && e.player === 0)) sawRiichiEvent = true;
    }
    expect(sawRiichiEvent).toBe(true);
  });

  it("always renders the concealed hand in display sort order (man -> pin -> sou -> honors, ascending rank), never raw hand order", async () => {
    const suitOf = (label: string): number => {
      if (label.includes("만")) return 0;
      if (label.includes("통")) return 1;
      if (label.includes("삭")) return 2;
      return 3; // honor name (동남서북백발중), no suit marker
    };
    const rankOf = (label: string): number => {
      const match = /(\d+)/.exec(label);
      return match ? Number(match[1]) : 0;
    };
    for (let i = 0; i < 10; i++) {
      const gs = newHumanGame(`cli-sort-render-${i}`);
      const io = createScriptedIO(alwaysPassPolicy);
      await runInteractiveHand(gs, io);
      const concealedLines = io.transcript.filter((l) => l.startsWith("Concealed: "));
      expect(concealedLines.length).toBeGreaterThan(0);
      for (const line of concealedLines) {
        const labels = [...line.matchAll(/\[\d+\](\S+)/g)].map((m) => m[1]!);
        const keys = labels.map((l) => [suitOf(l), rankOf(l)] as const);
        for (let k = 1; k < keys.length; k++) {
          const [prevSuit, prevRank] = keys[k - 1]!;
          const [curSuit, curRank] = keys[k]!;
          expect(curSuit > prevSuit || (curSuit === prevSuit && curRank >= prevRank)).toBe(true);
        }
      }
    }
  });

  it("maps a display index back to the correct physical tile id even when display order differs from raw hand order", () => {
    // Drives GameState.playHandInteractive() directly (bypassing the CLI's own IO) so the
    // test can inspect the raw (unsorted) DecisionRequest.view.concealedTiles order and
    // choose a seed/index where display order genuinely differs from it, then answer with
    // the DISPLAY index's tile id (exactly what humanPlayDriver.ts's askDiscardDecision
    // does internally) and confirm the logged discard is that sorted tile, not whatever
    // tile happened to sit at the same position in the raw array.
    let verifiedAtLeastOneMismatch = false;
    for (let i = 0; i < 20 && !verifiedAtLeastOneMismatch; i++) {
      const game = newHumanGame(`cli-index-mapping-${i}`);
      const session = game.playHandInteractive();
      let step = session.next();
      while (!step.done) {
        if (step.value.type === "discard") {
          const raw = step.value.view.concealedTiles;
          const sorted = [...raw].sort(compareTilesForDisplay);
          const rawIndexOfSortedFirst = raw.findIndex((t) => t.id === sorted[0]!.id);
          if (rawIndexOfSortedFirst !== 0) {
            // Display index 0 (what a user typing "0" selects) must resolve to sorted[0],
            // a physically different tile than raw[0] - the actual bug this guards against.
            expect(sorted[0]!.id).not.toBe(raw[0]!.id);
            step = session.next({ type: "discard", tileId: sorted[0]!.id, declareRiichi: false });
            // Find seat 0's own discard specifically - by the time this resumes, the other
            // two AI seats may already have taken (and logged) further turns/discards.
            const seat0Discard = [...game.log].reverse().find((e): e is Extract<typeof e, { type: "discard" }> => e.type === "discard" && e.player === 0);
            expect(seat0Discard?.tile).toBe(sorted[0]!.kind);
            verifiedAtLeastOneMismatch = true;
            break;
          }
        }
        // Not an interesting seed/turn for this check - fast-forward with a trivial
        // always-pass policy to reach either the next discard opportunity or hand_end.
        step = session.next(
          step.value.type === "discard"
            ? { type: "discard", tileId: step.value.legalTileIds[0]!, declareRiichi: false }
            : { type: step.value.type, declare: false }
        );
      }
    }
    expect(verifiedAtLeastOneMismatch).toBe(true);
  });
});
