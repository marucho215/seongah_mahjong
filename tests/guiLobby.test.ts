import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { CHARACTER_PROFILES } from "../src/ai/characterProfiles.js";
import { CHARACTER_PRESENTATION, buildCharacterRoster } from "../src/gui/characterRoster.js";
import { createGuiLobbyServer, type GuiLobbyOptions } from "../src/gui/createGuiServer.js";
import { DEFAULT_OPPONENTS, createGuiGame, parseGuiGameConfig } from "../src/gui/gameSetup.js";
import { defaultResponse } from "./helpers/yonmaHuman.js";
import type { GuiSession } from "../src/gui/guiSession.js";

async function readOneSseMessage(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { text: string }): Promise<any> {
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

async function startLobby(options: GuiLobbyOptions = {}) {
  const handle = createGuiLobbyServer({ frameDelayMs: 0, ...options });
  // 한 게임을 끝내는 데 수 초가 걸리므로, 그동안 쉬던 keep-alive 연결을 서버가 유휴 제한(기본 5초)으로 닫는 순간과
  // 테스트의 다음 fetch가 그 연결을 재사용하는 순간이 겹치면 ECONNRESET이 난다. 테스트 서버에서만 유휴 제한을 끈다
  // (close()에서 closeAllConnections()로 모든 연결을 정리한다).
  handle.server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  const baseUrl = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
  const stream = await fetch(`${baseUrl}/events`);
  const reader = stream.body!.getReader();
  const buffer = { text: "" };
  return {
    baseUrl,
    getSession: handle.getSession,
    next: () => readOneSseMessage(reader, buffer),
    post: (path: string, body?: unknown) =>
      fetch(`${baseUrl}${path}`, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
    close: async () => {
      await reader.cancel();
      handle.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => handle.server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

describe("시작 화면 캐릭터 목록 (characterRoster)", () => {
  it("등록된 모든 캐릭터를 순서대로 담고, 모두 한 줄 설명과 태그 0~4개를 가진다 (평가/서열 표현 없음)", () => {
    const roster = buildCharacterRoster();
    expect(roster.map((c) => c.characterId)).toEqual(Object.keys(CHARACTER_PROFILES));
    expect(Object.keys(CHARACTER_PRESENTATION).sort()).toEqual(Object.keys(CHARACTER_PROFILES).sort());
    for (const entry of roster) {
      expect(entry.summary.length, entry.characterId).toBeGreaterThan(0);
      expect(entry.tags.length, entry.characterId).toBeLessThanOrEqual(4);
      expect(new Set(entry.tags).size).toBe(entry.tags.length);
      for (const tag of entry.tags) expect(tag, entry.characterId).not.toMatch(/강함|약함|숙련|최상급|실력/);
    }
  });

  it("내부 AI 수치와 archetype 식별자는 목록에 싣지 않는다", () => {
    for (const entry of buildCharacterRoster()) {
      expect(Object.keys(entry).sort()).toEqual(["characterId", "displayName", "summary", "tags"]);
      expect(JSON.stringify(entry)).not.toContain(CHARACTER_PROFILES[entry.characterId]!.archetype);
    }
  });

  it("초상화는 선택 필드다: 등록되지 않은 캐릭터에는 portrait 키 자체가 없다", () => {
    for (const entry of buildCharacterRoster()) expect("portrait" in entry, entry.characterId).toBe(false);
  });
});

describe("대국 구성 검증 (parseGuiGameConfig)", () => {
  it("정상 구성을 정규화한다 (legacy id는 정식 id로, 빈 시드는 없음으로)", () => {
    expect(parseGuiGameConfig({ mode: "sanma", opponents: ["ryuhart", "inan"], seed: "  ", saveReplays: true })).toEqual({
      mode: "sanma",
      opponents: ["ryuheart", "inan"],
      saveReplays: true,
    });
    expect(parseGuiGameConfig({ mode: "yonma", opponents: ["inan", "magnum", "yuwen"], seed: " s1 " })).toEqual({
      mode: "yonma",
      opponents: ["inan", "magnum", "yuwen"],
      seed: "s1",
      saveReplays: false,
    });
  });

  it("잘못된 구성은 거절한다", () => {
    expect(() => parseGuiGameConfig(null)).toThrow();
    expect(() => parseGuiGameConfig({ mode: "gomoku", opponents: [] })).toThrow(/알 수 없는 모드/);
    expect(() => parseGuiGameConfig({ mode: "sanma", opponents: ["inan"] })).toThrow(/2명/);
    expect(() => parseGuiGameConfig({ mode: "yonma", opponents: ["inan", "magnum"] })).toThrow(/3명/);
    expect(() => parseGuiGameConfig({ mode: "sanma", opponents: ["inan", "nobody"] })).toThrow(/Unknown character/);
    expect(() => parseGuiGameConfig({ mode: "sanma", opponents: ["ryuheart", "ryuhart"] })).toThrow(/두 좌석/);
    expect(() => parseGuiGameConfig({ mode: "sanma", opponents: ["inan", "magnum"], seed: "x".repeat(101) })).toThrow(/100자/);
    expect(() => parseGuiGameConfig({ mode: "sanma", opponents: ["inan", "magnum"], saveReplays: "yes" })).toThrow(/saveReplays/);
  });

  it("상대를 지정하지 않은 createGuiGame은 기존 기본 구성 그대로다", () => {
    expect(createGuiGame("sanma", "s").characterProfiles.map((p) => p?.characterId ?? null)).toEqual([null, ...DEFAULT_OPPONENTS.sanma]);
    expect(createGuiGame("yonma", "s").characterProfiles.map((p) => p?.characterId ?? null)).toEqual([null, ...DEFAULT_OPPONENTS.yonma]);
    const custom = createGuiGame("yonma", "s", ["inan", "magnum", "yuwen"]);
    expect(custom.characterProfiles.map((p) => p?.characterId ?? null)).toEqual([null, "inan", "magnum", "yuwen"]);
    expect(custom.controllers).toEqual(["human", "characterAI", "characterAI", "characterAI"]);
  });
});

describe("시작 화면 서버 (createGuiLobbyServer)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  it("접속하면 시작 화면 상태(목록, 인원 수, CLI 초기값)를 보내고, 게임 전에는 응답/진행을 거절한다", async () => {
    const lobby = await startLobby({ defaults: { mode: "yonma", seed: "cli-seed", saveReplays: true } });
    cleanup = lobby.close;
    const msg = await lobby.next();
    expect(msg.type).toBe("setup");
    expect(msg.roster.length).toBe(Object.keys(CHARACTER_PROFILES).length);
    expect(msg.playerCounts).toEqual({ sanma: 3, yonma: 4 });
    expect(msg.defaults).toEqual({
      mode: "yonma",
      opponents: { sanma: [...DEFAULT_OPPONENTS.sanma], yonma: [...DEFAULT_OPPONENTS.yonma] },
      seed: "cli-seed",
      saveReplays: true,
    });
    expect(lobby.getSession()).toBeNull();
    expect((await lobby.post("/respond", { type: "discard", tileId: 0, declareRiichi: false })).status).toBe(400);
    expect((await lobby.post("/continue")).status).toBe(400);
  });

  it("고른 상대로 게임을 시작하고, 진행 중에는 새 시작/시작 화면 복귀를 거절한다", async () => {
    let started: unknown;
    const lobby = await startLobby({ onGameStarted: (c) => (started = c) });
    cleanup = lobby.close;
    await lobby.next();

    const bad = await lobby.post("/start", { mode: "sanma", opponents: ["inan", "inan"] });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/두 좌석/);
    expect(lobby.getSession()).toBeNull();

    const ok = await lobby.post("/start", { mode: "yonma", opponents: ["inan", "magnum", "yuwen"], seed: "lobby-seed", saveReplays: false });
    expect(ok.status).toBe(204);
    const first = await lobby.next();
    expect(first.type).toBe("decision");
    expect(first.characterNames).toEqual([null, "이난", "매그넘", "여온"]);
    expect(started).toEqual({ mode: "yonma", opponents: ["inan", "magnum", "yuwen"], seed: "lobby-seed", saveReplays: false });
    expect(lobby.getSession()).not.toBeNull();

    expect((await lobby.post("/start", { mode: "sanma", opponents: ["inan", "magnum"] })).status).toBe(400);
    expect((await lobby.post("/setup")).status).toBe(400);
  });

  /** 세션에 직접 응답해 게임을 끝낸다 (HTTP로 한 수씩 보내는 것보다 빠르다). */
  function finishGame(getSession: () => GuiSession | null): void {
    const session = getSession()!;
    for (let steps = 0; session.getPhase() !== "game_end"; steps++) {
      if (steps > 200000) throw new Error("game did not finish");
      if (session.getPhase() === "hand_end") session.continueToNextHand();
      else session.respond(defaultResponse(session.getCurrentRequest()!));
    }
  }

  async function connectOnce(baseUrl: string): Promise<any> {
    const res = await fetch(`${baseUrl}/events`);
    const reader = res.body!.getReader();
    const msg = await readOneSseMessage(reader, { text: "" });
    await reader.cancel();
    return msg;
  }

  it("게임이 끝나면 엔진의 최종 순위와 실제 시드를 보내고, 시작 화면으로 돌아가면 마지막 구성이 초기값이 된다", async () => {
    const lobby = await startLobby();
    cleanup = lobby.close;
    await lobby.next();
    expect((await lobby.post("/start", { mode: "sanma", opponents: ["magnum", "inan"], seed: "lobby-full" })).status).toBe(204);
    await lobby.next();
    const game = lobby.getSession()!;
    finishGame(lobby.getSession);

    const ended = await connectOnce(lobby.baseUrl);
    expect(ended.type).toBe("game_end");
    expect(ended.canStartNewGame).toBe(true);
    // 새로고침으로 받은 종료 상태에도 작탁을 다시 그릴 마지막 장면 view(사람 좌석, 상대 손패 없음)가 있다
    expect(ended.view.seat).toBe(0);
    expect(ended.view.concealedTiles.length).toBeGreaterThan(0);
    for (const o of ended.view.opponents) expect(o).not.toHaveProperty("concealedTiles");
    expect(ended.gameConfig).toEqual({ mode: "sanma", opponents: ["magnum", "inan"], seed: "lobby-full", saveReplays: false });
    expect(ended.standings.map((s: { player: number }) => s.player).sort()).toEqual([0, 1, 2]);
    expect(ended.standings.map((s: { placement: number }) => s.placement)).toEqual([1, 2, 3]);
    expect(ended.standings.map((s: { rawScore: number }) => s.rawScore).sort()).toEqual([...ended.event.finalScores].sort());
    expect(game.getPhase()).toBe("game_end");

    expect((await lobby.post("/setup")).status).toBe(204);
    const setup = await lobby.next();
    expect(setup.type).toBe("setup");
    expect(setup.screen).toBe("setup"); // 설정 바꾸기: 허브가 아니라 마지막 모드의 설정 화면
    expect(setup.mode).toBe("sanma");
    expect(setup.defaults.mode).toBe("sanma");
    expect(setup.defaults.opponents.sanma).toEqual(["magnum", "inan"]);
    expect(setup.defaults.seed).toBe("lobby-full");
    expect(lobby.getSession()).toBeNull();
  }, 60_000);

  it("종료 화면에서 같은 시드로 다시 하면 같은 판이, 같은 설정으로 다시 하면 새 시드의 판이 시작된다", async () => {
    const started: { seed: string }[] = [];
    const lobby = await startLobby({ onGameStarted: (c) => started.push(c) });
    cleanup = lobby.close;
    await lobby.next();
    const config = { mode: "sanma", opponents: ["josangmin", "hwayoung"], seed: "rematch-seed" };
    expect((await lobby.post("/start", config)).status).toBe(204);
    const firstRequest = (await lobby.next()).request;
    finishGame(lobby.getSession);

    // 같은 시드로 다시: 서버를 다시 켜지 않고 새 게임이 시작되며, 첫 요청(배패 포함)이 원래 게임과 같다
    expect((await lobby.post("/start", config)).status).toBe(204);
    const replayed = await lobby.next();
    expect(replayed.type).toBe("decision");
    expect(replayed.request).toEqual(firstRequest);
    expect(started[1]!.seed).toBe("rematch-seed");
    finishGame(lobby.getSession);

    // 같은 설정으로 다시: 시드를 비우면 새 시드가 만들어진다
    expect((await lobby.post("/start", { mode: config.mode, opponents: config.opponents })).status).toBe(204);
    const fresh = await lobby.next();
    expect(fresh.type).toBe("decision");
    expect(fresh.characterNames).toEqual([null, "조상민", "화영"]);
    expect(started[2]!.seed).not.toBe("rematch-seed");
  }, 120_000);

  it("처음에는 모드를 고르는 허브이고, 모드를 고르면 그 모드의 설정 화면, 허브로 돌아가 다른 모드를 고를 수 있다", async () => {
    const lobby = await startLobby();
    cleanup = lobby.close;
    const first = await lobby.next();
    expect(first.type).toBe("setup");
    expect(first.screen).toBe("hub");
    expect(first.modes).toEqual([
      { mode: "sanma", players: 3, chi: false, kita: true, startingScore: 35000 },
      { mode: "yonma", players: 4, chi: true, kita: false, startingScore: 25000 },
    ]);
    expect(lobby.getSession()).toBeNull(); // 허브에서는 게임이 시작되지 않는다

    expect((await lobby.post("/lobby", { screen: "setup", mode: "sanma" })).status).toBe(204);
    const sanma = await lobby.next();
    expect([sanma.screen, sanma.mode]).toEqual(["setup", "sanma"]);
    expect(sanma.playerCounts.sanma).toBe(3);
    expect(sanma.defaults.opponents.sanma.length).toBe(2);
    expect(lobby.getSession()).toBeNull(); // 산마를 골라도 바로 시작하지 않는다

    expect((await lobby.post("/lobby", { screen: "hub" })).status).toBe(204);
    expect((await lobby.next()).screen).toBe("hub");
    expect((await lobby.post("/lobby", { screen: "setup", mode: "yonma" })).status).toBe(204);
    const yonma = await lobby.next();
    expect([yonma.screen, yonma.mode]).toEqual(["setup", "yonma"]);
    expect(yonma.defaults.opponents.yonma.length).toBe(3);

    expect((await lobby.post("/lobby", { screen: "setup", mode: "gomoku" })).status).toBe(400);
    expect((await lobby.post("/lobby", { screen: "elsewhere" })).status).toBe(400);

    // 새 접속도 같은 화면을 본다 (서버가 화면 상태를 들고 있다)
    const again = await fetch(`${lobby.baseUrl}/events`);
    const reader = again.body!.getReader();
    const reconnect = await readOneSseMessage(reader, { text: "" });
    await reader.cancel();
    expect([reconnect.screen, reconnect.mode]).toEqual(["setup", "yonma"]);

    // 대국 중에는 로비로 옮길 수 없다
    expect((await lobby.post("/start", { mode: "yonma", opponents: ["inan", "magnum", "yuwen"], seed: "hub-flow" })).status).toBe(204);
    expect((await lobby.next()).type).toBe("decision");
    expect((await lobby.post("/lobby", { screen: "hub" })).status).toBe(400);
  }, 60_000);

  it("대국 그만두기: 그 모드의 설정 화면으로 돌아가고, 리플레이는 저장하지 않으며, 재생 중이던 장면도 멈춘다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abandon-replays-"));
    const lobby = await startLobby({ frameDelayMs: 30, replayDir: dir });
    const close = lobby.close;
    cleanup = async () => {
      await close();
      rmSync(dir, { recursive: true, force: true });
    };
    await lobby.next();
    expect((await lobby.post("/abandon")).status).toBe(400); // 대국이 없다

    expect((await lobby.post("/lobby", { screen: "setup", mode: "yonma" })).status).toBe(204);
    await lobby.next();
    expect((await lobby.post("/start", { mode: "yonma", opponents: ["inan", "magnum", "yuwen"], seed: "abandon-me", saveReplays: true })).status).toBe(204);
    const first = await lobby.next();
    expect(first.type).toBe("decision");
    expect(first.canAbandon).toBe(true);

    // 한 수 두어 AI 장면 재생을 시작시킨 뒤, 재생 도중에 그만둔다
    const request = first.request;
    const answer = request.type === "discard" ? { type: "discard", tileId: request.legalTileIds[0], declareRiichi: false } : { type: request.type, declare: false };
    expect((await lobby.post("/respond", answer)).status).toBe(204);
    const watch = await lobby.next();
    expect(watch.type).toBe("watch");
    expect(watch.canAbandon).toBe(true);
    expect((await lobby.post("/abandon")).status).toBe(204);

    let msg = await lobby.next();
    while (msg.type === "watch") msg = await lobby.next(); // 그만두기 직전에 이미 보낸 장면만 남을 수 있다
    expect([msg.type, msg.screen, msg.mode]).toEqual(["setup", "setup", "yonma"]);
    expect(lobby.getSession()).toBeNull();
    // 남은 장면 타이머가 살아 있었다면 원래 연결로 장면(watch)을 더 보냈을 것이다: 0.4초 동안 아무 메시지도 없어야 한다
    const extra = await Promise.race([lobby.next(), new Promise((r) => setTimeout(() => r("none"), 400))]);
    expect(extra).toBe("none");
    const reconnect = await fetch(`${lobby.baseUrl}/events`);
    const reader = reconnect.body!.getReader();
    expect((await readOneSseMessage(reader, { text: "" })).type).toBe("setup");
    await reader.cancel();
    expect(readdirSync(dir)).toEqual([]); // 중단한 대국의 리플레이는 없다
  }, 60_000);
});
