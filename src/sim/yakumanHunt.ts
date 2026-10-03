/* 역만 찾기: 고른 캐릭터 조합으로 AI끼리 한 판씩 두다가, 역만 화료가 나온 판에서 멈춘다.
 * 3명이면 산마, 4명이면 4마 (GUI의 AI 관전과 같은 createAiWatchGame). 판 i의 시드는 `<시드>::game<i>`라서, 찾은 판은
 * 출력된 시드로 그대로 다시 돌릴 수 있다. 엔진/AI는 건드리지 않고 끝난 판의 로그(win 이벤트의 yakumanUnits)만 읽는다.
 * CLI는 yakumanHuntCli.ts. */
import type { GameEvent } from "../core/GameLog.js";
import { getCharacterProfile, resolveCharacterId } from "../ai/characterProfiles.js";
import { createAiWatchGame, type GuiGameMode } from "../gui/gameSetup.js";
import { buildGameReplayRecord, replayFileNamePart, replaySeatsFromGame, writeGameReplay } from "./replayRecorder.js";

export interface YakumanHuntOptions {
  /** 캐릭터 id 3개(산마) 또는 4개(4마), 동가부터 */
  players: readonly string[];
  /** 기준 시드. 판 i는 `<seed>::game<i>` */
  seed: string;
  /** 이 판 수까지 돌려도 없으면 멈춘다 */
  maxGames: number;
  /** 찾은 판의 리플레이를 쓸 폴더 (없으면 쓰지 않는다) */
  replayDir?: string;
  /** 판이 끝날 때마다 (진행 표시용) */
  onGame?: (gamesPlayed: number) => void;
}

export interface YakumanWin {
  /** 몇 번째 국인지 (0부터, hand_start.handIndex) */
  handIndex: number;
  roundWind: number;
  roundHandNumber: number;
  honba: number;
  seat: number;
  characterId: string;
  isTsumo: boolean;
  ronFrom?: number;
  yakumanUnits: number;
  yaku: { name: string; han: number }[];
  points: number;
}

export interface YakumanHuntResult {
  mode: GuiGameMode;
  players: string[];
  seed: string;
  gamesPlayed: number;
  /** 역만이 나온 판 (없으면 null) */
  found: { gameIndex: number; gameSeed: string; wins: YakumanWin[]; replayPath?: string } | null;
}

export function huntYakuman(options: YakumanHuntOptions): YakumanHuntResult {
  const players = options.players.map((id) => resolveCharacterId(id.trim()));
  if (players.length !== 3 && players.length !== 4) throw new Error(`캐릭터는 3명(산마) 또는 4명(4마)이어야 합니다 (받은 수: ${players.length})`);
  const profiles = players.map((id) => getCharacterProfile(id));
  if (!Number.isInteger(options.maxGames) || options.maxGames < 1) throw new Error(`최대 판 수는 1 이상의 정수여야 합니다 (받은 값: ${options.maxGames})`);
  const mode: GuiGameMode = players.length === 3 ? "sanma" : "yonma";

  for (let gameIndex = 0; gameIndex < options.maxGames; gameIndex++) {
    const gameSeed = `${options.seed}::game${gameIndex}`;
    const game = createAiWatchGame(mode, gameSeed, profiles);
    game.playGame();
    options.onGame?.(gameIndex + 1);
    const wins = yakumanWinsOf(game.log, players);
    if (wins.length === 0) continue;
    let replayPath: string | undefined;
    if (options.replayDir !== undefined) {
      const label = replayFileNamePart(`yakuman-${mode}-${options.seed}`);
      replayPath = writeGameReplay(buildGameReplayRecord(game, label, gameIndex, replaySeatsFromGame(game)), options.replayDir);
    }
    return { mode, players, seed: options.seed, gamesPlayed: gameIndex + 1, found: { gameIndex, gameSeed, wins, ...(replayPath ? { replayPath } : {}) } };
  }
  return { mode, players, seed: options.seed, gamesPlayed: options.maxGames, found: null };
}

/** 한 판의 로그에서 역만 화료(yakumanUnits > 0)만 골라, 그 화료가 나온 국 정보와 함께 돌려준다. */
export function yakumanWinsOf(log: readonly GameEvent[], players: readonly string[]): YakumanWin[] {
  const wins: YakumanWin[] = [];
  let hand: Extract<GameEvent, { type: "hand_start" }> | undefined;
  for (const event of log) {
    if (event.type === "hand_start") hand = event;
    if (event.type !== "win" || event.yakumanUnits <= 0 || !hand) continue;
    wins.push({
      handIndex: hand.handIndex,
      roundWind: hand.roundWind,
      roundHandNumber: hand.roundHandNumber,
      honba: hand.honba,
      seat: event.player,
      characterId: players[event.player]!,
      isTsumo: event.isTsumo,
      ...(event.ronFrom !== undefined ? { ronFrom: event.ronFrom } : {}),
      yakumanUnits: event.yakumanUnits,
      yaku: event.yaku.map((y) => ({ name: y.name, han: y.han })),
      points: event.points,
    });
  }
  return wins;
}
