/* 규칙 옵션: 로비 "규칙"에서 동풍전/동남전, 적도라, 쿠이탕 등을 고르면 그 규칙으로 시작하고, 대국 화면 가운데에 기본과 다른 규칙이 작게 보인다. */
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
  dir = mkdtempSync(join(tmpdir(), "gui-rules-"));
  handle = createGuiLobbyServer({ frameDelayMs: 0, replayDir: join(dir, "replays"), customAiDir: join(dir, "custom-ai") });
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  handle.server.keepAliveTimeout = 0;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
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
const rules = () => page.locator("details.rule-options");

describe("규칙 옵션", () => {
  it("4마: 규칙을 바꿔 시작하면 대국 화면에 기본과 다른 규칙이 보이고, 설정은 다음 설정 화면에 기억된다", async () => {
    await modeRow("4마").click();
    await rules().waitFor();
    expect(await rules().locator("summary").textContent()).toContain("기본 규칙");
    await rules().locator("summary").click();
    // 4마에는 쿠이카에 항목이 있다
    expect(await rules().locator(".rule-label").allTextContents()).toContain("쿠이카에 금지");

    await rules().locator("select").first().selectOption("east-south"); // 대국 길이
    await rules().locator("label", { hasText: "적도라" }).locator("select").selectOption("none");
    await rules().locator("label", { hasText: "쿠이탕" }).locator("input").uncheck();
    expect(await rules().locator("summary").textContent()).toContain("3개 변경");

    await page.locator(".setup-side .setup-start").click();
    await page.locator("#zone-bottom .hand img.clickable").first().waitFor({ timeout: 30_000 });
    expect(await page.locator("#center-info .rule-chips").textContent()).toBe("동남전 · 적도라 없음 · 쿠이탕 없음");
    // 적도라 없음: 내 손패에 빨간 5(적도라 그림)가 없다
    expect(await page.locator('#zone-bottom .hand img[src*="Dora"]').count()).toBe(0);

    page.once("dialog", (d) => void d.accept());
    await page.locator(".abandon-button").click();
    await page.getByText("대국 방식 바꾸기").waitFor();
    expect(await rules().locator("summary").textContent()).toContain("3개 변경");
    await rules().locator("button", { hasText: "기본 규칙으로" }).click();
    expect(await rules().locator("summary").textContent()).toContain("기본 규칙");
  }, 90_000);

  it("산마에는 쿠이카에 항목이 없고, 기본 규칙으로 시작하면 규칙 표시가 없다", async () => {
    await modeRow("산마").click();
    await rules().waitFor();
    await rules().locator("summary").click();
    expect(await rules().locator(".rule-label").allTextContents()).not.toContain("쿠이카에 금지");
    await page.locator(".setup-side .setup-start").click();
    await page.locator("#zone-bottom .hand img").first().waitFor({ timeout: 30_000 }); // (첫 요청이 북빼기 등이면 아직 클릭할 수 있는 패가 없다)
    expect(await page.locator("#center-info .rule-chips").count()).toBe(0);
  }, 60_000);
});
