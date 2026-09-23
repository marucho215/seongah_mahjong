/* Milestone 1 human-play CLI: `npm run play [seed]`. Terminal-only, no graphics - a human
 * sits seat 0 against two CharacterAI opponents and plays one sanma East 1 hand start to
 * finish. Ron stays auto-declared and nine-terminals keeps its default auto-declare policy
 * for every seat (including the human) - both are explicit Milestone 1 scope choices, not
 * oversights (see GameStateOptions.controllers' doc comment). */
import { GameState } from "../core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../rules/RuleConfig.js";
import { getCharacterProfile } from "../ai/characterProfiles.js";
import { runInteractiveHand } from "./humanPlayDriver.js";
import { createNodeIO } from "./nodeIO.js";
import type { GameEvent } from "../core/GameLog.js";

async function main(): Promise<void> {
  const seed = process.argv[2] ?? `human-cli-${Date.now()}`;
  const gs = new GameState({
    rules: DEFAULT_SANMA_RULES,
    seed,
    characterProfiles: [null, getCharacterProfile("jegalmina"), getCharacterProfile("jegalnahui")],
    controllers: ["human", undefined, undefined],
  });

  const io = createNodeIO();
  io.print(`Seed: ${seed} (pass a seed as the first argument to reproduce a specific hand)`);
  io.print(`You are seat 0. Opponents: seat 1 (jegalmina), seat 2 (jegalnahui).`);

  await runInteractiveHand(gs, io);
  io.close?.();

  const handEnd = [...gs.log].reverse().find((e: GameEvent): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end");
  console.log("\n=== Hand finished ===");
  console.log(JSON.stringify(handEnd, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
