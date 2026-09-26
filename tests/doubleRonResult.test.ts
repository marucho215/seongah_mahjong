import { describe, expect, it } from "vitest";
import type { DecisionRequest, DecisionResponse } from "../src/core/decisions.js";
import type { HandEndEvent } from "../src/core/GameLog.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { ronGame } from "./helpers/ronFixture.js";

/** 좌석 0은 뽑은 패를 버리고, 론 제안은 모두 받는다. 나머지는 거절/패스. */
function respond(request: DecisionRequest): DecisionResponse {
  switch (request.type) {
    case "discard":
      return { type: "discard", tileId: request.view.concealedTiles.at(-1)!.id, declareRiichi: false };
    case "ron":
      return { type: "ron", declare: true };
    case "chi":
      return { type: "chi", optionId: null };
    default:
      return { type: request.type, declare: false } as DecisionResponse;
  }
}

/** 더블 론 한 국을 끝까지 진행하고 hand_end 이벤트를 돌려준다 (결과 화면이 그리는 데이터). */
function playDoubleRon(): HandEndEvent {
  const game = ronGame(DEFAULT_SANMA_RULES); // [J0, W, W]: 좌석 0이 뽑은 p8을 버리면 좌석 1·2가 p5/p8 대기로 함께 론
  const session = game.playHandInteractive();
  let step = session.next();
  while (!step.done) step = session.next(respond(step.value));
  const handEnd = game.log.findLast((e) => e.type === "hand_end");
  if (!handEnd || handEnd.type !== "hand_end") throw new Error("no hand_end");
  return handEnd;
}

describe("더블 론 결과 (결과 화면이 쓰는 hand_end.result)", () => {
  it("화료자 두 명이 각자 손패 스냅샷/도라 내역/역을 갖고, 방총자와 점수 이동이 기록과 맞는다", () => {
    const handEnd = playDoubleRon();
    const result = handEnd.result!;
    expect(result.kind).toBe("agari");
    if (result.kind !== "agari") return;
    expect(result.winners.map((w) => w.winnerSeat).sort()).toEqual([1, 2]);
    for (const w of result.winners) {
      expect(w.method).toBe("ron");
      expect(w.loserSeat).toBe(0);
      expect(w.winningTile.kind).toBe("p8");
      expect(w.snapshot).toBeDefined();
      expect(w.snapshot!.winningTileSource).toBe("ron");
      expect(w.doraBreakdown).toBeDefined();
      expect(w.yaku.length).toBeGreaterThan(0);
      expect(w.totalPoints).toBeGreaterThan(0);
    }
    // 두 화료의 지불 합이 국 전체 점수 변화와 같다 (공탁이 없으므로)
    expect(result.kyotakuAwarded).toBe(0);
    const summed = [0, 1, 2].map((seat) => result.winners.reduce((acc, w) => acc + (w.paymentDeltas[seat] ?? 0), 0));
    const actual = [0, 1, 2].map((seat) => result.scoresAfterSettlement[seat]! - result.scoresBeforeSettlement[seat]!);
    expect(summed).toEqual(actual);
  });
});
