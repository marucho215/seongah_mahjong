// CustomAI 내보내기/가져오기: 공유용 파일에는 이름과 슬라이더 값만 있고(내부 id 없음), 가져올 때 저장과 같은 검증을 거쳐 새 id로 만든다.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import { CUSTOM_AI_EXPORT_KIND, exportCustomAi, initialCustomAiStyle, parseCustomAiImport } from "../src/customai/customAiSchema.js";

const def = { formatVersion: 1 as const, id: "c-0123456789ab", name: "공유 AI", style: { ...initialCustomAiStyle(), attack: 80, defense: 20 } };

describe("파일 형식", () => {
  it("내보낸 파일은 id 없이 이름과 style만 담고, 그대로 가져오면 같은 값이다", () => {
    const file = exportCustomAi(def);
    expect(file).toEqual({ kind: CUSTOM_AI_EXPORT_KIND, formatVersion: 1, name: "공유 AI", style: def.style });
    expect(JSON.stringify(file)).not.toContain(def.id);
    expect(parseCustomAiImport(JSON.parse(JSON.stringify(file)))).toEqual({ name: "공유 AI", style: def.style });
  });

  it("다른 JSON, 모르는 필드, 범위 밖 값, 긴 이름은 거절한다", () => {
    const ok = exportCustomAi(def);
    expect(() => parseCustomAiImport([])).toThrow();
    expect(() => parseCustomAiImport({ ...ok, kind: "other" })).toThrow(/내보낸/);
    expect(() => parseCustomAiImport({ ...ok, formatVersion: 2 })).toThrow(/버전/);
    expect(() => parseCustomAiImport({ ...ok, id: "c-000000000000" })).toThrow(/알 수 없는/);
    expect(() => parseCustomAiImport({ ...ok, style: { ...ok.style, attack: 101 } })).toThrow(/0~100/);
    expect(() => parseCustomAiImport({ ...ok, style: { ...ok.style, extra: 1 } })).toThrow(/알 수 없는/);
    expect(() => parseCustomAiImport({ ...ok, name: "가".repeat(31) })).toThrow(/30자/);
  });
});

describe("서버: GET .../export, POST /api/custom-ai/import", () => {
  it("만든 CustomAI를 내려받아 다시 가져오면 같은 값의 새 CustomAI가 생긴다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custom-ai-share-"));
    const handle = createGuiLobbyServer({ frameDelayMs: 0, replayDir: join(dir, "replays"), customAiDir: join(dir, "custom-ai") });
    try {
      await new Promise<void>((resolve) => handle.server.listen(0, resolve));
      handle.server.keepAliveTimeout = 0;
      const base = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
      const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

      const created = (await (await post("/api/custom-ai", { name: "내보낼 AI", style: def.style })).json()) as { id: string };
      const exported = await fetch(`${base}/api/custom-ai/${created.id}/export`);
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-disposition")).toContain("attachment");
      const text = await exported.text();
      expect(text).not.toContain(created.id);

      const imported = await post("/api/custom-ai/import", text);
      expect(imported.status).toBe(200);
      const copy = (await imported.json()) as { id: string; name: string; style: unknown };
      expect(copy.id).not.toBe(created.id);
      expect(copy).toMatchObject({ name: "내보낼 AI", style: def.style });

      const list = (await (await fetch(`${base}/api/custom-ai`)).json()) as { entries: { id: string }[] };
      expect(list.entries.map((e) => e.id).sort()).toEqual([created.id, copy.id].sort());

      expect((await post("/api/custom-ai/import", "{ not json")).status).toBe(400);
      expect((await post("/api/custom-ai/import", { name: "x", style: def.style })).status).toBe(400); // 내보낸 파일이 아님
      expect((await fetch(`${base}/api/custom-ai/c-ffffffffffff/export`)).status).toBe(400);
    } finally {
      handle.server.closeAllConnections();
      await new Promise<void>((resolve) => handle.server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
