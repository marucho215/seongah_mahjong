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
  preview: {
    yaku: { name: string; han: number }[];
    han: number;
    fu: number;
    yakumanUnits: number;
    totalPoints: number;
  };
  view: PlayerView;
}

export interface RonDecisionResponse {
  type: "ron";
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

export type DecisionRequest = DiscardDecisionRequest | CallDecisionRequest | RonDecisionRequest | NineTerminalsDecisionRequest;
export type DecisionResponse = DiscardDecisionResponse | CallDecisionResponse | RonDecisionResponse | NineTerminalsDecisionResponse;
