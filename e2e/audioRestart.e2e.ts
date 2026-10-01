/* 효과음 회귀: 종료 화면의 "같은 설정으로 다시"로 설정 화면을 거치지 않고 새 대국을 열어도 효과음이 난다.
 * (새 대국은 효과음 seq를 1부터 다시 매기는데, 클라이언트 기준점이 이전 대국의 큰 seq에 남아 있으면 모든 신호가 "이미 본 것"으로 버려졌다.)
 * 헤드리스 브라우저는 소리를 낼 수 없으므로 AudioContext를 가짜로 바꿔, 실제로 재생을 시작한 소리 파일을 기록한다. */
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

/** 재생을 시작한 소리의 URL을 window.__played에 쌓는 가짜 AudioContext (소리 파일 내용 = 자기 URL) */
function fakeAudio() {
  const played: string[] = [];
  (window as unknown as { __played: string[] }).__played = played;
  const param = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} });
  class FakeAudioContext {
    state = "running";
    currentTime = 0;
    destination = {};
    createGain() {
      return { gain: param(), connect() {} };
    }
    createBufferSource() {
      const src = { buffer: null as { url: string } | null, connect() {}, stop() {}, start() { if (src.buffer) played.push(src.buffer.url); } };
      return src;
    }
    decodeAudioData(data: ArrayBuffer) {
      return Promise.resolve({ url: new TextDecoder().decode(data) });
    }
    resume() {
      return Promise.resolve();
    }
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "audio-restart-"));
  handle = createGuiLobbyServer({ frameDelayMs: 0, replayDir: join(dir, "replays"), customAiDir: join(dir, "custom-ai") });
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  handle.server.keepAliveTimeout = 0;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(fakeAudio);
  await page.route("**/assets/audio/**", (route) => route.fulfill({ status: 200, body: new URL(route.request().url()).pathname }));
  await page.goto(`http://localhost:${(handle.server.address() as AddressInfo).port}/`);
});

afterEach(async () => {
  await browser.close();
  handle.server.closeAllConnections();
  await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

const played = () => page.evaluate(() => [...(window as unknown as { __played: string[] }).__played]);
const DISCARD_SOUND = "mahjong_tile_1";

describe("효과음", () => {
  it("종료 화면에서 같은 설정으로 다시 시작해도 타패 효과음이 난다", async () => {
    await page.locator("section:has(> h2:text-is('대국 방식')) button.setup-seat", { hasText: "산마" }).click();
    await page.locator(".setup-side .setup-start").click();
    await page.locator("#zone-bottom .hand img").first().waitFor();

    // 첫 대국은 세션에 직접 응답해 끝낸다 (효과음 seq가 크게 쌓인다)
    const session = handle.getSession()!;
    for (let steps = 0; session.getPhase() !== "game_end"; steps++) {
      if (steps > 200000) throw new Error("game did not finish");
      if (session.getPhase() === "hand_end") session.continueToNextHand();
      else session.respond(defaultResponse(session.getCurrentRequest()!));
    }
    await page.reload(); // 접속 기준점(cueBase)이 끝난 대국의 마지막 seq가 된다
    await page.getByText("최종 결과 보기").click();
    await page.getByText("같은 설정으로 다시").click();

    // 새 대국: 내가 한 장 버리면 타패 효과음이 재생되어야 한다
    // 시드가 새로 정해지므로 첫 요청이 북 빼기/쯔모 같은 예·아니오일 수 있다 - 버릴 차례가 올 때까지 넘긴다
    await page.locator("#zone-bottom .hand img").first().waitFor();
    for (let tries = 0; (await page.locator("#zone-bottom .hand img.clickable").count()) === 0; tries++) {
      if (tries > 150) throw new Error("버릴 차례가 오지 않았습니다");
      const decline = page.locator("#action-bar button", { hasText: /^(넘기기|아니오)$/ });
      if (await decline.count()) await decline.first().click();
      else await page.waitForTimeout(200);
    }
    const before = (await played()).filter((u) => u.includes(DISCARD_SOUND)).length;
    await page.locator("#zone-bottom .hand img.clickable").last().click();
    const plain = page.locator("#action-bar button", { hasText: "그냥 버리기" }); // 리치 가능한 패였으면 리치 없이 버린다
    if (await plain.count()) await plain.click();
    await expect.poll(async () => (await played()).filter((u) => u.includes(DISCARD_SOUND)).length, { timeout: 15_000 }).toBeGreaterThan(before);
  }, 180_000);
});
