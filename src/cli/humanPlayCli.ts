/* human-play CLI: `npm run play [seed] [-- --mode yonma]`. Terminal-only, no graphics - a human
 * sits seat 0 against CharacterAI opponents (2 in sanma, 3 in yonma) and plays one hand start to
 * finish. The game setup is shared with the GUI server (src/gui/gameSetup.ts); only the mode differs. */
import { createGuiGame, parseGameArgs } from "../gui/gameSetup.js";
import { runInteractiveHand } from "./humanPlayDriver.js";
import { createNodeIO } from "./nodeIO.js";
import { buildGameReplayRecord, replaySeatsFromGame, writeGameReplay } from "../sim/replayRecorder.js";
import type { GameEvent } from "../core/GameLog.js";

async function main(): Promise<void> {
  const parsed = parseGameArgs(process.argv.slice(2));
  const seed = parsed.seed ?? `human-cli-${Date.now()}`;
  const gs = createGuiGame(parsed.mode, seed);

  const io = createNodeIO();
  io.print(`Mode: ${parsed.mode}, Seed: ${seed} (pass a seed as the first argument to reproduce a specific hand)`);
  const opponents = gs.characterProfiles.map((p, seat) => (seat === 0 ? null : `seat ${seat} (${p?.displayName ?? "AI"})`)).filter(Boolean);
  io.print(`You are seat 0. Opponents: ${opponents.join(", ")}.`);

  await runInteractiveHand(gs, io);
  io.close?.();

  const handEnd = [...gs.log].reverse().find((e: GameEvent): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end");
  console.log("\n=== Hand finished ===");
  console.log(JSON.stringify(handEnd, null, 2));

  if (parsed.saveReplays) {
    // CLI는 한 국만 진행하므로 game_end 없이 그 국까지의 리플레이가 저장된다 (형식은 AI 리플레이와 동일).
    const record = buildGameReplayRecord(gs, `human-cli-${parsed.mode}-${seed}`, 0, replaySeatsFromGame(gs));
    console.log(`Replay saved: ${writeGameReplay(record, "replays")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
