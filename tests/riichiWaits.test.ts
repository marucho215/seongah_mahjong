import { describe, expect, it } from "vitest";
import type { GameState } from "../src/core/GameState.js";
import type { DecisionRequest, DecisionResponse } from "../src/core/decisions.js";
import type { PlayerView } from "../src/core/playerView.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES, type RuleConfig } from "../src/rules/RuleConfig.js";
import { GuiSession } from "../src/gui/guiSession.js";
import type { TileKind } from "../src/core/tiles.js";
import { J0, RonFixture, W } from "./helpers/ronFixture.js";

const HUMAN3 = ["human", "human", "human"] as const;
const HUMAN4 = ["human", "human", "human", "human"] as const;

function fixture(rules: RuleConfig, hands: TileKind[][], draws: TileKind[]): GameState {
  const controllers = hands.length === 3 ? [...HUMAN3] : [...HUMAN4];
  return new RonFixture({ rules, seed: "riichi-waits", controllers }, { hands, draws });
}

/** 좌석 1이 첫 버림에서 리치한다. 론은 opts.passRon이면 넘기고, 나머지 질문은 거절/패스, 쯔모는 넘긴다. */
function makeRespond(opts: { passRon?: boolean } = {}) {
  let riichiDone = false;
  return (request: DecisionRequest): DecisionResponse => {
    switch (request.type) {
      case "discard": {
        const drawn = request.view.concealedTiles.at(-1)!;
        if (request.seat === 1 && !riichiDone) {
          riichiDone = true;
          return { type: "discard", tileId: drawn.id, declareRiichi: true };
        }
        return { type: "discard", tileId: drawn.id, declareRiichi: false };
      }
      case "ron":
        return { type: "ron", declare: !opts.passRon };
      case "tsumo":
        return { type: "tsumo", declare: false };
      case "chi":
        return { type: "chi", optionId: null };
      default:
        return { type: request.type, declare: false };
    }
  };
}

/** 요청을 순서대로 모두 모은다 (끝까지 가지 않고 predicate가 참인 요청에서 멈춘다). */
function collectUntil(game: GameState, respond: (r: DecisionRequest) => DecisionResponse, stop: (r: DecisionRequest) => boolean): DecisionRequest[] {
  const session = game.playHandInteractive();
  const seen: DecisionRequest[] = [];
  let step = session.next();
  while (!step.done) {
    seen.push(step.value);
    if (stop(step.value)) return seen;
    step = session.next(respond(step.value));
  }
  throw new Error("stop condition never reached");
}

const SANMA_DRAWS: TileKind[] = ["z2", "z6", "z7", "z4", "p8"];
const WAIT_KINDS = ["p5", "p8"];

