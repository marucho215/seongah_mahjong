/* 리플레이 뷰어용 재시뮬레이션. 리플레이 원본(시드, 규칙, 좌석 구성, 기록된 사람 결정)으로 현재 엔진에서 같은 대국을
 * 다시 진행하면서, 로그에 이벤트가 하나 추가될 때마다 그 순간의 표시용 상태(모든 좌석의 손패/멘츠/강/북, 도라 표시패,
 * 점수)를 복사해 둔다.
 *
 * - 원본은 읽기만 한다. 재현한 이벤트는 추가되는 즉시 원본의 같은 위치와 비교하고, 한 곳이라도 다르면 그 자리에서
 *   멈추고 "현재 엔진으로 정확히 재현할 수 없는 리플레이"로 돌려준다 (이후 상태를 추측으로 복원하지 않는다).
 *   끝까지 같더라도 이벤트 수, AI 판단 기록, 사람 결정 기록이 모두 원본과 같아야 재현 성공이다.
 * - 관찰은 재현용으로 새로 만든 GameState 인스턴스의 log.push에만 걸고, 엔진에서는 GameState.observeCurrentHands()
 *   (표시 전용 읽기 접근자)만 읽는다. 게임 진행/RNG/AI 판단에는 관여하지 않는다.
 * - 엔진은 상태를 먼저 바꾼 뒤 이벤트를 로그에 넣으므로, 이벤트가 추가된 순간의 상태가 곧 그 이벤트 직후의 상태다.
 * - AI 판단은 "이 이벤트가 추가되기 직전에 새로 기록된 판단"만 그 이벤트에 붙인다 (재현 중 실제 순서, 추측 없음). */
import { GameState, type ControllerKind } from "../core/GameState.js";
import type { AiDecisionEntry, GameEvent, MeldSnapshot, TileRef } from "../core/GameLog.js";
import type { DecisionRequest, DecisionResponse } from "../core/decisions.js";
import type { HumanDecisionEntry } from "../core/humanDecisionLog.js";
import { getCharacterProfile } from "../ai/characterProfiles.js";
import { GuiSession } from "../gui/guiSession.js";
import { tileToRef } from "../yaku/doraBreakdown.js";
import { meldToSnapshot } from "../yaku/winSnapshot.js";
import type { GameReplayRecord, ReplaySeatInfo } from "../sim/replayRecorder.js";

export interface ReplayDiscard {
  tile: TileRef;
  calledAway: boolean;
  riichi: boolean;
  tsumogiri: boolean;
}

export interface ReplaySeatState {
  concealed: TileRef[];
  melds: MeldSnapshot[];
  kita: TileRef[];
  discards: ReplayDiscard[];
  riichi: boolean;
}

/** 한 이벤트 직후의 표시용 상태. 국이 시작되기 전(게임 종료 이벤트 등)이면 table이 null일 수 있다. */
export interface ReplayTableState {
  seats: ReplaySeatState[];
  doraIndicators: TileRef[];
  scores: number[];
  roundWind: number;
  roundHandNumber: number;
  dealer: number;
  honba: number;
  kyotaku: number;
}

export interface ReplayStep {
  eventIndex: number;
  event: GameEvent;
  /** 이 이벤트가 속한 국 (hand_start의 handIndex). 첫 국 이전이면 -1. */
  handIndex: number;
  table: ReplayTableState | null;
  /** 이 이벤트가 추가되기 직전(앞 이벤트 이후)에 새로 기록된 AI 판단. */
  aiDecisions: AiDecisionEntry[];
}

export interface ReplayHandSummary {
  handIndex: number;
  roundWind: number;
  roundHandNumber: number;
  honba: number;
  /** steps 배열에서 이 국의 hand_start 위치와 hand_end 위치 */
  firstStep: number;
  lastStep: number;
  /** 화료(win), 유국(exhaustive_draw/abortive_draw) 이벤트의 steps 위치 */
  resultSteps: number[];
}

export type ReplayReproduction =
  | { ok: true; seats: ReplaySeatInfo[]; playerCount: number; steps: ReplayStep[]; hands: ReplayHandSummary[] }
  | { ok: false; reason: string; mismatchAtEvent: number | null };

