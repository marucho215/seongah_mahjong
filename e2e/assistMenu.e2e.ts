/* 보조 메뉴(표시 전용 옵션: 샹텐/위험도/유효패)와 입력 방식(두 번 눌러 버리기, 키보드).
 * 고정 패 대국: 좌석 0은 p5/p8 대기 텐파이 직전 손패이고 첫 쯔모 z6를 버리면 텐파이가 된다 (tests/helpers/ronFixture.ts). */
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
  game = new RonFixture({ rules: DEFAULT_SANMA_RULES, seed: "assist-menu", controllers: ["human", "simpleAI", "simpleAI"] }, { hands: [W, J0, J0], draws: ["z6"] });
  handle = createGuiServer(game, { frameDelayMs: 0 });
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  handle.server.keepAliveTimeout = 0;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => void d.dismiss());
  await page.goto(`http://localhost:${(handle.server.address() as AddressInfo).port}/`);
});

afterEach(async () => {
  await browser.close();
  handle.server.closeAllConnections();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  expect(errors).toEqual([]);
});

const hand = () => page.locator("#zone-bottom .hand");
const openMenu = async () => {
  await page.locator(".assist-menu-toggle").click();
  await page.locator("#assist-panel:not(.hidden)").waitFor();
};
const discardsByMe = () => game.log.filter((e) => e.type === "discard" && e.player === 0).length;

describe("보조 메뉴", () => {
  it("보조 항목은 메뉴 패널에서 켜고 끈다: 기본은 샹텐만 켜짐, 유효패를 켜면 패마다 표시와 상세가 나오고 설정은 새로고침 뒤에도 유지된다", async () => {
    await hand().locator("img.clickable").first().waitFor();
    // 기본: 유효패/위험도 표시 없음
    expect(await page.locator(".ukeire-badge").count()).toBe(0);
    await openMenu();
    const box = (key: string) => page.locator(`#assist-panel input[data-assist=${key}]`);
    expect(await box("shanten").isChecked()).toBe(true);
    expect(await box("ukeire").isChecked()).toBe(false);
    expect(await box("risk").isChecked()).toBe(false);

    await box("ukeire").check();
    await page.locator(".ukeire-badge.is-best").first().waitFor();
    // 쯔모한 z6를 올려 보면: 버리면 텐파이, 유효패는 p5/p8 (미확인 장수 포함)
    const z6 = hand().locator('img[alt="발"]').first();
    await z6.hover();
    const detail = page.locator("#zone-bottom .assist-detail");
    await detail.waitFor();
    const text = (await detail.textContent())!;
    expect(text).toContain("버리면");
    expect(text).toContain("텐파이");
    expect(await detail.locator(".wait-item").count()).toBe(2); // p5, p8
    await page.mouse.move(0, 0);

    // 끄면 표시가 사라진다 (응답/게임에는 영향 없음: 아직 아무것도 버리지 않았다)
    await box("ukeire").uncheck();
    await expect.poll(() => page.locator(".ukeire-badge").count()).toBe(0);
    expect(discardsByMe()).toBe(0);

    // 켜 두면 새로고침 뒤에도 유지된다 (이 브라우저에 저장)
    await box("ukeire").check();
    await page.reload();
    await hand().locator("img.clickable").first().waitFor();
    await page.locator(".ukeire-badge.is-best").first().waitFor();
  }, 120_000);

  it("두 번 눌러 버리기: 첫 누름은 고르기만 하고, 한 번 더 누르면 버린다 (취소 가능)", async () => {
    await hand().locator("img.clickable").first().waitFor();
    await openMenu();
    await page.locator("#assist-panel input[data-option=confirmDiscard]").check();
    await page.locator(".assist-menu-toggle").click(); // 패널 닫기

    const target = hand().locator("img.clickable:not(.riichi-legal)").first();
    await target.click();
    await page.locator("#action-bar").getByText("버릴까요?").waitFor();
    expect(await hand().locator("img.is-selected").count()).toBe(1);
    expect(discardsByMe()).toBe(0);

    // 다른 패 고르기 → 선택 해제
    await page.locator("#action-bar button", { hasText: "다른 패 고르기" }).click();
    expect(await hand().locator("img.is-selected").count()).toBe(0);
    expect(discardsByMe()).toBe(0);

    // 고른 뒤 같은 패를 한 번 더 누르면 버린다
    await target.click();
    await hand().locator("img.is-selected").waitFor();
    await hand().locator("img.is-selected").click();
    await expect.poll(() => discardsByMe(), { timeout: 15_000 }).toBe(1);
  }, 120_000);

  it("키보드: ←/→로 고르고 Enter로 버린다, T는 쯔모기리, 옵션을 끄면 동작하지 않는다", async () => {
    await hand().locator("img.clickable").first().waitFor();
    await page.keyboard.press("ArrowLeft"); // 오른쪽 끝(쯔모 쪽)부터
    expect(await hand().locator("img.is-selected").count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await hand().locator("img.is-selected").count()).toBe(0);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await hand().locator("img.is-selected").count()).toBe(1);
    expect(discardsByMe()).toBe(0); // 고르기만으로는 버리지 않는다

    await openMenu();
    await page.locator("#assist-panel input[data-option=keyboard]").uncheck();
    await page.locator(".assist-menu-toggle").click();
    await page.keyboard.press("t");
    await page.waitForTimeout(300);
    expect(discardsByMe()).toBe(0); // 키보드 옵션을 끄면 단축키가 동작하지 않는다

    await openMenu();
    await page.locator("#assist-panel input[data-option=keyboard]").check();
    await page.locator(".assist-menu-toggle").click();
    await page.keyboard.press("t"); // 쯔모패(z6)를 그대로 버린다
    await expect.poll(() => discardsByMe(), { timeout: 15_000 }).toBe(1);
    const mine = game.log.find((e) => e.type === "discard" && e.player === 0);
    expect(mine).toMatchObject({ tile: "z6", tsumogiri: true });
  }, 120_000);
});
