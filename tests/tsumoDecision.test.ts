import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { GameState } from "../src/core/GameState.js";
import type { DecisionRequest, DecisionResponse } from "../src/core/decisions.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { GuiSession } from "../src/gui/guiSession.js";
import { createGuiServer } from "../src/gui/createGuiServer.js";
import { runInteractiveHand } from "../src/cli/humanPlayDriver.js";
import { createScriptedIO } from "../src/cli/scriptedIO.js";
import { ALL_HUMAN, J0, RonFixture, W } from "./helpers/ronFixture.js";
import type { TileKind } from "../src/core/tiles.js";

type Tsumo = Extract<DecisionRequest, { type: "tsumo" }>;

/** 사람 3명 고정 패 시나리오. 좌석 0/1/2가 차례로 뽑고, 좌석 1이 W(p5/p8 대기)로 두 번째 뽑기에 p8을 뽑아 쯔모한다.
 *  첫 순에 쯔모하면 천화/지화 역만이 되므로 한 바퀴 돌린 뒤에 쯔모하게 한다. */
const NORMAL = { hands: [J0, W, J0], draws: ["z2", "z6", "z7", "z4", "p8"] as TileKind[] };

function fixture(setup: ConstructorParameters<typeof RonFixture>[1], controllers = ALL_HUMAN): GameState {
  return new RonFixture({ rules: DEFAULT_SANMA_RULES, seed: "tsumo-decision", controllers }, setup);
}

/** 기본 응답: 마지막(방금 뽑은) 패를 버리고, 나머지 질문은 모두 거절/패스. 론과 쯔모는 받는다. */
function baseResponse(request: DecisionRequest): DecisionResponse {
  switch (request.type) {
    case "discard":
      return { type: "discard", tileId: request.view.concealedTiles.at(-1)!.id, declareRiichi: false };
    case "tsumo":
      return { type: "tsumo", declare: true };
    case "ron":
      return { type: "ron", declare: true };
    case "chi":
      return { type: "chi", optionId: null };
    default:
      return { type: request.type, declare: false };
  }
}

type Respond = (request: DecisionRequest) => DecisionResponse;

/** tsumo 요청이 나올 때까지 진행한다. */
function runToTsumo(game: GameState, respond: Respond = baseResponse) {
  const session = game.playHandInteractive();
  let step = session.next();
  while (!step.done) {
    if (step.value.type === "tsumo") return { session, request: step.value as Tsumo };
    step = session.next(respond(step.value));
  }
  throw new Error("tsumo request never appeared");
}

const winsOf = (game: GameState) => game.log.filter((e) => e.type === "win");

describe("human tsumo choice: 일반 draw", () => {
  it("유효한 쯔모에서만 요청이 나오고, 엔진이 계산한 preview와 뽑은 패를 담는다", () => {
    const { request } = runToTsumo(fixture(NORMAL));
    expect(request.seat).toBe(1);
    expect(request.winningTile.kind).toBe("p8");
    expect(request.preview.han).toBeGreaterThan(0);
    expect(request.preview.totalPoints).toBeGreaterThan(0);
    expect(request.preview.yaku.length).toBeGreaterThan(0);
    expect(request.view.seat).toBe(1);
  });

  it("쯔모를 선언하면 기존 쯔모 정산과 같다 (점수 = preview)", () => {
    const game = fixture(NORMAL);
    const { session, request } = runToTsumo(game);
    const step = session.next({ type: "tsumo", declare: true });
    expect(step.done).toBe(true);
    const wins = winsOf(game);
    expect(wins).toHaveLength(1);
    expect(wins[0]).toMatchObject({ type: "win", player: 1, isTsumo: true, points: request.preview.totalPoints });
  });

  it("넘기면 화료 없이 그 차례의 버릴 패 선택으로 이어지고, 후리텐이 생기지 않는다", () => {
    const game = fixture(NORMAL);
    const { session, request } = runToTsumo(game);
    const step = session.next({ type: "tsumo", declare: false });
    expect(step.done).toBe(false);
    const next = step.value as DecisionRequest;
    expect(next.type).toBe("discard");
    expect(next.seat).toBe(request.seat);
    expect((next as Extract<DecisionRequest, { type: "discard" }>).legalTileIds).toHaveLength(14);
    expect(winsOf(game)).toHaveLength(0);
    // 론 패스가 아니므로 어떤 후리텐도 새로 생기지 않는다
    expect(next.view.furiten).toMatchObject({ active: false, selfDiscard: false, temporary: false, riichi: false });
  });

  it("AI 좌석은 요청 없이 기존처럼 자동 쯔모한다", () => {
    const game = fixture(NORMAL, ["human", "simpleAI", "human"]);
    const session = game.playHandInteractive();
    let step = session.next();
    while (!step.done) {
      expect(step.value.type).not.toBe("tsumo");
      step = session.next(baseResponse(step.value));
    }
    const wins = winsOf(game);
    expect(wins).toHaveLength(1);
    expect(wins[0]).toMatchObject({ player: 1, isTsumo: true });
  });
});

