/* 대기패별 역 유무 (표시 전용 HandStatus.tenpaiWaits[].yaku): 엔진의 점수 계산을 평소 조건으로 돌려 정한다.
 * 역이 있으면 필드가 없고, 멘젠이라 쯔모만 되면 "tsumo_only", 론도 쯔모도 안 되면 "none". */
import { describe, expect, it } from "vitest";
import type { DecisionRequest, DecisionResponse } from "../src/core/decisions.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { J0, RonFixture, W } from "./helpers/ronFixture.js";
import type { TileKind } from "../src/core/tiles.js";

/** 좌석 2에게 처음 오는 요청까지 진행한다 (다른 좌석은 뽑은 패를 버리고, 울기/론은 하지 않는다). */
function firstRequestOfSeat2(hands: TileKind[][], draws: TileKind[], ponMelds?: (TileKind | undefined)[], filter: (r: DecisionRequest) => boolean = () => true) {
  const game = new RonFixture({ rules: DEFAULT_SANMA_RULES, seed: "wait-yaku", controllers: ["human", "human", "human"] }, { hands, draws, ...(ponMelds ? { ponMelds } : {}) });
  const session = game.playHandInteractive();
  let step = session.next();
  for (let guard = 0; !step.done && guard < 100; guard++) {
    const r = step.value as DecisionRequest;
    if (r.seat === 2 && filter(r)) return r;
    const response: DecisionResponse =
      r.type === "discard" ? { type: "discard", tileId: r.view.concealedTiles.at(-1)!.id, declareRiichi: false }
      : r.type === "chi" ? { type: "chi", optionId: null }
      : ({ type: r.type, declare: false } as DecisionResponse);
    step = session.next(response);
  }
  throw new Error("좌석 2의 요청이 오지 않았습니다");
}

const waitsOf = (r: DecisionRequest) => r.view.handStatus.tenpaiWaits.map((w) => ({ kind: w.kind, yaku: w.yaku }));

describe("대기패별 역 유무", () => {
  it("멘젠 텐파이인데 론으로는 역이 없으면 쯔모만 (멘젠쯔모)", () => {
    // s234 s567 m999 z11 p67: p5/p8 대기, 탕야오·핑후·역패 없음
    const X: TileKind[] = ["s2", "s3", "s4", "s5", "s6", "s7", "m9", "m9", "m9", "z1", "z1", "p6", "p7"];
    const r = firstRequestOfSeat2([J0, J0, X], ["p5", "z1"], undefined, (q) => q.type === "call_pon");
    expect(waitsOf(r)).toEqual([{ kind: "p5", yaku: "tsumo_only" }, { kind: "p8", yaku: "tsumo_only" }]);
  });

  it("울어서 역이 없는 텐파이는 역 없음", () => {
    // [s9 퐁] + p67 s234 s567 m99: p5/p8 대기, 울어서 멘젠쯔모도 없고 탕야오(s9, m9)·역패도 없다
    const Y: TileKind[] = ["p6", "p7", "s2", "s3", "s4", "s5", "s6", "s7", "m9", "m9"];
    const r = firstRequestOfSeat2([J0, J0, Y], [], [undefined, undefined, "s9"]);
    expect(waitsOf(r)).toEqual([{ kind: "p5", yaku: "none" }, { kind: "p8", yaku: "none" }]);
  });

  it("역이 있는 대기에는 표시가 없다 (멘젠 탕야오·핑후)", () => {
    const r = firstRequestOfSeat2([J0, J0, W], []);
    expect(waitsOf(r)).toEqual([{ kind: "p5", yaku: undefined }, { kind: "p8", yaku: undefined }]);
  });

  it("장풍패(동)를 퐁하면 같은 대기에 역이 생겨 표시가 사라진다", () => {
    const X: TileKind[] = ["s2", "s3", "s4", "s5", "s6", "s7", "m9", "m9", "m9", "z1", "z1", "p6", "p7"];
    const game = new RonFixture({ rules: DEFAULT_SANMA_RULES, seed: "wait-yaku", controllers: ["human", "human", "human"] }, { hands: [J0, J0, X], draws: ["p5", "z1", "s3"] });
    const session = game.playHandInteractive();
    let step = session.next();
    let ponDiscarded = false;
    let next: DecisionRequest | undefined;
    for (let guard = 0; !step.done && guard < 100; guard++) {
      const r = step.value as DecisionRequest;
      if (ponDiscarded && r.seat === 2) {
        next = r; // 퐁하고 m9를 버린 뒤 좌석 2가 받는 다음 요청 (다음 쯔모의 타패 등)
        break;
      }
      let response: DecisionResponse;
      if (r.type === "call_pon") response = { type: "call_pon", declare: r.seat === 2 };
      else if (r.type === "discard" && r.seat === 2) {
        response = { type: "discard", tileId: r.view.concealedTiles.find((t) => t.kind === "m9")!.id, declareRiichi: false };
        ponDiscarded = true;
      } else if (r.type === "discard") response = { type: "discard", tileId: r.view.concealedTiles.at(-1)!.id, declareRiichi: false };
      else if (r.type === "chi") response = { type: "chi", optionId: null };
      else response = { type: r.type, declare: false } as DecisionResponse;
      step = session.next(response);
    }
    expect(next).toBeDefined();
    expect(next!.view.melds.map((m) => m.type)).toEqual(["pon"]);
    expect(waitsOf(next!)).toEqual([{ kind: "p5", yaku: undefined }, { kind: "p8", yaku: undefined }]);
  });
});
