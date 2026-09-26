import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import { initialCustomAiStyle } from "../src/customai/customAiSchema.js";

async function readOne(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { text: string }): Promise<any> {
  while (true) {
    const m = /data: (.*)\n\n/.exec(buffer.text);
    if (m) {
      buffer.text = buffer.text.slice(m.index + m[0].length);
      return JSON.parse(m[1]!);
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    buffer.text += Buffer.from(value).toString("utf-8");
  }
}

describe("CustomAI 서버 API와 대국 참가", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  it("만들고 나열하고, 잘못된 값은 거절하며, 시작 화면 목록에 들어가 대국 상대로 앉을 수 있다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custom-ai-server-"));
    const handle = createGuiLobbyServer({ frameDelayMs: 0, customAiDir: dir });
    await new Promise<void>((resolve) => handle.server.listen(0, resolve));
    handle.server.keepAliveTimeout = 0;
    const base = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
    const events = await fetch(`${base}/events`);
    const reader = events.body!.getReader();
    const buffer = { text: "" };
    cleanup = async () => {
      await reader.cancel();
      handle.server.closeAllConnections();
      await new Promise<void>((resolve) => handle.server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    };
    const post = (path: string, body: unknown, method = "POST") => fetch(`${base}${path}`, { method, body: JSON.stringify(body) });

    const first = await readOne(reader, buffer);
    expect(first.type).toBe("setup");
    expect(first.roster.some((r: { custom?: boolean }) => r.custom)).toBe(false);

    const schema = (await (await fetch(`${base}/api/custom-ai`)).json()) as any;
    expect(schema.schema.fields.length).toBe(15);
    expect(schema.schema.fields.every((f: { label: string; key: string }) => !/[A-Z]/.test(f.label))).toBe(true);

    expect((await post("/api/custom-ai", { name: "x", style: { ...initialCustomAiStyle(), attack: 150 } })).status).toBe(400);
    expect((await post("/api/custom-ai", { name: "x", style: initialCustomAiStyle(), extra: true })).status).toBe(200); // 요청 본문의 여분 필드는 무시하고 파일에는 스키마 필드만 쓴다
    const created = (await (await post("/api/custom-ai", { name: "서버 테스트 AI", style: { ...initialCustomAiStyle(), riichi: 95, dama: 95 } })).json()) as any;
    expect(created.id).toMatch(/^c-[0-9a-f]{12}$/);

    // 만들 때마다 시작 화면 목록이 다시 온다
    let setup = await readOne(reader, buffer);
    setup = await readOne(reader, buffer);
    const entry = setup.roster.find((r: { characterId: string }) => r.characterId === `custom:${created.id}`);
    expect(entry).toMatchObject({ displayName: "서버 테스트 AI", summary: "", tags: [], custom: true });

    const list = (await (await fetch(`${base}/api/custom-ai`)).json()) as any;
    const listed = list.entries.find((e: { id: string }) => e.id === created.id);
    expect(listed.notices.length).toBeGreaterThan(0); // 리치/다마 둘 다 높음: 막지 않고 안내만

    const missing = await post("/start", { mode: "sanma", opponents: ["custom:c-000000000000", "inan"] });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toMatch(/찾을 수 없습니다/);
    expect(handle.getSession()).toBeNull();

    expect((await post("/start", { mode: "sanma", opponents: [`custom:${created.id}`, "inan"], seed: "custom-server" })).status).toBe(204);
    const decision = await readOne(reader, buffer);
    expect(decision.type).toBe("decision");
    expect(decision.characterNames).toEqual([null, "서버 테스트 AI", "이난"]);

    // 대국 중에 지워도 진행 중인 게임은 시작 때의 스냅샷으로 계속된다
    expect((await fetch(`${base}/api/custom-ai/${created.id}`, { method: "DELETE" })).status).toBe(200);
    expect(handle.getSession()!.getPhase()).toBe("decision");

    expect((await fetch(`${base}/api/custom-ai/..%2Fx`, { method: "DELETE" })).status).toBe(400);
  }, 60_000);
});
