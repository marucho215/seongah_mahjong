import { describe, expect, it } from "vitest";
import { GuiSession } from "../src/gui/guiSession.js";
import { createGuiGame } from "../src/gui/gameSetup.js";
import type { DecisionRequest, DecisionResponse } from "../src/core/decisions.js";

/** 퐁 제안은 받아들이고(울기 직후 타패 요청을 만들기 위해), 타패는 drawnTileId가 있으면 그 패, 없으면 첫 합법 패. */
function respond(request: DecisionRequest): DecisionResponse {
  switch (request.type) {
    case "discard":
      return { type: "discard", tileId: request.drawnTileId ?? request.legalTileIds[0]!, declareRiichi: false };
    case "call_pon":
      return { type: "call_pon", declare: true };
    case "chi":
      return { type: "chi", optionId: null };
    case "ron":
    case "tsumo":
      return { type: request.type, declare: true };
    default:
      return { type: request.type, declare: false } as DecisionResponse;
  }
}

describe("타패 요청의 drawnTileId (엔진이 알려주는 이번 차례 쯔모패)", () => {
  it("쯔모 뒤 타패에만 있고 직전 쯔모 패와 같으며, 그 패를 버리면 쯔모기리로 기록된다. 퐁 직후 타패에는 없다", () => {
    let afterDraw = 0;
    let afterCall = 0;
    for (const seed of ["drawn-tile-1", "drawn-tile-2", "drawn-tile-3", "drawn-tile-4"]) {
      const game = createGuiGame("sanma", seed);
      const session = new GuiSession(game);
      for (let steps = 0; session.getPhase() !== "game_end" && steps < 5000; steps++) {
        if (session.getPhase() === "hand_end") {
          session.continueToNextHand();
          continue;
        }
        const request = session.getCurrentRequest()!;
        if (request.type === "discard") {
          const last = [...game.log].reverse().find((e) => e.type === "draw" || e.type === "call" || e.type === "kita")!;
          if (request.drawnTileId !== undefined) {
            afterDraw++;
            expect(last.type).toBe("draw");
            if (last.type === "draw") {
              expect(last.player).toBe(request.seat);
              expect(request.view.concealedTiles.find((t) => t.id === request.drawnTileId)!.kind).toBe(last.tile);
            }
            const before = game.log.length;
            session.respond(respond(request));
            const discard = game.log.slice(before).find((e) => e.type === "discard");
            if (discard && discard.type === "discard") expect(discard.tsumogiri).toBe(true);
            continue;
          }
          // 뽑은 패가 없는 타패 요청은 울기(퐁) 직후뿐이다
          expect(last.type).toBe("call");
          afterCall++;
        }
        session.respond(respond(request));
      }
    }
    expect(afterDraw).toBeGreaterThan(20);
    expect(afterCall).toBeGreaterThan(0);
  }, 120_000);
});
