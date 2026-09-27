// AI 관전 모드: 로비에서 모든 좌석에 AI를 앉혀 한 게임을 엔진에서 끝까지 진행하고, 리플레이로 저장해 뷰어로 본다.
// 엔진/RNG/AI 판단은 바꾸지 않는다 - 시뮬레이션(npm run sim)과 같은 GameState 구성으로 같은 대국이 나와야 한다.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { GameState } from "../src/core/GameState.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import { runAiWatchGame } from "../src/gui/engineRunner.js";
import { EngineWorkerPool } from "../src/gui/engineWorkerPool.js";
import { DEFAULT_WATCH_SEATS, parseAiWatchConfig } from "../src/gui/gameSetup.js";
import { initialCustomAiStyle } from "../src/customai/customAiSchema.js";

describe("관전 구성 검증 (parseAiWatchConfig)", () => {
  it("좌석 수는 모드 인원과 같아야 하고, legacy id는 정식 id로, 빈 시드는 없음으로 정규화한다", () => {
    expect(parseAiWatchConfig({ mode: "sanma", seats: ["ryuhart", "inan", "jegalmina"], seed: "  " })).toEqual({
      mode: "sanma",
      seats: ["ryuheart", "inan", "jegalmina"],
    });
    expect(() => parseAiWatchConfig({ mode: "sanma", seats: ["inan", "jegalmina"] })).toThrow("좌석은 3개");
    expect(() => parseAiWatchConfig({ mode: "yonma", seats: ["inan", "jegalmina", "byeonari"] })).toThrow("좌석은 4개");
    expect(() => parseAiWatchConfig({ mode: "sanma", seats: ["inan", "inan", "jegalmina"] })).toThrow("같은 캐릭터");
    expect(() => parseAiWatchConfig({ mode: "sanma", seats: ["inan", "jegalmina", "no-such-character"] })).toThrow();
    expect(() => parseAiWatchConfig({ mode: "sanma", seats: ["inan", "jegalmina", "byeonari"], seed: "x".repeat(101) })).toThrow("100자");
  });
});

describe("AI 관전 대국 (runAiWatchGame)", () => {
  it("시뮬레이션과 같은 GameState 구성으로 같은 대국을 만든다 (이벤트, AI 판단, 최종 순위가 같고 사람 결정 기록은 없다)", () => {
    const seats = [...DEFAULT_WATCH_SEATS.sanma];
    const record = runAiWatchGame({ mode: "sanma", seed: "ai-watch-parity", seats: seats.map((characterId) => ({ characterId })) }, "watch-test");

    const sim = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "ai-watch-parity", characterProfiles: seats.map(getCharacterProfile) });
    sim.playGame();

    expect(JSON.stringify(record.events)).toBe(JSON.stringify(sim.log));
    expect(JSON.stringify(record.aiDecisions)).toBe(JSON.stringify(sim.aiDecisionLog));
    expect(record.finalStandings).toEqual(sim.computeFinalStandings());
    expect(record.meta.seats.map((s) => s.kind)).toEqual(["characterAI", "characterAI", "characterAI"]);
    expect(record.meta.seats.map((s) => s.characterId)).toEqual(seats);
    expect(record).not.toHaveProperty("humanDecisions");
    expect(record.events.at(-1)?.type).toBe("game_end");
  }, 120_000);

  it("worker에서 돌려도 같은 스레드와 같은 기록이 나온다", async () => {
    const spec = { mode: "sanma" as const, seed: "ai-watch-worker", seats: DEFAULT_WATCH_SEATS.sanma.map((characterId) => ({ characterId })) };
    const pool = new EngineWorkerPool(1);
    try {
      const fromWorker = await pool.runAiWatch(spec, "watch-worker");
      expect(JSON.stringify(fromWorker)).toBe(JSON.stringify(runAiWatchGame(spec, "watch-worker")));
      expect(pool.load).toBe(0);
    } finally {
      await pool.close();
    }
  }, 120_000);
});

