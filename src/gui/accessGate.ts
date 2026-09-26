/* 온라인 입장 게이트 (1.2 1단계): 초대 코드를 아는 사람만 닉네임을 정해 입장한다.
 * - 입장하면 무작위 세션 토큰을 쿠키로 준다. 서버는 토큰의 SHA-256 해시만 저장한다(파일이 새어도 토큰은 복원되지 않는다).
 * - 세션은 <dataDir>/sessions.json에 저장해 서버를 다시 켜도 유지된다. 계정/비밀번호는 없고 닉네임은 표시용이다.
 * - 초대 코드가 틀린 입장 시도는 접속지별로 횟수를 제한한다.
 * 게임 로직과 무관한 서버 계층이며, 초대 코드 없이 켠 서버(로컬 모드)에서는 쓰이지 않는다. */
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

/** 입장 시도 횟수 제한에 쓰는 접속지. Cloudflare Tunnel 뒤에서는 모든 요청이 로컬에서 오므로 CF-Connecting-IP를 쓴다. */
function clientKeyOf(req: IncomingMessage): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  return req.socket.remoteAddress ?? "unknown";
}

export interface AccessGateOptions {
  inviteCode: string;
  /** 세션 파일 폴더 (기본 "server-data", 프로젝트 루트 기준) */
  dataDir?: string;
  now?: () => number;
}

export class AccessGate {
  private readonly inviteDigest: Buffer;
  private readonly file: string;
  private readonly sessions: Map<string, OnlineUser>;
  private readonly failures = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(options: AccessGateOptions) {
    if (!options.inviteCode.trim()) throw new Error("초대 코드가 비어 있습니다");
    this.inviteDigest = sha256(options.inviteCode.trim());
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

  /** 요청의 세션 쿠키에 해당하는 사용자. 입장하지 않았으면 null. */
  userOf(req: IncomingMessage): OnlineUser | null {
    const token = sessionTokenOf(req);
    return token ? (this.sessions.get(sha256(token).toString("hex")) ?? null) : null;
  }

  /** 초대 코드와 닉네임으로 입장한다. 새 세션 토큰(쿠키 값)과 사용자를 돌려준다. */
  join(req: IncomingMessage, input: unknown): { token: string; user: OnlineUser } {
    const key = clientKeyOf(req);
    const now = this.now();
    const recent = (this.failures.get(key) ?? []).filter((t) => now - t < JOIN_FAILURE_WINDOW_MS);
    if (recent.length >= JOIN_FAILURE_LIMIT) throw new AccessError("입장 시도가 너무 많습니다. 잠시 뒤 다시 시도해 주세요", 429);
    const raw = (typeof input === "object" && input !== null ? input : {}) as { inviteCode?: unknown; nickname?: unknown };
    const code = typeof raw.inviteCode === "string" ? raw.inviteCode.trim() : "";
    if (!timingSafeEqual(sha256(code), this.inviteDigest)) {
      this.failures.set(key, [...recent, now]);
      throw new AccessError("초대 코드가 맞지 않습니다", 403);
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
    const token = randomBytes(32).toString("base64url");
    const user: OnlineUser = { userId: randomUUID(), nickname, createdAt: now };
    this.sessions.set(sha256(token).toString("hex"), user);
    this.save();
    return { token, user };
  }

  /** 세션 쿠키 헤더 값. HTTPS(Cloudflare Tunnel 등 프록시가 알려 주는 경우)면 Secure를 붙인다. */
  static cookieHeader(req: IncomingMessage, token: string): string {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}${secure}`;
  }
}
