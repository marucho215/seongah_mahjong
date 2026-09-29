// 친선전 C·D단계: 시간 제한(한 수 + 국마다 여유), 시간 초과/연결 끊김이면 중립 AI 대행(substitute.ts)과 자리 비움, 다시 접속하면 복귀,
// 참가자 모두의 폴더에 닉네임이 담긴 리플레이 저장(대행한 결정도 사람 결정으로 기록되어 그대로 재현), 방장의 "같은 멤버로 다시".
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import { AccessGate, SESSION_COOKIE } from "../src/gui/accessGate.js";
import { substituteResponse } from "../src/gui/substitute.js";
import { GuiSession } from "../src/gui/guiSession.js";
import { createGuiGame } from "../src/gui/gameSetup.js";
import type { ClaimDecisionRequest, DiscardDecisionRequest, SeatDecisionRequest } from "../src/core/decisions.js";

describe("중립 AI 대행 (substituteResponse)", () => {
  function firstDiscard(): DiscardDecisionRequest {
    const session = new GuiSession(createGuiGame("sanma", "substitute-discard"));
    for (let i = 0; i < 50; i++) {
      const request = session.getCurrentRequest()!;
      if (request.type === "discard") return request;
      session.respond({ type: request.type, declare: false } as never);
    }
    throw new Error("no discard request");
  }

  it("버리기: 합법한 패 중에서 SimpleAI 규칙으로 고르고 리치는 선언하지 않는다 (못 버리는 종류는 피한다)", () => {
    const request = firstDiscard();
    const response = substituteResponse(request);
    expect(response.type).toBe("discard");
    if (response.type !== "discard") return;
    expect(request.legalTileIds).toContain(response.tileId);
    expect(response.declareRiichi).toBe(false);
    // 고른 종류를 쿠이카에처럼 못 버리게 하면 다른 합법 패를 고른다
    const chosenKind = request.view.concealedTiles.find((t) => t.id === response.tileId)!.kind;
    const restricted = { ...request, legalTileIds: request.view.concealedTiles.filter((t) => t.kind !== chosenKind).map((t) => t.id) };
    const second = substituteResponse(restricted);
    expect(second.type === "discard" && restricted.legalTileIds.includes(second.tileId)).toBe(true);
  });

  it("선택/론/쯔모/울기/북: 론·쯔모는 선언, 울기는 넘김, 북 빼기는 함, 구종구패는 선언하지 않음", () => {
    const view = firstDiscard().view;
    const claim = (ron: boolean): ClaimDecisionRequest => ({
      type: "claim", seat: 0, fromSeat: 1, tile: { id: 1, kind: "p5" }, context: "discard", daiminkan: false, pon: true, chiOptions: [], view,
      ...(ron ? { ron: { yaku: [], han: 1, fu: 30, yakumanUnits: 0, totalPoints: 1000 } } : {}),
    });
    expect(substituteResponse(claim(true))).toEqual({ type: "claim", choice: "ron" });
    expect(substituteResponse(claim(false))).toEqual({ type: "claim", choice: "pass" });
    const simple = (type: string) => substituteResponse({ type, seat: 0, view } as unknown as SeatDecisionRequest);
    expect(simple("tsumo")).toEqual({ type: "tsumo", declare: true });
    expect(simple("call_pon")).toEqual({ type: "call_pon", declare: false });
    expect(simple("ankan")).toEqual({ type: "ankan", declare: false });
    expect(simple("kita")).toEqual({ type: "kita", declare: true });
    expect(simple("nine_terminals")).toEqual({ type: "nine_terminals", declare: false });
    expect(simple("chi")).toEqual({ type: "chi", optionId: null });
  });
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startServer(options: { friendTimeScale: number; presenceGraceMs?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "friend-cd-"));
  const handle = createGuiLobbyServer({ frameDelayMs: 0, access: new AccessGate({ dataDir: dir }), userDataDir: join(dir, "users"), ...options });
  handle.server.keepAliveTimeout = 0;
  await new Promise<void>((r) => handle.server.listen(0, r));
  const base = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  cleanups.push(async () => {
    for (const r of readers) await r.cancel().catch(() => {});
    handle.server.closeAllConnections();
    await new Promise<void>((r) => handle.server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  async function enter(nickname: string) {
    const res = await fetch(`${base}/join`, { method: "POST", body: JSON.stringify({ nickname }) });
    const cookie = new RegExp(`${SESSION_COOKIE}=[^;]+`).exec(res.headers.get("set-cookie") ?? "")![0];
    const user = {
      nickname,
      cookie,
      replayDir: "",
      reader: null as ReadableStreamDefaultReader<Uint8Array> | null,
      text: "",
      async connect() {
        const stream = await fetch(`${base}/events`, { headers: { Cookie: cookie } });
        user.reader = stream.body!.getReader();
        user.text = "";
        readers.add(user.reader);
        return user.next();
      },
      async disconnect() {
        await user.reader!.cancel();
        readers.delete(user.reader!);
      },
      async next(): Promise<any> {
        for (;;) {
          const m = /data: (.*)\n\n/.exec(user.text);
          if (m) {
            user.text = user.text.slice(m.index + m[0].length);
            return JSON.parse(m[1]!);
          }
          const { value, done } = await user.reader!.read();
          if (done) throw new Error("SSE ended");
          user.text += Buffer.from(value).toString("utf-8");
        }
      },
      post: (path: string, body?: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { Cookie: cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
      get: (path: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } }),
    };
    await user.connect();
    return user;
  }
  const userDir = (userId: string) => join(dir, "users", userId, "replays");
  return { enter, dir, userDir };
}

async function untilType(user: { next: () => Promise<any> }, pred: (m: any) => boolean, seen?: (m: any) => void) {
  for (let guard = 0; guard < 100_000; guard++) {
    const m = await user.next();
    seen?.(m);
    if (pred(m)) return m;
  }
  throw new Error("message not found");
}

describe("친선전 시간 제한과 자리 비움 (C) · 리플레이와 다시 하기 (D)", () => {
  it("혼자 + AI 친선전: 방장이 한 번도 답하지 않아도 시간 초과 → 자리 비움 → 대행으로 끝까지 가고, 리플레이가 닉네임과 함께 남아 재현된다", async () => {
    const s = await startServer({ friendTimeScale: 0.002 });
    const a = await s.enter("방장");
    expect((await a.post("/friend/create", { mode: "sanma", thinkingTime: "3+5" })).status).toBe(204);
    await untilType(a, (m) => m.type === "setup" && m.friendRoom);
    await a.post("/friend/seat", { seat: 1, characterId: "jegalmina" });
    await a.post("/friend/seat", { seat: 2, characterId: "jegalnahui" });
    await untilType(a, (m) => m.type === "setup" && m.friendRoom?.canStart);
    expect((await a.post("/friend/start")).status).toBe(204);

    let sawTimer = false;
    let sawAway = false;
    const end = await untilType(
      a,
      (m) => m.type === "game_end",
      (m) => {
        if (m.type === "decision" && m.timer) sawTimer = true;
        if (m.awaySeats?.includes(0)) sawAway = true;
      }
    );
    expect(sawTimer).toBe(true); // 내 결정에는 남은 시간이 실린다
    expect(sawAway).toBe(true); // 연속 시간 초과로 자리 비움이 된다
    expect(end.canRestartFriend).toBe(true);
    expect(end.replayFile).toMatch(/^friend-sanma-.*_game0\.json$/);

    const viewer = await (await a.get(`/api/replays/${encodeURIComponent(end.replayFile)}`)).json();
    expect(viewer.reproduction.ok).toBe(true); // 대행한 결정도 사람 결정으로 기록되어 그대로 재현된다
    expect(viewer.seatNames).toEqual(["방장", "제갈 미나", "제갈 나희"]);
  }, 300_000);

  it("사람 둘: 손님이 연결을 끊으면 자리 비움으로 대행되어 대국이 이어지고, 두 사람 폴더에 리플레이가 남는다. 다시 접속하면 복귀하고, 방장은 같은 멤버로 다시 시작한다", async () => {
    const s = await startServer({ friendTimeScale: 0.1, presenceGraceMs: 50 });
    const a = await s.enter("방장");
    const b = await s.enter("손님");
    expect((await a.post("/friend/create", { mode: "sanma" })).status).toBe(204);
    const code = (await untilType(a, (m) => m.type === "setup" && m.friendRoom)).friendRoom.code;
    expect((await b.post("/friend/join", { code })).status).toBe(204);
    await a.post("/friend/seat", { seat: 2, characterId: "jegalmina" });
    await untilType(a, (m) => m.type === "setup" && m.friendRoom?.canStart);
    expect((await a.post("/friend/start")).status).toBe(204);
    await untilType(b, (m) => m.type === "decision" || m.type === "waiting");

    // 손님이 떠난다 (브라우저를 닫음): 유예 시간 뒤 자리 비움
    await b.disconnect();
    let sawGuestAway = false;
    const end = await untilType(
      a,
      (m) => m.type === "game_end",
      (m) => {
        if (m.awaySeats?.includes(1)) sawGuestAway = true;
        if (m.type === "hand_end") void a.post("/continue");
        if (m.type === "decision") {
          const r = m.request;
          const answer =
            r.type === "discard" ? { type: "discard", tileId: r.legalTileIds.at(-1), declareRiichi: false }
            : r.type === "claim" ? { type: "claim", choice: r.ron ? "ron" : "pass" }
            : r.type === "chi" ? { type: "chi", optionId: null }
            : { type: r.type, declare: r.type === "ron" || r.type === "tsumo" };
          void a.post("/respond", answer);
        }
      }
    );
    expect(sawGuestAway).toBe(true);
    expect(end.characterNames).toEqual(["방장", "손님", "제갈 미나"]);

    // 참가자 모두의 리플레이 폴더에 같은 파일 (닉네임 포함)
    const userDirs = readdirSync(join(s.dir, "users"));
    expect(userDirs).toHaveLength(2);
    for (const userId of userDirs) {
      const files = readdirSync(s.userDir(userId));
      expect(files).toEqual([end.replayFile]);
      const record = JSON.parse(readFileSync(join(s.userDir(userId), end.replayFile), "utf-8"));
      expect(record.meta.multiplayer).toBe(true);
      expect(record.meta.seats.map((x: any) => x.nickname ?? null)).toEqual(["방장", "손님", null]);
    }

    // 손님이 다시 접속하면 자리 복귀 (자리 비움 목록에서 빠진다)
    const back = await b.connect();
    expect(back.type).toBe("game_end");
    expect(back.awaySeats ?? []).not.toContain(1);
    expect(back.canRestartFriend).toBe(false); // 손님은 다시 시작할 수 없다

    // 방장이 종료 화면에서 같은 멤버로 다시 → 두 사람 모두 새 대국
    expect((await a.post("/friend/start")).status).toBe(204);
    const aNew = await untilType(a, (m) => m.type === "decision" || m.type === "waiting");
    const bNew = await untilType(b, (m) => m.type === "decision" || m.type === "waiting");
    expect(aNew.characterNames).toEqual(["방장", "손님", "제갈 미나"]);
    expect(bNew.view?.seat ?? bNew.request?.view.seat).toBe(1);
  }, 300_000);
});
