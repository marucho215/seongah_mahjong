/* 리플레이 탐색: 국 목차(국마다 결과 한 줄), 북마크(새로고침 뒤에도 유지), 링크 복사(그 수로 바로 열림). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createGuiLobbyServer, type GuiLobbyServerHandle } from "../src/gui/createGuiServer.js";
import { writeGameReplay } from "../src/sim/replayRecorder.js";
import { aiOnlyRecord } from "../tests/helpers/replayParityGames.js";

let handle: GuiLobbyServerHandle;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let dir: string;
let base: string;
let file: string;
let errors: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "gui-replay-nav-"));
  writeGameReplay(aiOnlyRecord("sanma", "replay-nav"), join(dir, "replays"));
  file = readdirSync(join(dir, "replays")).find((f) => f.endsWith(".json"))!;
  handle = createGuiLobbyServer({ frameDelayMs: 0, replayDir: join(dir, "replays"), customAiDir: join(dir, "custom-ai") });
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  handle.server.keepAliveTimeout = 0;
  base = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
}, 120_000);

afterAll(async () => {
  await browser.close();
  handle.server.closeAllConnections();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

const position = async () => Number((await page.locator("#rv-position").textContent())!.split("/")[0]!.trim());

describe("리플레이 탐색", () => {
  it("목차로 국을 옮기고, 북마크는 새로고침 뒤에도 남으며, 복사한 링크는 그 수로 바로 열린다", async () => {
    await page.goto(`${base}/?replay=${encodeURIComponent(file)}`);
    await page.locator("#rv-slider").waitFor({ timeout: 90_000 });
    await page.locator("#rv-toc-toggle").click();
    const items = page.locator("#rv-toc-panel .rv-toc-list").first().locator(".rv-toc-item");
    expect(await items.count()).toBeGreaterThan(1);
    // 국마다 결과 한 줄 (화료 또는 유국)
    const results = await items.locator(".rv-toc-result").allTextContents();
    expect(results.every((t) => /점|유국/.test(t))).toBe(true);

    // 두 번째 국으로
    const startOfSecond = await (async () => {
      await items.nth(1).click();
      return position();
    })();
    expect(startOfSecond).toBeGreaterThan(1);

    // 북마크: 켜면 ★, 목록에 생기고 새로고침해도 남는다
    await page.locator("#rv-bookmark").click();
    expect(await page.locator("#rv-bookmark").textContent()).toBe("★");
    await page.locator("#rv-toc-panel .rv-mark").first().waitFor();
    await page.reload();
    await page.locator("#rv-slider").waitFor({ timeout: 90_000 });
    await page.locator("#rv-toc-toggle").click();
    await page.locator("#rv-toc-panel .rv-mark").first().waitFor();
    await page.locator("#rv-toc-panel .rv-mark .rv-toc-item").first().click();
    expect(await position()).toBe(startOfSecond);
    // 해제
    await page.locator("#rv-bookmark").click();
    await expect.poll(() => page.locator("#rv-toc-panel .rv-mark").count()).toBe(0);

    // 링크 복사: 다른 수로 옮긴 뒤 복사 → 그 링크를 열면 같은 수
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const here = await position();
    await page.locator("#rv-share").click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toContain(`step=${here - 1}`);
    await page.goto(link);
    await page.locator("#rv-slider").waitFor({ timeout: 90_000 });
    await expect.poll(position).toBe(here);
  }, 240_000);
});
