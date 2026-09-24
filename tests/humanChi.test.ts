import { describe, expect, it } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { GuiSession } from "../src/gui/guiSession.js";
import { MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";
import { askChiDecision, runInteractiveHand } from "../src/cli/humanPlayDriver.js";
import { createScriptedIO } from "../src/cli/scriptedIO.js";
import { parseKind } from "../src/core/tiles.js";
import { defaultResponse, findChiRequest, newYonmaHumanGame } from "./helpers/yonmaHuman.js";
import type { DecisionRequest } from "../src/core/decisions.js";
import { createGuiGame } from "../src/gui/gameSetup.js";

type ChiRequest = Extract<DecisionRequest, { type: "chi" }>;

const SINGLE = (q: ChiRequest) => q.options.length === 1;
const MULTI = (q: ChiRequest) => q.options.length >= 2;

/** 고정 시드 (탐색 비용이 커서 고정): chi-3은 첫 국 안에 후보 2개 이상인 치 요청이 나오고,
 *  chi-0은 첫 치 요청의 후보가 하나다. */
function firstSeed(accept: (q: ChiRequest) => boolean): string {
  return accept === MULTI ? "chi-3" : "chi-0";
}

describe("human chi decision (yonma)", () => {
  it("치 요청은 하가(버린 사람의 다음 좌석)에게만 오고, 사람 좌석의 손에서 만들 수 있는 후보만 담긴다", () => {
    let seen = 0;
    for (let i = 0; i < 1; i++) {
      const found = findChiRequest(`chi-${i}`);
      if (!found) continue;
      seen++;
      const { request } = found;
      expect(request.seat).toBe((request.fromSeat + 1) % 4);
      expect(request.seat).toBe(0); // 사람 좌석
      expect(request.options.length).toBeGreaterThan(0);
      expect(new Set(request.options.map((o) => o.id)).size).toBe(request.options.length);
      const handIds = new Map(request.view.concealedTiles.map((t) => [t.id, t.kind]));
      for (const option of request.options) {
        expect(option.sequence).toContain(request.discardedTile.kind);
        const own = [...option.sequence];
        own.splice(own.indexOf(request.discardedTile.kind), 1);
        expect(option.consumeTileIds.map((id) => handIds.get(id)).sort()).toEqual(own.sort());
        const ranks = option.sequence.map((k) => parseKind(k).rank);
        expect(ranks[1]).toBe(ranks[0]! + 1);
        expect(ranks[2]).toBe(ranks[1]! + 1);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("사람이 하가가 아닌 좌석의 버림패에는 치 요청이 절대 나오지 않는다", () => {
    for (let i = 0; i < 1; i++) {
      const game = newYonmaHumanGame(`chi-scan-${i}`);
      const session = game.playHandInteractive();
      let step = session.next();
      while (!step.done) {
        const request = step.value;
        if (request.type === "chi") expect((request.fromSeat + 1) % 4).toBe(request.seat);
        step = session.next(defaultResponse(request, "pass"));
      }
    }
  });

  it("후보가 하나인 치와 여러 개인 치를 모두 볼 수 있다", () => {
    expect(findChiRequest(firstSeed(SINGLE), SINGLE)).not.toBeNull();
    expect(findChiRequest(firstSeed(MULTI), MULTI)).not.toBeNull();
  });

  it("패스하면 치 없이 정상 진행한다 (멜드 없음)", () => {
    const found = findChiRequest(firstSeed(MULTI), MULTI)!;
    const { session, request } = found;
    const step = session.next({ type: "chi", optionId: null });
    if (!step.done) expect(step.value.type).not.toBe("chi_after_pass_glitch");
    expect(found.game.log.some((e) => e.type === "call" && e.call === "chi" && e.player === request.seat)).toBe(false);
  });

  it("고른 후보대로 치 멜드가 만들어지고, 곧바로 쿠이카에가 금지된 패를 못 버린다", () => {
    const found = findChiRequest(firstSeed(MULTI), MULTI)!;
    const { session, request, game } = found;
    const chosen = request.options[request.options.length - 1]!;
    const step = session.next({ type: "chi", optionId: chosen.id });
    expect(step.done).toBe(false);
    const next = step.value as DecisionRequest;
    expect(next.type).toBe("discard");
    if (next.type !== "discard") return;
    const meld = next.view.melds.find((m) => m.type === "chi");
    expect(meld).toBeDefined();
    expect(meld!.tiles.map((t) => t.kind).sort()).toEqual([...chosen.sequence].sort());
    const chiLog = game.log.filter((e) => e.type === "call" && e.call === "chi" && e.player === request.seat);
    expect(chiLog.length).toBe(1);
    // 방금 친 패(같은 종류)는 지금 버릴 수 없다
    const forbiddenIds = next.view.concealedTiles.filter((t) => t.kind === request.discardedTile.kind).map((t) => t.id);
    for (const id of forbiddenIds) expect(next.legalTileIds).not.toContain(id);
    expect(next.riichiLegalTileIds).toEqual([]);
  });

  it("존재하지 않는 option id나 잘못된 응답 종류는 조용히 패스하지 않고 거절한다", () => {
    const seed = firstSeed(MULTI);
    expect(() => findChiRequest(seed, MULTI)!.session.next({ type: "chi", optionId: "not-an-option" })).toThrow(/not a legal chi option/);
    expect(() => findChiRequest(seed, MULTI)!.session.next({ type: "ron", declare: false })).toThrow(/expected a "chi" response/);
  });

  it("GuiSession은 엔진에 넣기 전에 잘못된 치 응답을 거절하고, 같은 요청이 유지된다", () => {
    const seed = firstSeed(MULTI);
    const session = new GuiSession(createGuiGame("yonma", seed));
    for (let guard = 0; guard < 3000; guard++) {
      const request = session.getCurrentRequest();
      if (session.getPhase() === "hand_end") {
        session.continueToNextHand();
        continue;
      }
      if (session.getPhase() !== "decision" || !request) break;
      if (request.type === "chi") {
        expect(() => session.respond({ type: "chi", optionId: "bogus" })).toThrow(/not one of the offered options/);
        expect(() => session.respond({ type: "chi", declare: true } as never)).toThrow(/not one of the offered options/);
        expect(() => session.respond({ type: "ron", declare: true })).toThrow(/expected a "chi" response/);
        expect(session.getCurrentRequest()).toBe(request);
        session.respond({ type: "chi", optionId: request.options[0]!.id });
        expect(session.getCurrentRequest()!.type).toBe("discard");
        return;
      }
      session.respond(defaultResponse(request, "pass"));
    }
    throw new Error("chi request never reached");
  });

  it("human 좌석이 없는 4마 게임은 치 요청 없이 기존처럼 끝까지 동기 진행된다 (playHand가 요청 없이 완주)", () => {
    const game = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "chi-ai-only" });
    game.playGame();
    expect(game.log.some((e) => e.type === "game_end")).toBe(true);
  });
});

describe("CLI chi", () => {
  const fake = (options: ChiRequest["options"]): ChiRequest =>
    ({
      type: "chi",
      seat: 0,
      fromSeat: 3,
      discardedTile: { kind: "s4", id: 1 },
      options,
      view: {} as ChiRequest["view"],
    }) as ChiRequest;
  const THREE: ChiRequest["options"] = [
    { id: "s2-s3-s4", sequence: ["s2", "s3", "s4"], consumeTileIds: [10, 11] },
    { id: "s3-s4-s5", sequence: ["s3", "s4", "s5"], consumeTileIds: [11, 12] },
    { id: "s4-s5-s6", sequence: ["s4", "s5", "s6"], consumeTileIds: [12, 13] },
  ];

  it("여러 후보를 번호로 보여주고, 고른 번호의 option id를 돌려준다", async () => {
    const io = createScriptedIO(() => "1");
    const response = await askChiDecision(fake(THREE), io);
    expect(response).toEqual({ type: "chi", optionId: "s3-s4-s5" });
    const text = io.transcript.join("\n");
    expect(text).toContain("치할 수 있습니다");
    expect(text).toContain("[0] 2삭 3삭 + 4삭");
    expect(text).toContain("[1] 3삭 5삭 + 4삭");
    expect(text).toContain("[2] 5삭 6삭 + 4삭");
    expect(text).toContain("[p] 패스");
    expect(text).not.toMatch(/tileId|consume/);
  });

  it("p는 패스, 범위를 벗어난 입력은 다시 묻는다", async () => {
    const answers = ["9", "x", "p"];
    const io = createScriptedIO((_p, n) => answers[n]!);
    expect(await askChiDecision(fake(THREE), io)).toEqual({ type: "chi", optionId: null });
    expect(io.transcript.filter((l) => l.includes("사이의 번호나 p(패스)를 입력하세요")).length).toBe(2);
  });

  it("실제 진행 중 치 요청에서 CLI가 후보를 보여주고 선택한 치가 적용된다", async () => {
    const game = newYonmaHumanGame("chi-0");
    const io = createScriptedIO((prompt, askCount) => {
      if (prompt.includes("치 조합 번호")) return "0";
      if (prompt.startsWith("Discard which tile?")) return String(askCount % 13);
      if (prompt.includes("론 하시겠습니까")) return "y";
      return "n";
    });
    await runInteractiveHand(game, io);
    expect(io.transcript.join("\n")).toContain("[0] ");
    expect(game.log.some((e) => e.type === "call" && e.call === "chi" && e.player === 0)).toBe(true);
  });
});
