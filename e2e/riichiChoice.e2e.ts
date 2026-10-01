/* 리치 선언 (휴대폰): 리치 가능한 패를 누르면 브라우저 확인 창 없이 행동 막대에서 리치 / 그냥 버리기 / 다른 패 고르기를 고른다.
 * 모바일 브라우저(앱 안 브라우저, 전체 화면 등)는 window.confirm을 막고 바로 "취소"로 돌려주는 경우가 있어, 예전에는 리치를
 * 선언할 방법이 없었다. 여기서는 확인 창이 뜨면 기록해 두고(뜨면 실패), 고정 패로 첫 버림에서 리치가 되는 대국을 쓴다. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createGuiServer, type GuiServerHandle } from "../src/gui/createGuiServer.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { J0, RonFixture, W } from "../tests/helpers/ronFixture.js";

let handle: GuiServerHandle;
let game: RonFixture;
let browser: Browser;
let phone: BrowserContext;
let page: Page;
let errors: string[];
let dialogs: string[];

beforeEach(async () => {
  // 좌석 0(사람)은 텐파이 직전 손패이고 첫 쯔모 z6를 버리면 p5/p8 대기로 리치할 수 있다
  game = new RonFixture({ rules: DEFAULT_SANMA_RULES, seed: "riichi-choice", controllers: ["human", "simpleAI", "simpleAI"] }, { hands: [W, J0, J0], draws: ["z6"] });
  handle = createGuiServer(game, { frameDelayMs: 0 });
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  handle.server.keepAliveTimeout = 0;
  browser = await chromium.launch();
  phone = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  page = await phone.newPage();
  errors = [];
  dialogs = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss(); // 막힌 확인 창처럼 바로 "취소"
  });
  await page.goto(`http://localhost:${(handle.server.address() as AddressInfo).port}/`);
});

afterEach(async () => {
  await browser.close();
  handle.server.closeAllConnections();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  expect(errors).toEqual([]);
  expect(dialogs).toEqual([]);
});

const bar = () => page.locator("#action-bar");

describe("리치 선언 (휴대폰)", () => {
  it("리치 가능한 패를 누르면 행동 막대에서 고른다: 다른 패 고르기 → 다시 눌러 리치", async () => {
    const riichiTile = page.locator("#zone-bottom .hand img.clickable.riichi-legal").first();
    await riichiTile.waitFor();

    // 누르면 바로 버리지 않고 묻는다. 고르는 패는 들려 있고, 리치하면 기다릴 패가 보인다
    await riichiTile.tap();
    await bar().getByText("버리면서 리치할까요?").waitFor();
    expect(await page.locator("#zone-bottom .hand img.riichi-pending").count()).toBe(1);
    expect(await page.locator("#zone-bottom .waits").textContent()).toContain("리치하면 대기");
    expect(await bar().locator("button").allTextContents()).toEqual(["리치", "그냥 버리기", "다른 패 고르기"]);
    expect(game.log.some((e) => e.type === "discard")).toBe(false);

    // 다른 패 고르기: 처음 안내로 돌아가고, 들린 패도 내려온다
    await bar().locator("button", { hasText: "다른 패 고르기" }).tap();
    await bar().getByText("버릴 패를 클릭하세요").waitFor();
    expect(await page.locator("#zone-bottom .hand img.riichi-pending").count()).toBe(0);

    // 다시 눌러 리치
    await riichiTile.tap();
    await bar().locator("button", { hasText: /^리치$/ }).tap();
    await expect.poll(() => game.log.some((e) => e.type === "riichi" && e.player === 0), { timeout: 15_000 }).toBe(true);
  }, 120_000);
});
