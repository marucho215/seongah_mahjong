import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import type { IncomingMessage } from "node:http";
import { AccessGate, JOIN_FAILURE_LIMIT, NEW_USERS_PER_CLIENT, NEW_USERS_PER_WINDOW, NEW_USER_WINDOW_MS, SESSION_COOKIE, clientKeyOf, parseNickname } from "../src/gui/accessGate.js";

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

describe("공개 모드 입장 (초대 코드 없이 닉네임만)", () => {
  const publicGate = (dataDir: string, options: { maxUsers?: number; now?: () => number } = {}) => new AccessGate({ dataDir, ...options });

  it("입장 정보 API는 입장 전에도 열리고, 초대 코드가 필요한지 알려 준다", async () => {
    const open = await startGated(tempDir(), publicGate(tempDir()));
    expect(await (await open.request("/api/join-info")).json()).toEqual({ inviteRequired: false });
    const closed = await startGated(tempDir());
    expect(await (await closed.request("/api/join-info")).json()).toEqual({ inviteRequired: true });
  });

  it("닉네임만으로 입장해 로비를 쓰고, 입장 전에는 비공개 모드처럼 막는다", async () => {
    const dataDir = tempDir();
    const s = await startGated(dataDir, publicGate(dataDir));
    expect((await s.request("/")).status).toBe(302); // 입장 화면으로
    expect((await s.request("/events")).status).toBe(401);
    expect((await s.join({ nickname: "" })).status).toBe(400);
    const res = await s.join({ nickname: "손님" });
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect(await (await s.request("/api/me", { cookie })).json()).toEqual({ nickname: "손님" });
    const first = await firstSseMessage(await s.request("/events", { cookie }));
    expect([first.type, first.screen]).toEqual(["setup", "hub"]);
    // 초대 코드를 보내도 무시한다 (틀린 코드여도 입장)
    expect((await s.join({ nickname: "다른 손님", inviteCode: "anything" })).status).toBe(200);
  });

  it("비공개 모드에서 입장한 브라우저는 공개 모드로 바꿔 켜도 같은 사용자로 들어간다 (세션 파일 공용)", async () => {
    const dataDir = tempDir();
    const closed = await startGated(dataDir);
    const cookie = cookieOf(await closed.join({ inviteCode: INVITE, nickname: "기존" }));
    const open = await startGated(dataDir, publicGate(dataDir));
    expect(await (await open.request("/api/me", { cookie })).json()).toEqual({ nickname: "기존" });
  });

  it(`접속지별로 한 시간에 새 사용자 ${NEW_USERS_PER_CLIENT}명까지 (다른 접속지와 이미 입장한 브라우저는 영향 없음)`, async () => {
    let now = 5_000_000;
    const dataDir = tempDir();
    const s = await startGated(dataDir, publicGate(dataDir, { now: () => now }));
    const joinFrom = (ip: string, cookie?: string) =>
      s.request("/join", { method: "POST", body: JSON.stringify({ nickname: "a" }), headers: { "X-Forwarded-For": `${ip}, 10.0.0.1` }, ...(cookie ? { cookie } : {}) });
    let firstCookie = "";
    for (let i = 0; i < NEW_USERS_PER_CLIENT; i++) {
      const res = await joinFrom("198.51.100.7");
      expect(res.status).toBe(200);
      if (i === 0) firstCookie = cookieOf(res);
    }
    const blocked = await joinFrom("198.51.100.7");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("set-cookie")).toBeNull();
    expect((await joinFrom("198.51.100.7", firstCookie)).status).toBe(200); // 이미 입장한 브라우저의 닉네임 바꾸기는 새 사용자가 아니다
    expect((await joinFrom("198.51.100.8")).status).toBe(200);
    now += NEW_USER_WINDOW_MS;
    expect((await joinFrom("198.51.100.7")).status).toBe(200);
  });

  it(`원래 접속지를 알 수 없으면(헤더 없는 루프백) 접속지별 제한 대신 서버 전체 한 시간 ${NEW_USERS_PER_WINDOW}명 제한만 적용한다`, async () => {
    const dataDir = tempDir();
    const s = await startGated(dataDir, publicGate(dataDir));
    for (let i = 0; i < NEW_USERS_PER_WINDOW; i++) expect((await s.join({ nickname: `u${i}` })).status).toBe(200);
    expect((await s.join({ nickname: "over" })).status).toBe(429);
  });

  it("서버 전체 사용자 수 상한에 닿으면 새 입장만 막는다 (503)", async () => {
    const dataDir = tempDir();
    const s = await startGated(dataDir, publicGate(dataDir, { maxUsers: 2 }));
    const a = cookieOf(await s.join({ nickname: "a" }));
    expect((await s.join({ nickname: "b" })).status).toBe(200);
    const full = await s.join({ nickname: "c" });
    expect(full.status).toBe(503);
    expect(await full.text()).toMatch(/사용자 수 상한/);
    expect((await s.join({ nickname: "a2" }, a)).status).toBe(200);
    expect(await (await s.request("/api/me", { cookie: a })).json()).toEqual({ nickname: "a2" });
  });
});

describe("입장 제한에 쓰는 접속지 (clientKeyOf)", () => {
  const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;
  it("루프백(같은 PC의 터널/프록시)에서 온 요청만 원래 접속지 헤더를 믿는다", () => {
    expect(clientKeyOf(req("127.0.0.1", { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientKeyOf(req("::1", { "cf-connecting-ip": "203.0.113.10" }))).toBe("203.0.113.10");
    expect(clientKeyOf(req("127.0.0.1"))).toBeNull(); // 모든 사람이 한 접속지로 보이므로 접속지별 제한에 쓰지 않는다
    expect(clientKeyOf(req("198.51.100.3", { "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "5.6.7.8" }))).toBe("198.51.100.3"); // 위조 가능
  });
});
