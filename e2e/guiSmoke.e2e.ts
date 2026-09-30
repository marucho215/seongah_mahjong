/* GUI 핵심 흐름 스모크 테스트 (최소 범위): 로비 → 대국 방식 선택 → 설정 → 대국 시작 → 그만두기 / 종료 → 설정 바꾸기,
 * 그리고 로비의 AI끼리 관전 → 리플레이 뷰어 자동 재생.
 * 규칙/AI는 단위 테스트가 다루고, 여기서는 화면 흐름이 끊기지 않는지만 본다. 서버는 테스트 안에서 임시 폴더로 띄운다. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { createGuiLobbyServer, type GuiLobbyServerHandle } from "../src/gui/createGuiServer.js";
import { defaultResponse } from "../tests/helpers/yonmaHuman.js";

let handle: GuiLobbyServerHandle;
let browser: Browser;
let page: Page;
let dir: string;
let errors: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gui-smoke-"));
  handle = createGuiLobbyServer({ frameDelayMs: 0, replayDir: join(dir, "replays"), customAiDir: join(dir, "custom-ai") });
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  handle.server.keepAliveTimeout = 0;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept()); // 대국 그만두기 확인 창
  await page.goto(`http://localhost:${(handle.server.address() as AddressInfo).port}/`);
});

afterEach(async () => {
  await browser.close();
  handle.server.closeAllConnections();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

// 허브에는 사람 대국과 AI 관전에 같은 모드 이름이 두 번 나온다 - 섹션 제목으로 구분한다
const modeRow = (name: string) => page.locator("section:has(> h2:text-is('대국 방식')) button.setup-seat", { hasText: name });
const watchRow = (name: string) => page.locator("section:has(> h2:text-is('AI끼리 관전')) button.setup-seat", { hasText: name });
const seatLabels = () => page.locator("section:has(> h2:text('좌석')) .setup-seat .seat-where").allTextContents();

describe("GUI 스모크", () => {
  it("산마: 로비 → 대국 방식 선택 → 3인 좌석 설정 → 대국 시작 → 대국 그만두기 → 산마 설정", async () => {
    await modeRow("산마").waitFor();
    expect(await page.locator(".setup-side .setup-start").count()).toBe(0); // 대국 방식을 고르기 전에는 시작할 수 없다
    expect(handle.getSession()).toBeNull();

    await modeRow("산마").click();
    await page.getByText("대국 방식 바꾸기").waitFor();
    expect(await seatLabels()).toEqual(["나", "하가", "상가"]);
    expect(handle.getSession()).toBeNull(); // 모드를 골라도 바로 시작하지 않는다

    await page.locator(".setup-side .setup-start").click();
    await page.locator("#zone-bottom .hand img").first().waitFor();
    expect(await page.locator("#table").getAttribute("data-players")).toBe("3");

    await page.locator(".abandon-button").click();
    await page.getByText("대국 방식 바꾸기").waitFor();
    expect(await page.locator(".setup-seats div.setup-seat .seat-name").textContent()).toBe("산마");
    expect(handle.getSession()).toBeNull();
  });

  it("4마: 4인 좌석으로 대국 → 종료 화면(새로고침 포함) → 설정 바꾸기 → 4마 설정 → 대국 방식 바꾸기", async () => {
    await modeRow("4마").click();
    await page.getByText("대국 방식 바꾸기").waitFor();
    expect(await seatLabels()).toEqual(["나", "하가", "대면", "상가"]);

    await page.locator(".setup-side .setup-start").click();
    await page.locator("#zone-bottom .hand img").first().waitFor();
    expect(await page.locator("#table").getAttribute("data-players")).toBe("4");

    // 대국 진행 자체는 단위 테스트가 다루므로 세션에 직접 응답해 끝낸다
    const session = handle.getSession()!;
    for (let steps = 0; session.getPhase() !== "game_end"; steps++) {
      if (steps > 200000) throw new Error("game did not finish");
      if (session.getPhase() === "hand_end") session.continueToNextHand();
      else session.respond(defaultResponse(session.getCurrentRequest()!));
    }
    await page.reload();
    await page.getByText("최종 결과 보기").click();
    expect(await page.locator(".final-standings tbody tr").count()).toBe(4);
    expect(await page.locator(".final-standings thead th").allTextContents()).toEqual(["순위", "이름", "점수"]); // pt 증감은 보이지 않는다
    expect(await page.locator("#zone-bottom .hand img").count()).toBeGreaterThan(0); // 새로고침 뒤에도 작탁이 비지 않는다

    await page.getByText("설정 바꾸기").click();
    await page.getByText("대국 방식 바꾸기").waitFor();
    expect(await page.locator(".setup-seats div.setup-seat .seat-name").textContent()).toBe("4마");
    await page.getByText("대국 방식 바꾸기").click();
    await modeRow("산마").waitFor();
    expect(await modeRow("4마").count()).toBe(1);
  });

  it("AI끼리 관전: 허브 → 산마 관전 설정(3좌석 모두 AI) → 관전 시작 → 리플레이 뷰어 자동 재생", async () => {
    await watchRow("산마").click();
    await page.getByText("관전 시작").waitFor();
    expect(await seatLabels()).toEqual(["동가", "남가", "서가"]);
    expect(await page.locator(".setup-side input[type=checkbox]").count()).toBe(0); // 관전은 항상 저장하므로 저장 옵션이 없다

    // 이 버튼에서는 Playwright의 클릭 전 "스크롤" 단계가 멈추는 경우가 있어(실제 마우스 클릭은 정상), 보이게 스크롤한 뒤 그 자리를
    // 진짜 마우스로 누른다
    const start = page.locator(".setup-side .setup-start");
    await start.evaluate((b) => b.scrollIntoView({ block: "center" }));
    const box = (await start.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForURL(/\/replay\.html\?file=watch-sanma-.*_game0\.json&autoplay=1$/, { timeout: 120_000 });
    await page.locator("#rv-play", { hasText: "정지" }).waitFor({ timeout: 120_000 }); // 재현이 끝나면 스스로 재생을 시작한다
    expect(handle.getSession()).toBeNull(); // 사람 대국 화면(세션)은 쓰지 않는다
  }, 240_000);

  it("휴대폰: 세로 로비는 가로로 넘치지 않고, 대국은 세로면 돌려 달라는 안내, 가로면 조작 막대가 메뉴로 접힌다", async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await phone.newPage();
    mobile.on("pageerror", (e) => errors.push(e.message));
    try {
      await mobile.goto(page.url());
      const overflowX = () => mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const row = mobile.locator("section:has(> h2:text-is('대국 방식')) button.setup-seat", { hasText: "4마" });
      await row.waitFor();
      expect(await overflowX()).toBe(0);
      await row.tap();
      await mobile.getByText("대국 방식 바꾸기").waitFor();
      expect(await overflowX()).toBe(0);

      await mobile.locator(".setup-side .setup-start").tap();
      await mobile.locator("#zone-bottom .hand img").first().waitFor({ state: "attached" });
      await mobile.locator("#rotate-hint").waitFor({ state: "visible" });
      expect(await overflowX()).toBe(0); // 작탁이 넘쳐 페이지가 넓어지지(축소되지) 않는다

      await mobile.setViewportSize({ width: 844, height: 390 });
      await mobile.locator("#rotate-hint").waitFor({ state: "hidden" });
      await mobile.locator("#zone-bottom .hand img").first().waitFor({ state: "visible" });
      expect(await mobile.locator("#audio-controls .speed-select").isVisible()).toBe(false); // 접혀 있다
      await mobile.locator(".controls-toggle").tap();
      await mobile.locator("#audio-controls .speed-select").waitFor({ state: "visible" });
      await mobile.locator("#table").tap({ position: { x: 20, y: 200 } }); // 막대 밖을 누르면 닫힌다
      await mobile.locator("#audio-controls .speed-select").waitFor({ state: "hidden" });
    } finally {
      await phone.close();
    }
  }, 120_000);
});
