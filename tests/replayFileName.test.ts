// 사람 대국 리플레이 파일 이름: 시드를 파일 이름에 그대로 쓰면 한글/빈칸 시드는 리플레이 목록(REPLAY_FILE_NAME)에서 빠지고,
// 경로 문자(/, \)가 든 시드는 저장이 실패하거나 폴더 밖을 가리킬 수 있다. 파일 이름만 안전하게 바꾸고 기록 안의 시드는 그대로 둔다.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import { replayFileNamePart, writeGameReplay, type GameReplayRecord } from "../src/sim/replayRecorder.js";
import { defaultResponse } from "./helpers/yonmaHuman.js";


async function readOneSseMessage(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { text: string }): Promise<any> {
  while (true) {
    const match = /data: (.*)\n\n/.exec(buffer.text);
    if (match) {
      buffer.text = buffer.text.slice(match.index + match[0].length);
      return JSON.parse(match[1]!);
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE stream ended before a full message arrived");
    buffer.text += Buffer.from(value).toString("utf-8");
  }
}

describe("사람 대국 리플레이 파일 이름 (GUI 로비)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  /** 시드를 정해 산마 한 게임을 HTTP/SSE로 끝까지 두고, 저장된 경로를 돌려준다. */
  async function playAndSave(seed: string) {
    const root = mkdtempSync(join(tmpdir(), "replay-name-"));
    const replayDir = join(root, "replays");
    const saved: string[] = [];
    const handle = createGuiLobbyServer({ frameDelayMs: 0, replayDir, onReplaySaved: (p) => saved.push(p) });
    handle.server.keepAliveTimeout = 0; // 한 게임에 수 초 걸리므로 guiLobby.test.ts와 같은 이유로 유휴 제한을 끈다
    await new Promise<void>((r) => handle.server.listen(0, r));
    const base = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
    const stream = await fetch(`${base}/events`);
    const reader = stream.body!.getReader();
    const buffer = { text: "" };
    cleanup = async () => {
      await reader.cancel();
      handle.server.closeAllConnections();
      await new Promise<void>((r) => handle.server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    };
    const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

    await readOneSseMessage(reader, buffer);
    expect((await post("/start", { mode: "sanma", opponents: ["jegalmina", "jegalnahui"], seed, saveReplays: true })).status).toBe(204);
    for (let guard = 0; ; guard++) {
      if (guard > 5000) throw new Error("game did not end");
      const m = await readOneSseMessage(reader, buffer);
      if (m.type === "game_end") break;
      const res = m.type === "hand_end" ? await post("/continue") : m.type === "decision" ? await post("/respond", defaultResponse(m.request)) : null;
      if (res && res.status !== 204) throw new Error(`${m.type} -> ${res.status}: ${await res.text()}`);
    }
    const list = (await (await fetch(`${base}/api/replays`)).json()) as { name: string }[];
    return { root, replayDir, saved, listed: list.map((f) => f.name) };
  }

  it("영문/숫자/._-만 쓴 시드는 지금까지와 같은 파일 이름이다", async () => {
    const { saved, listed } = await playAndSave("ascii-seed_1.0");
    expect(listed).toEqual(["human-sanma-ascii-seed_1.0_game0.json"]);
    expect(basename(saved[0]!)).toBe("human-sanma-ascii-seed_1.0_game0.json");
  }, 120_000);

  for (const seed of ["한글 시드", "a/b", "..\\escape"]) {
    it(`시드 ${JSON.stringify(seed)}: 사용자 리플레이 폴더 바로 아래에 저장되고, 목록에 나오며, 기록 안의 시드는 그대로다`, async () => {
      const { root, replayDir, saved, listed } = await playAndSave(seed);
      expect(saved).toHaveLength(1);
      const path = saved[0]!;
      expect(dirname(resolve(path))).toBe(resolve(replayDir));
      expect(readdirSync(root)).toEqual(["replays"]); // 폴더 밖에 아무것도 쓰지 않았다
      expect(listed).toEqual([basename(path)]);
      const record = JSON.parse(readFileSync(path, "utf-8"));
      expect(record.meta.gameSeed).toBe(seed);
    }, 120_000);
  }
});

describe("리플레이 파일 이름 조각 (replayFileNamePart)", () => {
  it("영문/숫자/._-만 쓴 텍스트는 그대로 둔다 (기존 파일 이름 유지)", () => {
    expect(replayFileNamePart("gui-1790000000000")).toBe("gui-1790000000000");
    expect(replayFileNamePart("my.seed_01")).toBe("my.seed_01");
    expect(replayFileNamePart("x".repeat(100))).toBe("x".repeat(100));
  });

  it("그 밖의 문자는 _로 바꾸고 원문 해시를 붙여, 서로 다른 시드가 같은 이름이 되지 않는다", () => {
    const a = replayFileNamePart("가나");
    const b = replayFileNamePart("다라");
    expect(a).toMatch(/^__-[0-9a-f]{8}$/);
    expect(b).toMatch(/^__-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(replayFileNamePart("가나")).toBe(a); // 같은 시드는 같은 이름
    expect(replayFileNamePart("a/b")).toMatch(/^a_b-[0-9a-f]{8}$/);
    expect(replayFileNamePart("..\\x")).toMatch(/^\.\._x-[0-9a-f]{8}$/);
  });

  it("maxLength를 넘는 텍스트는 잘라서 해시를 붙인다", () => {
    expect(replayFileNamePart("y".repeat(50), 40)).toMatch(new RegExp(`^y{40}-[0-9a-f]{8}$`));
  });

  it("writeGameReplay는 경로 문자가 섞인 라벨을 쓰지 않고 거절한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-guard-"));
    try {
      for (const label of ["a/b", "..\\up", "../up"]) {
        const record = { meta: { simulationLabel: label, gameIndex: 0 } } as unknown as GameReplayRecord;
        expect(() => writeGameReplay(record, dir)).toThrow(/path separators/);
      }
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
