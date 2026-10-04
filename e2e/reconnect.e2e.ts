/* 연결이 끊겼다가 다시 연결될 때: 안내를 띄우고, 다시 연결되면 서버의 현재 요청을 그대로 이어 받으며 "최근 행동" 목록도 채운다
 * (장면은 다시 재생하지 않는다). 서버가 연결을 모두 끊는 것으로 네트워크 끊김을 흉내 낸다. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { createGuiServer, type GuiServerHandle } from "../src/gui/createGuiServer.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { J0, RonFixture, W } from "../tests/helpers/ronFixture.js";

let handle: GuiServerHandle;
let game: RonFixture;
let browser: Browser;
let page: Page;
let errors: string[];

beforeEach(async () => {
  game = new RonFixture({ rules: DEFAULT_SANMA_RULES, seed: "reconnect", controllers: ["human", "simpleAI", "simpleAI"] }, { hands: [W, J0, J0], draws: ["z6"] });
  handle = createGuiServer(game, { frameDelayMs: 0 });
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  handle.server.keepAliveTimeout = 0;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${(handle.server.address() as AddressInfo).port}/`);
  await page.locator("#zone-bottom .hand img.clickable").first().waitFor();
});

afterEach(async () => {
  await browser.close();
  handle.server.closeAllConnections();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  expect(errors).toEqual([]);
});

describe("연결 복구", () => {
  it("연결이 끊기면 안내가 뜨고, 다시 연결되면 안내가 사라지며 같은 요청을 이어 받고 최근 행동이 채워진다", async () => {
    await page.keyboard.press("t"); // 내가 한 장 버리면 AI 둘이 차례로 둔 뒤 내 다음 타패 요청이 온다
    await expect.poll(() => game.log.filter((e) => e.type === "discard").length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    await page.locator("#action-bar").getByText("버릴 패를", { exact: false }).waitFor();
    const before = handle.session.getCurrentRequest();
    expect(before?.type).toBe("discard");

    handle.server.closeAllConnections();
    await page.locator("#conn-banner:not(.hidden)").waitFor({ timeout: 10_000 });
    await page.locator("#conn-banner.hidden").waitFor({ state: "attached", timeout: 15_000 }); // 자동으로 다시 연결된다

    // 같은 요청을 다시 받아 이어 둔다: 서버의 요청은 그대로이고, 화면은 계속 버릴 패를 기다린다
    expect(handle.session.getCurrentRequest()).toBe(before);
    await page.locator("#zone-bottom .hand img.clickable").first().waitFor();
    // 최근 행동 목록: 끊긴 사이에 지나간 AI의 타패가 보인다 (장면은 다시 재생하지 않는다)
    await page.locator("#recent-feed:not(.hidden) .feed-item").first().waitFor();
    expect(await page.locator("#recent-feed .feed-item").allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("타패")]));

    // 다시 연결된 뒤에도 정상 진행: 한 장 버리면 요청이 넘어간다
    await page.keyboard.press("t");
    await expect.poll(() => handle.session.getCurrentRequest() !== before, { timeout: 15_000 }).toBe(true);
  }, 90_000);
});
