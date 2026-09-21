import { applyChi, applyDaiminkan, applyPon, canDaiminkan, canPon } from "../actions/calls.js";
import type { Hand, Meld } from "./Hand.js";
import type { Tile, TileKind } from "./tiles.js";
import type { Wall } from "./Wall.js";
import { chiCandidatesForDiscard, type DiscardResponseCandidate, type NonWinningCallCandidate } from "./discardResponses.js";
import { nextSeat } from "./seats.js";
import type { RuleConfig } from "../rules/RuleConfig.js";
import { forbiddenDiscardsAfterChi } from "../rules/kuikae.js";
import { recordPaoLiabilityAfterOpenCall } from "../rules/pao.js";

export interface DiscardResponseApplicationState {
  rules: RuleConfig;
  hands: Hand[];
  wall: Wall;
  currentPlayer: number;
  ippatsuEligible: boolean[];
  /** Physical discard ids already transferred into a meld. */
  appliedDiscardIds: Set<number>;
}

export interface AppliedDiscardResponse {
  candidate: NonWinningCallCandidate;
  meld: Meld;
  replacementTile?: Tile;
  currentPlayer: number;
  mustDiscard: true;
  /** One-use legality restriction for the caller's immediate post-chi discard. */
  forbiddenDiscardKinds: TileKind[];
}

function sameChiCandidate(a: NonWinningCallCandidate, b: NonWinningCallCandidate): boolean {
  return (
    a.type === "chi" &&
    b.type === "chi" &&
    a.seat === b.seat &&
    a.sequence.join(",") === b.sequence.join(",") &&
    a.consumedKinds.join(",") === b.consumedKinds.join(",")
  );
}

function assertCandidateStillLegal(
  state: DiscardResponseApplicationState,
  candidate: NonWinningCallCandidate,
  discarderSeat: number,
  discardedTile: Tile
): void {
  const hand = state.hands[candidate.seat];
  if (!hand) throw new Error(`applySelectedDiscardResponse: missing caller seat ${candidate.seat}`);
  if (candidate.seat === discarderSeat) throw new Error("applySelectedDiscardResponse: discarder cannot call own tile");

  if (candidate.type === "chi") {
    if (candidate.seat !== nextSeat(discarderSeat, state.rules.playerCount)) {
      throw new Error("applySelectedDiscardResponse: only the next seat may chi");
    }
    const legal = chiCandidatesForDiscard(
      state.rules,
      candidate.seat,
      hand.concealed.map((tile) => tile.kind),
      discardedTile.kind
    );
    if (!legal.some((option) => sameChiCandidate(option, candidate))) {
      throw new Error("applySelectedDiscardResponse: selected chi sequence is not legal");
    }
    return;
  }
  if (candidate.kind !== discardedTile.kind) {
    throw new Error("applySelectedDiscardResponse: candidate kind does not match the discard");
  }
  if (candidate.type === "pon" && !canPon(hand, discardedTile.kind)) {
    throw new Error("applySelectedDiscardResponse: pon is no longer legal");
  }
  if (candidate.type === "daiminkan") {
    if (!canDaiminkan(hand, discardedTile.kind)) {
      throw new Error("applySelectedDiscardResponse: daiminkan is no longer legal");
    }
    if (!state.wall.canDrawRinshan(state.rules.maxKans)) {
      throw new Error("applySelectedDiscardResponse: no legal daiminkan replacement remains");
    }
  }
}

/**
 * Commits one arbitrated non-winning response. It never chooses legality, priority, or AI
 * preference; those are completed before this mutation boundary.
 */
export function applySelectedDiscardResponse(
  state: DiscardResponseApplicationState,
  candidate: DiscardResponseCandidate,
  discarderSeat: number,
  discardedTile: Tile
): AppliedDiscardResponse {
  if (candidate.type === "ron") {
    throw new Error("Ron application requires the unsupported yonma scoring path");
  }
  if (state.appliedDiscardIds.has(discardedTile.id)) {
    throw new Error("applySelectedDiscardResponse: discard was already applied");
  }
  assertCandidateStillLegal(state, candidate, discarderSeat, discardedTile);

  const callerHand = state.hands[candidate.seat]!;
  let meld: Meld;
  let replacementTile: Tile | undefined;
  if (candidate.type === "chi") {
    meld = applyChi(callerHand, discardedTile, discarderSeat, candidate.consumedKinds);
  } else if (candidate.type === "pon") {
    meld = applyPon(callerHand, discardedTile, discarderSeat);
  } else {
    meld = applyDaiminkan(callerHand, discardedTile, discarderSeat);
    state.wall.commitKan("after-discard");
    replacementTile = state.wall.drawCommittedRinshan();
    callerHand.addDrawn(replacementTile);
  }

  if (candidate.type === "pon" || candidate.type === "daiminkan") {
    recordPaoLiabilityAfterOpenCall(callerHand, meld.type, discardedTile.kind, discarderSeat);
  }

  state.hands[discarderSeat]!.markDiscardCalledAway(discardedTile.id);
  state.appliedDiscardIds.add(discardedTile.id);
  state.ippatsuEligible.fill(false);
  state.currentPlayer = candidate.seat;
  return {
    candidate,
    meld,
    ...(replacementTile ? { replacementTile } : {}),
    currentPlayer: candidate.seat,
    mustDiscard: true,
    forbiddenDiscardKinds:
      candidate.type === "chi" ? forbiddenDiscardsAfterChi(state.rules, candidate, discardedTile.kind) : [],
  };
}
