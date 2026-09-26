import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { MAX_REQUEST_BODY_BYTES, ONLINE_LIMITS, createGuiLobbyServer, type GuiLobbyOptions, type ResourceLimits } from "../src/gui/createGuiServer.js";
import { AccessGate } from "../src/gui/accessGate.js";
import { defaultResponse } from "./helpers/yonmaHuman.js";
import { initialCustomAiStyle } from "../src/customai/customAiSchema.js";

// 1.2 4·5단계: 온라인 서버의 사용자별 저장(CustomAI, 리플레이)과 자원 제한.
const INVITE = "online";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** 테스트에서 걸리지 않을 만큼 넉넉한 제한 (각 테스트가 보려는 항목만 줄인다) */
const LOOSE: ResourceLimits = { ...ONLINE_LIMITS, requestsPerSecond: 10_000, requestBurst: 10_000, maxOpenGames: 100, idleGameMs: 3_600_000, idleRoomMs: 3_600_000 };

async function startOnline(limits: Partial<ResourceLimits> = {}, extra: GuiLobbyOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "seongah-online-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const handle = createGuiLobbyServer({
    frameDelayMs: 0,
    access: new AccessGate({ inviteCode: INVITE, dataDir: dir }),
    userDataDir: join(dir, "users"),
    limits: { ...LOOSE, ...limits },
    ...extra,
  });
  handle.server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  cleanups.push(async () => {
    handle.server.closeAllConnections();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  });
  const baseUrl = `http://localhost:${(handle.server.address() as AddressInfo).port}`;

  async function enter(nickname: string) {
    const res = await fetch(`${baseUrl}/join`, { method: "POST", body: JSON.stringify({ inviteCode: INVITE, nickname }) });
    const cookie = /(seongah_session=[^;]+)/.exec(res.headers.get("set-cookie")!)![1]!;
    const sessions = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf-8")).sessions as Record<string, { userId: string; nickname: string }>;
    const userId = Object.values(sessions).find((u) => u.nickname === nickname)!.userId;
    const headers = { Cookie: cookie };
    const request = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    const post = (path: string, body?: unknown, method = "POST") =>
      request(path, { method, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    async function stream() {
      const res = await request("/events");
      if (res.status !== 200) return { status: res.status, next: async () => null as any };
      const reader = res.body!.getReader();
      cleanups.push(() => reader.cancel().catch(() => {}));
      let text = "";
      return {
        status: 200,
        next: async (): Promise<any> => {
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
        },
      };
    }
    /** 로비에서 대국을 시작해 기본 응답으로 끝까지 둔다 (리플레이 저장은 서버 경로로만 일어난다). */
    async function playGame(config: object) {
      const events = await stream();
      await events.next();
      expect((await post("/start", config)).status).toBe(204);
      for (let guard = 0; guard < 2000; guard++) {
        const m = await events.next();
        if (m.type === "game_end") return m;
        if (m.type === "hand_end") expect((await post("/continue")).status).toBe(204);
        else if (m.type === "decision") expect((await post("/respond", defaultResponse(m.request))).status).toBe(204);
      }
      throw new Error("game did not end");
    }
    return { userId, request, post, stream, playGame, userDir: join(dir, "users", userId) };
  }
  return { baseUrl, handle, dir, enter };
}

const SANMA = { mode: "sanma", opponents: ["jegalmina", "jegalnahui"], saveReplays: false };
const customInput = (name: string) => ({ name, style: initialCustomAiStyle() });

describe("사용자별 저장 (CustomAI, 리플레이)", () => {
  it("CustomAI는 만든 사용자에게만 보이고, 다른 사용자는 그 CustomAI로 대국을 시작할 수 없다", async () => {
    const s = await startOnline();
    const a = await s.enter("A");
    const b = await s.enter("B");
    const created = await (await a.post("/api/custom-ai", customInput("A의 AI"))).json();
    expect(created.name).toBe("A의 AI");
    expect(readdirSync(join(a.userDir, "custom-ai"))).toEqual([`${created.id}.json`]);

    const aList = await (await a.request("/api/custom-ai")).json();
    const bList = await (await b.request("/api/custom-ai")).json();
    expect(aList.entries.map((e: { name: string }) => e.name)).toEqual(["A의 AI"]);
    expect(bList.entries).toEqual([]);
    const bSetup = await (await b.stream()).next();
    expect(bSetup.roster.some((r: { custom?: boolean }) => r.custom)).toBe(false);

    const customId = aList.entries[0].characterId;
    const res = await b.post("/start", { ...SANMA, opponents: [customId, "jegalmina"] });
    expect(res.status).toBe(400);
    expect((await a.post("/start", { ...SANMA, opponents: [customId, "jegalmina"] })).status).toBe(204);
  });

  it("CustomAI는 한 사람당 개수 제한이 있다 (새로 만들기와 복제 모두)", async () => {
    const s = await startOnline({ maxCustomAisPerUser: 2 });
    const a = await s.enter("A");
    const first = await (await a.post("/api/custom-ai", customInput("하나"))).json();
    expect((await a.post("/api/custom-ai", customInput("둘"))).status).toBe(200);
    const third = await a.post("/api/custom-ai", customInput("셋"));
    expect(third.status).toBe(400);
    expect(await third.text()).toMatch(/2개까지/);
    expect((await a.post(`/api/custom-ai/${first.id}/duplicate`)).status).toBe(400);
    // 다른 사용자는 따로 센다
    const b = await s.enter("B");
    expect((await b.post("/api/custom-ai", customInput("B"))).status).toBe(200);
  });

  it("리플레이는 사용자 폴더에 저장되고, 다른 사용자는 목록에서도 보지 못하고 열 수도 없다. 원본 파일을 내려받을 수 있다", async () => {
    const s = await startOnline();
    const a = await s.enter("A");
    const b = await s.enter("B");
    await a.playGame({ ...SANMA, seed: "online-replay", saveReplays: true });
    const files = readdirSync(join(a.userDir, "replays"));
    expect(files).toHaveLength(1);
    expect(existsSync(join(s.dir, "replays"))).toBe(false);

    const aList = await (await a.request("/api/replays")).json();
    expect(aList.map((f: { name: string }) => f.name)).toEqual(files);
    expect(await (await b.request("/api/replays")).json()).toEqual([]);
    expect((await b.request(`/api/replays/${files[0]}`)).status).toBe(404);
    expect((await b.request(`/api/replays/${files[0]}?download=1`)).status).toBe(404);

    const download = await a.request(`/api/replays/${files[0]}?download=1`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toBe(`attachment; filename="${files[0]}"`);
    expect(await download.text()).toBe(readFileSync(join(a.userDir, "replays", files[0]!), "utf-8"));
    expect((await a.request(`/api/replays/..%2Fsessions.json?download=1`)).status).toBe(400);
  }, 120_000);

  it("사용자별 리플레이는 최근 것만 남긴다", async () => {
    const s = await startOnline({ maxReplaysPerUser: 1 });
    const a = await s.enter("A");
    await a.playGame({ ...SANMA, seed: "keep-old", saveReplays: true });
    await new Promise((r) => setTimeout(r, 20));
    expect((await a.post("/setup")).status).toBe(204);
    await a.playGame({ ...SANMA, seed: "keep-new", saveReplays: true });
    await new Promise((r) => setTimeout(r, 200)); // 정리는 저장 직후 비동기로 한다
    expect(readdirSync(join(a.userDir, "replays"))).toEqual(["human-sanma-keep-new_game0.json"]);
  }, 120_000);
});

describe("자원 제한 (온라인 서버)", () => {
  it("서버 전체 동시 대국 수를 넘으면 새 대국을 시작할 수 없고, 자리가 나면 시작할 수 있다", async () => {
    const s = await startOnline({ maxOpenGames: 1 });
    const a = await s.enter("A");
    const b = await s.enter("B");
    expect((await a.post("/start", SANMA)).status).toBe(204);
    const refused = await b.post("/start", SANMA);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toMatch(/최대 1판/);
    // 자기 대국을 다시 시작하는 것은 제한에 걸리지 않는다 (진행 중이면 원래 규칙대로 거절)
    expect((await a.post("/abandon")).status).toBe(204);
    expect((await b.post("/start", SANMA)).status).toBe(204);
  });

  it("오래 요청이 없는 사용자의 대국은 정리되고, 로비에 안내가 나온다", async () => {
    const s = await startOnline({ idleGameMs: 300 });
    const a = await s.enter("A");
    const events = await a.stream();
    await events.next();
    expect((await a.post("/start", SANMA)).status).toBe(204);
    expect((await events.next()).type).toBe("decision");
    expect(s.handle.getSession(a.userId)).not.toBeNull();
    const cleared = await events.next(); // 정리 주기(최소 1초) 안에 온다
    expect(cleared.type).toBe("setup");
    expect(cleared.notice).toMatch(/오래 응답이 없어/);
    expect(s.handle.getSession(a.userId)).toBeNull();
    // 안내는 로비를 움직이면 사라진다
    expect((await a.post("/lobby", { screen: "hub" })).status).toBe(204);
    expect((await events.next()).notice).toBeUndefined();
  }, 20_000);

  it("사용자별 요청 빈도를 넘으면 429로 거절한다 (다른 사용자는 영향 없음)", async () => {
    const s = await startOnline({ requestsPerSecond: 1, requestBurst: 3 });
    const a = await s.enter("A");
    const b = await s.enter("B");
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await a.post("/speed", { speed: "fast" })).status);
    expect(statuses).toEqual([204, 204, 204, 429]);
    expect((await b.post("/speed", { speed: "fast" })).status).toBe(204);
    // 화면 파일(정적 파일)은 세지 않는다
    expect((await a.request("/style.css")).status).toBe(200);
  });

  it("한 사용자가 동시에 여는 이벤트 연결 수를 제한한다", async () => {
    const s = await startOnline({ maxStreamsPerUser: 2 });
    const a = await s.enter("A");
    expect((await a.stream()).status).toBe(200);
    expect((await a.stream()).status).toBe(200);
    expect((await a.stream()).status).toBe(429);
  });
});

