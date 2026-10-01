/* 일시(동순내) 후리텐이 풀리는 시점. 표준 규칙(작혼 포함): 화료패를 놓치면 "자기 다음 타패"까지 론할 수 없다.
 * 자기 쯔모로 풀리는 것은 물론이고, 쯔모 없이 퐁/치를 하고 버려도 그 타패로 풀린다. 남의 울기로 자기 쯔모가 건너뛰어지면
 * 자기가 버리기 전까지 계속 후리텐이다. 리치 중 놓치면 그 국 내내 후리텐이다. */
import { describe, expect, it } from "vitest";
import type { DecisionRequest, DecisionResponse } from "../src/core/decisions.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { FuritenTracker } from "../src/actions/furiten.js";
import { J0, RonFixture } from "./helpers/ronFixture.js";
import type { TileKind } from "../src/core/tiles.js";

// 좌석 2: s234 s567 m999 z11 p67 - p5/p8 텐파이지만 역이 없다 (멘젠 론, 탕야오/핑후 아님).
// z1(동, 장풍)을 퐁하고 m9를 버리면 s234 s567 m99 p67 + [z1 퐁] - 같은 p5/p8 대기에 역(장풍패)이 생긴다.
const X: TileKind[] = ["s2", "s3", "s4", "s5", "s6", "s7", "m9", "m9", "m9", "z1", "z1", "p6", "p7"];

function play(draws: TileKind[]) {
  const game = new RonFixture({ rules: DEFAULT_SANMA_RULES, seed: "furiten-timing", controllers: ["human", "human", "human"] }, { hands: [J0, J0, X], draws });
  const seen: DecisionRequest[] = [];
  const session = game.playHandInteractive();
  const respond = (r: DecisionRequest): DecisionResponse => {
    switch (r.type) {
      case "discard": {
        if (r.seat === 2) return { type: "discard", tileId: r.view.concealedTiles.find((t) => t.kind === "m9")!.id, declareRiichi: false };
        return { type: "discard", tileId: r.view.concealedTiles.at(-1)!.id, declareRiichi: false };
      }
      case "call_pon":
        return { type: "call_pon", declare: r.seat === 2 };
      case "ron":
        return { type: "ron", declare: true };
      case "tsumo":
        return { type: "tsumo", declare: false };
      case "chi":
        return { type: "chi", optionId: null };
      default:
        return { type: r.type, declare: false } as DecisionResponse;
    }
  };
  let step = session.next();
  for (let guard = 0; !step.done && guard < 200; guard++) {
    const request = step.value as DecisionRequest;
    seen.push(request);
    if (request.type === "ron") break;
    step = session.next(respond(request));
  }
  return { game, seen };
}

describe("일시 후리텐 해제 시점", () => {
  it("화료패를 놓친 뒤 쯔모 없이 퐁하고 버리면, 그 타패로 일시 후리텐이 풀려 다음 화료패에 론할 수 있다", () => {
    // 좌석 0이 p5(좌석 2의 화료패, 역 없음 → 일시 후리텐) → 좌석 1이 z1 → 좌석 2 퐁, m9 버림 → 좌석 0이 p8
    const { game, seen } = play(["p5", "z1", "p8"]);
    const events = game.log.map((e) => e.type === "discard" ? `${e.player}:${e.tile}` : e.type === "call" ? `call ${e.player}:${e.kind}` : null).filter(Boolean);
    expect(events).toEqual(["0:p5", "1:z1", "call 2:z1", "2:m9", "0:p8"]);
    const ron = seen.at(-1)!;
    expect(ron).toMatchObject({ type: "ron", seat: 2, fromSeat: 0, winningTile: { kind: "p8" } });
  });

  it("퐁하고 버리기 전(퐁 직후 타패 선택)에는 아직 일시 후리텐이다", () => {
    const { seen } = play(["p5", "z1", "p8"]);
    const afterPon = seen.find((r) => r.type === "discard" && r.seat === 2)!;
    expect(afterPon.view.furiten).toMatchObject({ active: true, temporary: true });
  });
});

describe("FuritenTracker.onOwnDiscard", () => {
  it("자기 타패로 일시 후리텐이 풀린다", () => {
    const tracker = new FuritenTracker();
    tracker.onMissedRonChance();
    tracker.onOwnDiscard();
    expect(tracker.isFuriten(["s6"], [])).toBe(false);
  });

  it("리치 중 놓친 후리텐은 타패로도 풀리지 않는다", () => {
    const tracker = new FuritenTracker();
    tracker.onDeclareRiichi();
    tracker.onMissedRonChance();
    tracker.onOwnDiscard();
    expect(tracker.isFuriten(["s6"], [])).toBe(true);
  });
});
