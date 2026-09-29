// 사람끼리 대국 모드 (GameStateOptions.multiplayer, 친선전 B단계): 남이 내놓은 패에 반응할 수 있는 사람 모두에게 동시에 묻고(claim 묶음),
// 답은 기존 엔진 순서(론 우선 → 깡/퐁 → 치, 후리텐 등)로 적용한다. 장면은 사람 좌석마다 만든다. 끄면 지금까지와 같다.
import { describe, expect, it, vi } from "vitest";
import { FuritenTracker } from "../src/actions/furiten.js";
import { GameState } from "../src/core/GameState.js";
import { GuiSession } from "../src/gui/guiSession.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES, type RuleConfig } from "../src/rules/RuleConfig.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import { buildGameReplayRecord, replaySeatsFromGame } from "../src/sim/replayRecorder.js";
import { reproduceReplay } from "../src/replay/replayReproduction.js";
import type { ClaimDecisionRequest, ClaimDecisionResponse, SeatDecisionRequest, SeatDecisionResponse } from "../src/core/decisions.js";
import { ALL_HUMAN, J0, J2_PON, RonFixture, W } from "./helpers/ronFixture.js";

/** 좌석0이 p8을 버리면: 좌석1(W)은 p8 론(탕야오·핑후), 좌석2(J2_PON)는 p8 퐁이 가능하다 */
function ronVsPon(multiplayer: boolean, draws = ["p8", "z7", "z6", "z5"]) {
  const game = new RonFixture({ rules: DEFAULT_SANMA_RULES, seed: "multiplayer-claims", controllers: ALL_HUMAN, multiplayer }, { hands: [J0, W, J2_PON], draws });
  const session = new GuiSession(game);
  const first = session.getCurrentRequest()!;
  if (first.type !== "discard") throw new Error(`expected seat 0's discard, got ${first.type}`);
  const p8 = first.view.concealedTiles.find((t) => t.kind === "p8")!;
  session.respond({ type: "discard", tileId: p8.id, declareRiichi: false });
  return { game, session };
}

const claim = (choice: ClaimDecisionResponse["choice"], chiOptionId?: string): ClaimDecisionResponse => ({ type: "claim", choice, ...(chiOptionId ? { chiOptionId } : {}) });

describe("동시에 묻기 (고정 패)", () => {
  it("론 가능한 사람과 퐁 가능한 사람에게 한 번에 묻고, 한 사람만 답하면 엔진은 기다린다", () => {
    const { game, session } = ronVsPon(true);
    const current = session.getCurrentRequest()!;
    expect(current.type).toBe("multi");
    const requests = session.pendingSeatRequests() as ClaimDecisionRequest[];
    expect(requests.map((r) => [r.seat, !!r.ron, r.pon, r.daiminkan, r.chiOptions.length])).toEqual([
      [1, true, false, false, 0],
      [2, false, true, false, 0],
    ]);
    expect(requests[0]!.ron!.yaku.map((y) => y.name)).toEqual(expect.arrayContaining(["Tanyao", "Pinfu"]));
    // 각자 자기 손패만 보인다
    for (const r of requests) expect(r.view.seat).toBe(r.seat);

    const logLength = game.log.length;
    session.respond(claim("pon"), 2);
    expect(game.log.length).toBe(logLength); // 좌석1의 답을 기다린다
    expect(session.pendingSeatRequests().map((r) => r.seat)).toEqual([1]);
    expect(() => session.respond(claim("pon"), 2)).toThrow(/nothing to answer/); // 이미 답했다
    expect(() => session.respond(claim("pon"), 1)).toThrow(/pon is not an option/); // 좌석1에게 퐁은 없다
  });

  it("론이 퐁보다 우선한다: 퐁을 골랐어도 론이 나면 퐁은 없던 일이 된다", () => {
    const { game, session } = ronVsPon(true);
    session.respond(claim("pon"), 2);
    session.respond(claim("ron"), 1);
    const wins = game.log.filter((e) => e.type === "win");
    expect(wins.map((w) => (w.type === "win" ? [w.player, w.ronFrom] : null))).toEqual([[1, 0]]);
    expect(game.log.some((e) => e.type === "call")).toBe(false);
    expect(game.humanDecisionLog.map((d) => [d.seat, d.type, d.choice.choice])).toEqual([
      [0, "discard", undefined],
      [1, "claim", "ron"],
      [2, "claim", "pon"],
    ]);
  });

  it("론을 넘기면 후리텐이 되고, 퐁이 적용되어 퐁한 사람의 타패 차례가 된다", () => {
    const { game, session } = ronVsPon(true);
    session.respond(claim("pass"), 1);
    session.respond(claim("pon"), 2);
    expect(game.log.some((e) => e.type === "call" && e.call === "pon" && e.player === 2 && e.fromPlayer === 0)).toBe(true);
    const next = session.getCurrentRequest()!;
    expect(next.type === "discard" && next.seat).toBe(2);
    if (next.type === "discard") expect(next.view.opponents.find((o) => o.seat === 1)).toBeDefined();
  });

  it("둘 다 넘기면 아무 일도 없이 다음 좌석이 뽑는다 (론을 넘긴 것은 론 기회를 놓친 것으로 센다)", () => {
    const spy = vi.spyOn(FuritenTracker.prototype, "onMissedRonChance");
    const { game, session } = ronVsPon(true);
    session.respond(claim("pass"), 1);
    expect(spy).not.toHaveBeenCalled(); // 모두 답하기 전에는 아무것도 적용하지 않는다
    session.respond(claim("pass"), 2);
    expect(spy).toHaveBeenCalledTimes(1); // 좌석1의 론 패스 (일시 후리텐은 좌석1이 다음에 뽑을 때 풀린다 - 기존 규칙)
    spy.mockRestore();
    expect(game.log.some((e) => e.type === "call" || e.type === "win")).toBe(false);
    const next = session.getCurrentRequest()!;
    expect(next.type === "discard" && next.seat).toBe(1);
  });

  it("사람끼리 대국 모드가 아니면 지금까지처럼 한 좌석씩 차례로 묻는다 (론 먼저, 그다음 퐁)", () => {
    const { session } = ronVsPon(false);
    const first = session.getCurrentRequest()!;
    expect([first.type, first.type === "ron" && first.seat]).toEqual(["ron", 1]);
    session.respond({ type: "ron", declare: false });
    const second = session.getCurrentRequest()!;
    expect([second.type, second.type === "call_pon" && second.seat]).toEqual(["call_pon", 2]);
  });

  it("잘못된 답은 엔진에 넣지 않고 거절한다 (세션은 그대로)", () => {
    const { session } = ronVsPon(true);
    expect(() => session.respond(claim("chi", "p6-p7-p8"), 2)).toThrow(/chi option/);
    expect(() => session.respond({ type: "ron", declare: true } as SeatDecisionResponse, 1)).toThrow(/expected a "claim"/);
    expect(() => session.respond(claim("pass"))).toThrow(/say which seat/);
    expect(session.pendingSeatRequests()).toHaveLength(2);
  });
});

