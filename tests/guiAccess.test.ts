import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import { AccessGate, JOIN_FAILURE_LIMIT, SESSION_COOKIE, parseNickname } from "../src/gui/accessGate.js";

const INVITE = "mahjong-2026";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seongah-access-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function startGated(dataDir: string, gate?: AccessGate) {
  const access = gate ?? new AccessGate({ inviteCode: INVITE, dataDir });
  const handle = createGuiLobbyServer({ frameDelayMs: 0, access, userDataDir: join(dataDir, "users") });
  handle.server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => handle.server.listen(0, resolve));
  const baseUrl = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
  cleanups.push(async () => {
    handle.server.closeAllConnections();
    await new Promise<void>((resolve) => handle.server.close(() => resolve()));
  });
  const request = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    fetch(`${baseUrl}${path}`, { redirect: "manual", ...init, headers: { ...(init.cookie ? { Cookie: init.cookie } : {}), ...(init.headers ?? {}) } });
  const join_ = async (body: unknown, cookie?: string) =>
    request("/join", { method: "POST", body: JSON.stringify(body), ...(cookie ? { cookie } : {}) });
  return { baseUrl, request, join: join_ };
}

function cookieOf(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
  if (!match) throw new Error(`no session cookie: ${header}`);
  return `${SESSION_COOKIE}=${match[1]}`;
}

async function firstSseMessage(res: Response): Promise<any> {
  const reader = res.body!.getReader();
  let text = "";
  while (!/data: .*\n\n/.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString("utf-8");
  }
  await reader.cancel();
  return JSON.parse(/data: (.*)\n\n/.exec(text)![1]!);
}

describe("닉네임 검증 (parseNickname)", () => {
  it("앞뒤 공백을 지우고 연속 공백을 하나로 줄인다", () => {
    expect(parseNickname("  성아  마작 ")).toBe("성아 마작");
  });
  it("비어 있거나 12자를 넘거나 제어 문자가 있으면 거절한다", () => {
    expect(() => parseNickname("")).toThrow(/입력/);
    expect(() => parseNickname("   ")).toThrow(/입력/);
    expect(() => parseNickname(42)).toThrow(/입력/);
    expect(parseNickname("가".repeat(12))).toBe("가".repeat(12));
    expect(() => parseNickname("가".repeat(13))).toThrow(/12자/);
    expect(() => parseNickname("a\u0000b")).toThrow(/문자/);
    expect(() => parseNickname("a​b")).toThrow(/문자/);
  });
});