describe("human tsumo choice: 리치 중", () => {
  it("리치 중에도 요청이 나오고, 넘기면 기존 리치 제한(뽑은 패 그대로 버림)이 유지되며 후리텐이 생기지 않는다", () => {
    const game = fixture(NORMAL);
    let riichiDeclared = false;
    const respond: Respond = (request) => {
      if (request.type === "discard" && request.seat === 1 && !riichiDeclared) {
        riichiDeclared = true;
        const drawn = request.view.concealedTiles.at(-1)!;
        expect(request.riichiLegalTileIds).toContain(drawn.id);
        return { type: "discard", tileId: drawn.id, declareRiichi: true };
      }
      return baseResponse(request);
    };
    const { session, request } = runToTsumo(game, respond);
    expect(request.seat).toBe(1);
    expect(request.view.riichi).toBe(true);

    const step = session.next({ type: "tsumo", declare: false });
    // 리치 중이므로 사람에게 버릴 패를 묻지 않고, 뽑은 p8을 그대로 버렸다
    const lastDiscardOf1 = game.log.filter((e) => e.type === "discard" && e.player === 1).at(-1)!;
    expect(lastDiscardOf1).toMatchObject({ tile: "p8", tsumogiri: true });
    expect(winsOf(game)).toHaveLength(0);
    if (!step.done) {
      expect(step.value.view.furiten.riichi).toBe(false);
      expect(step.value.view.furiten.temporary).toBe(false);
    }
  });
});

