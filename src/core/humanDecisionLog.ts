import type { DecisionRequest, DecisionResponse } from "./decisions.js";

/**
 * 사람이 내린 결정 한 건의 기록 (리플레이의 `humanDecisions`). AI의 `aiDecisions`와 대칭이지만 별도 배열이다.
 * 실제 결과(타패/울기/화료 등)는 이미 `events`에 남으므로, 여기에는 "무엇을 물었고 무엇을 골랐는가"와
 * 그 결정이 events의 어느 지점에서 내려졌는가만 담는다. 상대의 숨은 정보는 담지 않는다 (사람 자신의 패만).
 */
export interface HumanDecisionEntry {
  handIndex: number;
  seat: number;
  /** 결정이 내려진 시점의 events 길이. events[atEventIndex]가 이 결정의 결과로 처음 기록되는 이벤트다. */
  atEventIndex: number;
  type: DecisionRequest["type"];
  /** 종류별 요약 (예: discard -> { tile, tileId, riichi }, chi -> { optionId, sequence }, ron/tsumo -> { declare, ... }) */
  choice: Record<string, unknown>;
}

/** 요청과 응답을 리플레이용 요약으로 바꾼다. 요청 안의 view(숨은 정보 포함 가능)는 그대로 복사하지 않는다. */
export function summarizeHumanDecision(request: DecisionRequest, response: DecisionResponse): Record<string, unknown> {
  switch (request.type) {
    case "discard": {
      const r = response as Extract<DecisionResponse, { type: "discard" }>;
      const tile = request.view.concealedTiles.find((t) => t.id === r.tileId);
      return { tileId: r.tileId, tile: tile?.kind, riichi: r.declareRiichi };
    }
    case "chi": {
      const r = response as Extract<DecisionResponse, { type: "chi" }>;
      const option = request.options.find((o) => o.id === r.optionId);
      return {
        declare: r.optionId !== null,
        fromSeat: request.fromSeat,
        calledTile: request.discardedTile.kind,
        optionId: r.optionId,
        ...(option ? { sequence: option.sequence } : {}),
      };
    }
    case "ron": {
      const r = response as Extract<DecisionResponse, { type: "ron" }>;
      return { declare: r.declare, fromSeat: request.fromSeat, winningTile: request.winningTile.kind, context: request.context };
    }
    case "tsumo": {
      const r = response as Extract<DecisionResponse, { type: "tsumo" }>;
      return { declare: r.declare, winningTile: request.winningTile.kind };
    }
    case "nine_terminals": {
      const r = response as Extract<DecisionResponse, { type: "nine_terminals" }>;
      return { declare: r.declare, distinctTerminalKinds: request.distinctTerminalKinds };
    }
    default: {
      // call_pon / call_daiminkan / ankan / kakan / kita
      const r = response as Extract<DecisionResponse, { declare: boolean }>;
      return { declare: r.declare, tile: request.tileKind, ...(request.fromPlayer !== undefined ? { fromSeat: request.fromPlayer } : {}) };
    }
  }
}
