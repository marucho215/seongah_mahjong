/* 친선전 방 (사람끼리 대전 A단계): 누구나 방을 만들어 코드를 받고, 그 코드를 아는 사람이 빈자리에 앉는다. 공개 방 목록은 없다.
 * 이 파일은 서버/화면과 무관한 방 상태와 규칙만 가진다(createGuiServer.ts가 요청을 여기로 넘기고 결과를 참가자들에게 보낸다).
 * - 좌석: 빈자리(open) / 사람(human) / AI(characterId, 등록 캐릭터 또는 방장의 CustomAI). 방장은 seat 0에 앉는다.
 * - 사람당 방 하나(방장이든 참가자든). 방장이 나가면 방이 닫힌다.
 * - 시간 제한(작혼 친선전 옵션)은 방 설정으로만 저장한다. 실제 적용은 C단계.
 * - 코드는 헷갈리는 글자(0/O, 1/I)를 뺀 32자 중 6자리(약 10억 가지). 틀린 코드 입력은 사용자별로 횟수를 제한한다. */
import { randomInt } from "node:crypto";
import { playerCountOf, type GuiGameMode } from "./gameSetup.js";

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
/** 틀린 코드 입력 제한: 사용자별로 이 시간 안에 이 횟수까지 */
export const ROOM_CODE_FAILURE_LIMIT = 10;
export const ROOM_CODE_FAILURE_WINDOW_MS = 10 * 60 * 1000;
/** 아무 활동이 없으면 방을 닫는 시간 */
export const ROOM_IDLE_MS = 30 * 60 * 1000;
/** 서버 전체 방 수 상한 */
export const MAX_FRIEND_ROOMS = 100;

/** 작혼 친선전의 시간 제한 옵션: 한 수마다 주어지는 시간(초) + 국마다 나눠 쓰는 여유 시간(초). 기본은 단위전과 같은 5+20. */
export const THINKING_TIME_OPTIONS = [
  { id: "3+5", perTurnSeconds: 3, bankSeconds: 5 },
  { id: "5+10", perTurnSeconds: 5, bankSeconds: 10 },
  { id: "5+20", perTurnSeconds: 5, bankSeconds: 20 },
  { id: "60+0", perTurnSeconds: 60, bankSeconds: 0 },
  { id: "300+0", perTurnSeconds: 300, bankSeconds: 0 },
] as const;
export type ThinkingTimeId = (typeof THINKING_TIME_OPTIONS)[number]["id"];
export const DEFAULT_THINKING_TIME: ThinkingTimeId = "5+20";

export type RoomSeat = { kind: "open" } | { kind: "human"; userId: string; nickname: string } | { kind: "ai"; characterId: string };

export interface FriendRoom {
  code: string;
  hostUserId: string;
  mode: GuiGameMode;
  thinkingTime: ThinkingTimeId;
  /** seat 0이 방장 */
  seats: RoomSeat[];
  createdAt: number;
  lastActivity: number;
}

export class FriendRoomError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function parseThinkingTime(value: unknown): ThinkingTimeId {
  if (value === undefined || value === null) return DEFAULT_THINKING_TIME;
  const found = THINKING_TIME_OPTIONS.find((o) => o.id === value);
  if (!found) throw new FriendRoomError(`시간 제한은 ${THINKING_TIME_OPTIONS.map((o) => o.id).join(", ")} 중 하나여야 합니다`);
  return found.id;
}

/** 입력한 코드를 정리한다: 공백/하이픈 제거, 대문자. 모양이 맞지 않으면 null. */
export function normalizeRoomCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export interface FriendRoomStoreOptions {
  now?: () => number;
  /** 코드 생성기 (테스트용) */
  generateCode?: () => string;
  maxRooms?: number;
}

export class FriendRoomStore {
  private readonly rooms = new Map<string, FriendRoom>();
  /** 사용자 id -> 그 사용자가 있는 방 코드 */
  private readonly memberOf = new Map<string, string>();
  private readonly failures = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly generateCode: () => string;
  private readonly maxRooms: number;

