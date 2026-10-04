/* 론/울기 선택 버튼: Enter(하기)/Esc·N(넘기기) 단축키, 론을 넘기면 후리텐이 되므로 넘기기는 한 번 더 눌러야 확정된다.
 * 고정 패 대국: 좌석 0은 p2/p5 대기 텐파이 직전 손패, 좌석 1은 리치하며 p2를 버린다. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { createGuiServer, type GuiServerHandle } from "../src/gui/createGuiServer.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { J0, RonFixture } from "../tests/helpers/ronFixture.js";
import type { TileKind } from "../src/core/tiles.js";

// 좌석 0: p2/p5 대기 텐파이 직전 손패 (첫 쯔모 z6을 버린다). 좌석 1: s8/p7 샤보 텐파이로, 쯔모한 p5 대신 p2를 버리며 리치한다
// (AI의 선택이라 AI 판단이 바뀌면 이 시나리오의 전제가 깨진다 - 그때는 "론 요청이 뜬다"는 사전 확인이 먼저 실패한다)
const WAIT_P2_P5: TileKind[] = ["p3", "p4", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s8", "p6", "p7", "p8"];
const SHANPON_TENPAI: TileKind[] = ["p2", "p3", "p4", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s8", "p7", "p7"];

let handle: GuiServerHandle;
let game: RonFixture;
let browser: Browser;
let page: Page;
let errors: string[];

beforeEach(async () => {
  game = new RonFixture({ rules: DEFAULT_SANMA_RULES, seed: "call-buttons", controllers: ["human", "simpleAI", "simpleAI"] }, { hands: [WAIT_P2_P5, SHANPON_TENPAI, J0], draws: ["z6", "p5"] });
  handle = createGuiServer(game, { frameDelayMs: 0 });
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  handle.server.keepAliveTimeout = 0;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${(handle.server.address() as AddressInfo).port}/`);
  // 첫 타패: 쯔모한 z6를 버린다 (T 단축키)
  await page.locator("#zone-bottom .hand img.clickable").first().waitFor();
  await page.keyboard.press("t");
  await page.locator("#action-bar button[data-key=accept]").waitFor({ timeout: 20_000 }); // 론 요청
});

afterEach(async () => {
  await browser.close();
  handle.server.closeAllConnections();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  expect(errors).toEqual([]);
});

const winEvents = () => game.log.filter((e) => e.type === "win");

describe("론 선택 버튼", () => {
  it("Enter로 론한다", async () => {
    await page.locator("#action-bar").getByText("론 가능!", { exact: false }).waitFor();
    await page.keyboard.press("Enter");
    await expect.poll(() => winEvents().length, { timeout: 15_000 }).toBe(1);
  }, 60_000);

  it("패스(Esc)는 후리텐이 되므로 한 번 더 눌러야 넘어간다: 첫 번째는 확인으로 바뀌기만 한다", async () => {
    const pass = page.locator("#action-bar button[data-key=decline]");
    await page.keyboard.press("Escape");
    await expect.poll(() => pass.textContent()).toMatch(/후리텐이 됩니다/);
    await page.waitForTimeout(300);
    expect(winEvents().length).toBe(0);
    expect(handle.session.getCurrentRequest()!.type).toBe("ron"); // 아직 응답하지 않았다

    // 마우스로 다시 누르면 넘어간다 (론 없이 다음 상태로)
    await pass.click();
    await expect.poll(() => handle.session.getCurrentRequest()?.type !== "ron", { timeout: 15_000 }).toBe(true);
    expect(winEvents().length).toBe(0);
  }, 60_000);

  it("확인 상태는 시간이 지나면 원래대로 돌아간다 (오래 둔 뒤의 한 번 누름이 곧바로 넘기지 않는다)", async () => {
    const pass = page.locator("#action-bar button[data-key=decline]");
    await pass.click();
    await expect.poll(() => pass.textContent()).toMatch(/후리텐이 됩니다/);
    await expect.poll(() => pass.textContent(), { timeout: 6_000 }).toBe("패스");
    expect(handle.session.getCurrentRequest()!.type).toBe("ron");
  }, 60_000);
});
