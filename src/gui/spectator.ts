/* 친선전 방 관전: 대국의 한 좌석 시점 메시지에서 그 사람의 손패와 결정 요청을 지운 관전용 메시지를 만든다.
 * 관전자가 받는 것은 테이블에 모두 보이는 정보(강, 멘츠, 리치, 점수, 도라, 상대 손패 장수)뿐이다. 순수 함수라서 서버(createGuiServer)가
 * 보내기 직전에 적용하고, 이 모듈이 숨은 정보(손패, 대기, 위험도, 요청)를 모두 지우는지는 tests/spectator.test.ts가 지킨다. */

type Json = Record<string, unknown>;

/** 한 좌석 시점의 view에서 그 좌석의 비공개 정보를 지운다: 손패는 장수만(`hiddenCount`), 대기/샹텐/위험도/후리텐은 비운다. */
export function spectatorView(view: Json): Json {
  const concealed = Array.isArray(view.concealedTiles) ? (view.concealedTiles as unknown[]) : [];
  const {
    concealedTiles: _concealed,
    waits: _waits,
    handStatus: _handStatus,
    discardRisk: _risk,
    furiten: _furiten,
    ...rest
  } = view;
  void _concealed;
  void _waits;
  void _handStatus;
  void _risk;
  void _furiten;
  return {
    ...rest,
    concealedTiles: [],
    hiddenCount: concealed.length,
    waits: [],
    handStatus: { shanten: 99, tenpaiWaits: [] },
    discardRisk: [],
    furiten: { active: false, selfDiscard: false, temporary: false, riichi: false },
  };
}

/** 한 좌석 시점 메시지(문자열 JSON)를 관전용 메시지로. 관전자에게 보여 줄 수 없는 종류면 null. */
export function toSpectatorMessage(message: string): string | null {
  let msg: Json;
  try {
    msg = JSON.parse(message) as Json;
  } catch {
    return null;
  }
  const common = {
    spectator: true,
    canAbandon: true, // 관전 나가기 (/abandon)
    ...(msg.characterNames !== undefined ? { characterNames: msg.characterNames } : {}),
    ...(msg.ruleLabels !== undefined ? { ruleLabels: msg.ruleLabels } : {}),
    ...(msg.awaySeats !== undefined ? { awaySeats: msg.awaySeats } : {}),
    ...(msg.recent !== undefined ? { recent: msg.recent } : {}),
    ...(msg.gameId !== undefined ? { gameId: msg.gameId } : {}),
    ...(msg.cues !== undefined ? { cues: msg.cues } : {}),
    ...(msg.cueBase !== undefined ? { cueBase: msg.cueBase } : {}),
  };
  switch (msg.type) {
    case "watch":
      // 장면: 공개 행동과 그 순간의 작탁 (view만 손패를 지운다)
      return JSON.stringify({ ...msg, view: spectatorView(msg.view as Json), ...common });
    case "decision": {
      // 누군가의 결정을 기다리는 중: 요청 자체(선택지, 점수 미리보기)는 보내지 않는다
      const request = msg.request as Json | null;
      if (!request) return null;
      return JSON.stringify({ type: "spectate", view: spectatorView(request.view as Json), waitingFor: [request.seat], ...common });
    }
    case "waiting":
      return JSON.stringify({ type: "spectate", ...(msg.view ? { view: spectatorView(msg.view as Json) } : {}), waitingFor: msg.waitingFor ?? [], ...common });
    case "hand_end":
      return JSON.stringify({ type: "hand_end", event: msg.event, ...(msg.view ? { view: spectatorView(msg.view as Json) } : {}), ...common });
    case "game_end":
      // 새 대국/다시 하기/리플레이 링크는 참가자의 것이다
      return JSON.stringify({ type: "game_end", event: msg.event, handEvent: msg.handEvent, standings: msg.standings, ...(msg.view ? { view: spectatorView(msg.view as Json) } : {}), canStartNewGame: false, ...common });
    default:
      return null;
  }
}
