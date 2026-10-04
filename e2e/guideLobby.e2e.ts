/* 마작 배우기: 로비의 "마작 배우기"에서 기초 규칙/역 도감을 연다. 역 카드는 눌러서 펼치면 팁과 예시 패가 나오고, 분류/검색으로 거르며, Esc로 닫는다. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { createGuiLobbyServer, type GuiLobbyServerHandle } from "../src/gui/createGuiServer.js";

let handle: GuiLobbyServerHandle;
let browser: Browser;
let page: Page;
let dir: string;
let errors: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gui-guide-"));
  handle = createGuiLobbyServer({ frameDelayMs: 0, replayDir: join(dir, "replays"), customAiDir: join(dir, "custom-ai") });
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  handle.server.keepAliveTimeout = 0;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${(handle.server.address() as AddressInfo).port}/`);
});

afterEach(async () => {
  await browser.close();
  handle.server.closeAllConnections();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

describe("마작 배우기", () => {
  it("로비에서 기초 규칙과 역 도감을 열고, 카드를 펼치면 예시 패가 보이며, 검색/분류/Esc가 동작한다", async () => {
    await page.locator("section:has(> h2:text-is('마작 배우기')) button", { hasText: "기초 규칙" }).click();
    await page.locator("#guide-overlay:not(.hidden) .guide-section").first().waitFor();
    expect(await page.locator("#guide-overlay .guide-section h3").first().textContent()).toBe("이기는 방법");
    expect(await page.locator("#guide-overlay .guide-example img").count()).toBeGreaterThan(5);

    await page.locator("#guide-overlay .guide-tab", { hasText: "역 도감" }).click();
    const cards = page.locator("#guide-overlay .guide-card");
    expect(await cards.count()).toBeGreaterThan(40);
    // 펼치면 팁과 예시
    await page.locator('.guide-card[data-yaku="Tanyao"] .guide-card-head').click();
    await page.locator('.guide-card[data-yaku="Tanyao"] .guide-example img').first().waitFor();
    expect(await page.locator('.guide-card[data-yaku="Tanyao"] .guide-tips').textContent()).toContain("팁");

    // 분류 칩: 역만만 보면 모든 카드가 역만
    await page.locator("#guide-overlay .guide-chip", { hasText: "역만" }).click();
    const hans = await page.locator("#guide-overlay .guide-han").allTextContents();
    expect(hans.length).toBeGreaterThan(10);
    expect(hans.every((h) => h.includes("역만"))).toBe(true);
    await page.locator("#guide-overlay .guide-chip", { hasText: "전체" }).click();

    // 검색
    await page.locator("#guide-overlay .guide-search").fill("리치");
    await expect.poll(() => cards.count()).toBeLessThan(6);
    expect(await page.locator("#guide-overlay .guide-name").allTextContents()).toContain("리치");
    await page.locator("#guide-overlay .guide-search").fill("없는역이름");
    await page.locator("#guide-overlay .guide-empty").waitFor();

    await page.keyboard.press("Escape");
    await page.locator("#guide-overlay.hidden").waitFor({ state: "attached" });
  }, 60_000);
});
