import { GameState } from "../core/GameState.js";
import { getCharacterProfile } from "../ai/characterProfiles.js";
import { MAJSOUL_YONMA_RULES } from "../rules/RuleConfig.js";
import {
  buildGameReplayRecord,
  writeGameReplay,
  type ReplaySeatInfo,
} from "./replayRecorder.js";

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const playersValue = optionValue(argv, "--players");
const seed = optionValue(argv, "--seed") ?? "yonma-character-cli";
const saveReplays = argv.includes("--save-replays");

if (!playersValue) {
  throw new Error(
    "Usage: npm run sim:yonma -- --players <id1,id2,id3,id4> [--seed <seed>] [--save-replays]"
  );
}

const characterIds = playersValue.split(",").map((id) => id.trim()).filter(Boolean);
if (characterIds.length !== MAJSOUL_YONMA_RULES.playerCount) {
  throw new Error(`--players must contain exactly ${MAJSOUL_YONMA_RULES.playerCount} comma-separated character ids`);
}

const profiles = characterIds.map((id) => getCharacterProfile(id));
const game = new GameState({
  rules: MAJSOUL_YONMA_RULES,
  seed,
  characterProfiles: profiles,
});
game.playGame();

const gameEnd = game.log.at(-1);
if (!gameEnd || gameEnd.type !== "game_end") {
  throw new Error("Yonma simulation ended without a game_end event");
}

let replayPath: string | undefined;
if (saveReplays) {
  const seats: ReplaySeatInfo[] = characterIds.map((characterId, seat) => ({
    seat,
    kind: "characterAI",
    characterId,
  }));
  const uniqueLabel = `yonma-${seed}-${Date.now()}-${process.pid}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  const replay = {
    ...buildGameReplayRecord(game, uniqueLabel, 0, seats),
    summary: {
      ruleset: "mahjongsoul-yonma",
      seed,
      characterIds: [...characterIds],
      finalScores: [...gameEnd.finalScores],
      standings: game.computeFinalStandings(),
      reason: gameEnd.reason,
    },
  };
  replayPath = writeGameReplay(replay, "replays");
}

console.log(
  JSON.stringify(
    {
      ruleset: "mahjongsoul-yonma",
      seed,
      players: characterIds.map((characterId, seat) => ({ seat, characterId })),
      handsPlayed: game.log.filter((event) => event.type === "hand_start").length,
      finalScores: gameEnd.finalScores,
      reason: gameEnd.reason,
      standings: game.computeFinalStandings(),
      aiDecisionCount: game.aiDecisionLog.length,
      ...(replayPath ? { replayPath } : {}),
    },
    null,
    2
  )
);
