// 친선전 방 규칙 (A단계): 코드, 입장/퇴장, 방장 권한, 좌석(빈자리/사람/AI), 틀린 코드 제한, 방치 정리.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THINKING_TIME,
  FriendRoomError,
  FriendRoomStore,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_FAILURE_LIMIT,
  ROOM_CODE_LENGTH,
  ROOM_IDLE_MS,
  THINKING_TIME_OPTIONS,
  normalizeRoomCode,
  parseThinkingTime,
} from "../src/gui/friendRooms.js";

const host = { userId: "u-host", nickname: "방장" };
const guest = { userId: "u-guest", nickname: "손님" };
const third = { userId: "u-third", nickname: "셋째" };

function statusOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof FriendRoomError) return err.status;
    throw err;
  }
}

describe("방 코드와 시간 옵션", () => {
  it("코드는 헷갈리는 글자(0/O/1/I)가 없는 6자리이고, 입력은 공백/하이픈/소문자를 정리한다", () => {
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[01OI]/);
    const room = new FriendRoomStore().create(host, "sanma");
    expect(room.code).toMatch(new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`));
    expect(normalizeRoomCode(" ab-cd ef ")).toBe("ABCDEF");
    expect(normalizeRoomCode("ABCDE0")).toBeNull(); // 0은 코드에 없다
    expect(normalizeRoomCode("ABC")).toBeNull();
    expect(normalizeRoomCode(123)).toBeNull();
  });

  it("시간 제한은 작혼 친선전의 다섯 가지 중 하나이고 기본은 5+20", () => {
    expect(THINKING_TIME_OPTIONS.map((o) => o.id)).toEqual(["3+5", "5+10", "5+20", "60+0", "300+0"]);
    expect(DEFAULT_THINKING_TIME).toBe("5+20");
    expect(parseThinkingTime(undefined)).toBe("5+20");
    expect(parseThinkingTime("300+0")).toBe("300+0");
    expect(() => parseThinkingTime("10+10")).toThrow(FriendRoomError);
  });

  it("코드가 겹치면 다시 만든다", () => {
    const codes = ["AAAAAA", "AAAAAA", "BBBBBB"];
    const store = new FriendRoomStore({ generateCode: () => codes.shift()! });
    expect(store.create(host, "sanma").code).toBe("AAAAAA");
    expect(store.create(guest, "sanma").code).toBe("BBBBBB");
  });
});

describe("방 만들기 / 들어가기 / 나가기", () => {
  it("방장은 seat 0, 나머지는 빈자리로 시작한다 (4마는 4좌석)", () => {
    const room = new FriendRoomStore().create(host, "yonma", "3+5");
    expect(room.seats).toEqual([{ kind: "human", userId: "u-host", nickname: "방장" }, { kind: "open" }, { kind: "open" }, { kind: "open" }]);
    expect(room.thinkingTime).toBe("3+5");
  });

  it("코드로 들어가면 첫 빈자리에 앉고, 같은 방에 다시 들어가면 그대로다", () => {
    const store = new FriendRoomStore();
    const room = store.create(host, "sanma");
    expect(store.join(guest, room.code.toLowerCase())).toBe(room);
    expect(room.seats[1]).toEqual({ kind: "human", userId: "u-guest", nickname: "손님" });
    store.join(guest, room.code);
    expect(store.membersOf(room)).toEqual(["u-host", "u-guest"]);
  });

  it("사람당 방은 하나: 방이 있으면 새로 만들거나 다른 방에 들어갈 수 없다", () => {
    const store = new FriendRoomStore();
    const a = store.create(host, "sanma");
    const b = store.create(guest, "sanma");
    expect(statusOf(() => store.create(host, "yonma"))).toBe(400);
    expect(statusOf(() => store.join(host, b.code))).toBe(400);
    expect(store.roomOf(host.userId)).toBe(a);
  });

  it("빈자리가 없으면 들어갈 수 없다 (409)", () => {
    const store = new FriendRoomStore();
    const room = store.create(host, "sanma");
    store.join(guest, room.code);
    store.join(third, room.code);
    expect(statusOf(() => store.join({ userId: "u-4", nickname: "넷째" }, room.code))).toBe(409);
  });

  it("참가자가 나가면 그 자리는 빈자리가 되고, 방장이 나가면 방이 닫힌다", () => {
    const store = new FriendRoomStore();
    const room = store.create(host, "sanma");
    store.join(guest, room.code);
    store.join(third, room.code);
    expect(store.leave(guest.userId)).toMatchObject({ closed: false, members: ["u-host", "u-guest", "u-third"] });
    expect(room.seats[1]).toEqual({ kind: "open" });
    expect(store.roomOf(guest.userId)).toBeNull();
    expect(store.leave(host.userId)).toMatchObject({ closed: true, members: ["u-host", "u-third"] });
    expect(store.roomOf(third.userId)).toBeNull();
    expect(store.size).toBe(0);
    expect(statusOf(() => store.join(guest, room.code))).toBe(404);
    expect(store.leave(guest.userId)).toBeNull();
  });
});

describe("방장의 좌석 설정", () => {
  it("빈자리에 AI를 앉히고, 사람을 내보낼 수 있다 (방장 자리는 못 바꿈, 같은 캐릭터 중복 불가)", () => {
    const store = new FriendRoomStore();
    const room = store.create(host, "yonma");
    store.join(guest, room.code);
    expect(store.setSeat(host.userId, 2, { kind: "ai", characterId: "jegalmina" }).removedUserId).toBeNull();
    expect(room.seats[2]).toEqual({ kind: "ai", characterId: "jegalmina" });
    expect(statusOf(() => store.setSeat(host.userId, 3, { kind: "ai", characterId: "jegalmina" }))).toBe(400);
    expect(statusOf(() => store.setSeat(host.userId, 0, { kind: "open" }))).toBe(400);
    expect(statusOf(() => store.setSeat(host.userId, 4, { kind: "open" }))).toBe(400);
    // 사람이 앉은 자리를 AI로 바꾸면 그 사람은 방에서 나간다
    expect(store.setSeat(host.userId, 1, { kind: "ai", characterId: "byeonari" }).removedUserId).toBe("u-guest");
    expect(store.roomOf(guest.userId)).toBeNull();
  });

  it("참가자는 좌석을 바꿀 수 없다 (403), 방에 없으면 400", () => {
    const store = new FriendRoomStore();
    const room = store.create(host, "sanma");
    store.join(guest, room.code);
    expect(statusOf(() => store.setSeat(guest.userId, 2, { kind: "open" }))).toBe(403);
    expect(statusOf(() => store.setSeat(third.userId, 1, { kind: "open" }))).toBe(400);
  });
});

describe("남용 방지와 정리", () => {
  it(`틀린 코드를 ${ROOM_CODE_FAILURE_LIMIT}번 넣은 사용자는 한동안 맞는 코드로도 들어갈 수 없다 (다른 사용자는 영향 없음)`, () => {
    let now = 1_000_000;
    const store = new FriendRoomStore({ now: () => now });
    const room = store.create(host, "sanma");
    for (let i = 0; i < ROOM_CODE_FAILURE_LIMIT; i++) expect(statusOf(() => store.join(guest, "ZZZZZZ"))).toBe(404);
    expect(statusOf(() => store.join(guest, room.code))).toBe(429);
    expect(store.join(third, room.code)).toBe(room);
    now += 10 * 60 * 1000;
    expect(store.join(guest, room.code)).toBe(room);
  });

  it("서버 전체 방 수 상한", () => {
    const store = new FriendRoomStore({ maxRooms: 1 });
    store.create(host, "sanma");
    expect(statusOf(() => store.create(guest, "sanma"))).toBe(503);
  });

  it(`${ROOM_IDLE_MS / 60000}분 동안 활동이 없는 방은 닫고, 있던 사람들을 알려 준다`, () => {
    let now = 0;
    const store = new FriendRoomStore({ now: () => now });
    const idle = store.create(host, "sanma");
    store.join(guest, idle.code);
    now += ROOM_IDLE_MS - 1;
    const active = store.create(third, "sanma");
    expect(store.sweepIdle()).toEqual([]);
    now += 2;
    const closed = store.sweepIdle();
    expect(closed.map((c) => [c.room.code, c.members])).toEqual([[idle.code, ["u-host", "u-guest"]]]);
    expect(store.roomOf(guest.userId)).toBeNull();
    expect(store.roomOf(third.userId)).toBe(active);
  });
});
