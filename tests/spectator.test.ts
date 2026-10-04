// 관전용 메시지 변환: 손패/대기/위험도/후리텐/결정 요청은 지우고, 테이블에 보이는 정보는 그대로 둔다.
import { describe, expect, it } from "vitest";
import { spectatorView, toSpectatorMessage } from "../src/gui/spectator.js";

const view = {
  seat: 1,
  concealedTiles: [{ kind: "m1", id: 1 }, { kind: "p5", id: 2, red: true }],
  melds: [{ type: "pon", tiles: [{ kind: "z5", id: 9 }] }],
  kitaTiles: [{ kind: "z4", id: 99 }],
  discards: ["s3"],
  waits: [{ kind: "m1", unseenCount: 3 }],
  handStatus: { shanten: 0, tenpaiWaits: [{ kind: "m1", unseenCount: 3 }] },
  discardRisk: [{ kind: "p5", level: "high" }],
  furiten: { active: true, selfDiscard: true, temporary: false, riichi: false },
  opponents: [{ seat: 0, concealedCount: 13, discards: ["z1"] }],
  scores: [35000, 35000, 35000],
};

const parse = (m: string | null) => JSON.parse(m!) as Record<string, any>;

describe("spectatorView", () => {
  it("손패는 장수만 남기고 대기/샹텐/위험도/후리텐을 비우며, 공개 정보(멘츠, 북, 강, 상대, 점수)는 그대로 둔다", () => {
    const v = spectatorView(view) as any;
    expect(v.concealedTiles).toEqual([]);
    expect(v.hiddenCount).toBe(2);
    expect(v.waits).toEqual([]);
    expect(v.handStatus).toEqual({ shanten: 99, tenpaiWaits: [] });
    expect(v.discardRisk).toEqual([]);
    expect(v.furiten.active).toBe(false);
    expect(v.melds).toEqual(view.melds);
    expect(v.kitaTiles).toEqual(view.kitaTiles);
    expect(v.discards).toEqual(["s3"]);
    expect(v.opponents).toEqual(view.opponents);
    expect(JSON.stringify(v)).not.toContain('"id":1');
    expect(JSON.stringify(v)).not.toContain('"id":2');
  });
});

describe("toSpectatorMessage", () => {
  const base = { characterNames: ["A", "B", "C"], gameId: 3, cues: [], canAbandon: false };

  it("결정 요청은 요청 자체를 지우고 기다리는 좌석만 알려 준다", () => {
    const out = parse(toSpectatorMessage(JSON.stringify({ type: "decision", request: { type: "discard", seat: 1, legalTileIds: [1, 2], riichiLegalTileIds: [1], discardUkeire: [{ kind: "m1" }], view }, ...base })));
    expect(out).toMatchObject({ type: "spectate", spectator: true, waitingFor: [1], canAbandon: true, gameId: 3 });
    expect(JSON.stringify(out)).not.toContain("legalTileIds");
    expect(JSON.stringify(out)).not.toContain("discardUkeire");
    expect(out.view.concealedTiles).toEqual([]);
  });

  it("장면(watch)과 국 결과는 view만 손패를 지운 채 그대로 보낸다", () => {
    const watch = parse(toSpectatorMessage(JSON.stringify({ type: "watch", view, actor: 0, actions: [{ seat: 0, action: "discard", tile: "z1" }], ...base })));
    expect(watch).toMatchObject({ type: "watch", spectator: true, actor: 0 });
    expect(watch.actions).toHaveLength(1);
    expect(watch.view.concealedTiles).toEqual([]);
    const end = parse(toSpectatorMessage(JSON.stringify({ type: "hand_end", event: { type: "hand_end" }, view, ...base })));
    expect(end).toMatchObject({ type: "hand_end", spectator: true });
    expect(end.view.hiddenCount).toBe(2);
  });

  it("게임 종료는 순위만 보내고 새 대국/다시 하기 구성은 보내지 않는다", () => {
    const out = parse(toSpectatorMessage(JSON.stringify({ type: "game_end", event: {}, handEvent: {}, standings: [{ player: 0 }], view, canStartNewGame: true, gameConfig: { opponents: ["x"] }, replayFile: "a.json", ...base })));
    expect(out.canStartNewGame).toBe(false);
    expect(out).not.toHaveProperty("gameConfig");
    expect(out).not.toHaveProperty("replayFile");
    expect(out.standings).toEqual([{ player: 0 }]);
  });

  it("로비(setup) 같은 관전과 무관한 메시지나 깨진 JSON은 보내지 않는다", () => {
    expect(toSpectatorMessage(JSON.stringify({ type: "setup" }))).toBeNull();
    expect(toSpectatorMessage("not json")).toBeNull();
    expect(toSpectatorMessage(JSON.stringify({ type: "decision", request: null }))).toBeNull();
  });
});
