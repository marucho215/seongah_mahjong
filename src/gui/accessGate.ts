/* 온라인 입장 게이트: 브라우저마다 닉네임을 정해 입장하고, 그 세션으로 사용자를 나눈다.
 * - 공개 모드(초대 코드 없음): 누구나 닉네임만 정하면 입장한다. 새 사용자 만들기는 접속지별/서버 전체 시간당 횟수와
 *   전체 사용자 수 상한으로 제한한다(쿠키를 지워 가며 사용자 폴더를 늘리는 남용 방지).
 * - 비공개 모드(초대 코드 있음): 초대 코드를 아는 사람만 입장한다. 틀린 시도는 접속지별로 횟수를 제한한다.
 *   (초대 코드는 앞으로 사람끼리 대전의 입장에도 쓴다.)
 * - 입장하면 무작위 세션 토큰을 쿠키로 준다. 서버는 토큰의 SHA-256 해시만 저장한다(파일이 새어도 토큰은 복원되지 않는다).
 * - 세션은 <dataDir>/sessions.json에 저장해 서버를 다시 켜도 유지된다. 계정/비밀번호는 없고 닉네임은 표시용이다.
 * 게임 로직과 무관한 서버 계층이며, 공개/비공개 어느 쪽도 아닌 서버(로컬 모드)에서는 쓰이지 않는다. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IncomingMessage } from "node:http";

export const SESSION_COOKIE = "seongah_session";
export const NICKNAME_MAX = 12;
/** 세션 쿠키 유효 기간 (초): 1년 */
export const SESSION_MAX_AGE_S = 365 * 24 * 60 * 60;
/** 초대 코드를 틀린 시도: 접속지별로 이 시간 안에 이 횟수까지 */
export const JOIN_FAILURE_LIMIT = 5;
export const JOIN_FAILURE_WINDOW_MS = 10 * 60 * 1000;
/** 새 사용자 만들기 제한 (한 시간 창): 접속지별, 서버 전체 */
export const NEW_USER_WINDOW_MS = 60 * 60 * 1000;
export const NEW_USERS_PER_CLIENT = 10;
export const NEW_USERS_PER_WINDOW = 60;
/** 서버 전체 사용자(세션) 수 기본 상한. 넘으면 새 입장만 막고 이미 입장한 사람은 그대로 쓴다. */
export const DEFAULT_MAX_USERS = 500;

export interface OnlineUser {
  /** 서버 내부 사용자 id (이후 단계에서 사용자별 대국/저장에 쓴다) */
  userId: string;
  nickname: string;
  createdAt: number;
}

interface SessionFile {
  version: 1;
  sessions: Record<string, OnlineUser>; // key: 토큰의 SHA-256 hex
}

export class AccessError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf-8").digest();

/** 닉네임 검증: 앞뒤 공백 제거, 1~12자(코드 포인트 기준), 제어 문자 금지. 올바르면 정리된 닉네임을 돌려준다. */
export function parseNickname(input: unknown): string {
  if (typeof input !== "string") throw new AccessError("닉네임을 입력해 주세요", 400);
  const nickname = input.normalize("NFC").trim().replace(/\s+/g, " ");
  const length = [...nickname].length;
  if (length === 0) throw new AccessError("닉네임을 입력해 주세요", 400);
  if (length > NICKNAME_MAX) throw new AccessError(`닉네임은 ${NICKNAME_MAX}자 이하로 정해 주세요`, 400);
  if (/[\p{Cc}\p{Cf}]/u.test(nickname)) throw new AccessError("닉네임에 쓸 수 없는 문자가 있습니다", 400);
  return nickname;
}

/** Cookie 헤더에서 세션 토큰을 꺼낸다. */
export function sessionTokenOf(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim()) || null;
  }
  return null;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** 입장 횟수 제한에 쓰는 접속지. 터널/프록시가 같은 PC(루프백)에서 넘겨 준 요청이면 그 프록시가 붙인 원래 접속지
 *  헤더(CF-Connecting-IP, X-Forwarded-For의 첫 주소)를 쓴다. 루프백이 아닌 곳에서 온 헤더는 믿지 않는다(위조 가능).
 *  원래 접속지를 알 수 없으면(헤더 없는 루프백, 예: 원래 주소를 넘기지 않는 터널) null - 모든 사람이 한 접속지로 보이므로
 *  접속지별 제한에 쓰지 않는다. */
export function clientKeyOf(req: IncomingMessage): string | null {
  const remote = req.socket.remoteAddress ?? "";
  if (!LOOPBACK.has(remote)) return remote || null;
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  const xff = req.headers["x-forwarded-for"];
  const first = typeof xff === "string" ? xff.split(",")[0]!.trim() : "";
  return first || null;
}

export interface AccessGateOptions {
  /** 주면 비공개 모드(초대 코드를 아는 사람만), 없으면 공개 모드(누구나 닉네임만 정해 입장) */
  inviteCode?: string;
  /** 서버 전체 사용자(세션) 수 상한 (기본 DEFAULT_MAX_USERS) */
  maxUsers?: number;
  /** 세션 파일 폴더 (기본 "server-data", 프로젝트 루트 기준) */
  dataDir?: string;
  now?: () => number;
}

export class AccessGate {
  private readonly inviteDigest: Buffer | null;
  private readonly file: string;
  private readonly sessions: Map<string, OnlineUser>;
  private readonly failures = new Map<string, number[]>();
  /** 새 사용자를 만든 시각: 접속지별(알 수 있을 때)과 서버 전체 */
  private readonly newUsersByClient = new Map<string, number[]>();
  private newUsers: number[] = [];
  private readonly maxUsers: number;
  private readonly now: () => number;

