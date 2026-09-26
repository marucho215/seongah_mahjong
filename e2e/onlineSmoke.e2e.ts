/* 온라인 스모크 테스트 (1.2 7단계): 초대 코드 서버에 두 사람이 서로 다른 브라우저(쿠키가 따로인 컨텍스트)로 동시에 접속해
 * 각자 입장하고 각자 대국을 시작해도 화면이 섞이지 않는지 본다. 서버는 실제 온라인 구성(입장 게이트, 엔진 worker 풀,
 * 자원 제한)과 같게 띄운다. 대국 진행 자체는 단위 테스트가 다룬다. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ONLINE_LIMITS, createGuiLobbyServer, type GuiLobbyServerHandle } from "../src/gui/createGuiServer.js";
import { AccessGate } from "../src/gui/accessGate.js";
import { EngineWorkerPool } from "../src/gui/engineWorkerPool.js";

const INVITE = "smoke-invite";
let pool: EngineWorkerPool;
let handle: GuiLobbyServerHandle;
let browser: Browser;
let dir: string;
let baseUrl: string;
let errors: string[];
const contexts: BrowserContext[] = [];

beforeAll(() => {
  pool = new EngineWorkerPool(2);
});
afterAll(async () => {
  await pool.close();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "online-smoke-"));
  handle = createGuiLobbyServer({
    frameDelayMs: 0,
    access: new AccessGate({ inviteCode: INVITE, dataDir: dir }),
    userDataDir: join(dir, "users"),
    limits: ONLINE_LIMITS,
    engine: pool,
  });
  handle.server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  baseUrl = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  errors = [];
});

afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
  await browser.close();
  handle.server.closeAllConnections();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

/** 새 브라우저(쿠키가 따로인 컨텍스트)로 접속해 입장한다. */
async function enterAs(nickname: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${nickname}: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(`${baseUrl}/`);
  await page.waitForURL(`${baseUrl}/join.html`);
  await page.fill("input[name=inviteCode]", INVITE);
  await page.fill("input[name=nickname]", nickname);
  await page.click(".setup-start");
  await page.waitForURL(`${baseUrl}/`);
  await page.locator(".setup-nickname", { hasText: nickname }).waitFor();
  return page;
}

const modeRow = (page: Page, name: string) => page.locator(".setup-seats button.setup-seat", { hasText: name });

async function startMode(page: Page, name: string): Promise<void> {
  await modeRow(page, name).click();
  await page.getByText("대국 방식 바꾸기").waitFor();
  await page.locator(".setup-side .setup-start").click();
  await page.locator("#zone-bottom .hand img").first().waitFor();
}

describe("온라인 스모크 (두 사용자 동시 접속)", () => {
  it("입장하지 않은 브라우저는 입장 화면으로 가고, 틀린 초대 코드는 거절된다", async () => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/replay.html`);
    await page.waitForURL(`${baseUrl}/join.html`);
    await page.fill("input[name=inviteCode]", "wrong");
    await page.fill("input[name=nickname]", "누군가");
    await page.click(".setup-start");
    await page.locator(".setup-error", { hasText: "초대 코드가 맞지 않습니다" }).waitFor();
    expect(page.url()).toBe(`${baseUrl}/join.html`);
  });

  it("두 사람이 각자 입장해 각자 대국을 두고, 한 사람이 그만둬도 다른 사람의 대국은 그대로다", async () => {
    const a = await enterAs("에이");
    const b = await enterAs("비");

    // 한 사람이 로비를 옮겨도 다른 사람의 로비는 허브 그대로다
    await modeRow(a, "산마").click();
    await a.getByText("대국 방식 바꾸기").waitFor();
    expect(await b.getByText("대국 방식 바꾸기").count()).toBe(0);

    await a.locator(".setup-side .setup-start").click();
    await a.locator("#zone-bottom .hand img").first().waitFor();
    await startMode(b, "4마");
    expect(await a.locator("#table").getAttribute("data-players")).toBe("3");
    expect(await b.locator("#table").getAttribute("data-players")).toBe("4");
    // worker에서 도는 대국이라 서버 스레드에는 세션이 없다
    expect(handle.getSession()).toBeNull();
    expect(pool.load).toBe(2);

    const bHandBefore = await b.locator("#zone-bottom .hand img").count();
    await a.locator(".abandon-button").click();
    await a.getByText("대국 방식 바꾸기").waitFor();
    expect(pool.load).toBe(1);

    // B는 여전히 대국 중이고, 새로고침해도 자기 대국으로 돌아온다
    expect(await b.locator("#setup-screen").isHidden()).toBe(true);
    await b.reload();
    await b.locator("#zone-bottom .hand img").first().waitFor();
    expect(await b.locator("#table").getAttribute("data-players")).toBe("4");
    expect(await b.locator("#zone-bottom .hand img").count()).toBe(bHandBefore);

    // A의 새로고침은 A의 로비(산마 설정)다
    await a.reload();
    await a.getByText("대국 방식 바꾸기").waitFor();
    expect(await a.locator(".setup-seats div.setup-seat .seat-name").textContent()).toBe("산마");
  });
});