describe("온라인 입장 게이트 (초대 코드 + 닉네임)", () => {
  it("입장하지 않으면 페이지는 입장 화면으로 보내고, 이벤트/대국/API 요청은 401로 막는다", async () => {
    const s = await startGated(tempDir());
    for (const page of ["/", "/index.html", "/replay.html"]) {
      const res = await s.request(page);
      expect(res.status, page).toBe(302);
      expect(res.headers.get("location")).toBe("/join.html");
    }
    for (const [method, path] of [
      ["GET", "/events"],
      ["GET", "/app.js"],
      ["GET", "/api/replays"],
      ["GET", "/api/custom-ai"],
      ["GET", "/api/me"],
      ["POST", "/start"],
      ["POST", "/respond"],
      ["POST", "/abandon"],
      ["POST", "/lobby"],
      ["POST", "/speed"],
    ] as const) {
      const res = await s.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
      await res.text();
    }
    for (const path of ["/join.html", "/join.js", "/style.css"]) expect((await s.request(path)).status, path).toBe(200);
  });

  it("초대 코드가 틀리면 403, 닉네임이 잘못되면 400이고 쿠키를 주지 않는다", async () => {
    const s = await startGated(tempDir());
    const wrong = await s.join({ inviteCode: "nope", nickname: "성아" });
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).toMatch(/초대 코드/);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    const bad = await s.join({ inviteCode: INVITE, nickname: "" });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("set-cookie")).toBeNull();
    expect((await s.request("/join", { method: "POST", body: "{not json" })).status).toBe(400);
  });

  it("입장하면 HttpOnly 세션 쿠키를 받고, 그 쿠키로 로비 이벤트와 닉네임을 받는다", async () => {
    const s = await startGated(tempDir());
    const res = await s.join({ inviteCode: ` ${INVITE} `, nickname: " 성아 " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nickname: "성아" });
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).not.toMatch(/Secure/);
    const cookie = cookieOf(res);

    expect(await (await s.request("/api/me", { cookie })).json()).toEqual({ nickname: "성아" });
    expect((await s.request("/", { cookie })).status).toBe(200);
    const events = await s.request("/events", { cookie });
    expect(events.status).toBe(200);
    const first = await firstSseMessage(events);
    expect(first.type).toBe("setup");
    expect(first.screen).toBe("hub");
    // 잘못된 쿠키는 입장하지 않은 것과 같다
    expect((await s.request("/api/me", { cookie: `${SESSION_COOKIE}=forged` })).status).toBe(401);
  });

  it("HTTPS 프록시(x-forwarded-proto: https) 뒤에서는 쿠키에 Secure를 붙인다", async () => {
    const s = await startGated(tempDir());
    const res = await s.request("/join", { method: "POST", body: JSON.stringify({ inviteCode: INVITE, nickname: "a" }), headers: { "X-Forwarded-Proto": "https" } });
    expect(res.headers.get("set-cookie")).toMatch(/; Secure/);
  });

  it("이미 입장한 브라우저가 다시 입장하면 같은 세션으로 닉네임만 바뀐다", async () => {
    const dataDir = tempDir();
    const s = await startGated(dataDir);
    const cookie = cookieOf(await s.join({ inviteCode: INVITE, nickname: "처음" }));
    const again = await s.join({ inviteCode: INVITE, nickname: "나중" }, cookie);
    expect(cookieOf(again)).toBe(cookie);
    expect(await (await s.request("/api/me", { cookie })).json()).toEqual({ nickname: "나중" });
    const saved = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf-8"));
    expect(Object.values(saved.sessions)).toHaveLength(1);
  });

  it("세션은 파일에 토큰 해시로만 저장되어, 서버를 다시 켜도 같은 쿠키로 들어갈 수 있다", async () => {
    const dataDir = tempDir();
    const first = await startGated(dataDir);
    const cookie = cookieOf(await first.join({ inviteCode: INVITE, nickname: "성아" }));
    const token = decodeURIComponent(cookie.split("=")[1]!);
    const file = readFileSync(join(dataDir, "sessions.json"), "utf-8");
    expect(file).not.toContain(token);
    expect(file).toContain("성아");

    const second = await startGated(dataDir);
    expect(await (await second.request("/api/me", { cookie })).json()).toEqual({ nickname: "성아" });
  });

  it(`초대 코드를 ${JOIN_FAILURE_LIMIT}번 틀린 접속지는 한동안 맞는 코드로도 입장할 수 없다 (다른 접속지는 영향 없음)`, async () => {
    let now = 1_000_000;
    const dataDir = tempDir();
    const s = await startGated(dataDir, new AccessGate({ inviteCode: INVITE, dataDir, now: () => now }));
    const from = (ip: string) => ({ "CF-Connecting-IP": ip });
    const attempt = (ip: string, inviteCode: string) =>
      s.request("/join", { method: "POST", body: JSON.stringify({ inviteCode, nickname: "a" }), headers: from(ip) });
    for (let i = 0; i < JOIN_FAILURE_LIMIT; i++) expect((await attempt("203.0.113.1", "wrong")).status).toBe(403);
    const blocked = await attempt("203.0.113.1", INVITE);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("set-cookie")).toBeNull();
    expect((await attempt("203.0.113.2", INVITE)).status).toBe(200);
    now += 10 * 60 * 1000;
    expect((await attempt("203.0.113.1", INVITE)).status).toBe(200);
  });

  it("초대 코드 없이 만든 서버(로컬 모드)는 지금처럼 입장 없이 쓴다", async () => {
    const dataDir = tempDir();
    const handle = createGuiLobbyServer({ frameDelayMs: 0, customAiDir: join(dataDir, "custom-ai") });
    handle.server.keepAliveTimeout = 0;
    await new Promise<void>((resolve) => handle.server.listen(0, resolve));
    cleanups.push(async () => {
      handle.server.closeAllConnections();
      await new Promise<void>((resolve) => handle.server.close(() => resolve()));
    });
    const baseUrl = `http://localhost:${(handle.server.address() as AddressInfo).port}`;
    expect((await fetch(`${baseUrl}/`, { redirect: "manual" })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/me`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/join`, { method: "POST", body: "{}" })).status).toBe(405);
    expect(existsSync(join(dataDir, "sessions.json"))).toBe(false);
  });
});
