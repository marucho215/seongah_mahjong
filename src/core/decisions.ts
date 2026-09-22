import type { TileKind } from "./tiles.js";
import type { PlayerView } from "./playerView.js";

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

export type DecisionRequest = DiscardDecisionRequest | CallDecisionRequest;
export type DecisionResponse = DiscardDecisionResponse | CallDecisionResponse;
