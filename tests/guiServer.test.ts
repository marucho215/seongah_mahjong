import { describe, expect, it, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import { collectAllInvariantViolations } from "../src/validation/invariants.js";
import { createGuiServer } from "../src/gui/createGuiServer.js";

function newHumanGame(seed: string): GameState {
  return new GameState({
    rules: DEFAULT_SANMA_RULES,
    seed,
    characterProfiles: [null, getCharacterProfile("jegalmina"), getCharacterProfile("jegalnahui")],
    controllers: ["human", undefined, undefined],
  });
}

/** Reads exactly one SSE "data: ..." message from an open fetch stream's reader and parses
 *  it as JSON - good enough for this test's single-client, one-message-at-a-time usage. */
async function readOneSseMessage(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { text: string }): Promise<unknown> {
  while (true) {
    const lineMatch = /data: (.*)\n\n/.exec(buffer.text);
    if (lineMatch) {
      buffer.text = buffer.text.slice(lineMatch.index + lineMatch[0].length);
      return JSON.parse(lineMatch[1]!);
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE stream ended before a full message arrived");
    buffer.text += Buffer.from(value).toString("utf-8");
  }
}

async function startServer(game: GameState, frameDelayMs = 0): Promise<{ baseUrl: string; close: () => Promise<void>; getSession: () => ReturnType<typeof createGuiServer>["session"] }> {
  const { server, session } = createGuiServer(game, { frameDelayMs });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://localhost:${port}`,
    getSession: () => session,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections(); // defense-in-depth: a leaked SSE connection would otherwise hang close() forever
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("GUI HTTP/SSE server (createGuiServer)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  it("AI 턴은 장면(watch)으로 한 수씩 먼저 보내고, 재생이 끝난 뒤에 다음 상태를 보낸다", async () => {
    const { baseUrl, close, getSession } = await startServer(newHumanGame("gui-watch-frames"), 15);
    cleanup = close;
    const stream = await fetch(`${baseUrl}/events`);
    const reader = stream.body!.getReader();
    const buffer = { text: "" };
    await readOneSseMessage(reader, buffer); // 접속 시 현재 상태

    // 북빼기 같은 선택은 거절하고, 첫 타패를 낼 때까지 응답한다. 타패 뒤에는 AI 턴 장면이 온다.
    const kinds: string[] = [];
    let sawDiscardAnswer = false;
    for (let guard = 0; guard < 6 && !sawDiscardAnswer; guard++) {
      const request = getSession().getCurrentRequest()!;
      sawDiscardAnswer = request.type === "discard";
      const answer =
        request.type === "discard"
          ? { type: "discard", tileId: request.legalTileIds[0], declareRiichi: false }
          : { type: request.type, declare: false };
      const res = await fetch(`${baseUrl}/respond`, { method: "POST", body: JSON.stringify(answer) });
      expect(res.status).toBe(204);
      let last: { type: string } | undefined;
      do {
        last = (await readOneSseMessage(reader, buffer)) as typeof last;
        kinds.push(last!.type);
      } while (last!.type === "watch");
    }
    await reader.cancel();

    // 내 타패 + 상대 타패마다 장면이 있고, 마지막에만 결정/국 종료 상태가 온다
    expect(kinds.filter((k) => k === "watch").length).toBeGreaterThanOrEqual(2);
    expect(kinds[kinds.length - 1]).not.toBe("watch");
  });

  it("serves the static client shell and tile assets", async () => {
    const { baseUrl, close } = await startServer(newHumanGame("gui-http-static"));
    cleanup = close;

    const index = await fetch(`${baseUrl}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");

    const tile = await fetch(`${baseUrl}/assets/mahjong/regular/Man1.svg`);
    expect(tile.status).toBe(200);
    expect(tile.headers.get("content-type")).toContain("image/svg+xml");
    const svgText = await tile.text();
    expect(svgText).toContain("<svg");
  });

  it("marks the frequently edited frontend files no-store, but not the tile assets", async () => {
    const { baseUrl, close } = await startServer(newHumanGame("gui-http-cache"));
    cleanup = close;
    for (const path of ["/", "/index.html", "/app.js", "/audioManager.js", "/style.css"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      await res.arrayBuffer();
    }
    const tile = await fetch(`${baseUrl}/assets/mahjong/regular/Man1.svg`);
    expect(tile.headers.get("cache-control")).toBeNull();
    await tile.arrayBuffer();
  });

  it("rejects path traversal outside the public directory", async () => {
    const { baseUrl, close } = await startServer(newHumanGame("gui-http-traversal"));
    cleanup = close;
    const res = await fetch(`${baseUrl}/../../package.json`);
    expect([403, 404]).toContain(res.status);
  });

  it("plays a full hand end-to-end over real HTTP + SSE, with zero invariant violations and no opponent concealed leak", async () => {
    const game = newHumanGame("gui-http-full-hand");
    const { baseUrl, close, getSession } = await startServer(game);
    cleanup = close;

    const sseRes = await fetch(`${baseUrl}/events`);
    const reader = sseRes.body!.getReader();
    const buffer = { text: "" };

    let steps = 0;
    while (true) {
      const msg = await readOneSseMessage(reader, buffer) as { type: string; request?: any; event?: unknown };
      if (msg.type === "hand_end" || msg.type === "game_end") break;
      expect(msg.type).toBe("decision");
      const request = msg.request;
      // The wire payload is exactly PlayerView/DecisionRequest - confirm no opponent
      // concealed tile field ever crosses the HTTP boundary.
      for (const opponent of request.view.opponents) {
        expect(opponent).not.toHaveProperty("concealedTiles");
      }
      const response = request.type === "discard"
        ? { type: "discard", tileId: request.legalTileIds[0], declareRiichi: false }
        : { type: request.type, declare: false };
      const postRes = await fetch(`${baseUrl}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response),
      });
      expect(postRes.status).toBe(204);
      steps++;
      if (steps > 2000) throw new Error("runaway loop guard triggered");
    }

    await reader.cancel(); // otherwise the still-open SSE connection keeps server.close() (in afterEach) pending forever
    expect(getSession().getPhase()).not.toBe("decision");
    expect(game.log.some((e) => e.type === "hand_end")).toBe(true);
    const violations = collectAllInvariantViolations({ rules: DEFAULT_SANMA_RULES, events: game.log });
    expect(violations).toEqual([]);
  }, 120000);

  it("continues to a second hand over HTTP via POST /continue, on the same GameState", async () => {
    const game = newHumanGame("gui-http-continue");
    const { baseUrl, close, getSession } = await startServer(game);
    cleanup = close;

    const sseRes = await fetch(`${baseUrl}/events`);
    const reader = sseRes.body!.getReader();
    const buffer = { text: "" };

    async function driveOneHandOverHttp(): Promise<string> {
      let steps = 0;
      for (;;) {
        const msg = (await readOneSseMessage(reader, buffer)) as { type: string; request?: any };
        if (msg.type === "hand_end" || msg.type === "game_end") return msg.type;
        const request = msg.request;
        const response = request.type === "discard"
          ? { type: "discard", tileId: request.legalTileIds[0], declareRiichi: false }
          : { type: request.type, declare: false };
        const postRes = await fetch(`${baseUrl}/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(response),
        });
        expect(postRes.status).toBe(204);
        steps++;
        if (steps > 2000) throw new Error("runaway loop guard triggered");
      }
    }

    const firstOutcome = await driveOneHandOverHttp();
    expect(firstOutcome).toBe("hand_end"); // this seed doesn't end the game on hand 1
    const handIndexAfterFirst = game.handIndex;

    const continueRes = await fetch(`${baseUrl}/continue`, { method: "POST" });
    expect(continueRes.status).toBe(204);
    expect(getSession().getPhase()).toBe("decision");

    await driveOneHandOverHttp();

    // Same GameState the whole time - handIndex advanced, no fresh game was ever constructed.
    expect(game.handIndex).toBe(handIndexAfterFirst + 1);
    expect(game.log.filter((e) => e.type === "hand_start").length).toBeGreaterThanOrEqual(2);

    await reader.cancel();
    const violations = collectAllInvariantViolations({ rules: DEFAULT_SANMA_RULES, events: game.log });
    expect(violations).toEqual([]);
  }, 120000);

  it("rejects a premature POST /continue (a decision is still pending) with a 400", async () => {
    const { baseUrl, close } = await startServer(newHumanGame("gui-http-continue-too-early"));
    cleanup = close;

    const res = await fetch(`${baseUrl}/continue`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("효과음 신호: 접속 메시지에는 과거 신호가 없고, 이후 메시지에는 순서대로 새 신호만 온다", async () => {
    const game = newHumanGame("gui-http-cues");
    const { baseUrl, close } = await startServer(game);
    cleanup = close;

    const sse = await fetch(`${baseUrl}/events`);
    const reader = sse.body!.getReader();
    const buffer = { text: "" };
    const first = (await readOneSseMessage(reader, buffer)) as { type: string; request: any; cues: any[]; cueBase: number };
    expect(first.cues).toEqual([]);
    expect(typeof first.cueBase).toBe("number");

    // 첫 결정에 응답 (kita 제안이 먼저 올 수 있으므로 discard가 나올 때까지 거절)
    let msg = first;
    for (let i = 0; i < 20 && msg.request.type !== "discard"; i++) {
      await fetch(`${baseUrl}/respond`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: msg.request.type, declare: false }) });
      msg = (await readOneSseMessage(reader, buffer)) as typeof first;
    }
    await fetch(`${baseUrl}/respond`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "discard", tileId: msg.request.legalTileIds[0], declareRiichi: false }) });
    const next = (await readOneSseMessage(reader, buffer)) as { cues: { seq: number; type: string; seat?: number }[] };

    expect(next.cues.length).toBeGreaterThan(0);
    expect(next.cues[0]).toMatchObject({ type: "discard", seat: 0 }); // 내가 방금 버린 패가 맨 처음
    const seqs = next.cues.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBeGreaterThan(first.cueBase);
    // 공개 정보만: 패 종류/id 같은 필드가 신호에 없다
    for (const cue of next.cues) expect(Object.keys(cue).every((k) => ["seq", "type", "seat", "first", "riichiSticksCollected"].includes(k))).toBe(true);
    await reader.cancel();

    // 재접속: 그 사이의 모든 신호는 과거이므로 다시 보내지 않고, 기준점만 최신으로 알려준다.
    const again = await fetch(`${baseUrl}/events`);
    const reader2 = again.body!.getReader();
    const reconnect = (await readOneSseMessage(reader2, { text: "" })) as { cues: unknown[]; cueBase: number };
    expect(reconnect.cues).toEqual([]);
    expect(reconnect.cueBase).toBeGreaterThanOrEqual(seqs[seqs.length - 1]!);
    await reader2.cancel();
  }, 60000);

  it("rejects an illegal discard response over HTTP with a 400, instead of silently corrupting the hand", async () => {
    const { baseUrl, close } = await startServer(newHumanGame("gui-http-illegal"));
    cleanup = close;

    const sseRes = await fetch(`${baseUrl}/events`);
    const reader = sseRes.body!.getReader();
    const buffer = { text: "" };

    // The first decision point isn't guaranteed to be a discard (could be a kita offer for
    // a dealer holding North) - pass through anything else with a harmless "decline" answer
    // until a real discard request appears, exactly like the CLI's own illegal-input tests do.
    let request: any;
    for (let i = 0; i < 20; i++) {
      const msg = await readOneSseMessage(reader, buffer) as { type: string; request?: any };
      if (msg.type === "hand_end") throw new Error("hand ended before a discard request ever appeared");
      request = msg.request;
      if (request.type === "discard") break;
      await fetch(`${baseUrl}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: request.type, declare: false }),
      });
    }
    expect(request.type).toBe("discard");

    const res = await fetch(`${baseUrl}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "discard", tileId: -999999, declareRiichi: false }),
    });
    expect(res.status).toBe(400);

    // 거절된 뒤에도 세션은 멀쩡해야 한다: 올바른 응답이 정상 처리되고, 다음 메시지는 이벤트 없는 hand_end가 아니다.
    const legal = await fetch(`${baseUrl}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "discard", tileId: request.legalTileIds[0], declareRiichi: false }),
    });
    expect(legal.status).toBe(204);
    const next = (await readOneSseMessage(reader, buffer)) as { type: string; event?: unknown };
    if (next.type === "hand_end") expect(next.event).toBeDefined();
    await reader.cancel();
  }, 30000);

  /** 첫 타패를 낼 때까지 응답하고(다른 선택은 거절), 그 사이 받은 메시지 종류와 마지막 상태를 돌려준다. */
  async function playToFirstDiscard(baseUrl: string, getSession: () => ReturnType<typeof createGuiServer>["session"]) {
    const stream = await fetch(`${baseUrl}/events`);
    const reader = stream.body!.getReader();
    const buffer = { text: "" };
    await readOneSseMessage(reader, buffer);
    const kinds: string[] = [];
    let last: any;
    let discarded = false;
    for (let guard = 0; guard < 6 && !discarded; guard++) {
      const request = getSession().getCurrentRequest()!;
      discarded = request.type === "discard";
      const answer =
        request.type === "discard"
          ? { type: "discard", tileId: request.legalTileIds[0], declareRiichi: false }
          : { type: request.type, declare: false };
      expect((await fetch(`${baseUrl}/respond`, { method: "POST", body: JSON.stringify(answer) })).status).toBe(204);
      do {
        last = await readOneSseMessage(reader, buffer);
        kinds.push(last.type);
      } while (last.type === "watch");
    }
    await reader.cancel();
    return { kinds, last };
  }

  it("AI 진행 속도는 장면 재생 간격만 바꾸고, 게임 진행과 결과는 같다", async () => {
    const seed = "gui-speed-parity";
    const replayed = newHumanGame(seed);
    const a = await startServer(replayed, 15);
    const withFrames = await playToFirstDiscard(a.baseUrl, a.getSession);
    await a.close();

    const instantGame = newHumanGame(seed);
    const b = await startServer(instantGame, 15);
    cleanup = b.close;
    expect((await fetch(`${b.baseUrl}/speed`, { method: "POST", body: JSON.stringify({ speed: "instant" }) })).status).toBe(204);
    const instant = await playToFirstDiscard(b.baseUrl, b.getSession);

    expect(withFrames.kinds).toContain("watch");
    expect(instant.kinds).not.toContain("watch");
    expect(instant.last.request ?? instant.last.event).toEqual(withFrames.last.request ?? withFrames.last.event);
    expect(JSON.stringify(instantGame.log)).toBe(JSON.stringify(replayed.log));
  });

  it("알 수 없는 재생 속도는 400으로 거절한다", async () => {
    const { baseUrl, close } = await startServer(newHumanGame("gui-speed-invalid"));
    cleanup = close;
    for (const body of [{ speed: "turbo" }, { speed: 3 }, {}]) {
      const res = await fetch(`${baseUrl}/speed`, { method: "POST", body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      await res.text();
    }
    for (const speed of ["slow", "normal", "fast", "instant"]) {
      expect((await fetch(`${baseUrl}/speed`, { method: "POST", body: JSON.stringify({ speed }) })).status).toBe(204);
    }
  });
});
