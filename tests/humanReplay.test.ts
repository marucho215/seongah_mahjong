import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { GuiSession } from "../src/gui/guiSession.js";
import { createGuiGame } from "../src/gui/gameSetup.js";
import { createGuiServer } from "../src/gui/createGuiServer.js";
import { buildGameReplayRecord, replaySeatsFromGame, writeGameReplay, type GameReplayRecord } from "../src/sim/replayRecorder.js";
import { collectAllInvariantViolations } from "../src/validation/invariants.js";
import { collectReplayInvariantViolations } from "./helpers/replayQa.js";
import { defaultResponse } from "./helpers/yonmaHuman.js";
import type { DecisionRequest } from "../src/core/decisions.js";

/** 사람 좌석을 기본 정책(마지막 패 버리기, 콜 거절, 론은 받음, 치 패스)으로 끝까지 진행한다. */
function playToGameEnd(game: GameState): { session: GuiSession; responses: number; requests: DecisionRequest[] } {
  const session = new GuiSession(game);
  const requests: DecisionRequest[] = [];
  let steps = 0;
  while (session.getPhase() !== "game_end") {
    if (++steps > 200000) throw new Error("game did not finish");
    if (session.getPhase() === "hand_end") {
      session.continueToNextHand();
      continue;
    }
    const request = session.getCurrentRequest()!;
    requests.push(request);
    session.respond(defaultResponse(request, "pass"));
  }
  return { session, responses: requests.length, requests };
}

function checkReplay(record: GameReplayRecord, playerCount: number, humanSeat: number, responses: number, requests: DecisionRequest[]): void {
  // 메타: 좌석별 조종자 (사람 좌석은 human, 나머지는 characterAI), 캐릭터 정체성은 별도로 유지
  expect(record.meta.replaySchemaVersion).toBe(2);
  expect(record.meta.seats).toHaveLength(playerCount);
  expect(record.meta.seats[humanSeat]).toMatchObject({ seat: humanSeat, kind: "human" });
  expect(record.meta.seats[humanSeat]!.characterId).toBeUndefined();
  for (const seat of record.meta.seats.filter((s) => s.seat !== humanSeat)) {
    expect(seat.kind).toBe("characterAI");
    expect(typeof seat.characterId).toBe("string");
  }

  // 사람 결정: 응답 수와 같고, 요청 종류/순서가 일치하며, events와 연결된다
  const decisions = record.humanDecisions!;
  expect(decisions).toHaveLength(responses);
  decisions.forEach((d, i) => {
    expect(d.type).toBe(requests[i]!.type);
    expect(d.seat).toBe(humanSeat);
    expect(d.atEventIndex).toBeGreaterThanOrEqual(i === 0 ? 0 : decisions[i - 1]!.atEventIndex);
    expect(d.atEventIndex).toBeLessThanOrEqual(record.events.length);
  });
  const discards = decisions.filter((d) => d.type === "discard");
  expect(discards.length).toBeGreaterThan(0);
  for (const d of discards) {
    expect(typeof d.choice.tile).toBe("string");
    expect(d.choice.riichi).toBe(false);
  }
  expect(decisions.map((d) => d.handIndex)).toEqual([...decisions.map((d) => d.handIndex)].sort((a, b) => a - b));

  // game_end 포함, 다른 좌석의 숨은 패는 결정 기록에 없다
  expect(record.events.at(-1)!.type).toBe("game_end");
  expect(JSON.stringify(decisions)).not.toMatch(/concealed|opponents/);

  // 기존 리플레이 검증기 통과
  expect(collectReplayInvariantViolations({ rules: record.meta.rules, events: record.events })).toEqual([]);
  expect(collectAllInvariantViolations({ rules: record.meta.rules, events: record.events, schemaVersion: record.meta.replaySchemaVersion })).toEqual([]);
}

describe("human+AI 대국 리플레이", () => {
  for (const [mode, players, seed] of [["sanma", 3, "human-replay-sanma"], ["yonma", 4, "human-replay-yonma"]] as const) {
    it(`${mode}: 끝까지 진행한 대국을 기존 형식으로 저장하고 검증기를 통과한다`, () => {
      const game = createGuiGame(mode, seed);
      const { responses, requests } = playToGameEnd(game);
      const record = buildGameReplayRecord(game, `human-${mode}-${seed}`, 0, replaySeatsFromGame(game));
      checkReplay(record, players, 0, responses, requests);

      // 파일 저장 (임시 디렉터리) 후 다시 읽어도 같은 내용
      const dir = mkdtempSync(join(tmpdir(), "human-replay-"));
      const path = writeGameReplay(record, dir);
      expect(path).toBe(join(dir, `human-${mode}-${seed}_game0.json`));
      const loaded = JSON.parse(readFileSync(path, "utf-8")) as GameReplayRecord;
      expect(loaded.humanDecisions).toHaveLength(responses);
      expect(loaded.meta.seats[0]!.kind).toBe("human");
      expect(loaded.events.at(-1)!.type).toBe("game_end");
    }, 120_000);
  }

  it("사람이 없는 게임의 리플레이에는 humanDecisions가 없고, 좌석 정보 형식도 그대로다", () => {
    const ai = new GameState({
      rules: DEFAULT_SANMA_RULES,
      seed: "ai-only-compat",
    });
    ai.playGame();
    const record = buildGameReplayRecord(ai, "ai-only", 0, [0, 1, 2].map((seat) => ({ seat, kind: "simpleAI" as const })));
    expect("humanDecisions" in record).toBe(false);
    expect(record.meta.replaySchemaVersion).toBe(2);
    expect(ai.humanDecisionLog).toEqual([]);
  }, 60_000);
});

describe("GUI 서버 리플레이 저장", () => {
  it("게임 종료 때 한 번 저장하고, 도중의 새로고침/재접속에도 기록이 이어진다", async () => {
    const game = createGuiGame("sanma", "gui-replay-save");
    const dir = mkdtempSync(join(tmpdir(), "gui-replay-"));
    let saved: string | undefined;
    const { server, session } = createGuiServer(game, { frameDelayMs: 0, replay: { label: "human-sanma-gui-replay-save", dir, onSaved: (p) => (saved = p) } });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    try {
      let responses = 0;
      let reconnected = false;
      for (let steps = 0; session.getPhase() !== "game_end"; steps++) {
        if (steps > 200000) throw new Error("game did not finish");
        if (session.getPhase() === "hand_end") {
          const res = await fetch(`${baseUrl}/continue`, { method: "POST" });
          expect(res.status).toBe(204);
          continue;
        }
        if (!reconnected && responses === 5) {
          // 새로고침: 같은 세션에 다시 접속해도 진행 중인 기록은 그대로다
          const stream = await fetch(`${baseUrl}/events`);
          await stream.body!.cancel();
          reconnected = true;
          expect(game.humanDecisionLog).toHaveLength(5);
        }
        const res = await fetch(`${baseUrl}/respond`, { method: "POST", body: JSON.stringify(defaultResponse(session.getCurrentRequest()!, "pass")) });
        expect(res.status).toBe(204);
        responses++;
      }
      expect(reconnected).toBe(true);
      expect(saved).toBe(join(dir, "human-sanma-gui-replay-save_game0.json"));
      expect(readdirSync(dir)).toEqual(["human-sanma-gui-replay-save_game0.json"]);
      const record = JSON.parse(readFileSync(saved!, "utf-8")) as GameReplayRecord;
      expect(record.humanDecisions).toHaveLength(responses);
      expect(record.events.at(-1)!.type).toBe("game_end");
      expect(record.meta.seats[0]!.kind).toBe("human");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);
});
