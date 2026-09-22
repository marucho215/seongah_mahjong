import { GameState } from "../core/GameState.js";
import { getCharacterProfile, resolveCharacterId } from "../ai/characterProfiles.js";
import { MAJSOUL_YONMA_RULES } from "../rules/RuleConfig.js";
import { buildGameReplayRecord, writeGameReplay, type ReplaySeatInfo } from "./replayRecorder.js";

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const playersValue = optionValue(argv, "--players");

const gamesArg = optionValue(argv, "--games");
const games = gamesArg !== undefined ? Number(gamesArg) : 1;
if (!Number.isInteger(games) || games < 1) {
  throw new Error(`--games must be a positive integer, got "${gamesArg}"`);
}

const explicitSeed = optionValue(argv, "--seed");
// When the user doesn't pass --seed, generate a fresh random base seed for THIS run, so
// repeated invocations produce different games. Previously this defaulted to the literal
// string "yonma-character-cli" unconditionally, which made every seed-less run replay the
// exact same deterministic game. An explicit --seed still reproduces exactly (tests can
// keep using a fixed one) - only the no-seed default is randomized.
const baseSeed = explicitSeed ?? `yonma-cli-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

const saveReplays = argv.includes("--save-replays");

if (!playersValue) {
  throw new Error(
    "Usage: npm run sim:yonma -- --players <id1,id2,id3,id4> [--games <n>] [--seed <seed>] [--save-replays]"
  );
}

const characterIds = playersValue
  .split(",")
  .map((id) => resolveCharacterId(id.trim()))
  .filter(Boolean);
if (characterIds.length !== MAJSOUL_YONMA_RULES.playerCount) {
  throw new Error(`--players must contain exactly ${MAJSOUL_YONMA_RULES.playerCount} comma-separated character ids`);
}

const profiles = characterIds.map((id) => getCharacterProfile(id));
const seats: ReplaySeatInfo[] = characterIds.map((characterId, seat) => ({ seat, kind: "characterAI", characterId }));
const simulationLabel = `yonma-${baseSeed}`.replace(/[^a-zA-Z0-9._-]/g, "_");

interface GameResult {
  gameIndex: number;
  gameSeed: string;
  finalScores: number[];
  reason: string;
  standings: ReturnType<GameState["computeFinalStandings"]>;
  handsPlayed: number;
  aiDecisionCount: number;
  replayPath?: string;
}

const results: GameResult[] = [];

for (let gameIndex = 0; gameIndex < games; gameIndex++) {
  // Each game gets its own deterministic sub-seed derived from the base seed, so game0..
  // game(N-1) within one run are distinct hands/walls/AI decisions from each other, while
  // the whole sequence reproduces exactly given the same base seed (matches the composite
  // seed convention GameState itself already uses internally, e.g. "<seed>::hand<n>").
  const gameSeed = `${baseSeed}::game${gameIndex}`;
  const game = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: gameSeed, characterProfiles: profiles });
  game.playGame();

  const gameEnd = game.log.at(-1);
  if (!gameEnd || gameEnd.type !== "game_end") {
    throw new Error(`Yonma simulation (game ${gameIndex}) ended without a game_end event`);
  }

  let replayPath: string | undefined;
  if (saveReplays) {
    const replay = {
      ...buildGameReplayRecord(game, simulationLabel, gameIndex, seats),
      summary: {
        ruleset: "mahjongsoul-yonma",
        gameSeed,
        characterIds: [...characterIds],
        finalScores: [...gameEnd.finalScores],
        standings: game.computeFinalStandings(),
        reason: gameEnd.reason,
      },
    };
    replayPath = writeGameReplay(replay, "replays");
  }

  results.push({
    gameIndex,
    gameSeed,
    finalScores: gameEnd.finalScores,
    reason: gameEnd.reason,
    standings: game.computeFinalStandings(),
    handsPlayed: game.log.filter((event) => event.type === "hand_start").length,
    aiDecisionCount: game.aiDecisionLog.length,
    ...(replayPath ? { replayPath } : {}),
  });
}

console.log(
  JSON.stringify(
    {
      ruleset: "mahjongsoul-yonma",
      baseSeed,
      players: characterIds.map((characterId, seat) => ({ seat, characterId })),
      gamesRequested: games,
      gamesPlayed: results.length,
      games: results,
    },
    null,
    2
  )
);
