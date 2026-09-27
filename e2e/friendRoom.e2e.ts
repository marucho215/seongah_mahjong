/* 친선전 방 스모크 (A단계): 공개 모드 서버에 브라우저 두 개(쿠키가 따로)로 들어가, 방장이 방을 만들고 손님이 코드로 들어오고,
 * 방장이 AI를 앉히고 손님을 내보낸 뒤 방장 + AI로 대국을 시작한다. 규칙 자체는 tests/friendRooms*.test.ts가 다룬다. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { ONLINE_LIMITS, createGuiLobbyServer, type GuiLobbyServerHandle } from "../src/gui/createGuiServer.js";
import { AccessGate } from "../src/gui/accessGate.js";

let handle: GuiLobbyServerHandle;
let browser: Browser;
let dir: string;
let baseUrl: string;
let errors: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "friend-e2e-"));
  handle = createGuiLobbyServer({ frameDelayMs: 0, access: new AccessGate({ dataDir: dir }), userDataDir: join(dir, "users"), limits: ONLINE_LIMITS });
  handle.server.keepAliveTimeout = 0;
  await new Promise<void>((r) => handle.server.listen(0, r));
  baseUrl = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  errors = [];
});

afterEach(async () => {
  await browser.close();
  handle.server.closeAllConnections();
  await new Promise<void>((r) => handle.server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

async function enterAs(nickname: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${nickname}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${baseUrl}/`);
  await page.waitForURL(`${baseUrl}/join.html`);
  await page.fill("input[name=nickname]", nickname);
  await page.click(".setup-start");
  await page.waitForURL(`${baseUrl}/`);
  await page.locator(".setup-nickname", { hasText: nickname }).waitFor();
  return page;
}

const seatRow = (page: Page, seat: string) => page.locator(".setup-seats li", { has: page.locator(".seat-where", { hasText: seat }) });

describe("친선전 방 스모크", () => {
  it("방장이 방을 만들고 손님이 코드로 들어온다 → AI 배정, 내보내기 → 방장 + AI로 시작", async () => {
    const host = await enterAs("방장");
    const guest = await enterAs("손님");

    // 허브의 친선전: 3인, 시간 60+0으로 방 만들기
    await host.locator("section:has(> h2:text-is('친선전')) select").first().selectOption("sanma");
    await host.locator("section:has(> h2:text-is('친선전')) select").nth(1).selectOption("60+0");
    await host.locator(".friend-create").click();
    await host.locator(".friend-code-value").waitFor();
    const code = (await host.locator(".friend-code-value").textContent())!.trim();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(await host.getByText("시간 제한 60+0초").count()).toBe(1);

    // 손님이 코드로 들어온다 (소문자로 입력해도 된다)
    await guest.locator(".friend-code-input").fill(code.toLowerCase());
    await guest.locator(".friend-join").click();
    await guest.locator(".friend-code-value", { hasText: code }).waitFor();
    await seatRow(host, "남가").locator(".seat-name", { hasText: "손님" }).waitFor();
    expect(await guest.locator(".setup-start", { hasText: "대국 시작" }).count()).toBe(0); // 손님에게는 시작 버튼이 없다

    // 방장: 서가 좌석을 골라 AI를 앉힌다
    await seatRow(host, "서가").locator("button.setup-seat").click();
    await host.locator(".character-card", { hasText: "제갈 미나" }).click();
    await seatRow(guest, "서가").locator(".seat-name", { hasText: "제갈 미나" }).waitFor();
    await host.locator(".setup-lead", { hasText: "사람 2명 이상" }).waitFor();
    expect(await host.locator(".setup-start", { hasText: "대국 시작" }).isDisabled()).toBe(true);

    // 손님을 내보내면 손님 화면은 로비로 돌아가 안내를 본다
    await seatRow(host, "남가").locator(".setup-link-button", { hasText: "내보내기" }).click();
    await guest.locator(".setup-notice", { hasText: "방에서 나왔습니다" }).waitFor();
    expect(await guest.locator(".friend-code-value").count()).toBe(0);

    // 빈자리에 AI를 앉히고 시작한다
    await seatRow(host, "남가").locator("button.setup-seat").click();
    await host.locator(".character-card", { hasText: "제갈 나희" }).click();
    await host.locator(".setup-start:not([disabled])", { hasText: "대국 시작" }).click();
    await host.locator("#zone-bottom .hand img").first().waitFor();
    expect(await host.locator("#table").getAttribute("data-players")).toBe("3");
  }, 120_000);
});
