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
    // 사람 둘 + AI로 빈자리가 없으면 시작할 수 있다 (B단계)
    await host.locator(".setup-start:not([disabled])", { hasText: "대국 시작" }).waitFor();

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

  it("사람끼리 대국 (B단계): 두 사람이 각자 자기 시점으로 두고, 자기 차례가 아니면 기다린다", async () => {
    const host = await enterAs("방장");
    const guest = await enterAs("손님");
    await host.locator(".friend-create").click();
    const code = (await host.locator(".friend-code-value").textContent())!.trim();
    await guest.locator(".friend-code-input").fill(code);
    await guest.locator(".friend-join").click();
    await seatRow(host, "남가").locator(".seat-name", { hasText: "손님" }).waitFor();
    await seatRow(host, "서가").locator("button.setup-seat").click();
    await host.locator(".character-card", { hasText: "제갈 미나" }).click();
    await host.locator(".setup-start:not([disabled])", { hasText: "대국 시작" }).click();

    // 두 사람 모두 작탁이 열리고, 각자 자기 손패를 본다. 손님에게는 그만두기가 없다
    await host.locator("#zone-bottom .hand img").first().waitFor();
    await guest.locator("#zone-bottom .hand img").first().waitFor();
    expect(await guest.locator(".abandon-button").isVisible()).toBe(false);
    // 첫 차례는 방장(친)이므로 손님은 기다린다. 방장 화면에는 남은 시간(기본 5+20초)이 보이고, 손님에게는 없다
    await guest.locator("#action-bar", { hasText: "방장의 선택을 기다리는 중" }).waitFor();
    await host.locator("#turn-timer", { hasText: /초/ }).waitFor();
    expect(await guest.locator("#turn-timer").isVisible()).toBe(false);

    // 몇 수를 진행한다: 자기 요청이 뜬 사람만 누른다 (버림은 첫 패, 선택 요청은 넘기기, 그 밖의 예/아니오는 아니오)
    for (let moves = 0; moves < 12; ) {
      let acted = false;
      for (const page of [host, guest]) {
        const bar = page.locator("#action-bar");
        const text = (await bar.textContent()) ?? "";
        if (text.includes("버릴 패")) {
          await page.locator("#zone-bottom .hand img.clickable").first().click();
          const plain = bar.locator("button", { hasText: "그냥 버리기" }); // 리치 가능한 패였으면 리치 없이 버린다
          if (await plain.count()) await plain.click();
        } else if (await bar.locator("button", { hasText: "넘기기" }).count()) {
          await bar.locator("button", { hasText: "넘기기" }).click();
        } else if (await bar.locator("button", { hasText: "아니오" }).count()) {
          await bar.locator("button", { hasText: "아니오" }).click();
        } else continue;
        acted = true;
        moves++;
        await page.waitForTimeout(150);
      }
      if (!acted) await host.waitForTimeout(200);
      if ((await host.locator("#hand-end-overlay:not(.hidden)").count()) > 0) break;
    }
  }, 180_000);
});
