import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import { AccessGate, SESSION_COOKIE } from "../src/gui/accessGate.js";

// 1.2 2단계: 입장한 사용자마다 로비/대국/이벤트 스트림이 따로다.
const INVITE = "rooms";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), "seongah-rooms-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const handle = createGuiLobbyServer({
    frameDelayMs: 0,
    access: new AccessGate({ inviteCode: INVITE, dataDir: dir }),
    customAiDir: join(dir, "custom-ai"),
    replayDir: join(dir, "replays"),
  });
  handle.server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  const baseUrl = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    handle.server.closeAllConnections();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  });
  return baseUrl;
}

/** 입장한 사용자 하나: 쿠키, 이벤트 스트림(여러 개 열 수 있음), POST. */
async function enter(baseUrl: string, nickname: string) {
  const res = await fetch(`${baseUrl}/join`, { method: "POST", body: JSON.stringify({ inviteCode: INVITE, nickname }) });
  const cookie = /(seongah_session=[^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
  expect(cookie.startsWith(SESSION_COOKIE)).toBe(true);
  const openStream = async () => {
    const stream = await fetch(`${baseUrl}/events`, { headers: { Cookie: cookie } });
    const reader = stream.body!.getReader();
    const buffer = { text: "" };
    cleanups.push(() => reader.cancel().catch(() => {}));
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
    /** 다음 메시지. timeoutMs 안에 오지 않으면 null. */
    const next = async (timeoutMs = 5000): Promise<any> => {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const match = /data: (.*)\n\n/.exec(buffer.text);
        if (match) {
          buffer.text = buffer.text.slice(match.index + match[0].length);
          return JSON.parse(match[1]!);
        }
        pending ??= reader.read();
        const left = deadline - Date.now();
        const result = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, left)))]);
        if (result === null) return null;
        pending = null;
        if (result.done) throw new Error("stream ended");
        buffer.text += Buffer.from(result.value).toString("utf-8");
      }
    };
    return { next };
  };
  const post = (path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, { method: "POST", headers: { Cookie: cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { cookie, openStream, post };
}

const SANMA = { mode: "sanma", opponents: ["jegalmina", "jegalnahui"], seed: "rooms-a", saveReplays: false };
const YONMA = { mode: "yonma", opponents: ["inan", "magnum", "yuwen"], seed: "rooms-b", saveReplays: false };

describe("사용자별 로비와 대국 (입장 게이트 서버)", () => {
  it("한 사용자의 로비 이동은 다른 사용자의 로비에 보이지 않는다", async () => {
    const baseUrl = await startServer();
    const a = await enter(baseUrl, "A");
    const b = await enter(baseUrl, "B");
    const aEvents = await a.openStream();
    const bEvents = await b.openStream();
    expect((await aEvents.next()).screen).toBe("hub");
    expect((await bEvents.next()).screen).toBe("hub");

    expect((await a.post("/lobby", { screen: "setup", mode: "yonma" })).status).toBe(204);
    const aSetup = await aEvents.next();
    expect([aSetup.screen, aSetup.mode]).toEqual(["setup", "yonma"]);
    expect(await bEvents.next(300)).toBeNull();
    // B가 새로 접속해도 B 자신의 로비(허브)를 받는다
    const bFresh = await (await b.openStream()).next();
    expect(bFresh.screen).toBe("hub");
  });

  it("각자 대국을 시작하면 서로의 대국 메시지를 받지 않고, 한쪽이 그만둬도 다른 쪽 대국은 그대로다", async () => {
    const baseUrl = await startServer();
    const a = await enter(baseUrl, "A");
    const b = await enter(baseUrl, "B");
    const aEvents = await a.openStream();
    const bEvents = await b.openStream();
    await aEvents.next();
    await bEvents.next();

    expect((await a.post("/start", SANMA)).status).toBe(204);
    const aFirst = await aEvents.next();
    expect(aFirst.type).toBe("decision");
    expect(aFirst.request.view.opponents).toHaveLength(2);
    expect(await bEvents.next(300)).toBeNull();

    // B는 로비에 있으므로 A의 대국에 응답/진행/그만두기를 할 수 없다
    for (const [path, body] of [
      ["/respond", { type: "discard", tileId: aFirst.request.view.concealedTiles[0].id, declareRiichi: false }],
      ["/continue", undefined],
      ["/abandon", undefined],
    ] as const) {
      const res = await b.post(path, body);
      expect(res.status, path).toBe(400);
      expect(await res.text()).toMatch(/진행 중인/);
    }
    expect(await aEvents.next(300)).toBeNull();

    expect((await b.post("/start", YONMA)).status).toBe(204);
    const bFirst = await bEvents.next();
    expect(bFirst.request.view.opponents).toHaveLength(3);
    expect(await aEvents.next(300)).toBeNull();

    // A가 그만두면 A만 설정 화면으로, B의 대국은 새로 접속해도 그대로 이어진다
    expect((await a.post("/abandon")).status).toBe(204);
    const aBack = await aEvents.next();
    expect([aBack.type, aBack.mode]).toEqual(["setup", "sanma"]);
    expect(await bEvents.next(300)).toBeNull();
    const bResume = await (await b.openStream()).next();
    expect(bResume.type).toBe("decision");
    expect(bResume.request).toEqual(bFirst.request);
  });

  it("같은 사용자의 탭 두 개는 같은 로비와 대국을 본다", async () => {
    const baseUrl = await startServer();
    const a = await enter(baseUrl, "A");
    const tab1 = await a.openStream();
    const tab2 = await a.openStream();
    await tab1.next();
    await tab2.next();
    expect((await a.post("/start", SANMA)).status).toBe(204);
    const [m1, m2] = [await tab1.next(), await tab2.next()];
    expect(m1.type).toBe("decision");
    expect(m2).toEqual(m1);
  });
});
