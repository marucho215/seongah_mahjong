// 내 자리 선택: 로비 대국의 사람은 동가(seat 0) 고정이 아니다. 상대는 사람 다음 차례부터 같은 순서로 앉고,
// 대국/리플레이/재현은 사람 좌석이 어디든 같은 방식으로 동작한다. 자리를 고르지 않으면 지금까지와 완전히 같다(동가).
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { gameFromSpec } from "../src/gui/engineRunner.js";
import { GuiSession } from "../src/gui/guiSession.js";
import { parseGuiGameConfig, resolveHumanSeat, seatFromSeed, seatsAroundHuman } from "../src/gui/gameSetup.js";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import { buildGameReplayRecord, replaySeatsFromGame } from "../src/sim/replayRecorder.js";
import { reproduceReplay } from "../src/replay/replayReproduction.js";
import { defaultResponse } from "./helpers/yonmaHuman.js";
import type { GameReplayRecord } from "../src/sim/replayRecorder.js";

const OPPONENTS = ["jegalmina", "jegalnahui", "byeonari"];

describe("자리 해석", () => {
  it("상대는 사람 다음 차례부터 순서대로 앉는다", () => {
    expect(seatsAroundHuman(["a", "b", "c"], 0)).toEqual([null, "a", "b", "c"]);
    expect(seatsAroundHuman(["a", "b", "c"], 2)).toEqual(["b", "c", null, "a"]);
    expect(seatsAroundHuman(["a", "b"], 1)).toEqual(["b", null, "a"]);
  });

  it("랜덤은 시드로 정해지고 (같은 시드는 같은 자리) 모든 자리가 나올 수 있다", () => {
    expect(seatFromSeed("seed-1", 4)).toBe(seatFromSeed("seed-1", 4));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(seatFromSeed(`s${i}`, 4));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    expect(resolveHumanSeat(undefined, "x", "yonma")).toBe(0);
    expect(resolveHumanSeat(3, "x", "yonma")).toBe(3);
    expect(resolveHumanSeat("random", "x", "sanma")).toBeLessThan(3);
  });

  it("구성 검증: 자리는 모드 인원 안의 정수 또는 random이고, 생략하면 필드가 없다", () => {
    const base = { mode: "yonma", opponents: OPPONENTS };
    expect(parseGuiGameConfig(base)).not.toHaveProperty("humanSeat");
    expect(parseGuiGameConfig({ ...base, humanSeat: 3 }).humanSeat).toBe(3);
    expect(parseGuiGameConfig({ ...base, humanSeat: "random" }).humanSeat).toBe("random");
    expect(() => parseGuiGameConfig({ ...base, humanSeat: 4 })).toThrow();
    expect(() => parseGuiGameConfig({ ...base, humanSeat: -1 })).toThrow();
    expect(() => parseGuiGameConfig({ ...base, humanSeat: 1.5 })).toThrow();
    expect(() => parseGuiGameConfig({ mode: "sanma", opponents: OPPONENTS.slice(0, 2), humanSeat: 3 })).toThrow();
  });
});