describe("리치 대기패 표시 (엔진 계산)", () => {
  it("리치 전 버림 선택에서 리치 가능한 각 패의 대기 미리보기를 주고, 리치 후에는 view.waits로 계속 준다", () => {
    const game = fixture(DEFAULT_SANMA_RULES, [J0, W, J0], SANMA_DRAWS);
    const seen = collectUntil(game, makeRespond(), (r) => r.type === "tsumo");

    // 좌석 1의 첫 버림 요청: 아직 리치 전이므로 view.waits는 비어 있고, 뽑은 z6를 버리는 리치는 p5/p8 대기
    const firstDiscard = seen.find((r) => r.type === "discard" && r.seat === 1) as Extract<DecisionRequest, { type: "discard" }>;
    expect(firstDiscard.view.waits).toEqual([]);
    const drawn = firstDiscard.view.concealedTiles.at(-1)!;
    expect(firstDiscard.riichiLegalTileIds).toContain(drawn.id);
    expect(firstDiscard.riichiWaits.map((w) => w.tileId).sort()).toEqual([...firstDiscard.riichiLegalTileIds].sort());
    const preview = firstDiscard.riichiWaits.find((w) => w.tileId === drawn.id)!;
    expect([...preview.waits].sort()).toEqual(WAIT_KINDS);

    // 리치 후 좌석 1의 이후 요청(쯔모 요청 포함)은 대기패를 계속 담는다
    const after = seen.filter((r) => r.seat === 1 && r.view.riichi);
    expect(after.length).toBeGreaterThan(0);
    for (const r of after) expect([...r.view.waits].sort()).toEqual(WAIT_KINDS);
  });

  it("다른 좌석의 화면에는 대기패가 없고, 상대 대기 정보가 담기지 않는다 (숨은 정보 비노출)", () => {
    const game = fixture(DEFAULT_SANMA_RULES, [J0, W, J0], SANMA_DRAWS);
    const seen = collectUntil(game, makeRespond(), (r) => r.type === "tsumo");
    const others = seen.filter((r) => r.seat !== 1);
    expect(others.length).toBeGreaterThan(0);
    for (const r of others) {
      expect(r.view.waits).toEqual([]);
      expect(JSON.stringify(r.view.opponents)).not.toMatch(/waits/);
    }
    // 리치한 상대가 있어도 그 상대의 대기는 내 화면에서 알 수 없다 (리치 여부만 공개)
    const seat0AfterRiichi = others.filter((r) => r.seat === 0 && r.view.opponents.some((o) => o.seat === 1 && o.riichi));
    expect(seat0AfterRiichi.length).toBeGreaterThan(0);
    for (const r of seat0AfterRiichi) expect(r.view.waits).toEqual([]);
  });

  it("론을 넘겨 후리텐이 되면 대기는 그대로 보이고 view.furiten이 원인을 알려준다", () => {
    // 좌석 0이 p5를 버려 좌석 1(리치, p5 대기)의 론을 넘기게 한다
    const game = fixture(DEFAULT_SANMA_RULES, [J0, W, J0], ["z2", "z6", "z7", "p5", "p8"]);
    const seen = collectUntil(game, makeRespond({ passRon: true }), (r) => r.type === "tsumo");
    const tsumo = seen.at(-1)! as Extract<DecisionRequest, { type: "tsumo" }>;
    expect(tsumo.seat).toBe(1);
    expect([...tsumo.view.waits].sort()).toEqual(WAIT_KINDS);
    expect(tsumo.view.furiten.active).toBe(true);
    expect(tsumo.view.furiten.riichi).toBe(true);
  });

  it("4마에서도 같다", () => {
    const game = fixture(MAJSOUL_YONMA_RULES, [J0, W, J0, J0], ["z2", "z6", "z7", "z2", "z7", "p8"]);
    const seen = collectUntil(game, makeRespond(), (r) => r.type === "tsumo");
    const firstDiscard = seen.find((r) => r.type === "discard" && r.seat === 1) as Extract<DecisionRequest, { type: "discard" }>;
    const drawn = firstDiscard.view.concealedTiles.at(-1)!;
    expect([...firstDiscard.riichiWaits.find((w) => w.tileId === drawn.id)!.waits].sort()).toEqual(WAIT_KINDS);
    const tsumo = seen.at(-1)!;
    expect(tsumo.seat).toBe(1);
    expect([...tsumo.view.waits].sort()).toEqual(WAIT_KINDS);
    for (const r of seen.filter((s) => s.seat !== 1)) expect(r.view.waits).toEqual([]);
  });

  it("새로고침/재접속 후에도 같은 요청(대기 포함)이 복구된다", () => {
    const game = fixture(DEFAULT_SANMA_RULES, [J0, W, J0], SANMA_DRAWS);
    const session = new GuiSession(game);
    const respond = makeRespond();
    let request = session.getCurrentRequest()!;
    for (let guard = 0; request.type !== "tsumo" && guard < 60; guard++) {
      session.respond(respond(request));
      request = session.getCurrentRequest()!;
    }
    expect(request.type).toBe("tsumo");
    // 재접속은 같은 GuiSession의 현재 요청을 그대로 다시 보내므로, 두 번 읽어도 대기 정보가 같다
    const a = JSON.parse(JSON.stringify(session.getCurrentRequest()!.view)) as PlayerView;
    const b = JSON.parse(JSON.stringify(session.getCurrentRequest()!.view)) as PlayerView;
    expect(a.waits.sort()).toEqual(WAIT_KINDS);
    expect(b).toEqual(a);
  });
});
