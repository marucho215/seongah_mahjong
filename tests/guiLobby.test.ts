import { describe, expect, it, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { CHARACTER_PROFILES } from "../src/ai/characterProfiles.js";
import { ARCHETYPE_LABELS, BALANCED_TENDENCY, MAX_TENDENCIES, buildCharacterRoster, tendenciesOf } from "../src/gui/characterRoster.js";
import { createGuiLobbyServer, type GuiLobbyOptions } from "../src/gui/createGuiServer.js";
import { DEFAULT_OPPONENTS, createGuiGame, parseGuiGameConfig } from "../src/gui/gameSetup.js";
import { defaultResponse } from "./helpers/yonmaHuman.js";

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
  it("등록된 모든 캐릭터를 순서대로 담고, 성향 표기가 빠진 archetype이 없다", () => {
    const roster = buildCharacterRoster();
    expect(roster.map((c) => c.characterId)).toEqual(Object.keys(CHARACTER_PROFILES));
    for (const entry of roster) {
      expect(ARCHETYPE_LABELS[entry.archetype], entry.characterId).toBeDefined();
      expect(entry.archetypeLabel).toBe(ARCHETYPE_LABELS[entry.archetype]);
      expect(["high", "mid", "low"]).toContain(entry.skillLevel);
      expect(entry.tendencies.length).toBeGreaterThan(0);
      expect(entry.tendencies.length).toBeLessThanOrEqual(MAX_TENDENCIES);
    }
  });

  it("내부 AI 파라미터 수치는 목록에 싣지 않는다 (문구와 숙련도 구간만)", () => {
    for (const entry of buildCharacterRoster()) {
      expect(Object.keys(entry).sort()).toEqual(["archetype", "archetypeLabel", "characterId", "displayName", "skillLevel", "tendencies"]);
    }
  });

  it("성향 문구는 문턱값을 크게 넘는 순이며, 해당이 없으면 균형형이다", () => {
    const base = CHARACTER_PROFILES.jegalmina!;
    const neutral = { ...base, aggression: 0.5, defense: 0.5, callBias: 0.4, riichiBias: 0.5, damaBias: 0.4, valueGreed: 0.5, entropy: 0.3 };
    expect(tendenciesOf(neutral)).toEqual([BALANCED_TENDENCY]);
    expect(tendenciesOf({ ...neutral, callBias: 0.9, aggression: 0.7 })).toEqual(["울기를 자주 사용함", "공격적인 편"]);
    expect(tendenciesOf({ ...neutral, callBias: 0.9, aggression: 0.95, defense: 0.1, entropy: 0.9 })).toHaveLength(MAX_TENDENCIES);
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

  it("게임이 끝나면 새 대국 버튼 정보를 보내고, 시작 화면으로 돌아가면 마지막 구성이 초기값이 된다", async () => {
    const lobby = await startLobby();
    cleanup = lobby.close;
    await lobby.next();
    expect((await lobby.post("/start", { mode: "sanma", opponents: ["magnum", "inan"], seed: "lobby-full" })).status).toBe(204);
    await lobby.next();

    // 시간 절약: HTTP 대신 세션에 직접 응답해 게임을 끝낸 뒤, 게임 종료 상태는 새 접속으로 확인한다.
    const session = lobby.getSession()!;
    for (let steps = 0; session.getPhase() !== "game_end"; steps++) {
      if (steps > 200000) throw new Error("game did not finish");
      if (session.getPhase() === "hand_end") session.continueToNextHand();
      else session.respond(defaultResponse(session.getCurrentRequest()!));
    }
    const fresh = await fetch(`${lobby.baseUrl}/events`);
    const freshReader = fresh.body!.getReader();
    const ended = await readOneSseMessage(freshReader, { text: "" });
    await freshReader.cancel();
    expect(ended.type).toBe("game_end");
    expect(ended.canStartNewGame).toBe(true);

    expect((await lobby.post("/setup")).status).toBe(204);
    const setup = await lobby.next();
    expect(setup.type).toBe("setup");
    expect(setup.defaults.mode).toBe("sanma");
    expect(setup.defaults.opponents.sanma).toEqual(["magnum", "inan"]);
    expect(setup.defaults.seed).toBe("lobby-full");
    expect(lobby.getSession()).toBeNull();
  }, 60_000);
});
