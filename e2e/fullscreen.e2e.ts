/* 휴대폰 주소창 문제: 전체 화면 버튼/자동 전체 화면과, 홈 화면에 추가할 때 주소창 없이 열리게 하는 manifest(입장 전에도 열린다). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { createGuiLobbyServer, type GuiLobbyServerHandle } from "../src/gui/createGuiServer.js";
import { AccessGate } from "../src/gui/accessGate.js";

let handle: GuiLobbyServerHandle;
let browser: Browser;
let dir: string;
let base: string;
let errors: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gui-fs-"));
  handle = createGuiLobbyServer({ frameDelayMs: 0, replayDir: join(dir, "replays"), customAiDir: join(dir, "custom-ai") });
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  handle.server.keepAliveTimeout = 0;
  base = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  errors = [];
});

afterEach(async () => {
  await browser.close();
  handle.server.closeAllConnections();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

async function phone(): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/`);
  return page;
}

describe("전체 화면 (휴대폰 주소창)", () => {
  it("로비의 전체 화면 버튼으로 전체 화면이 되고, 대국을 시작하면 자동으로 전체 화면이 되며, 메뉴의 전체 화면 버튼으로 끌 수 있다", async () => {
    const page = await phone();
    const lobbyButton = page.locator(".learn-actions button", { hasText: "전체 화면" });
    await lobbyButton.waitFor();
    await lobbyButton.tap();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);

    // 터치 화면은 "대국 시작 시 전체 화면"이 기본 켜짐: 대국을 시작하면 전체 화면
    await page.locator("section:has(> h2:text-is('대국 방식')) button.setup-seat", { hasText: "4마" }).tap();
    await page.locator(".setup-side .setup-start").tap();
    await page.locator("#zone-bottom .hand img").first().waitFor({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);

    // 메뉴의 버튼: 전체 화면 끄기 -> 켜기
    await page.locator(".controls-toggle").tap();
    const toggle = page.locator("#audio-controls .fullscreen-toggle");
    expect(await toggle.textContent()).toBe("전체 화면 끄기");
    await toggle.tap();
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await expect.poll(() => toggle.textContent()).toBe("전체 화면"); // (fullscreenchange 이벤트가 글자를 바꾼다)
  }, 90_000);

  it("옵션을 끄면 대국을 시작해도 전체 화면이 되지 않는다", async () => {
    const page = await phone();
    await page.evaluate(() => localStorage.setItem("seongah.playOptions", JSON.stringify({ autoFullscreen: false })));
    await page.reload();
    await page.locator("section:has(> h2:text-is('대국 방식')) button.setup-seat", { hasText: "4마" }).tap();
    await page.locator(".setup-side .setup-start").tap();
    await page.locator("#zone-bottom .hand img").first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  }, 60_000);

  it("manifest(전체 화면 앱)와 아이콘은 입장 게이트가 있어도 로그인 전에 열린다", async () => {
    const gateDir = mkdtempSync(join(tmpdir(), "gui-fs-gate-"));
    const gated = createGuiLobbyServer({ frameDelayMs: 0, access: new AccessGate({ dataDir: gateDir }), userDataDir: join(gateDir, "users") });
    try {
      await new Promise<void>((resolve) => gated.server.listen(0, resolve));
      gated.server.keepAliveTimeout = 0;
      const url = `http://localhost:${(gated.server.address() as AddressInfo).port}`;
      const manifest = await fetch(`${url}/manifest.webmanifest`);
      expect(manifest.status).toBe(200);
      expect(manifest.headers.get("content-type")).toContain("manifest+json");
      const json = (await manifest.json()) as { display: string; orientation: string; icons: { src: string }[] };
      expect(json).toMatchObject({ display: "fullscreen", orientation: "landscape" });
      for (const icon of json.icons) {
        const res = await fetch(`${url}${icon.src}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
      }
      expect((await fetch(`${url}/app.js`, { redirect: "manual" })).status).not.toBe(200); // 앱 본체는 그대로 입장 뒤에만
    } finally {
      gated.server.closeAllConnections();
      await new Promise<void>((resolve) => gated.server.close(() => resolve()));
      rmSync(gateDir, { recursive: true, force: true });
    }
  }, 60_000);
});