  constructor(options: FriendRoomStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.generateCode = options.generateCode ?? (() => Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]).join(""));
    this.maxRooms = options.maxRooms ?? MAX_FRIEND_ROOMS;
  }

  get size(): number {
    return this.rooms.size;
  }

  /** 사용자가 있는 방 (없으면 null) */
  roomOf(userId: string): FriendRoom | null {
    const code = this.memberOf.get(userId);
    return code ? (this.rooms.get(code) ?? null) : null;
  }

  /** 방에 있는 사람들의 사용자 id (방장 포함) */
  membersOf(room: FriendRoom): string[] {
    return room.seats.flatMap((s) => (s.kind === "human" ? [s.userId] : []));
  }

  create(host: { userId: string; nickname: string }, mode: GuiGameMode, thinkingTime: ThinkingTimeId = DEFAULT_THINKING_TIME): FriendRoom {
    if (this.memberOf.has(host.userId)) throw new FriendRoomError("이미 친선전 방에 있습니다. 먼저 방에서 나가 주세요");
    if (this.rooms.size >= this.maxRooms) throw new FriendRoomError("지금은 서버에 방이 너무 많습니다. 잠시 뒤 다시 시도해 주세요", 503);
    let code = this.generateCode();
    for (let tries = 0; this.rooms.has(code); tries++) {
      if (tries > 20) throw new FriendRoomError("방 코드를 만들지 못했습니다. 다시 시도해 주세요", 503);
      code = this.generateCode();
    }
    const now = this.now();
    const seats: RoomSeat[] = Array.from({ length: playerCountOf(mode) }, (_, i) =>
      i === 0 ? { kind: "human", userId: host.userId, nickname: host.nickname } : { kind: "open" }
    );
    const room: FriendRoom = { code, hostUserId: host.userId, mode, thinkingTime, seats, createdAt: now, lastActivity: now };
    this.rooms.set(code, room);
    this.memberOf.set(host.userId, code);
    return room;
  }

  /** 코드로 들어가 첫 빈자리에 앉는다. 틀린 코드는 사용자별로 횟수를 제한한다. */
  join(user: { userId: string; nickname: string }, codeInput: unknown): FriendRoom {
    const now = this.now();
    const recent = (this.failures.get(user.userId) ?? []).filter((t) => now - t < ROOM_CODE_FAILURE_WINDOW_MS);
    if (recent.length >= ROOM_CODE_FAILURE_LIMIT) throw new FriendRoomError("방 코드 입력이 너무 많습니다. 잠시 뒤 다시 시도해 주세요", 429);
    const code = normalizeRoomCode(codeInput);
    const room = code ? this.rooms.get(code) : undefined;
    if (!room) {
      this.failures.set(user.userId, [...recent, now]);
      throw new FriendRoomError("그런 방이 없습니다. 코드를 확인해 주세요", 404);
    }
    const current = this.roomOf(user.userId);
    if (current === room) return room; // 이미 이 방에 있다 (새로고침 등)
    if (current) throw new FriendRoomError("이미 다른 친선전 방에 있습니다. 먼저 방에서 나가 주세요");
    const seat = room.seats.findIndex((s) => s.kind === "open");
    if (seat < 0) throw new FriendRoomError("빈자리가 없습니다", 409);
    room.seats[seat] = { kind: "human", userId: user.userId, nickname: user.nickname };
    room.lastActivity = now;
    this.memberOf.set(user.userId, room.code);
    return room;
  }

  /** 방에서 나간다. 방장이 나가면 방이 닫힌다. 영향을 받은 방과 닫혔는지, 그 방에 있던 사람들을 돌려준다. */
  leave(userId: string): { room: FriendRoom; closed: boolean; members: string[] } | null {
    const room = this.roomOf(userId);
    if (!room) return null;
    const members = this.membersOf(room);
    if (room.hostUserId === userId) {
      this.close(room);
      return { room, closed: true, members };
    }
    const seat = room.seats.findIndex((s) => s.kind === "human" && s.userId === userId);
    room.seats[seat] = { kind: "open" };
    room.lastActivity = this.now();
    this.memberOf.delete(userId);
    return { room, closed: false, members };
  }

  /** 방장이 좌석을 정한다: 빈자리로(사람이 앉아 있으면 내보냄) 또는 AI로. 방장 자리(seat 0)는 바꿀 수 없다.
   *  내보낸 사람이 있으면 그 사용자 id를 돌려준다. */
  setSeat(hostUserId: string, seatIndex: unknown, seat: { kind: "open" } | { kind: "ai"; characterId: string }): { room: FriendRoom; removedUserId: string | null } {
    const room = this.roomOf(hostUserId);
    if (!room) throw new FriendRoomError("친선전 방에 있지 않습니다");
    if (room.hostUserId !== hostUserId) throw new FriendRoomError("방장만 좌석을 바꿀 수 있습니다", 403);
    if (typeof seatIndex !== "number" || !Number.isInteger(seatIndex) || seatIndex < 1 || seatIndex >= room.seats.length) {
      throw new FriendRoomError(`좌석은 1~${room.seats.length - 1} 중 하나여야 합니다 (0은 방장 자리)`);
    }
    if (seat.kind === "ai" && room.seats.some((s, i) => i !== seatIndex && s.kind === "ai" && s.characterId === seat.characterId)) {
      throw new FriendRoomError("같은 캐릭터를 두 좌석에 앉힐 수 없습니다");
    }
    const previous = room.seats[seatIndex]!;
    const removedUserId = previous.kind === "human" ? previous.userId : null;
    if (removedUserId) this.memberOf.delete(removedUserId);
    room.seats[seatIndex] = seat;
    room.lastActivity = this.now();
    return { room, removedUserId };
  }

  /** 방에 활동이 있었다 (방치 정리 기준을 늦춘다) */
  touch(room: FriendRoom): void {
    room.lastActivity = this.now();
  }

  /** 오래 활동이 없는 방을 닫는다. 닫힌 방과 그 방에 있던 사람들을 돌려준다. */
  sweepIdle(): { room: FriendRoom; members: string[] }[] {
    const now = this.now();
    const closed: { room: FriendRoom; members: string[] }[] = [];
    for (const room of [...this.rooms.values()]) {
      if (now - room.lastActivity > ROOM_IDLE_MS) {
        closed.push({ room, members: this.membersOf(room) });
        this.close(room);
      }
    }
    return closed;
  }

  private close(room: FriendRoom): void {
    for (const userId of this.membersOf(room)) this.memberOf.delete(userId);
    this.rooms.delete(room.code);
  }
}