class ReproductionMismatch extends Error {
  constructor(message: string, readonly eventIndex: number | null) {
    super(message);
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 기록된 사람 결정 요약(choice)을 엔진 응답으로 되돌린다. 요청 종류가 다르면 불일치. */
function responseFromRecorded(request: DecisionRequest, entry: HumanDecisionEntry): DecisionResponse {
  const choice = entry.choice;
  switch (request.type) {
    case "discard":
      return { type: "discard", tileId: choice.tileId as number, declareRiichi: choice.riichi === true };
    case "chi":
      return { type: "chi", optionId: (choice.optionId as string | null) ?? null };
    default:
      return { type: request.type, declare: choice.declare === true } as DecisionResponse;
  }
}

function tableState(game: GameState, doraIndicators: TileRef[]): ReplayTableState | null {
  const hands = game.observeCurrentHands();
  if (!hands) return null;
  return {
    seats: hands.map((h) => ({
      concealed: h.concealed.map(tileToRef),
      melds: h.melds.map(meldToSnapshot),
      kita: h.kitaTiles.map(tileToRef),
      discards: h.discards.map((d) => ({ tile: tileToRef(d.tile), calledAway: d.calledAway, riichi: d.isRiichiDeclaration, tsumogiri: d.tsumogiri })),
      riichi: h.riichi,
    })),
    doraIndicators: [...doraIndicators],
    scores: [...game.scores],
    roundWind: game.roundWind,
    roundHandNumber: game.roundHandNumber,
    dealer: game.dealerSeat,
    honba: game.honba,
    kyotaku: game.kyotaku,
  };
}

/** 리플레이를 현재 엔진으로 재현한다. 재현할 수 없으면 ok:false와 이유를 돌려준다 (예외를 던지지 않는다). */
export function reproduceReplay(record: GameReplayRecord): ReplayReproduction {
  try {
    return reproduceOrThrow(record);
  } catch (err) {
    if (err instanceof ReproductionMismatch) return { ok: false, reason: err.message, mismatchAtEvent: err.eventIndex };
    return { ok: false, reason: `재현 중 오류: ${err instanceof Error ? err.message : String(err)}`, mismatchAtEvent: null };
  }
}

function reproduceOrThrow(record: GameReplayRecord): ReplayReproduction & { ok: true } {
  const { meta } = record;
  if (!meta || typeof meta.gameSeed !== "string" || !meta.rules || !Array.isArray(meta.seats)) {
    throw new ReproductionMismatch("리플레이에 시드/규칙/좌석 정보가 없습니다", null);
  }
  const seats = meta.seats;
  if (seats.some((s) => s.kind === "customAI")) throw new ReproductionMismatch("customAI 좌석은 재현할 수 없습니다", null);
  const controllers: ControllerKind[] = seats.map((s) => s.kind);
  const characterProfiles = seats.map((s) => (s.characterId ? getCharacterProfile(s.characterId) : null));
  const game = new GameState({ rules: meta.rules, seed: meta.gameSeed, characterProfiles, controllers });

  const steps: ReplayStep[] = [];
  let handIndex = -1;
  let doraIndicators: TileRef[] = [];
  let aiSeen = 0;

  // 재현용 인스턴스의 log.push에만 관찰을 건다: 추가된 이벤트를 원본과 비교하고 표시용 상태를 복사한다.
  const log = game.log;
  const originalPush = log.push.bind(log);
  log.push = (...events: GameEvent[]): number => {
    const length = originalPush(...events);
    for (let i = length - events.length; i < length; i++) {
      const event = log[i]!;
      const expected = record.events[i];
      if (expected === undefined || !sameJson(event, expected)) {
        throw new ReproductionMismatch(`이벤트 ${i}번이 원본과 다릅니다 (원본: ${expected ? expected.type : "없음"}, 재현: ${event.type})`, i);
      }
      if (event.type === "hand_start") {
        handIndex = event.handIndex;
        doraIndicators = [];
      }
      if (event.type === "dora_indicator_revealed") doraIndicators = [...doraIndicators, event.indicator];
      const aiDecisions = game.aiDecisionLog.slice(aiSeen);
      aiSeen = game.aiDecisionLog.length;
      steps.push({ eventIndex: i, event, handIndex, table: tableState(game, doraIndicators), aiDecisions });
    }
    return length;
  };

  const humanDecisions = record.humanDecisions ?? [];
  if (controllers.includes("human")) {
    const session = new GuiSession(game);
    let next = 0;
    for (let guard = 0; session.getPhase() !== "game_end"; guard++) {
      if (guard > 1_000_000) throw new ReproductionMismatch("재현이 끝나지 않습니다", null);
      if (session.getPhase() === "hand_end") {
        session.continueToNextHand();
        continue;
      }
      const request = session.getCurrentRequest()!;
      const entry = humanDecisions[next++];
      if (!entry || entry.type !== request.type || entry.seat !== request.seat || entry.atEventIndex !== game.log.length) {
        throw new ReproductionMismatch(`사람 결정 ${next - 1}번이 원본 기록과 맞지 않습니다`, game.log.length);
      }
      session.respond(responseFromRecorded(request, entry));
    }
  } else {
    game.playGame();
  }

  if (game.log.length !== record.events.length) {
    throw new ReproductionMismatch(`이벤트 수가 다릅니다 (원본 ${record.events.length}, 재현 ${game.log.length})`, game.log.length);
  }
  if (!sameJson(game.aiDecisionLog, record.aiDecisions ?? [])) {
    throw new ReproductionMismatch("AI 판단 기록이 원본과 다릅니다", null);
  }
  if (controllers.includes("human") && !sameJson(game.humanDecisionLog, humanDecisions)) {
    throw new ReproductionMismatch("사람 결정 기록이 원본과 다릅니다", null);
  }

  return { ok: true, seats, playerCount: meta.rules.playerCount, steps, hands: summarizeHands(steps) };
}

function summarizeHands(steps: ReplayStep[]): ReplayHandSummary[] {
  const hands: ReplayHandSummary[] = [];
  steps.forEach((step, i) => {
    const e = step.event;
    if (e.type === "hand_start") {
      hands.push({ handIndex: e.handIndex, roundWind: e.roundWind, roundHandNumber: e.roundHandNumber, honba: e.honba, firstStep: i, lastStep: i, resultSteps: [] });
      return;
    }
    const current = hands.at(-1);
    if (!current) return;
    if (e.type === "game_end") return; // 게임 종료는 어느 국에도 속하지 않는다
    if (step.handIndex === current.handIndex) current.lastStep = i;
    if (e.type === "win" || e.type === "exhaustive_draw" || e.type === "abortive_draw") current.resultSteps.push(i);
  });
  return hands;
}
