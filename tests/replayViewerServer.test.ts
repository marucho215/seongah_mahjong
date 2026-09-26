import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import { humanRecord, replayBytes } from "./helpers/replayParityGames.js";

describe("리플레이 뷰어 서버 (/api/replays)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  it("리플레이 폴더의 파일을 나열하고, 재현 결과 또는 재현 불가 이유를 돌려준다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-viewer-"));
    const record = humanRecord("sanma", "replay-viewer-server");
    writeFileSync(join(dir, "good_game0.json"), replayBytes(record));
    const tampered = JSON.parse(replayBytes(record));
    tampered.meta.gameSeed = "not-the-same-seed";
    writeFileSync(join(dir, "tampered_game0.json"), JSON.stringify(tampered));
    writeFileSync(join(dir, "ignored.txt"), "not a replay");

    const { server } = createGuiLobbyServer({ frameDelayMs: 0, replayDir: dir });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    server.keepAliveTimeout = 0; // 재현에 수 초 걸리므로 guiLobby.test.ts와 같은 이유로 유휴 제한을 끈다
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    cleanup = async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    };

    const list = (await (await fetch(`${base}/api/replays`)).json()) as { name: string }[];
    expect(list.map((f) => f.name).sort()).toEqual(["good_game0.json", "tampered_game0.json"]);

    const good = (await (await fetch(`${base}/api/replays/good_game0.json`)).json()) as any;
    expect(good.reproduction.ok).toBe(true);
    expect(good.reproduction.steps.length).toBe(record.events.length);
    expect(good.seatNames).toEqual(["플레이어", "제갈 미나", "제갈 나희"]);

    const bad = (await (await fetch(`${base}/api/replays/tampered_game0.json`)).json()) as any;
    expect(bad.reproduction.ok).toBe(false);
    expect(bad.reproduction).not.toHaveProperty("steps");

    expect((await fetch(`${base}/api/replays/..%2Fpackage.json`)).status).toBe(400);
    expect((await fetch(`${base}/api/replays/missing_game0.json`)).status).toBe(404);
  }, 120_000);
});
