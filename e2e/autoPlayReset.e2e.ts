/* 자동 옵션(자동 쯔모기리 / 울기 패스 / 자동 화료)은 한 국에서만 유효하다: 국이 끝나면 꺼져서, 다음 국의 타패와 울기를 막지 않는다.
 * (예전에는 켜 둔 옵션이 다음 국, 다음 대국까지 이어져 필요한 울기/타패를 대신 넘겨 버렸다.) */
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
  dir = mkdtempSync(join(tmpdir(), "gui-auto-"));
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

const toggles = () => page.locator("#audio-controls .auto-toggle[data-auto]");
const pressed = async () => (await toggles().evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed"))));

describe("자동 옵션은 국이 끝나면 꺼진다", () => {
  it("국이 끝나면 세 옵션이 모두 꺼지고 안내가 뜨며, 다음 국의 타패를 자동으로 버리지 않는다", async () => {
    await page.locator("section:has(> h2:text-is('대국 방식')) button.setup-seat", { hasText: "4마" }).click();
    await page.locator(".setup-side .setup-start").click();
    await page.locator("#zone-bottom .hand img.clickable").first().waitFor();

    await page.locator(".speed-select").selectOption("instant");
    // 세 옵션을 한 번에 켠다 (즉시 속도라 국이 금방 끝나므로 켜는 동작 사이에 국이 끝나지 않게 한 틱에 누른다)
    await toggles().evaluateAll((els) => els.forEach((e) => (e as HTMLButtonElement).click()));

    // 켜 둔 자동 옵션만으로 이 국이 끝까지 진행된다 (사람은 아무것도 누르지 않는다)
    await page.locator("#hand-end-overlay:not(.hidden)").waitFor({ timeout: 90_000 });
    const session = handle.getSession()!;
    expect(await pressed()).toEqual(["false", "false", "false"]);
    const toast = await page.locator("#toast").textContent();
    expect(toast).toContain("국이 끝나 자동 옵션을 껐습니다");
    for (const label of ["자동 쯔모기리", "울기 자동 패스", "자동 화료"]) expect(toast).toContain(label);
    expect(await toggles().evaluateAll((els) => els.filter((e) => e.classList.contains("is-on")).length)).toBe(0);

    expect(["hand_end", "game_end"]).toContain(session.getPhase());
    if (session.getPhase() === "hand_end") {
      await page.locator("#hand-end-overlay .continue-button").last().click();
      // 다음 국의 첫 사람 요청 (친이 아니면 퐁/치 제안이 먼저 올 수도 있다)이 사람의 선택을 기다린다.
      // 자동 옵션이 남아 있었다면 울기 패스/자동 쯔모기리가 곧바로 그 요청에 답해 요청이 바뀌었을 것이다.
      await expect.poll(() => session.getPhase() === "decision" && session.getCurrentRequest() !== null, { timeout: 30_000 }).toBe(true);
      const pending = session.getCurrentRequest();
      await page.waitForTimeout(1000);
      expect(session.getCurrentRequest()).toBe(pending);
      expect(await pressed()).toEqual(["false", "false", "false"]);
    }
  }, 120_000);

  it("대국을 그만두고 새 대국을 시작하면 켜 둔 자동 옵션이 모두 꺼져 있다", async () => {
    page.on("dialog", (d) => d.accept()); // 대국 그만두기 확인 창
    await page.locator("section:has(> h2:text-is('대국 방식')) button.setup-seat", { hasText: "4마" }).click();
    await page.locator(".setup-side .setup-start").click();
    await page.locator("#zone-bottom .hand img.clickable").first().waitFor();
    await toggles().evaluateAll((els) => els.forEach((e) => (e as HTMLButtonElement).click()));
    expect(await pressed()).toEqual(["true", "true", "true"]);

    await page.locator(".abandon-button").click();
    await page.getByText("대국 방식 바꾸기").waitFor();
    await page.locator(".setup-side .setup-start").click();
    await page.locator("#zone-bottom .hand img.clickable").first().waitFor();
    expect(await pressed()).toEqual(["false", "false", "false"]);
    // 새 대국의 첫 타패 요청도 사람의 선택을 기다린다 (자동 옵션이 남아 있었다면 AI 턴이 지나도 계속 자동으로 진행됐을 것)
    await page.waitForTimeout(1500);
    expect(handle.getSession()!.getCurrentRequest()!.type).toBe("discard");
  }, 120_000);
});
