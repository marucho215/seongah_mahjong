// 역만 찾기 (sim:yakuman): 끝난 판의 로그에서 역만 화료만 고르고, 고른 캐릭터 조합으로 역만이 나올 때까지 판을 돌린다.
import { describe, expect, it } from "vitest";
import type { GameEvent } from "../src/core/GameLog.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import { createAiWatchGame } from "../src/gui/gameSetup.js";
import { huntYakuman, yakumanWinsOf } from "../src/sim/yakumanHunt.js";

const handStart = (handIndex: number, roundWind: number, roundHandNumber: number, honba: number) =>
  ({ type: "hand_start", handIndex, roundWind, roundHandNumber, dealer: 0, honba, kyotaku: 0, scores: [35000, 35000, 35000], wallSeed: 1 }) as unknown as GameEvent;
const win = (player: number, yakumanUnits: number, name: string, isTsumo: boolean, ronFrom?: number) =>
  ({ type: "win", player, isTsumo, ...(ronFrom !== undefined ? { ronFrom } : {}), yaku: [{ name, han: yakumanUnits > 0 ? 13 : 1 }], han: 13, fu: 30, yakumanUnits, points: 32000, deltas: {} }) as unknown as GameEvent;

describe("yakumanWinsOf", () => {
  it("역만 화료만 고르고, 그 화료가 나온 국 정보를 붙인다", () => {
    const log = [handStart(0, 1, 1, 0), win(0, 0, "Riichi", true), handStart(1, 1, 2, 1), win(2, 2, "Suuankou Tanki", false, 1)];
    expect(yakumanWinsOf(log, ["a", "b", "c"])).toEqual([
      { handIndex: 1, roundWind: 1, roundHandNumber: 2, honba: 1, seat: 2, characterId: "c", isTsumo: false, ronFrom: 1, yakumanUnits: 2, yaku: [{ name: "Suuankou Tanki", han: 13 }], points: 32000 },
    ]);
  });
});

describe("huntYakuman", () => {
  it("캐릭터 수(3 또는 4), 등록된 캐릭터, 판 수를 확인한다", () => {
    expect(() => huntYakuman({ players: ["jegalmina", "jegalnahui"], seed: "s", maxGames: 1 })).toThrow(/3명\(산마\) 또는 4명/);
    expect(() => huntYakuman({ players: ["jegalmina", "jegalnahui", "no-such"], seed: "s", maxGames: 1 })).toThrow(/Unknown character id/);
    expect(() => huntYakuman({ players: ["jegalmina", "jegalnahui", "byeonari"], seed: "s", maxGames: 0 })).toThrow(/최대 판 수/);
  });

  it("3명이면 산마로, 판 i는 <시드>::game<i>로 둔다 (같은 판을 직접 돌린 결과와 같다)", () => {
    const players = ["jegalmina", "jegalnahui", "byeonari"];
    const games: number[] = [];
    const result = huntYakuman({ players, seed: "hunt-test", maxGames: 1, onGame: (n) => games.push(n) });
    expect(result).toMatchObject({ mode: "sanma", players, seed: "hunt-test", gamesPlayed: 1 });
    expect(games).toEqual([1]);
    const game = createAiWatchGame("sanma", "hunt-test::game0", players.map(getCharacterProfile));
    game.playGame();
    const expected = yakumanWinsOf(game.log, players);
    expect(result.found?.wins ?? []).toEqual(expected);
    if (expected.length === 0) expect(result.found).toBeNull();
  }, 120_000);
});