describe("human tsumo choice: 대체 패", () => {
  it("영상패(rinshan) 쯔모에서도 요청이 나온다", () => {
    const P9_KAN = ["p9", "p9", "p9", "p2", "p3", "p4", "s2", "s3", "s4", "s5", "s6", "s7", "s8"] as TileKind[];
    const game = fixture({ hands: [J0, P9_KAN, J0], draws: ["z2", "p9"], rinshan: ["s8"] });
    const respond: Respond = (request) => (request.type === "ankan" ? { type: "ankan", declare: true } : baseResponse(request));
    const { session, request } = runToTsumo(game, respond);
    expect(request.seat).toBe(1);
    expect(request.winningTile.kind).toBe("s8");
    expect(game.log.some((e) => e.type === "call" && e.call === "kan_closed" && e.player === 1)).toBe(true);
    expect(session.next({ type: "tsumo", declare: true }).done).toBe(true);
    expect(winsOf(game)[0]).toMatchObject({ player: 1, isTsumo: true });
  });

  it("가깡(shouminkan) 뒤 영상패 쯔모에서도 요청이 나온다", () => {
    // 좌석 1: p9 퐁 멜드 + 손패 10장(s8 단기 대기). p9를 뽑아 가깡하면 영상패 s8로 쯔모.
    const TEN = ["p2", "p3", "p4", "s2", "s3", "s4", "s5", "s6", "s7", "s8"] as TileKind[];
    const game = fixture({ hands: [J0, TEN, J0], draws: ["z2", "p9"], rinshan: ["s8"], ponMelds: [undefined, "p9", undefined] });
    const respond: Respond = (request) => (request.type === "kakan" ? { type: "kakan", declare: true } : baseResponse(request));
    const { session, request } = runToTsumo(game, respond);
    expect(request.seat).toBe(1);
    expect(request.winningTile.kind).toBe("s8");
    expect(game.log.some((e) => e.type === "call" && e.call === "kan_added" && e.player === 1)).toBe(true);
    // 넘기면 그 차례가 이어진다 (가깡은 이미 성립했으므로 버릴 패 선택으로)
    const step = session.next({ type: "tsumo", declare: false });
    expect(step.done).toBe(false);
    expect((step.value as DecisionRequest).type).not.toBe("tsumo");
    expect(winsOf(game)).toHaveLength(0);
  });

  it("북 대체 패(kita replacement) 쯔모에서도 요청이 나온다", () => {
    const game = fixture({ hands: [J0, W, J0], draws: ["z2", "z4"], kitaDraws: ["p8"] });
    const respond: Respond = (request) => (request.type === "kita" && request.seat === 1 ? { type: "kita", declare: true } : baseResponse(request));
    const { session, request } = runToTsumo(game, respond);
    expect(request.seat).toBe(1);
    expect(request.winningTile.kind).toBe("p8");
    expect(game.log.some((e) => e.type === "kita" && e.player === 1)).toBe(true);
    expect(session.next({ type: "tsumo", declare: true }).done).toBe(true);
    expect(winsOf(game)[0]).toMatchObject({ player: 1, isTsumo: true });
  });

  it("북 대체 패 쯔모를 넘기면 그 차례가 이어진다", () => {
    const game = fixture({ hands: [J0, W, J0], draws: ["z2", "z4"], kitaDraws: ["p8"] });
    const respond: Respond = (request) => (request.type === "kita" && request.seat === 1 ? { type: "kita", declare: true } : baseResponse(request));
    const { session } = runToTsumo(game, respond);
    const step = session.next({ type: "tsumo", declare: false });
    expect(step.done).toBe(false);
    expect((step.value as DecisionRequest).type).not.toBe("tsumo");
    expect(winsOf(game)).toHaveLength(0);
  });
});

describe("human tsumo choice: 응답 검증", () => {
  it("엔진은 다른 종류의 응답과 boolean이 아닌 declare를 조용히 넘기지 않고 거절한다", () => {
    expect(() => runToTsumo(fixture(NORMAL)).session.next({ type: "ron", declare: true })).toThrow(/expected a "tsumo" response/);
    expect(() => runToTsumo(fixture(NORMAL)).session.next({ type: "tsumo" } as never)).toThrow(/boolean "declare"/);
    expect(() => runToTsumo(fixture(NORMAL)).session.next({ type: "tsumo", declare: "yes" } as never)).toThrow(/boolean "declare"/);
  });

  it("GuiSession은 엔진에 넣기 전에 거절하고 같은 요청을 유지하며, 소비된 요청에 대한 중복 응답도 거절한다", () => {
    const session = new GuiSession(fixture(NORMAL));
    let request = session.getCurrentRequest()!;
    for (let guard = 0; request.type !== "tsumo" && guard < 50; guard++) {
      session.respond(baseResponse(request));
      request = session.getCurrentRequest()!;
    }
    expect(request.type).toBe("tsumo");
    expect(() => session.respond({ type: "ron", declare: true })).toThrow(/expected a "tsumo" response/);
    expect(() => session.respond({ type: "tsumo" } as never)).toThrow(/boolean "declare"/);
    expect(() => session.respond({ type: "tsumo", declare: 1 } as never)).toThrow(/boolean "declare"/);
    expect(session.getCurrentRequest()).toBe(request);

    session.respond({ type: "tsumo", declare: false });
    expect(session.getCurrentRequest()!.type).toBe("discard");
    // 이미 소비된 tsumo 요청에 다시 응답 -> 지금 요청(discard)과 종류가 달라 거절
    expect(() => session.respond({ type: "tsumo", declare: false })).toThrow(/expected a "discard" response/);
    expect(session.getCurrentRequest()!.type).toBe("discard");
  });
});

