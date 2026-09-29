/* 자리 비움 대행 (친선전 C단계): 시간이 다 되었거나 자리를 비운 사람의 결정을 중립 AI가 대신 내린다.
 * - 입력은 그 좌석이 받은 요청뿐이다(요청의 view = 그 사람이 볼 수 있는 정보). 상대 손패나 패산은 쓰지 않는다.
 * - 캐릭터 성향이 있는 CharacterAI가 아니라 SimpleAI(샹텐 우선, 리치한 상대가 있으면 현물 우선)의 타패 규칙을 쓴다.
 * - 응답은 사람이 낸 것과 같은 경로로 엔진에 들어가 사람 결정으로 기록된다 (리플레이가 그대로 재현된다).
 * 규칙: 버리기는 SimpleAI, 리치는 선언하지 않음, 론/쯔모는 선언(AI 좌석과 같음), 울기(퐁/깡/치)는 넘김, 암깡/가깡은 하지 않음,
 * 북 빼기는 함(SimpleAI와 같음), 구종구패는 선언하지 않음. */
import { Hand } from "../core/Hand.js";
import { parseKind, type Tile, type TileKind } from "../core/tiles.js";
import type { TileRef } from "../core/GameLog.js";
import type { SeatDecisionRequest, SeatDecisionResponse } from "../core/decisions.js";
import { chooseDiscard } from "../ai/simpleAI.js";

const toTile = (ref: TileRef): Tile => {
  const parsed = parseKind(ref.kind);
  return { id: ref.id, kind: ref.kind, suit: parsed.suit, rank: parsed.rank, isRed: ref.red === true };
};

export function substituteResponse(request: SeatDecisionRequest): SeatDecisionResponse {
  switch (request.type) {
    case "discard": {
      const view = request.view;
      const hand = new Hand();
      hand.dealIn(view.concealedTiles.map(toTile));
      // 샹텐 계산에는 멘츠 수만 쓰인다
      hand.melds = view.melds.map(() => ({ type: "pon" as const, tiles: [] }));
      const legal = new Set(request.legalTileIds);
      const forbiddenDiscardKinds = [...new Set(view.concealedTiles.filter((t) => !legal.has(t.id)).map((t) => t.kind))].filter(
        (kind) => !view.concealedTiles.some((t) => t.kind === kind && legal.has(t.id))
      ) as TileKind[];
      const riichiOpponentDiscardKinds = view.opponents.filter((o) => o.riichi).map((o) => o.discards);
      let tileId: number;
      try {
        tileId = chooseDiscard({ hand, riichiOpponentDiscardKinds, forbiddenDiscardKinds });
      } catch {
        tileId = request.legalTileIds.at(-1)!;
      }
      if (!legal.has(tileId)) tileId = request.drawnTileId !== undefined && legal.has(request.drawnTileId) ? request.drawnTileId : request.legalTileIds.at(-1)!;
      return { type: "discard", tileId, declareRiichi: false };
    }
    case "claim":
      return { type: "claim", choice: request.ron ? "ron" : "pass" };
    case "ron":
    case "tsumo":
      return { type: request.type, declare: true };
    case "chi":
      return { type: "chi", optionId: null };
    case "kita":
      return { type: "kita", declare: true };
    default:
      // call_pon / call_daiminkan / ankan / kakan / nine_terminals: 하지 않는다
      return { type: request.type, declare: false };
  }
}
