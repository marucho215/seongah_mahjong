// 친선전 관전: 코드로 진행 중인 대국을 지켜본다. 관전자는 자리에 앉지 않고, 손패와 결정 요청은 받지 못하며, 대국에 영향을 주지 못한다.
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


describe("친선전 방 관전", () => {
  it("시작 전에는 관전할 수 없고, 시작하면 손패/요청 없이 장면을 받으며, 나가도 대국은 계속된다", async () => {
    const s = await startServer();
    const host = await s.enter("방장");
    const watcher = await s.enter("관전자");

    expect((await host.post("/friend/create", { mode: "sanma" })).status).toBe(204);
    const code: string = (await host.untilSetup((m) => m.friendRoom)).friendRoom.code;
    expect((await host.post("/friend/seat", { seat: 1, characterId: "jegalmina" })).status).toBe(204);
    expect((await host.post("/friend/seat", { seat: 2, characterId: "jegalnahui" })).status).toBe(204);

    // 아직 대국이 없다 / 틀린 코드
    expect((await watcher.post("/friend/spectate", { code })).status).toBe(409);
    expect((await watcher.post("/friend/spectate", { code: "ZZZZZZ" })).status).toBe(404);

    expect((await host.post("/friend/start")).status).toBe(204);
    // 첫 타패 요청까지: 북빼기 같은 다른 요청이 먼저 오면 "하지 않음"으로 넘긴다 (시드가 무작위라 첫 요청이 타패가 아닐 수 있다)
    let hostDecision: any;
    for (;;) {
      const m = await host.next();
      if (m.type !== "decision") continue;
      if (m.request.type === "discard") {
        hostDecision = m;
        break;
      }
      expect((await host.post("/respond", { type: m.request.type, declare: false })).status).toBe(204);
    }
    expect((hostDecision.request.view.concealedTiles as unknown[]).length).toBeGreaterThanOrEqual(13);

    // 관전 시작: 첫 메시지는 관전용 (요청 없음, 내 손패 없음)
    expect((await watcher.post("/friend/spectate", { code })).status).toBe(204);
    const seen: any[] = [];
    let first: any;
    for (;;) {
      first = await watcher.next();
      if (first.type !== "setup") break;
    }
    seen.push(first);
    expect(first).toMatchObject({ spectator: true, type: "spectate", waitingFor: [hostDecision.request.seat] });
    expect(first.view.concealedTiles).toEqual([]);
    expect(first.view.hiddenCount).toBeGreaterThanOrEqual(13);
    expect(first.view.waits).toEqual([]);
    expect(first.view.discardRisk).toEqual([]);
    expect(first.canAbandon).toBe(true);
    expect(JSON.stringify(first)).not.toContain('"request"');

    // 관전자는 응답할 수 없고, 다른 방/대국도 먼저 나와야 한다
    expect((await watcher.post("/respond", { type: "discard", tileId: 0, declareRiichi: false })).status).toBeGreaterThanOrEqual(400);
    expect((await watcher.post("/friend/create", { mode: "sanma" })).status).toBeGreaterThanOrEqual(400);

    // 방장이 한 장 버리면 관전자도 그 뒤의 장면/상태를 받는다 (손패 없이)
    const hand = hostDecision.request.view.concealedTiles as { id: number; kind: string }[];
    const tile = hand.find((t) => hostDecision.request.legalTileIds.includes(t.id))!;
    expect((await host.post("/respond", { type: "discard", tileId: tile.id, declareRiichi: false })).status).toBe(204);
    for (let i = 0; i < 3; i++) seen.push(await watcher.next());
    for (const m of seen) {
      expect(m.spectator).toBe(true);
      expect(["spectate", "watch", "hand_end"]).toContain(m.type);
      expect(m.view?.concealedTiles ?? []).toEqual([]);
      expect(JSON.stringify(m)).not.toContain('"concealedTiles":[{');
      expect(JSON.stringify(m)).not.toContain('"request"');
    }
    // 방장이 버린 패는 공개 정보라 관전자의 작탁에 보인다
    const withRiver = seen.filter((m) => m.view).map((m) => m.view.discards ?? []).flat();
    expect(withRiver).toContain(tile.kind);

    // 관전 나가기: 로비로 돌아가고, 대국은 그대로다
    expect((await watcher.post("/abandon")).status).toBe(204);
    const lobby = await watcher.untilSetup();
    expect(lobby.screen).toBeDefined();
    // 방장은 계속 두고 있다: 관전자가 나간 뒤에도 다음 요청이 온다
    for (;;) {
      const m = await host.next();
      if (m.type === "decision") break;
    }
  }, 60_000);
});