describe("human tsumo choice: CLI", () => {
  function script(answer: "y" | "n", stopAtDiscard = false) {
    let sawTsumoPrompt = false;
    return (prompt: string): string => {
      if (prompt.includes("쯔모하시겠습니까")) {
        sawTsumoPrompt = true;
        return answer;
      }
      if (prompt.startsWith("Discard which tile?")) {
        if (stopAtDiscard && sawTsumoPrompt) throw new Error("STOP-AFTER-TSUMO-PROMPT");
        return "13"; // 마지막(방금 뽑은) 패
      }
      if (prompt.includes("론 하시겠습니까")) return "y";
      return "n";
    };
  }

  it("y를 입력하면 쯔모 화료한다 (역/판/부/점수 표시)", async () => {
    const game = fixture(NORMAL);
    const io = createScriptedIO(script("y"));
    await runInteractiveHand(game, io);
    const text = io.transcript.join("\n");
    expect(text).toContain("쯔모 화료가 가능합니다");
    expect(text).toMatch(/판 \d+부/);
    expect(winsOf(game)[0]).toMatchObject({ player: 1, isTsumo: true });
  });

  it("n을 입력하면 화료하지 않고 곧바로 버릴 패 선택으로 이어진다", async () => {
    const game = fixture(NORMAL);
    const io = createScriptedIO(script("n", true));
    await expect(runInteractiveHand(game, io)).rejects.toThrow("STOP-AFTER-TSUMO-PROMPT");
    const lines = io.transcript;
    const tsumoAt = lines.findIndex((l) => l.includes("쯔모하시겠습니까"));
    const discardAt = lines.findIndex((l, i) => i > tsumoAt && l.startsWith("? Discard which tile?"));
    expect(tsumoAt).toBeGreaterThan(-1);
    expect(discardAt).toBeGreaterThan(tsumoAt);
    expect(winsOf(game)).toHaveLength(0);
  });
});

describe("human tsumo choice: 서버/재접속", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function firstMessage(baseUrl: string): Promise<{ type: string; request?: { type: string } }> {
    const stream = await fetch(`${baseUrl}/events`);
    const reader = stream.body!.getReader();
    let text = "";
    while (!/data: (.*)\n\n/.test(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      text += Buffer.from(value).toString("utf-8");
    }
    await reader.cancel();
    return JSON.parse(/data: (.*)\n\n/.exec(text)![1]!);
  }

  it("쯔모 요청 대기 중 새로고침/재접속하면 같은 요청이 복구된다", async () => {
    const game = fixture(NORMAL);
    const { server, session } = createGuiServer(game, { frameDelayMs: 0 });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;

    for (let guard = 0; session.getCurrentRequest()!.type !== "tsumo" && guard < 50; guard++) {
      session.respond(baseResponse(session.getCurrentRequest()!));
    }
    const first = await firstMessage(baseUrl);
    const second = await firstMessage(baseUrl);
    expect(first).toMatchObject({ type: "decision", request: { type: "tsumo" } });
    expect(second).toMatchObject({ type: "decision", request: { type: "tsumo" } });

    // 요청 상태는 응답 전까지 그대로이고, 넘긴 뒤에야 다음 결정(discard)으로 바뀐다
    const res = await fetch(`${baseUrl}/respond`, { method: "POST", body: JSON.stringify({ type: "tsumo", declare: false }) });
    expect(res.status).toBe(204);
    expect(await firstMessage(baseUrl)).toMatchObject({ type: "decision", request: { type: "discard" } });
  });
});
