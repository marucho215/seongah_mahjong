/* GUI 핵심 흐름 스모크 테스트 (최소 범위): 로비 → 대국 방식 선택 → 설정 → 대국 시작 → 그만두기 / 종료 → 설정 바꾸기.
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

const modeRow = (name: string) => page.locator(".setup-seats button.setup-seat", { hasText: name });
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
    expect(await page.locator("#zone-bottom .hand img").count()).toBeGreaterThan(0); // 새로고침 뒤에도 작탁이 비지 않는다

    await page.getByText("설정 바꾸기").click();
    await page.getByText("대국 방식 바꾸기").waitFor();
    expect(await page.locator(".setup-seats div.setup-seat .seat-name").textContent()).toBe("4마");
    await page.getByText("대국 방식 바꾸기").click();
    await modeRow("산마").waitFor();
    expect(await modeRow("4마").count()).toBe(1);
  });
});
