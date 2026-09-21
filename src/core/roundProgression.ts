import type { RuleConfig } from "../rules/RuleConfig.js";
import { allSeats, nextSeat, seatDistance } from "./seats.js";

type ProgressionRules = Pick<
  RuleConfig,
  "playerCount" | "gameLength" | "handsPerRound" | "targetScore" | "automaticDealerEnd"
>;

export interface RoundProgressionInput {
  rules: ProgressionRules;
  scores: readonly number[];
  dealerSeat: number;
  roundWind: number;
  roundHandNumber: number;
  honba: number;
  dealerRepeats: boolean;
  isExhaustiveDraw: boolean;
  allowDealerEnd: boolean;
}

export interface RoundProgressionDecision {
  nextDealer: number;
  nextRoundWind: number;
  nextRoundHandNumber: number;
  nextHonba: number;
  tobiTriggered: boolean;
  dealerContinuationPending: boolean;
  dealerEndTriggered: boolean;
}

/**
 * Computes the next round-state snapshot after settlement has already updated scores.
 * It does not settle points, mutate state, or decide the final game_end reason.
 */
export function computeRoundProgression(input: RoundProgressionInput): RoundProgressionDecision {
  const {
    rules,
    scores,
    dealerSeat,
    roundWind,
    roundHandNumber,
    honba,
    dealerRepeats,
    isExhaustiveDraw,
    allowDealerEnd,
  } = input;
  const nextHonba = isExhaustiveDraw ? honba + 1 : dealerRepeats ? honba + 1 : 0;
  let nextDealer = dealerSeat;
  let nextRoundWind = roundWind;
  let nextRoundHandNumber = roundHandNumber;
  if (!dealerRepeats) {
    nextDealer = nextSeat(dealerSeat, rules.playerCount);
    nextRoundHandNumber++;
    if (nextRoundHandNumber > rules.handsPerRound) {
      nextRoundHandNumber = 1;
      nextRoundWind++;
    }
  }

  const maxNormalWind = rules.gameLength === "east" ? 1 : 2;
  const atRoundLastHand = roundHandNumber === rules.handsPerRound;
  const leader = allSeats(rules.playerCount).sort(
    (a, b) => scores[b]! - scores[a]! ||
      seatDistance(0, a, rules.playerCount) - seatDistance(0, b, rules.playerCount)
  )[0]!;
  const dealerEndTriggered =
    allowDealerEnd &&
    rules.automaticDealerEnd &&
    dealerRepeats &&
    atRoundLastHand &&
    roundWind >= maxNormalWind &&
    leader === dealerSeat &&
    scores[dealerSeat]! >= rules.targetScore;

  return {
    nextDealer,
    nextRoundWind,
    nextRoundHandNumber,
    nextHonba,
    tobiTriggered: scores.some((score) => score < 0),
    dealerContinuationPending: dealerRepeats && !dealerEndTriggered,
    dealerEndTriggered,
  };
}