describe("로비 AI 관전 (/lobby purpose, /watch)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  async function startServer() {
    const replayDir = mkdtempSync(join(tmpdir(), "ai-watch-replays-"));
    const customAiDir = mkdtempSync(join(tmpdir(), "ai-watch-custom-"));
    const { server } = createGuiLobbyServer({ frameDelayMs: 0, replayDir, customAiDir });
    server.keepAliveTimeout = 0; // 대국 한 판에 수 초 걸리므로 guiLobby.test.ts와 같은 이유로 유휴 제한을 끈다
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    cleanup = async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(replayDir, { recursive: true, force: true });
      rmSync(customAiDir, { recursive: true, force: true });
    };
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
    /** 첫 SSE 메시지(로비 상태)만 읽는다 */
    const lobbyState = async () => {
      const res = await fetch(`${base}/events`);
      const reader = res.body!.getReader();
      let text = "";
      while (!/data: (.*)\n\n/.test(text)) text += Buffer.from((await reader.read()).value!).toString("utf-8");
      await reader.cancel();
      return JSON.parse(/data: (.*)\n\n/.exec(text)![1]!);
    };
    return { base, replayDir, post, lobbyState };
  }

  it("허브에서 관전 설정 화면으로 가면 용도와 모드별 기본 관전 좌석을 보내고, 사람 대국 설정은 그대로 둔다", async () => {
    const { post, lobbyState } = await startServer();
    expect((await lobbyState()).purpose).toBe("play");
    expect((await post("/lobby", { screen: "setup", mode: "yonma", purpose: "watch" })).status).toBe(204);
    const msg = await lobbyState();
    expect(msg).toMatchObject({ type: "setup", screen: "setup", mode: "yonma", purpose: "watch" });
    expect(msg.defaults.watchSeats).toEqual({ sanma: [...DEFAULT_WATCH_SEATS.sanma], yonma: [...DEFAULT_WATCH_SEATS.yonma] });
    expect(msg.defaults.opponents.yonma).toHaveLength(3);
    // 용도를 적지 않으면 지금까지처럼 사람 대국 설정
    await post("/lobby", { screen: "setup", mode: "sanma" });
    expect((await lobbyState()).purpose).toBe("play");
    expect((await post("/lobby", { screen: "setup", mode: "sanma", purpose: "spectate" })).status).toBe(400);
  });

  it("/watch는 AI끼리 한 게임을 끝까지 두고 사용자 리플레이 폴더에 저장한다 (CustomAI 좌석 포함, 뷰어에서 재현 가능)", async () => {
    const { base, replayDir, post, lobbyState } = await startServer();
    const custom = (await (await post("/api/custom-ai", { name: "관전용", style: initialCustomAiStyle() })).json()) as { id: string };
    const seats = ["jegalmina", `custom:${custom.id}`, "byeonari"];

    const res = await post("/watch", { mode: "sanma", seats, seed: "관전 시드/1" });
    expect(res.status).toBe(200);
    const { file } = (await res.json()) as { file: string };
    // 시드의 한글/빈칸/경로 문자는 파일 이름에서 빠지고, 목록이 받는 이름이 된다
    expect(file).toMatch(/^watch-sanma-[A-Za-z0-9._-]+_game0\.json$/);
    expect(existsSync(join(replayDir, file))).toBe(true);

    const record = JSON.parse(readFileSync(join(replayDir, file), "utf-8"));
    expect(record.meta.gameSeed).toBe("관전 시드/1");
    expect(record.meta.seats.map((s: { kind: string }) => s.kind)).toEqual(["characterAI", "customAI", "characterAI"]);
    expect(record.meta.seats[1].customProfile.displayName).toBe("관전용");
    expect(record).not.toHaveProperty("humanDecisions");

    const list = (await (await fetch(`${base}/api/replays`)).json()) as { name: string }[];
    expect(list.map((f) => f.name)).toContain(file);
    const viewer = (await (await fetch(`${base}/api/replays/${encodeURIComponent(file)}`)).json()) as any;
    expect(viewer.reproduction.ok).toBe(true);
    expect(viewer.seatKinds).toEqual(["characterAI", "customAI", "characterAI"]);

    // 다음에 로비를 열면 마지막 관전 좌석이 채워져 있다
    expect((await lobbyState()).defaults.watchSeats.sanma).toEqual(seats);
  }, 300_000); // 같은 스레드에서 대국 한 판 + 뷰어 재현을 하므로 전체 스위트 부하에서는 120초를 넘길 수 있다

  it("잘못된 관전 구성은 대국을 돌리지 않고 거절한다", async () => {
    const { post, replayDir } = await startServer();
    expect((await post("/watch", { mode: "sanma", seats: ["inan", "inan", "jegalmina"] })).status).toBe(400);
    expect((await post("/watch", { mode: "yonma", seats: ["inan", "jegalmina", "byeonari"] })).status).toBe(400);
    expect(readdirSync(replayDir)).toEqual([]);
  });
});