describe("사람이 동가가 아닌 자리에 앉은 대국", () => {
  it("좌석 배치: 사람은 지정 자리, 상대는 사람 다음 차례부터 (하가가 다음 차례)", () => {
    const game = gameFromSpec({ mode: "yonma", seed: "seat-layout", humanSeat: 2, opponents: OPPONENTS.map((characterId) => ({ characterId })) });
    expect(game.controllers.map((c) => c === "human")).toEqual([false, false, true, false]);
    expect(game.characterProfiles.map((p) => p?.characterId ?? null)).toEqual(["jegalnahui", "byeonari", null, "jegalmina"]);
    expect(game.multiplayer).toBe(false); // 사람 1명이라 사람끼리 대국 모드가 아니다
  });

  it("동가를 고르면(또는 생략하면) 기존 로비 대국과 같은 대국이다", () => {
    const opponents = OPPONENTS.map((characterId) => ({ characterId }));
    const a = gameFromSpec({ mode: "yonma", seed: "same", opponents });
    const b = gameFromSpec({ mode: "yonma", seed: "same", opponents, humanSeat: 0 });
    expect(b.controllers).toEqual(a.controllers);
    expect(b.characterProfiles.map((p) => p?.characterId)).toEqual(a.characterProfiles.map((p) => p?.characterId));
  });

  /** 사람 좌석을 기본 응답으로 끝까지 진행한다. 요청은 모두 그 좌석의 것이어야 한다. */
  function playOut(mode: "sanma" | "yonma", humanSeat: number, seed: string) {
    const opponents = (mode === "yonma" ? OPPONENTS : OPPONENTS.slice(0, 2)).map((characterId) => ({ characterId }));
    const game = gameFromSpec({ mode, seed, humanSeat, opponents });
    const session = new GuiSession(game);
    let responses = 0;
    for (let steps = 0; session.getPhase() !== "game_end"; steps++) {
      if (steps > 200000) throw new Error("game did not finish");
      if (session.getPhase() === "hand_end") {
        session.continueToNextHand();
        continue;
      }
      const request = session.getCurrentRequest()!;
      if ("view" in request) expect(request.view.seat).toBe(humanSeat);
      session.respond(defaultResponse(request, "pass"));
      responses++;
    }
    return { game, responses };
  }

  function checkReplay(game: ReturnType<typeof playOut>["game"], humanSeat: number): void {
    // 리플레이: 사람 결정이 그 자리로 기록되고, 뷰어(재현)가 같은 대국을 다시 만든다
    const record = buildGameReplayRecord(game, "seat-test", 0, replaySeatsFromGame(game));
    expect(record.meta.seats[humanSeat]).toMatchObject({ seat: humanSeat, kind: "human" });
    expect(record.humanDecisions!.length).toBeGreaterThan(0);
    expect(record.humanDecisions!.every((d) => d.seat === humanSeat)).toBe(true);
    const reproduced = reproduceReplay(JSON.parse(JSON.stringify(record)) as GameReplayRecord);
    if (!reproduced.ok) throw new Error(reproduced.reason);
    expect(reproduced.steps.length).toBe(record.events.length);
  }

  it("산마 자리 2: 끝까지 진행되고 같은 시드는 같은 대국이며, 첫 친은 동가(내가 아님), 리플레이가 재현된다", () => {
    const first = playOut("sanma", 2, "seat-sanma-2");
    const second = playOut("sanma", 2, "seat-sanma-2");
    expect(first.responses).toBeGreaterThan(0);
    expect(JSON.stringify(first.game.log)).toBe(JSON.stringify(second.game.log));
    expect((first.game.log.find((e) => e.type === "hand_start") as { dealer: number }).dealer).toBe(0);
    checkReplay(first.game, 2);
  }, 120_000);

  it("4마 자리 3(북가): 끝까지 진행되고 리플레이가 재현된다", () => {
    const run = playOut("yonma", 3, "seat-yonma-3");
    expect(run.responses).toBeGreaterThan(0);
    checkReplay(run.game, 3);
  }, 180_000);
});

describe("로비 서버: POST /start의 humanSeat", () => {
  it("고른 자리에 사람이 앉고, 설정 기억과 종료 화면의 같은 설정 다시 하기에 자리가 이어진다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "human-seat-"));
    const handle = createGuiLobbyServer({ frameDelayMs: 0, replayDir: join(dir, "replays"), customAiDir: join(dir, "custom-ai") });
    try {
      await new Promise<void>((resolve) => handle.server.listen(0, resolve));
      handle.server.keepAliveTimeout = 0;
      const base = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
      const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

      expect((await post("/start", { mode: "yonma", opponents: OPPONENTS, saveReplays: false, humanSeat: 7 })).status).toBeGreaterThanOrEqual(400);
      const res = await post("/start", { mode: "yonma", opponents: OPPONENTS, saveReplays: false, humanSeat: 2, seed: "lobby-seat" });
      expect(res.ok).toBe(true);
      const session = handle.getSession()!;
      expect(session.getPhase()).toBe("decision");
      const request = session.getCurrentRequest()!;
      expect("view" in request && request.view.seat).toBe(2);
    } finally {
      handle.server.closeAllConnections();
      await new Promise<void>((resolve) => handle.server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
