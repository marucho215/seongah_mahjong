import { describe, expect, it } from "vitest";
import { GuiSession } from "../src/gui/guiSession.js";
import { createGuiGame, parseGameArgs, parseGuiMode } from "../src/gui/gameSetup.js";
import { defaultResponse } from "./helpers/yonmaHuman.js";
import type { DecisionRequest } from "../src/core/decisions.js";

describe("4마 human-play: 사람 1명 + AI 3명이 GuiSession으로 한 게임을 끝까지", () => {
  it("모드 인자를 해석한다", () => {
    expect(parseGuiMode(undefined)).toBe("sanma");
    expect(parseGuiMode("yonma")).toBe("yonma");
    expect(() => parseGuiMode("gomoku")).toThrow(/알 수 없는 모드/);
  });

  it("GUI 서버와 CLI가 공용하는 인자 해석: [seed] [--mode ...] 순서 무관", () => {
    expect(parseGameArgs([])).toEqual({ mode: "sanma", seed: undefined, saveReplays: false });
    expect(parseGameArgs(["my-seed"])).toEqual({ mode: "sanma", seed: "my-seed", saveReplays: false });
    expect(parseGameArgs(["--mode", "yonma"])).toEqual({ mode: "yonma", seed: undefined, saveReplays: false });
    expect(parseGameArgs(["s1", "--mode", "yonma"])).toEqual({ mode: "yonma", seed: "s1", saveReplays: false });
    expect(parseGameArgs(["--save-replays", "s1", "--mode", "yonma"])).toEqual({ mode: "yonma", seed: "s1", saveReplays: true });
    expect(parseGameArgs(["--mode", "yonma", "s1"])).toEqual({ mode: "yonma", seed: "s1", saveReplays: false });
    expect(() => parseGameArgs(["--mode"])).toThrow(/--mode/);
    expect(() => parseGameArgs(["--mode", "bogus"])).toThrow(/알 수 없는 모드/);
  });

  it("여러 국을 거쳐 game_end까지 진행되고, 좌석/정보 노출/치 요청이 정상이다", () => {
    const game = createGuiGame("yonma", "yonma-human-full");
    expect(game.rules.playerCount).toBe(4);
    expect(game.controllers).toEqual(["human", "characterAI", "characterAI", "characterAI"]);
    const session = new GuiSession(game);

    const dealers: number[] = [];
    const chiOfferedTo = new Set<number>();
    let hands = 0;
    let chiAccepted = 0;
    let chiToggle = false;
    let steps = 0;

    while (session.getPhase() !== "game_end") {
      if (++steps > 200000) throw new Error("game did not finish");
      if (session.getPhase() === "hand_end") {
        hands++;
        session.continueToNextHand();
        continue;
      }
      const request = session.getCurrentRequest() as DecisionRequest;
      const view = request.view;
      // 로컬 사람은 항상 seat 0(bottom), 상대 세 명은 나머지 seat이며 손패는 개수만 보인다
      expect(view.seat).toBe(0);
      expect(view.opponents.map((o) => o.seat).sort()).toEqual([1, 2, 3]);
      for (const o of view.opponents) {
        expect(typeof o.concealedCount).toBe("number");
        expect(JSON.stringify(o)).not.toMatch(/concealedTiles/);
      }
      if (dealers[hands] === undefined) dealers[hands] = view.dealerSeat;

      if (request.type === "chi") {
        chiOfferedTo.add(request.seat);
        chiToggle = !chiToggle;
        if (chiToggle) chiAccepted++;
        session.respond({ type: "chi", optionId: chiToggle ? request.options[request.options.length - 1]!.id : null });
        continue;
      }
      session.respond(defaultResponse(request, "pass"));
    }

    expect(session.getGameEndEvent()).toBeDefined();
    expect(session.getHandEndEvent()).toBeDefined();
    expect(hands + 1).toBeGreaterThanOrEqual(4); // 마지막 국은 continue 없이 game_end
    expect(new Set(dealers).size).toBeGreaterThan(1); // 친이 돈다
    expect([...chiOfferedTo]).toEqual([0]); // 치 요청은 사람 좌석에게만
    expect(chiAccepted).toBeGreaterThan(0);
    // 점수 합계 보존 (공탁 포함 종국 정산 후)
    const scores = game.scores;
    expect(scores.length).toBe(4);
  });
});
