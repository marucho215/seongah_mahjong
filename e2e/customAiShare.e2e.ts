/* CustomAI 가져오기/내보내기 (로비 화면): 내보내기 링크가 파일을 내려주고, "파일에서 가져오기"로 그 파일을 불러오면 새 CustomAI가 목록에 생긴다. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { createGuiLobbyServer, type GuiLobbyServerHandle } from "../src/gui/createGuiServer.js";
import { initialCustomAiStyle } from "../src/customai/customAiSchema.js";

let handle: GuiLobbyServerHandle;
let browser: Browser;
let page: Page;
let dir: string;
let base: string;
let errors: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gui-ai-share-"));
  handle = createGuiLobbyServer({ frameDelayMs: 0, replayDir: join(dir, "replays"), customAiDir: join(dir, "custom-ai") });
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  handle.server.keepAliveTimeout = 0;
  base = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
});

afterEach(async () => {
  await browser.close();
  handle.server.closeAllConnections();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

describe("CustomAI 가져오기/내보내기", () => {
  it("내보낸 파일을 가져오면 새 CustomAI가 생기고, 잘못된 파일은 오류를 보여 준다", async () => {
    await fetch(`${base}/api/custom-ai`, { method: "POST", body: JSON.stringify({ name: "공유할 AI", style: initialCustomAiStyle() }) });
    await page.goto(`${base}/`);
    await page.locator("section:has(> h2:text-is('대국 방식')) button.setup-seat", { hasText: "산마" }).click();
    const section = page.locator("section:has(> h2:text-is('CustomAI'))");
    await section.locator(".custom-ai-item").first().waitFor();

    const [download] = await Promise.all([page.waitForEvent("download"), section.locator("a", { hasText: "내보내기" }).click()]);
    const path = join(dir, "exported.json");
    await download.saveAs(path);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved).toMatchObject({ kind: "seongah-custom-ai", name: "공유할 AI" });
    expect(saved.id).toBeUndefined();

    await section.locator("input.custom-ai-import").setInputFiles(path);
    await expect.poll(() => section.locator(".custom-ai-item").count()).toBe(2);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ name: "다른 파일" }));
    await section.locator("input.custom-ai-import").setInputFiles(bad);
    await section.locator(".setup-error").waitFor();
    expect(await section.locator(".setup-error").textContent()).toContain("내보낸 CustomAI 파일이 아닙니다");
    expect(await section.locator(".custom-ai-item").count()).toBe(2);
  }, 60_000);
});
