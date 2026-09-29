// 친선전 B단계: 사람 2명 이상이 한 작탁에서 둔다. 서버는 좌석마다 자기 요청(없으면 waiting)과 자기 시점의 장면만 보내고,
// 남이 내놓은 패에 여러 사람이 반응할 수 있으면 동시에 묻는다(claim). 대국은 방장만 끝낼 수 있다.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import { AccessGate, SESSION_COOKIE } from "../src/gui/accessGate.js";
import { EngineWorkerPool } from "../src/gui/engineWorkerPool.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** `worker`: 실제 서버처럼 엔진 worker 풀에서 대국을 돌린다 (좌석 지정 응답이 worker까지 가는지) */
async function startServer({ worker = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-mp-"));
  const engine = worker ? new EngineWorkerPool(1) : undefined;
  const handle = createGuiLobbyServer({ frameDelayMs: 0, access: new AccessGate({ dataDir: dir }), userDataDir: join(dir, "users"), ...(engine ? { engine } : {}) });
  handle.server.keepAliveTimeout = 0;
  await new Promise<void>((r) => handle.server.listen(0, r));
  const base = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  cleanups.push(async () => {
    for (const r of readers) await r.cancel().catch(() => {});
    handle.server.closeAllConnections();
    await new Promise<void>((r) => handle.server.close(() => r()));
    await engine?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function enter(nickname: string) {
    const res = await fetch(`${base}/join`, { method: "POST", body: JSON.stringify({ nickname }) });
    const cookie = new RegExp(`${SESSION_COOKIE}=[^;]+`).exec(res.headers.get("set-cookie") ?? "")![0];
    const stream = await fetch(`${base}/events`, { headers: { Cookie: cookie } });
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
    const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { Cookie: cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    await next();
    return { nickname, next, post };
  }
  return { enter };
}

type User = Awaited<ReturnType<Awaited<ReturnType<typeof startServer>>["enter"]>>;

/** 방장 a가 방을 만들고 b가 들어온다. 좌석: 동가 a, 남가 b, 서가 AI (산마) */
async function roomWithTwoHumans(s: Awaited<ReturnType<typeof startServer>>) {
  const a = await s.enter("방장");
  const b = await s.enter("손님");
  expect((await a.post("/friend/create", { mode: "sanma" })).status).toBe(204);
  let code = "";
  for (;;) {
    const m = await a.next();
    if (m.type === "setup" && m.friendRoom) {
      code = m.friendRoom.code;
      break;
    }
  }
  expect((await b.post("/friend/join", { code })).status).toBe(204);
  expect((await a.post("/friend/seat", { seat: 2, characterId: "jegalmina" })).status).toBe(204);
  return { a, b };
}

/** 사람 좌석의 결정적 응답 (론/쯔모는 선언, 울기는 가끔 받아들임, 버림은 legal 중 마지막) */
function answer(request: any, n: number): any {
  switch (request.type) {
    case "discard":
      return { type: "discard", tileId: request.legalTileIds.at(-1), declareRiichi: false };
    case "claim":
      if (request.ron) return { type: "claim", choice: "ron" };
      if (request.pon && n % 2 === 0) return { type: "claim", choice: "pon" };
      return { type: "claim", choice: "pass" };
    case "ron":
    case "tsumo":
      return { type: request.type, declare: true };
    case "chi":
      return { type: "chi", optionId: null };
    default:
      return { type: request.type, declare: false };
  }
}

/** 한 사람의 화면처럼 메시지를 읽으며 자기 요청에만 답한다. 받은 메시지가 모두 자기 좌석 것인지 확인한다. */
async function playAs(user: User, seat: number, stats: { claims: number; waiting: number }) {
  let n = 0;
  for (let guard = 0; ; guard++) {
    if (guard > 20_000) throw new Error(`${user.nickname}: game did not finish`);
    const m = await user.next();
    if (m.view) expect(m.view.seat).toBe(seat); // 자기 시점만 (남의 손패가 담긴 view는 오지 않는다)
    if (m.type === "game_end") return m;
    if (m.type === "waiting") stats.waiting++;
    if (m.type === "hand_end") await user.post("/continue");
    if (m.type === "decision") {
      expect(m.request.seat).toBe(seat);
      expect(m.request.view.seat).toBe(seat);
      if (m.request.type === "claim") stats.claims++;
      const res = await user.post("/respond", answer(m.request, n++));
      expect(res.status, await res.clone().text()).toBe(204);
    }
  }
}

describe("친선전 사람끼리 대국 (B단계)", () => {
  for (const worker of [false, true]) {
  it(`두 사람이 각자 자기 요청에만 답하며 한 판을 끝까지 둔다 (남의 시점은 오지 않고, 선택 요청이 나온다)${worker ? " - worker 풀" : ""}`, async () => {
    const s = await startServer({ worker });
    const { a, b } = await roomWithTwoHumans(s);
    expect((await a.post("/friend/start")).status).toBe(204);
    const stats = { claims: 0, waiting: 0 };
    const [endA, endB] = await Promise.all([playAs(a, 0, stats), playAs(b, 1, stats)]);
    expect(endA.standings).toEqual(endB.standings);
    expect(endA.gameConfig.friendRoom).toBe(true);
    // 사람 좌석에는 닉네임이 보인다
    expect(endA.characterNames).toEqual(["방장", "손님", "제갈 미나"]);
    expect(stats.claims).toBeGreaterThan(0);
    expect(stats.waiting).toBeGreaterThan(0);
    // 둘 다 끝나면 "방으로 돌아가기" → 두 사람 모두 방 화면
    expect((await a.post("/setup")).status).toBe(204);
    expect((await b.post("/setup")).status).toBe(204);
  }, 180_000);
  }

  it("대국은 방장만 끝낼 수 있고, 끝내면 두 사람 모두 방으로 돌아간다", async () => {
    const s = await startServer();
    const { a, b } = await roomWithTwoHumans(s);
    expect((await a.post("/friend/start")).status).toBe(204);
    let bFirst: any;
    for (;;) {
      bFirst = await b.next();
      if (bFirst.type !== "setup") break;
    }
    expect(bFirst.canAbandon).toBe(false);
    expect((await b.post("/abandon")).status).toBe(400);
    expect((await a.post("/abandon")).status).toBe(204);
    for (;;) {
      const m = await b.next();
      if (m.type === "setup") {
        expect(m.notice).toBe("방장이 대국을 끝냈습니다.");
        expect(m.friendRoom).toMatchObject({ isHost: false });
        break;
      }
    }
  }, 60_000);
});