describe("요청 본문 크기 제한 (모든 서버)", () => {
  it("너무 큰 요청은 413으로 거절한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seongah-body-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const handle = createGuiLobbyServer({ frameDelayMs: 0, customAiDir: join(dir, "custom-ai"), replayDir: join(dir, "replays") });
    handle.server.keepAliveTimeout = 0;
    await new Promise<void>((resolve) => handle.server.listen(0, resolve));
    cleanups.push(async () => {
      handle.server.closeAllConnections();
      await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    });
    const baseUrl = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
    const big = JSON.stringify({ mode: "sanma", opponents: ["jegalmina", "jegalnahui"], seed: "x".repeat(MAX_REQUEST_BODY_BYTES) });
    const res = await fetch(`${baseUrl}/start`, { method: "POST", body: big }).catch((err) => err);
    // 서버가 413을 보내고 연결을 닫는다 (본문을 다 보내기 전에 끊기면 fetch가 실패할 수도 있다)
    if (res instanceof Response) expect(res.status).toBe(413);
    expect(handle.getSession()).toBeNull();
    // 로컬 모드에서는 다른 제한이 없다
    for (let i = 0; i < 50; i++) expect((await fetch(`${baseUrl}/speed`, { method: "POST", body: JSON.stringify({ speed: "fast" }) })).status).toBe(204);
  });
});
