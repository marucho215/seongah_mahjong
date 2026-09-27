// 친선전 방 서버 흐름 (A단계): 공개 모드 서버에 두 사람이 각자 입장해, 방을 만들고 코드로 들어오고, 방장이 좌석을 정하고,
// 방장 + AI일 때만 시작한다. 방 상태는 방에 있는 모든 사람의 로비(SSE)로 간다.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import { AccessGate, SESSION_COOKIE } from "../src/gui/accessGate.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startServer(options: { access?: boolean } = { access: true }) {
  const dir = mkdtempSync(join(tmpdir(), "friend-room-"));
  const handle = createGuiLobbyServer({
    frameDelayMs: 0,
    ...(options.access ? { access: new AccessGate({ dataDir: dir }), userDataDir: join(dir, "users") } : { customAiDir: join(dir, "custom-ai"), replayDir: join(dir, "replays") }),
  });
  handle.server.keepAliveTimeout = 0;
  await new Promise<void>((r) => handle.server.listen(0, r));
  const base = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  cleanups.push(async () => {
    for (const r of readers) await r.cancel().catch(() => {});
    handle.server.closeAllConnections();
    await new Promise<void>((r) => handle.server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  /** 입장해서 이벤트 스트림을 연 사용자 */
  async function enter(nickname: string) {
    let cookie = "";
    if (options.access) {
      const res = await fetch(`${base}/join`, { method: "POST", body: JSON.stringify({ nickname }) });
      cookie = new RegExp(`${SESSION_COOKIE}=[^;]+`).exec(res.headers.get("set-cookie") ?? "")![0];
    }
    const headers = cookie ? { Cookie: cookie } : {};
    const stream = await fetch(`${base}/events`, { headers });
    const reader = stream.body!.getReader();
    readers.push(reader);
    let text = "";
    const next = async (): Promise<any> => {
      for (;;) {
        const m = /data: (.*)\n\n/.exec(text);
        if (m) {
          text = text.slice(m.index + m[0].length);
          return JSON.parse(m[1]!);
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE ended");
        text += Buffer.from(value).toString("utf-8");
      }
    };
    /** 조건에 맞는 로비 상태(setup) 메시지까지 읽는다 */
    const untilSetup = async (pred: (m: any) => boolean = () => true) => {
      for (;;) {
        const m = await next();
        if (m.type === "setup" && pred(m)) return m;
      }
    };
    const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: "POST", headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const first = await next();
    return { first, next, untilSetup, post };
  }
  return { base, handle, enter };
}

describe("친선전 방 서버 (A단계)", () => {
  it("로컬 모드(입장 게이트 없음)에는 친선전이 없다", async () => {
    const s = await startServer({ access: false });
    const me = await s.enter("로컬");
    expect(me.first).not.toHaveProperty("friendRooms");
    expect((await me.post("/friend/create", { mode: "sanma" })).status).toBe(404);
  });

  it("방 만들기 → 코드로 들어가기 → 좌석 설정 → 시작 조건 → 내보내기 → 방장이 닫기", async () => {
    const s = await startServer();
    const a = await s.enter("방장");
    const b = await s.enter("손님");
    expect(a.first.friendRooms).toEqual({ thinkingTimes: ["3+5", "5+10", "5+20", "60+0", "300+0"], defaultThinkingTime: "5+20" });
    expect(a.first.friendRoom).toBeNull();

    expect((await a.post("/friend/create", { mode: "yonma", thinkingTime: "300+0" })).status).toBe(204);
    const created = (await a.untilSetup((m) => m.friendRoom)).friendRoom;
    expect(created).toMatchObject({ mode: "yonma", thinkingTime: "300+0", isHost: true, canStart: false });
    expect(created.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(created.seats).toEqual([
      { seat: 0, kind: "human", name: "방장", isHost: true, isMe: true },
      { seat: 1, kind: "open" },
      { seat: 2, kind: "open" },
      { seat: 3, kind: "open" },
    ]);
    // 방에 있으면 혼자 대국/관전은 시작할 수 없다
    expect((await a.post("/start", { mode: "sanma", opponents: ["jegalmina", "jegalnahui"] })).status).toBe(400);
    expect((await a.post("/watch", { mode: "sanma", seats: ["jegalmina", "jegalnahui", "byeonari"] })).status).toBe(400);

    // 손님이 코드(소문자, 하이픈 섞어도 됨)로 들어오면 두 사람 모두 새 상태를 받는다
    const code: string = created.code;
    expect((await b.post("/friend/join", { code: `${code.slice(0, 3).toLowerCase()}-${code.slice(3)}` })).status).toBe(204);
    const bView = (await b.untilSetup((m) => m.friendRoom)).friendRoom;
    expect(bView).toMatchObject({ code, isHost: false });
    expect(bView.seats[1]).toEqual({ seat: 1, kind: "human", name: "손님", isHost: false, isMe: true });
    const aView = (await a.untilSetup((m) => m.friendRoom?.seats[1].kind === "human")).friendRoom;
    expect(aView.seats[1]).toEqual({ seat: 1, kind: "human", name: "손님", isHost: false, isMe: false });

    // 방장만 좌석을 바꾼다. AI는 이름으로 보인다
    expect((await b.post("/friend/seat", { seat: 2, characterId: "jegalmina" })).status).toBe(403);
    expect((await a.post("/friend/seat", { seat: 2, characterId: "jegalmina" })).status).toBe(204);
    expect((await b.untilSetup((m) => m.friendRoom?.seats[2].kind === "ai")).friendRoom.seats[2]).toEqual({ seat: 2, kind: "ai", name: "제갈 미나", characterId: "jegalmina" });
    expect((await a.post("/friend/seat", { seat: 3, characterId: "no-such-character" })).status).toBe(400);
    expect((await a.post("/friend/seat", { seat: 3, characterId: "byeonari" })).status).toBe(204);

    // 사람이 둘이면 아직 시작할 수 없다 (B단계)
    const twoHumans = (await a.untilSetup((m) => m.friendRoom?.seats[3].kind === "ai")).friendRoom;
    expect(twoHumans.canStart).toBe(false);
    expect(twoHumans.startBlocker).toMatch(/사람 2명 이상/);
    expect((await a.post("/friend/start")).status).toBe(409);
    expect((await b.post("/friend/start")).status).toBe(403);

    // 내보내면 손님은 방에서 나오고 안내를 받는다
    expect((await a.post("/friend/seat", { seat: 1, characterId: null })).status).toBe(204);
    const kicked = await b.untilSetup((m) => m.friendRoom === null);
    expect(kicked.notice).toMatch(/방에서 나왔습니다/);
    expect((await a.untilSetup((m) => m.friendRoom?.seats[1].kind === "open")).friendRoom.startBlocker).toMatch(/빈자리/);

    // 손님이 다시 들어왔다가, 방장이 방을 닫으면 손님도 나온다
    expect((await b.post("/friend/join", { code })).status).toBe(204);
    await a.untilSetup((m) => m.friendRoom?.seats[1].kind === "human");
    expect((await a.post("/friend/leave")).status).toBe(204);
    expect((await a.untilSetup((m) => m.friendRoom === null)).friendRoom).toBeNull();
    expect((await b.untilSetup((m) => m.friendRoom === null)).notice).toBe("방장이 방을 닫았습니다.");
    expect((await b.post("/friend/join", { code })).status).toBe(404);
  });

  it("방장 + AI로 채우면 시작하고, 대국은 방에서 시작한 것으로 표시된다 (끝나면 방으로 돌아온다)", async () => {
    const s = await startServer();
    const a = await s.enter("방장");
    expect((await a.post("/friend/create", { mode: "sanma" })).status).toBe(204);
    await a.untilSetup((m) => m.friendRoom);
    expect((await a.post("/friend/seat", { seat: 1, characterId: "jegalmina" })).status).toBe(204);
    expect((await a.post("/friend/seat", { seat: 2, characterId: "jegalnahui" })).status).toBe(204);
    expect((await a.untilSetup((m) => m.friendRoom?.canStart)).friendRoom.thinkingTime).toBe("5+20");
    expect((await a.post("/friend/start")).status).toBe(204);
    let msg = await a.next();
    while (msg.type === "setup") msg = await a.next();
    expect(msg.type).toBe("decision");
    expect(msg.characterNames).toEqual([null, "제갈 미나", "제갈 나희"]);
    // 대국을 그만두면 방이 있는 로비(방 화면)로 돌아온다
    expect((await a.post("/abandon")).status).toBe(204);
    const back = await a.untilSetup();
    expect(back.friendRoom).toMatchObject({ isHost: true, canStart: true });
  }, 60_000);
});
