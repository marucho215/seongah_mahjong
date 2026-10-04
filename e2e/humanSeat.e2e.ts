/* 내 자리 선택: 로비에서 동가/남가/서가/북가/랜덤을 고르면 그 자리에서 시작한다 (먼저 친의 차례가 진행된 뒤 내 차례가 온다). */
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
  dir = mkdtempSync(join(tmpdir(), "gui-seat-"));
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

const modeRow = (name: string) => page.locator("section:has(> h2:text-is('대국 방식')) button.setup-seat", { hasText: name });
const pick = (label: string) => page.locator(".seat-picker button", { hasText: label });

describe("내 자리 선택", () => {
  it("4마: 서가를 고르면 서풍 자리에서 시작하고, 3인 모드로 바꾸면 북가 선택은 사라진다", async () => {
    await modeRow("4마").click();
    await page.locator(".seat-picker").waitFor();
    expect(await page.locator(".seat-picker button").allTextContents()).toEqual(["랜덤", "동가 (친)", "남가", "서가", "북가"]);
    expect(await pick("동가").getAttribute("aria-checked")).toBe("true"); // 기본은 동가

    await pick("서가").click();
    expect(await pick("서가").getAttribute("aria-checked")).toBe("true");
    await page.locator(".setup-side .setup-start").click();
    await page.locator("#zone-bottom .hand img.clickable").first().waitFor({ timeout: 30_000 });
    const request = handle.getSession()!.getCurrentRequest()!;
    expect("view" in request && request.view.seat).toBe(2);
    // 내 이름표: 서풍이고 친이 아니다
    const plate = await page.locator("#zone-bottom .nameplate").textContent();
    expect(plate).toContain("서");
    expect(plate).not.toContain("친");
  }, 90_000);

  it("산마: 북가가 없고, 남가를 고른 설정은 다음 대국 설정에도 이어진다", async () => {
    await modeRow("산마").click();
    await page.locator(".seat-picker").waitFor();
    expect(await page.locator(".seat-picker button").allTextContents()).toEqual(["랜덤", "동가 (친)", "남가", "서가"]);
    await pick("남가").click();
    await page.locator(".setup-side .setup-start").click();
    await page.locator("#zone-bottom .hand img").first().waitFor({ timeout: 30_000 });
    expect((handle.getSession()!.getCurrentRequest() as unknown as { view: { seat: number } }).view.seat).toBe(1);

    page.once("dialog", (d) => void d.accept());
    await page.locator(".abandon-button").click();
    await page.getByText("대국 방식 바꾸기").waitFor();
    expect(await pick("남가").getAttribute("aria-checked")).toBe("true"); // 마지막으로 고른 자리가 기억된다
  }, 90_000);

  it("랜덤: 시드가 같으면 같은 자리에 앉는다", async () => {
    await modeRow("4마").click();
    await page.locator(".seat-picker").waitFor();
    await pick("랜덤").click();
    await page.locator(".setup-input").first().fill("seat-random-seed");
    const seats: number[] = [];
    for (let i = 0; i < 2; i++) {
      await page.locator(".setup-side .setup-start").click();
      await page.locator("#zone-bottom .hand img.clickable").first().waitFor({ timeout: 30_000 });
      seats.push((handle.getSession()!.getCurrentRequest() as unknown as { view: { seat: number } }).view.seat);
      page.once("dialog", (d) => void d.accept());
      await page.locator(".abandon-button").click();
      await page.getByText("대국 방식 바꾸기").waitFor();
    }
    expect(seats[0]).toBe(seats[1]);
  }, 120_000);
});
