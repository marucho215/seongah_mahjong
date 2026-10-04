/* 패보 패널: H(또는 "패보" 버튼)로 열고 닫는다. 모두의 버림패를 버린 순서대로 보여 주며(쯔모기리 표시), 열림 상태는 이 브라우저에 저장된다. */
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
  game = new RonFixture({ rules: DEFAULT_SANMA_RULES, seed: "discard-log", controllers: ["human", "simpleAI", "simpleAI"] }, { hands: [W, J0, J0], draws: ["z6"] });
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

describe("패보", () => {
  it("H로 열고 닫는다: 좌석마다 구역이 있고, 내가 쯔모기리하면 내 구역에 흐린(쯔모기리) 패가 생긴다", async () => {
    expect(await page.locator("#log-panel:not(.hidden)").count()).toBe(0);
    await page.keyboard.press("h");
    await page.locator("#log-panel:not(.hidden)").waitFor();
    expect(await page.locator("#log-panel .log-seat").count()).toBe(3);
    expect(await page.locator("#log-panel .log-seat.is-me .log-empty").count()).toBe(1);
    expect(await page.locator(".log-toggle").getAttribute("aria-pressed")).toBe("true");

    await page.keyboard.press("t"); // 쯔모패 z6을 그대로 버린다
    await page.locator("#log-panel .log-seat.is-me .tile-img.is-tsumogiri").waitFor({ timeout: 15_000 });
    expect(await page.locator("#log-panel .log-seat.is-me .log-count").textContent()).toBe("1장");

    // 새로고침해도 열림 상태가 유지되고, 버튼/H로 닫는다
    await page.reload();
    await page.locator("#log-panel:not(.hidden)").waitFor();
    await page.locator(".log-toggle").click();
    await page.locator("#log-panel.hidden").waitFor({ state: "attached" });
    expect(await page.locator(".log-toggle").getAttribute("aria-pressed")).toBe("false");
  }, 60_000);
});
