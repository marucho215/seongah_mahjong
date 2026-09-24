import type { TileKind } from "./tiles.js";
import type { PlayerView } from "./playerView.js";
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
