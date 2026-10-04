import type { TileKind } from "./tiles.js";
import type { PlayerView, WaitInfo } from "./playerView.js";
import type { DiscardUkeire } from "../ai/discardUkeire.js";
import type { TileRef } from "./GameLog.js";

/** A normal turn discard, optionally combined with declaring riichi on it - riichi is a
 *  property of a specific discard, not a separate decision, so the two are answered
 *  together in one response. `legalTileIds`/`riichiLegalTileIds` are exactly what this seat
 *  may physically discard / may discard while declaring riichi (already checked against
 *  concealment, tenpai-after-discard, score, and live-wall-count) - the caller cannot
 *  construct an illegal combination the engine will silently accept. */
export interface DiscardDecisionRequest {
  type: "discard";
  seat: number;
  legalTileIds: number[];
  riichiLegalTileIds: number[];
  /** 리치 가능한 각 버림패를 골랐을 때의 대기패 미리보기 (엔진의 기존 대기 계산). riichiLegalTileIds와 같은 패들만 담는다.
   *  내 손패에서만 계산되므로 숨은 정보를 더하지 않는다. */
  riichiWaits: { tileId: number; waits: WaitInfo[] }[];
  /** 손패 종류별로 "그 패를 버리면 샹텐이 몇이고 어떤 패가 유효패인가" (GUI "유효패 표시"용, 표시 전용). 내 손패와 공개 정보만으로
   *  계산하며 리플레이에는 담기지 않는다. 리치 후처럼 고를 수 없는 요청에는 없다. */
  discardUkeire?: DiscardUkeire[];
  /** 이번 차례에 뽑은 패의 id (쯔모/영상패 뒤의 타패일 때만). 퐁/치/대명깡 직후의 타패처럼 뽑은 패가 없으면 없다.
   *  엔진이 쯔모기리 판정에 쓰는 것과 같은 패이며, GUI 자동 쯔모기리가 이 값만 쓴다 (GUI가 손패 순서로 추측하지 않는다). */
  drawnTileId?: number;
  /** Seat-filtered snapshot for a UI/HumanController to render - no opponent concealed
   *  tile ever appears in it (see PlayerView). Bundled with every request rather than
   *  requiring a separate "peek at current state" call, since a hand in progress has no
   *  other externally reachable state between decision points. */
  view: PlayerView;
}

export interface DiscardDecisionResponse {
  type: "discard";
  tileId: number;
  declareRiichi: boolean;
}

/** One yes/no opportunity, answered individually in exactly the order/priority the engine
 *  already evaluates it for AI seats - never a combined "menu" of unrelated opportunities.
 *  `call_pon`/`call_daiminkan` are offered on someone else's discard (`fromPlayer` is who
 *  discarded it); `ankan`/`kakan`/`kita` are offered on this seat's own turn. */
export interface CallDecisionRequest {
  type: "call_pon" | "call_daiminkan" | "ankan" | "kakan" | "kita";
  seat: number;
  tileKind: TileKind;
  fromPlayer?: number;
  view: PlayerView;
}

export interface CallDecisionResponse {
  type: CallDecisionRequest["type"];
  declare: boolean;
}

/** Which situation produced this ron chance - the same physical rule (a completed hand off
 *  someone else's tile) but different circumstances a UI may want to word differently. */
export type RonDecisionContext = "discard" | "riichi_discard" | "kita" | "chankan" | "kokushi_ankan";

/** 엔진이 이미 계산한 화료 결과 요약 (론/쯔모 공통). UI는 이것을 표시만 하고 다시 계산하지 않는다. */
export interface WinPreview {
  yaku: { name: string; han: number }[];
  han: number;
  fu: number;
  yakumanUnits: number;
  totalPoints: number;
}

/** A valid ron chance (shape complete, at least one yaku, not furiten) offered to a human seat.
 *  `preview` is the engine's own already-computed scoring of that exact ron (the same result
 *  finishHandWithWin would settle) - a UI must display it, never recompute it. Passing
 *  (`declare: false`) is a genuine missed ron chance and applies temporary/riichi furiten
 *  exactly as FuritenTracker.onMissedRonChance() always has. Never asked of a furiten seat. */
export interface RonDecisionRequest {
  type: "ron";
  seat: number;
  fromSeat: number;
  winningTile: TileRef;
  context: RonDecisionContext;
  preview: WinPreview;
  view: PlayerView;
}

export interface RonDecisionResponse {
  type: "ron";
  declare: boolean;
}

/** 사람 좌석이 스스로 뽑은 패(일반/영상/북 대체 패 포함)로 유효한 쯔모 화료가 될 때만 나온다.
 *  `declare: true`면 기존 쯔모 정산, false면 화료하지 않고 그 차례를 그대로 이어간다 (리치 중이면 기존 리치 제한
 *  그대로). 쯔모를 넘기는 것은 론 패스가 아니므로 후리텐과 무관하다. AI 좌석은 기존처럼 자동 쯔모하며 이 요청을 받지 않는다. */
export interface TsumoDecisionRequest {
  type: "tsumo";
  seat: number;
  winningTile: TileRef;
  preview: WinPreview;
  view: PlayerView;
}

export interface TsumoDecisionResponse {
  type: "tsumo";
  declare: boolean;
}

/** The 九種九牌 abortive-draw option: offered only to a human seat, only on its own first
 *  draw when the hand really has 9+ distinct terminal/honor kinds (same eligibility as ever).
 *  `declare: true` aborts the hand; false plays on. AI seats still use
 *  GameStateOptions.nineTerminalsPolicy and never see this request. */