  constructor(options: AccessGateOptions = {}) {
    if (options.inviteCode !== undefined && !options.inviteCode.trim()) throw new Error("초대 코드가 비어 있습니다");
    this.inviteDigest = options.inviteCode !== undefined ? sha256(options.inviteCode.trim()) : null;
    this.maxUsers = options.maxUsers ?? DEFAULT_MAX_USERS;
    if (!Number.isInteger(this.maxUsers) || this.maxUsers < 1) throw new Error("사용자 수 상한은 1 이상의 정수여야 합니다");
    const dir = resolve(options.dataDir ?? "server-data");
    this.file = join(dir, "sessions.json");
    this.now = options.now ?? Date.now;
    this.sessions = new Map(Object.entries(this.load()));
  }

  private load(): Record<string, OnlineUser> {
    if (!existsSync(this.file)) return {};
    const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as SessionFile;
    if (parsed?.version !== 1 || typeof parsed.sessions !== "object" || parsed.sessions === null) throw new Error(`세션 파일 형식이 올바르지 않습니다: ${this.file}`);
    return parsed.sessions;
  }

  private save(): void {
    const body: SessionFile = { version: 1, sessions: Object.fromEntries(this.sessions) };
    mkdirSync(join(this.file, ".."), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2), "utf-8");
    renameSync(tmp, this.file);
  }

  /** 초대 코드가 있어야 입장할 수 있는지 (비공개 모드). 입장 화면이 초대 코드 칸을 보일지 정한다. */
  get inviteRequired(): boolean {
    return this.inviteDigest !== null;
  }

  /** 요청의 세션 쿠키에 해당하는 사용자. 입장하지 않았으면 null. */
  userOf(req: IncomingMessage): OnlineUser | null {
    const token = sessionTokenOf(req);
    return token ? (this.sessions.get(sha256(token).toString("hex")) ?? null) : null;
  }

  /** 닉네임(비공개 모드면 초대 코드도)으로 입장한다. 새 세션 토큰(쿠키 값)과 사용자를 돌려준다. */
  join(req: IncomingMessage, input: unknown): { token: string; user: OnlineUser } {
    const key = clientKeyOf(req);
    const failureKey = key ?? "unknown";
    const now = this.now();
    const raw = (typeof input === "object" && input !== null ? input : {}) as { inviteCode?: unknown; nickname?: unknown };
    if (this.inviteDigest) {
      const recent = (this.failures.get(failureKey) ?? []).filter((t) => now - t < JOIN_FAILURE_WINDOW_MS);
      if (recent.length >= JOIN_FAILURE_LIMIT) throw new AccessError("입장 시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요", 429);
      const code = typeof raw.inviteCode === "string" ? raw.inviteCode.trim() : "";
      if (!timingSafeEqual(sha256(code), this.inviteDigest)) {
        this.failures.set(failureKey, [...recent, now]);
        throw new AccessError("초대 코드가 맞지 않습니다", 403);
      }
    }
    const nickname = parseNickname(raw.nickname);
    // 이미 입장한 브라우저가 다시 입장하면 같은 사용자로 닉네임만 바꾼다 (사용자별 데이터가 끊기지 않게).
    const existingToken = sessionTokenOf(req);
    const existing = this.userOf(req);
    if (existingToken && existing) {
      existing.nickname = nickname;
      this.save();
      return { token: existingToken, user: existing };
    }
    this.assertCanCreateUser(key, now);
    const token = randomBytes(32).toString("base64url");
    const user: OnlineUser = { userId: randomUUID(), nickname, createdAt: now };
    this.sessions.set(sha256(token).toString("hex"), user);
    this.save();
    this.newUsers.push(now);
    if (key !== null) this.newUsersByClient.set(key, [...(this.newUsersByClient.get(key) ?? []), now]);
    return { token, user };
  }

  /** 새 사용자(세션) 만들기 제한: 전체 사용자 수 상한, 서버 전체 시간당 횟수, 접속지별 시간당 횟수(접속지를 알 수 있을 때). */
  private assertCanCreateUser(key: string | null, now: number): void {
    if (this.sessions.size >= this.maxUsers) throw new AccessError("지금은 새 입장을 받지 않습니다 (사용자 수 상한). 이미 입장한 브라우저는 그대로 쓸 수 있습니다", 503);
    this.newUsers = this.newUsers.filter((t) => now - t < NEW_USER_WINDOW_MS);
    if (this.newUsers.length >= NEW_USERS_PER_WINDOW) throw new AccessError("새 입장이 몰려 잠시 받지 않습니다. 잠시 뒤 다시 시도해 주세요", 429);
    if (key === null) return;
    const recent = (this.newUsersByClient.get(key) ?? []).filter((t) => now - t < NEW_USER_WINDOW_MS);
    this.newUsersByClient.set(key, recent);
    if (recent.length >= NEW_USERS_PER_CLIENT) throw new AccessError("이 접속지에서 새 입장이 너무 많습니다. 잠시 뒤 다시 시도해 주세요", 429);
  }

  /** 세션 쿠키 헤더 값. HTTPS(Cloudflare Tunnel 등 프록시가 알려 주는 경우)면 Secure를 붙인다. */
  static cookieHeader(req: IncomingMessage, token: string): string {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}${secure}`;
  }
}
