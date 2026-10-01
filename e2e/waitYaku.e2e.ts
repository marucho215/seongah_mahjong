/* 역 없음 표시: 울어서 역이 없는 텐파이면 손 상태 줄의 대기패에 "역 없음"이 붙는다 (엔진 계산 HandStatus.tenpaiWaits[].yaku). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { createGuiServer, type GuiServerHandle } from "../src/gui/createGuiServer.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { J0, RonFixture } from "../tests/helpers/ronFixture.js";

let handle: GuiServerHandle;
let browser: Browser;
let page: Page;
let errors: string[];

beforeEach(async () => {
  // 좌석 0(사람): [s9 퐁] + p67 s234 s567 m99 - p5/p8 대기, 역 없음
  const game = new RonFixture(
    { rules: DEFAULT_SANMA_RULES, seed: "wait-yaku-e2e", controllers: ["human", "simpleAI", "simpleAI"] },
    { hands: [["p6", "p7", "s2", "s3", "s4", "s5", "s6", "s7", "m9", "m9"], J0, J0], draws: ["z6"], ponMelds: ["s9"] }
  );
  handle = createGuiServer(game, { frameDelayMs: 0 });
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
  expect(errors).toEqual([]);
});

describe("역 없음 표시", () => {
  it("울어서 역이 없는 텐파이는 대기패마다 역 없음이 붙는다", async () => {
    const waits = page.locator("#zone-bottom .waits");
    await waits.locator(".wait-item").first().waitFor();
    expect(await waits.locator(".wait-item.no-yaku").count()).toBe(2);
    expect(await waits.locator(".wait-yaku").allTextContents()).toEqual(["역 없음", "역 없음"]);
    if (process.env.WAIT_YAKU_SHOT) await page.screenshot({ path: process.env.WAIT_YAKU_SHOT });
  }, 60_000);
});
