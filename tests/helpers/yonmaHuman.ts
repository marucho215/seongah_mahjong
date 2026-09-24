import { GameState } from "../../src/core/GameState.js";
import { createGuiGame } from "../../src/gui/gameSetup.js";
import type { DecisionRequest, DecisionResponse } from "../../src/core/decisions.js";

export function newYonmaHumanGame(seed: string): GameState {
  return createGuiGame("yonma", seed);
}

export type ChiPolicy = "pass" | "first" | "last";

/** 사람 좌석의 모든 요청에 대한 결정적 기본 응답. 치만 정책으로 고른다. */
export function defaultResponse(request: DecisionRequest, chi: ChiPolicy = "pass"): DecisionResponse {
  switch (request.type) {
    case "discard":
      return { type: "discard", tileId: request.legalTileIds[request.legalTileIds.length - 1]!, declareRiichi: false };
    case "chi": {
      if (chi === "pass") return { type: "chi", optionId: null };
      const option = chi === "first" ? request.options[0]! : request.options[request.options.length - 1]!;
      return { type: "chi", optionId: option.id };
    }
    case "ron":
      return { type: "ron", declare: true };
    default:
      return { type: request.type, declare: false };
  }
}

/** 첫 치 요청(조건 만족)이 나올 때까지 사람 좌석을 default로 진행한다. 못 찾으면 null. */
export function findChiRequest(
  seed: string,
  accept: (request: Extract<DecisionRequest, { type: "chi" }>) => boolean = () => true,
  maxHands = 6
): { game: GameState; session: Generator<DecisionRequest, void, DecisionResponse>; request: Extract<DecisionRequest, { type: "chi" }> } | null {
  const game = newYonmaHumanGame(seed);
  for (let hand = 0; hand < maxHands && !game.isGameOver(); hand++) {
    const session = game.playHandInteractive();
    let step = session.next();
    while (!step.done) {
      const request = step.value;
      if (request.type === "chi" && accept(request)) return { game, session, request };
      step = session.next(defaultResponse(request, "pass"));
    }
    game.updateGameContinuationStateAfterHand();
  }
  return null;
}
