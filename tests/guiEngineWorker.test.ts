import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGuiLobbyServer, type GuiLobbyOptions } from "../src/gui/createGuiServer.js";
import { AccessGate } from "../src/gui/accessGate.js";
import { EngineWorkerPool } from "../src/gui/engineWorkerPool.js";
import { createGuiGame } from "../src/gui/gameSetup.js";
import { GuiSession } from "../src/gui/guiSession.js";
import { buildGameReplayRecord, replaySeatsFromGame, writeGameReplay } from "../src/sim/replayRecorder.js";
import { defaultResponse } from "./helpers/yonmaHuman.js";

// 1.2 3단계: 대국과 리플레이 재현을 worker 풀에서 돌려도 화면 메시지는 같은 스레드에서 돌릴 때와 같고,
// 한 사용자의 긴 계산이 다른 사용자의 요청을 막지 않는다.
let pool: EngineWorkerPool;
beforeAll(() => {
  pool = new EngineWorkerPool(2);
});
afterAll(async () => {
  await pool.close();
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seongah-engine-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(options: GuiLobbyOptions) {
  const handle = createGuiLobbyServer({ frameDelayMs: 0, ...options });
  handle.server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  cleanups.push(async () => {
    handle.server.closeAllConnections();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  });
  return { baseUrl: `http://localhost:${(handle.server.address() as AddressInfo).port}`, handle };
}

function sseReader(res: Response) {
  const reader = res.body!.getReader();
  cleanups.push(() => reader.cancel().catch(() => {}));
  let text = "";
  return async (): Promise<any> => {
    while (true) {
      const match = /data: (.*)\n\n/.exec(text);
      if (match) {
        text = text.slice(match.index + match[0].length);
        return JSON.parse(match[1]!);
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      text += Buffer.from(value).toString("utf-8");
    }
  };
}

/** 로비에서 대국을 시작해 기본 응답으로 끝까지 두고, 받은 메시지를 모두 돌려준다. */
async function playThrough(baseUrl: string, config: object): Promise<any[]> {
  const next = sseReader(await fetch(`${baseUrl}/events`));
  const messages: any[] = [await next()];
  const post = async (path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    expect(res.status, `${path} ${res.status === 204 ? "" : await res.text()}`).toBe(204);
  };
  await post("/start", config);
  for (let guard = 0; guard < 2000; guard++) {
    const message = await next();
    messages.push(message);
    if (message.type === "game_end") return messages;
    if (message.type === "hand_end") await post("/continue");
    else if (message.type === "decision") await post("/respond", defaultResponse(message.request));
  }
  throw new Error("game did not end");
}

describe("엔진 worker 풀 (engineWorkerPool)", () => {
  it("worker에서 돌린 대국은 같은 스레드에서 돌린 대국과 화면 메시지가 끝까지 같다 (리플레이 파일 포함)", async () => {
    const inlineDir = tempDir();
    const workerDir = tempDir();
    const config = { mode: "sanma", opponents: ["jegalmina", "seiyamouri"], seed: "engine-worker-parity", saveReplays: true };
    const inline = await listen({ replayDir: inlineDir, customAiDir: join(inlineDir, "custom-ai") });
    const worker = await listen({ replayDir: workerDir, customAiDir: join(workerDir, "custom-ai"), engine: pool });
    const a = await playThrough(inline.baseUrl, config);
    const b = await playThrough(worker.baseUrl, config);
    expect(b.length).toBe(a.length);
    expect(b).toEqual(a);
    expect(a.at(-1).type).toBe("game_end");
    // worker 대국은 서버 스레드에 세션이 없다
    expect(inline.handle.getSession()).not.toBeNull();
    expect(worker.handle.getSession()).toBeNull();
    const inlineReplay = await (await fetch(`${inline.baseUrl}/api/replays`)).json();
    const workerReplay = await (await fetch(`${worker.baseUrl}/api/replays`)).json();
    expect(workerReplay.map((f: { name: string }) => f.name)).toEqual(inlineReplay.map((f: { name: string }) => f.name));

    // 끝난 대국에서 로비로 돌아가면 worker의 대국도 비운다
    expect(pool.load).toBe(1);
    expect((await fetch(`${worker.baseUrl}/setup`, { method: "POST" })).status).toBe(204);
    expect(pool.load).toBe(0);
  }, 120_000);

  it("한 사용자의 리플레이 재현(수 초)이 worker에서 도는 동안 다른 사용자의 요청은 바로 응답한다", async () => {
    const dir = tempDir();
    const game = createGuiGame("yonma", "engine-worker-busy");
    const session = new GuiSession(game);
    while (session.getPhase() !== "game_end") {
      if (session.getPhase() === "hand_end") session.continueToNextHand();
      else session.respond(defaultResponse(session.getCurrentRequest()!));
    }
    const record = buildGameReplayRecord(game, "busy", 0, replaySeatsFromGame(game));

    const { baseUrl } = await listen({
      userDataDir: join(dir, "users"),
      access: new AccessGate({ inviteCode: "x", dataDir: dir }),
      engine: pool,
    });
    const enter = async (nickname: string) => {
      const res = await fetch(`${baseUrl}/join`, { method: "POST", body: JSON.stringify({ inviteCode: "x", nickname }) });
      return { Cookie: /(seongah_session=[^;]+)/.exec(res.headers.get("set-cookie")!)![1]! };
    };
    const a = await enter("A");
    const b = await enter("B");
    // 온라인 서버의 리플레이는 사용자 폴더에 있다: A의 폴더에 넣는다
    const sessions = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf-8")).sessions as Record<string, { userId: string; nickname: string }>;
    const userA = Object.values(sessions).find((u) => u.nickname === "A")!.userId;
    writeGameReplay(record, join(dir, "users", userA, "replays"));

    const started = Date.now();
    const reproduction = fetch(`${baseUrl}/api/replays/busy_game0.json`, { headers: a }).then(async (r) => ({ at: Date.now(), body: await r.json() }));
    await new Promise((r) => setTimeout(r, 200));
    const before = Date.now();
    const lobbyMove = await fetch(`${baseUrl}/lobby`, { method: "POST", headers: b, body: JSON.stringify({ screen: "setup", mode: "yonma" }) });
    const latency = Date.now() - before;
    expect(lobbyMove.status).toBe(204);
    const done = await reproduction;
    expect(done.body.reproduction.ok).toBe(true);
    // 재현이 끝나기 전에, 짧은 시간 안에 응답했다
    expect(done.at - started).toBeGreaterThan(1000);
    expect(latency).toBeLessThan(500);
    expect(before + latency).toBeLessThan(done.at);
  }, 120_000);
});