/** 사람 좌석의 결정적 응답: 버림은 legal 중 마지막, 리치/쯔모/론은 가능하면 선언, 울기는 번갈아 받아들인다(여러 경로를 거치게) */
function autoResponder() {
  let n = 0;
  return (request: SeatDecisionRequest): SeatDecisionResponse => {
    n++;
    switch (request.type) {
      case "discard":
        return { type: "discard", tileId: request.legalTileIds[request.legalTileIds.length - 1]!, declareRiichi: request.riichiLegalTileIds.includes(request.legalTileIds[request.legalTileIds.length - 1]!) };
      case "claim": {
        if (request.ron) return claim("ron");
        if (n % 3 === 0 && request.chiOptions.length > 0) return claim("chi", request.chiOptions[0]!.id);
        if (n % 2 === 0 && request.pon) return claim("pon");
        if (n % 5 === 0 && request.daiminkan) return claim("daiminkan");
        return claim("pass");
      }
      case "chi":
        return { type: "chi", optionId: null };
      case "ron":
      case "tsumo":
        return { type: request.type, declare: true };
      default:
        return { type: request.type, declare: false };
    }
  };
}

function playFullGame(rules: RuleConfig, controllers: ("human" | undefined)[], seed: string) {
  const profiles = controllers.map((c, i) => (c === "human" ? null : getCharacterProfile(["jegalmina", "jegalnahui", "byeonari", "seiyamouri"][i]!)));
  const game = new GameState({ rules, seed, controllers, characterProfiles: profiles, multiplayer: true });
  const session = new GuiSession(game);
  const respond = autoResponder();
  let multiSeen = 0;
  for (let guard = 0; session.getPhase() !== "game_end"; guard++) {
    if (guard > 200_000) throw new Error("game did not finish");
    if (session.getPhase() === "hand_end") {
      session.continueToNextHand();
      continue;
    }
    if (session.getCurrentRequest()!.type === "multi") multiSeen++;
    for (const request of session.pendingSeatRequests()) session.respond(respond(request), request.seat);
  }
  return { game, multiSeen, frames: session.takeFrames() };
}

describe("사람끼리 대국 한 판 전체", () => {
  for (const [name, rules, controllers] of [
    ["산마 사람 3명", DEFAULT_SANMA_RULES, ["human", "human", "human"]],
    ["4마 사람 2명 + AI 2명", MAJSOUL_YONMA_RULES, ["human", undefined, "human", undefined]],
  ] as const) {
    it(`${name}: 끝까지 두고, 같은 시드는 같은 대국이며, 리플레이로 정확히 재현된다`, () => {
      const a = playFullGame(rules, [...controllers], `multiplayer-${name}`);
      const b = playFullGame(rules, [...controllers], `multiplayer-${name}`);
      expect(a.multiSeen).toBeGreaterThan(0);
      expect(JSON.stringify(a.game.log)).toBe(JSON.stringify(b.game.log));
      expect(a.game.humanDecisionLog.some((d) => d.type === "claim")).toBe(true);
      // 장면은 사람 좌석마다 만들어진다
      const frameSeats = new Set(a.frames.map((f) => f.view.seat));
      expect([...frameSeats].sort()).toEqual(controllers.flatMap((c, i) => (c === "human" ? [i] : [])));

      const record = buildGameReplayRecord(a.game, "multiplayer-test", 0, replaySeatsFromGame(a.game));
      expect(record.meta.multiplayer).toBe(true);
      const reproduced = reproduceReplay(JSON.parse(JSON.stringify(record)));
      expect(reproduced.ok).toBe(true);
    }, 120_000);
  }

  it("사람끼리 대국 모드가 아닌 기록에는 meta.multiplayer 키가 없다 (기존 리플레이 바이트 그대로)", () => {
    const game = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "not-multiplayer", characterProfiles: ["jegalmina", "jegalnahui", "byeonari"].map(getCharacterProfile) });
    game.playGame();
    expect(buildGameReplayRecord(game, "x", 0, replaySeatsFromGame(game)).meta).not.toHaveProperty("multiplayer");
  }, 60_000);
});
