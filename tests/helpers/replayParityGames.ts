/* 리플레이 바이트 동일성 테스트용 고정 대국. 엔진에 표시 전용 관찰 기능을 넣기 전 코드로 만든 리플레이 JSON의
 * SHA-256을 tests/replayParity.test.ts에 고정해 두고, 이후에도 같은 바이트가 나오는지 확인한다. */
import { createHash } from "node:crypto";
import { GameState } from "../../src/core/GameState.js";
import { getCharacterProfile } from "../../src/ai/characterProfiles.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../../src/rules/RuleConfig.js";
import { GuiSession } from "../../src/gui/guiSession.js";
import { createGuiGame } from "../../src/gui/gameSetup.js";
import { buildGameReplayRecord, replaySeatsFromGame, type GameReplayRecord } from "../../src/sim/replayRecorder.js";
import { defaultResponse } from "./yonmaHuman.js";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** writeGameReplay와 같은 직렬화 (JSON.stringify(record, null, 2)). */
export function replayBytes(record: GameReplayRecord): string {
  return JSON.stringify(record, null, 2);
}

export function aiOnlyGame(mode: "sanma" | "yonma", seed: string): GameState {
  const ids = mode === "yonma" ? ["jegalmina", "hwayoung", "ryumint", "josangmin"] : ["jegalmina", "hwayoung", "ryumint"];
  const game = new GameState({ rules: mode === "yonma" ? MAJSOUL_YONMA_RULES : DEFAULT_SANMA_RULES, seed, characterProfiles: ids.map(getCharacterProfile) });
  game.playGame();
  return game;
}

export function aiOnlyRecord(mode: "sanma" | "yonma", seed: string): GameReplayRecord {
  const game = aiOnlyGame(mode, seed);
  const seats = game.characterProfiles.map((p, seat) => ({ seat, kind: "characterAI" as const, characterId: p!.characterId }));
  return buildGameReplayRecord(game, `parity-${mode}`, 0, seats);
}

/** 사람 1명(seat 0) + AI 대국을 결정적 기본 응답으로 끝까지 진행한다. */
export function humanGame(mode: "sanma" | "yonma", seed: string): GameState {
  const game = createGuiGame(mode, seed);
  const session = new GuiSession(game);
  for (let steps = 0; session.getPhase() !== "game_end"; steps++) {
    if (steps > 200000) throw new Error("game did not finish");
    if (session.getPhase() === "hand_end") session.continueToNextHand();
    else session.respond(defaultResponse(session.getCurrentRequest()!, "last"));
  }
  return game;
}

export function humanRecord(mode: "sanma" | "yonma", seed: string): GameReplayRecord {
  const game = humanGame(mode, seed);
  return buildGameReplayRecord(game, `parity-human-${mode}`, 0, replaySeatsFromGame(game));
}
