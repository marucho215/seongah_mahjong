// 화면에 주는 실제 도라 종류 (PlayerView.doraKinds, 리플레이 표시용 상태의 doraKinds): 공개된 표시패마다 엔진 nextDoraKind 결과.
// 화면은 이것을 "도라"로, 표시패는 따로 작게 보여 준다 (예전에는 표시패를 "도라"라고만 보여 줘 실제 도라를 알 수 없었다).
import { describe, expect, it } from "vitest";
import { createGuiGame } from "../src/gui/gameSetup.js";
import { GuiSession } from "../src/gui/guiSession.js";
import { nextDoraKind } from "../src/yaku/dora.js";
import { buildPlayerView } from "../src/core/playerView.js";
import { Hand } from "../src/core/Hand.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { reproduceReplay } from "../src/replay/replayReproduction.js";
import { humanRecord } from "./helpers/replayParityGames.js";
import { defaultResponse } from "./helpers/yonmaHuman.js";
import { tile } from "./helpers/ronFixture.js";

describe("실제 도라 종류", () => {
  it("산마: 1만 표시패의 도라는 9만, 9만은 1만 (엔진 규칙 그대로 view에 담긴다)", () => {
    const hands = [new Hand(), new Hand(), new Hand()];
    const view = buildPlayerView({
      seat: 0,
      hands,
      doraIndicators: [tile("m1"), tile("m9"), tile("z4")],
      doraKinds: ["m1", "m9", "z4"].map((k) => nextDoraKind(k, DEFAULT_SANMA_RULES)),
      scores: [35000, 35000, 35000],
      dealerSeat: 0,
      roundWind: 1,
      roundHandNumber: 1,
      honba: 0,
      kyotaku: 0,
      wallRemainingLive: 50,
    });
    expect(view.doraKinds).toEqual(["m9", "m1", "z1"]);
  });

  it("대국 중 사람에게 오는 view는 공개된 표시패마다 도라 종류를 같은 순서로 준다 (깡도라 포함)", () => {
    for (const mode of ["sanma", "yonma"] as const) {
      const game = createGuiGame(mode, `dora-kinds-${mode}`);
      const session = new GuiSession(game);
      let checked = 0;
      for (let steps = 0; session.getPhase() !== "game_end" && steps < 4000; steps++) {
        if (session.getPhase() === "hand_end") {
          session.continueToNextHand();
          continue;
        }
        const request = session.getCurrentRequest()!;
        const view = request.view;
        expect(view.doraKinds).toEqual(view.doraIndicators.map((t) => nextDoraKind(t.kind, game.rules)));
        checked++;
        session.respond(defaultResponse(request));
      }
      expect(checked).toBeGreaterThan(10);
    }
  }, 120_000);

  it("리플레이 표시용 상태도 같은 도라 종류를 준다", () => {
    const record = humanRecord("sanma", "dora-kinds-replay");
    const r = reproduceReplay(record);
    if (!r.ok) throw new Error(r.reason);
    const tables = r.steps.map((s) => s.table).filter((t) => t !== null);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) expect(t.doraKinds).toEqual(t.doraIndicators.map((d) => nextDoraKind(d.kind, record.meta.rules)));
  }, 120_000);
});