export interface NineTerminalsDecisionRequest {
  type: "nine_terminals";
  seat: number;
  distinctTerminalKinds: number;
  view: PlayerView;
}

export interface NineTerminalsDecisionResponse {
  type: "nine_terminals";
  declare: boolean;
}

/** 치 후보 하나. 엔진이 chiCandidatesForDiscard로 계산한 합법 후보만 담긴다 (UI/CLI는 조합을 계산하지 않는다).
 *  `id`는 요청 안에서 유일하다 (sequence를 "-"로 이은 값, 예: "s2-s3-s4"). `consumeTileIds`는 손에서 실제로
 *  꺼내지는 두 장의 id (엔진이 applyChi에서 고르는 바로 그 패). */
export interface ChiOption {
  id: string;
  sequence: [TileKind, TileKind, TileKind];
  consumeTileIds: [number, number];
}

/** 하가(다음 좌석)에서만 나오는 치 기회. 사람은 후보 중 하나를 고르거나 패스한다. 같은 버림패에 퐁/깡이 우선하면
 *  (엔진의 기존 우선순위) 이 요청은 발생하지 않는다. */
export interface ChiDecisionRequest {
  type: "chi";
  seat: number;
  fromSeat: number;
  discardedTile: TileRef;
  options: ChiOption[];
  view: PlayerView;
}

/** `optionId`는 요청의 options 중 하나의 id, 패스는 null. */
export interface ChiDecisionResponse {
  type: "chi";
  optionId: string | null;
}

export type DecisionRequest = DiscardDecisionRequest | CallDecisionRequest | RonDecisionRequest | NineTerminalsDecisionRequest | ChiDecisionRequest | TsumoDecisionRequest;
export type DecisionResponse = DiscardDecisionResponse | CallDecisionResponse | RonDecisionResponse | NineTerminalsDecisionResponse | ChiDecisionResponse | TsumoDecisionResponse;

/**
 * 사람이 2명 이상인 대국에서, 남이 내놓은 패 하나(버림패, 가깡 패, 북 빼기 패 등)에 대한 한 사람의 선택지를 한 번에 묻는다.
 * 여러 사람에게 동시에 묻기 위해서다: 차례로 물으면 "앞사람이 론을 고민한 시간" 때문에 뒷사람이 남의 선택지를 알게 된다.
 * 선택지는 엔진이 계산한 합법한 것만 담긴다(론은 후리텐이 아니고 역이 있을 때만, 울기는 리치 중이 아닐 때만).
 * 사람은 하나를 고르거나 넘긴다. 론을 넘기면(다른 선택 포함) 기존 론 패스와 똑같이 후리텐이 된다.
 * 실제 결과는 기존 엔진 순서(론 우선 → 깡/퐁 → 치, 아타마하네 등)로 정해진다 - 고른 것이 다른 사람의 우선 선택에 밀리면
 * 아무 일도 일어나지 않는다. 사람이 1명 이하인 대국은 이 요청을 쓰지 않는다(기존 ron/call_pon/chi 요청 그대로).
 */
export interface ClaimDecisionRequest {
  type: "claim";
  seat: number;
  fromSeat: number;
  tile: TileRef;
  context: RonDecisionContext;
  /** 론이 선택지일 때 엔진의 화료 결과 요약 */
  ron?: WinPreview;
  daiminkan: boolean;
  pon: boolean;
  /** 치 선택지 (4마에서 하가만). 없으면 빈 배열 */
  chiOptions: ChiOption[];
  view: PlayerView;
}
export type ClaimChoice = "pass" | "ron" | "daiminkan" | "pon" | "chi";
export interface ClaimDecisionResponse {
  type: "claim";
  choice: ClaimChoice;
  /** choice가 "chi"일 때 chiOptions 중 하나의 id */
  chiOptionId?: string;
}

/** 여러 사람에게 동시에 묻는 엔진 요청 (claim 여러 개). 응답은 같은 순서의 claim 응답 배열이다. */
export interface MultiDecisionRequest {
  type: "multi";
  requests: ClaimDecisionRequest[];
}
export interface MultiDecisionResponse {
  type: "multi";
  responses: ClaimDecisionResponse[];
}

/** 엔진(generator)이 내놓는 요청: 한 좌석의 결정, 또는 여러 좌석에 동시에 묻는 묶음 (claim은 항상 묶음 안에서만 나온다). */
export type EngineRequest = DecisionRequest | MultiDecisionRequest;
export type EngineResponse = DecisionResponse | MultiDecisionResponse;
/** 한 좌석이 답하는 요청 (묶음을 푼 것) */
export type SeatDecisionRequest = DecisionRequest | ClaimDecisionRequest;
export type SeatDecisionResponse = DecisionResponse | ClaimDecisionResponse;

/** claim 응답이 요청의 선택지와 맞는지 확인한다 (엔진에 넣기 전 검증, GuiSession과 엔진이 같이 쓴다). 맞지 않으면 이유. */
export function claimResponseProblem(request: ClaimDecisionRequest, response: unknown): string | null {
  const r = response as Partial<ClaimDecisionResponse> | null;
  if (r?.type !== "claim") return `expected a "claim" response, got "${String(r?.type)}"`;
  switch (r.choice) {
    case "pass":
      return null;
    case "ron":
      return request.ron ? null : "ron is not an option here";
    case "daiminkan":
      return request.daiminkan ? null : "daiminkan is not an option here";
    case "pon":
      return request.pon ? null : "pon is not an option here";
    case "chi":
      return request.chiOptions.some((o) => o.id === r.chiOptionId) ? null : `chi option "${String(r.chiOptionId)}" is not offered`;
    default:
      return `unknown claim choice "${String(r.choice)}"`;
  }
}
