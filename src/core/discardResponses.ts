import type { RuleConfig } from "../rules/RuleConfig.js";
import { canChi } from "../actions/calls.js";
import { parseKind, type TileKind } from "./tiles.js";
import { nextSeat, seatDistance, seatsInTurnOrder } from "./seats.js";

export interface RonCandidate {
  type: "ron";
  seat: number;
}

export interface PonCandidate {
  type: "pon";
  seat: number;
  kind: TileKind;
}

export interface DaiminkanCandidate {
  type: "daiminkan";
  seat: number;
  kind: TileKind;
}

export interface ChiCandidate {
  type: "chi";
  seat: number;
  /** Complete three-tile sequence, ordered by rank. */
  sequence: [TileKind, TileKind, TileKind];
  /** The two tiles consumed from the caller's concealed hand. */
  consumedKinds: [TileKind, TileKind];
}

export type NonWinningCallCandidate = PonCandidate | DaiminkanCandidate | ChiCandidate;
export type DiscardResponseCandidate = RonCandidate | NonWinningCallCandidate;

export interface DiscardResponseInput {
  rules: RuleConfig;
  discarderSeat: number;
  discardedKind: TileKind;
  /** Concealed tile kinds indexed by seat. Hidden information stays inside the rules engine. */
  concealedKindsBySeat: readonly (readonly TileKind[])[];
  /** Seats already found legally eligible to ron by the win/furiten/yaku layer. */
  ronEligibleSeats?: readonly number[];
  /** Established-riichi seats cannot make open calls. Ron eligibility is unaffected. */
  riichiSeats?: readonly number[];
}

export type DiscardResponseResolution =
  | { type: "none" }
  | { type: "ron"; winners: RonCandidate[]; closestWinner: RonCandidate }
  | { type: "call"; seat: number; candidates: NonWinningCallCandidate[] };

function countKind(kinds: readonly TileKind[], kind: TileKind): number {
  let count = 0;
  for (const candidate of kinds) if (candidate === kind) count++;
  return count;
}

/** Every legal chi shape for one discard, ordered by sequence start rank. */
export function chiCandidatesForDiscard(
  rules: RuleConfig,
  callerSeat: number,
  concealedKinds: readonly TileKind[],
  discardedKind: TileKind
): ChiCandidate[] {
  if (!canChi(rules)) return [];
  const { suit, rank } = parseKind(discardedKind);
  if (suit === "z") return [];

  const result: ChiCandidate[] = [];
  for (let start = rank - 2; start <= rank; start++) {
    if (start < 1 || start + 2 > 9) continue;
    const sequence = [`${suit}${start}`, `${suit}${start + 1}`, `${suit}${start + 2}`] as [TileKind, TileKind, TileKind];
    const consumedKinds = sequence.filter((kind) => kind !== discardedKind) as [TileKind, TileKind];
    if (consumedKinds.every((kind) => countKind(concealedKinds, kind) >= 1)) {
      result.push({ type: "chi", seat: callerSeat, sequence, consumedKinds });
    }
  }
  return result;
}

/**
 * Generates structural response candidates only. AI preference is intentionally absent:
 * legality is resolved before any caller chooses among the surviving action options.
 */
export function generateDiscardResponseCandidates(input: DiscardResponseInput): DiscardResponseCandidate[] {
  const { rules, discarderSeat, discardedKind, concealedKindsBySeat } = input;
  const order = seatsInTurnOrder(discarderSeat, rules.playerCount);
  const ronEligible = new Set(input.ronEligibleSeats ?? []);
  const riichiSeats = new Set(input.riichiSeats ?? []);
  const result: DiscardResponseCandidate[] = [];

  for (const seat of order) {
    if (ronEligible.has(seat)) result.push({ type: "ron", seat });
  }
  for (const seat of order) {
    if (riichiSeats.has(seat)) continue;
    const concealed = concealedKindsBySeat[seat] ?? [];
    const matching = countKind(concealed, discardedKind);
    if (matching >= 3) result.push({ type: "daiminkan", seat, kind: discardedKind });
    if (matching >= 2) result.push({ type: "pon", seat, kind: discardedKind });
  }

  const chiSeat = nextSeat(discarderSeat, rules.playerCount);
  if (!riichiSeats.has(chiSeat)) {
    result.push(...chiCandidatesForDiscard(rules, chiSeat, concealedKindsBySeat[chiSeat] ?? [], discardedKind));
  }
  return result;
}

function callPriority(candidate: NonWinningCallCandidate): number {
  return candidate.type === "chi" ? 1 : 2;
}

function candidateTieOrder(candidate: NonWinningCallCandidate): string {
  if (candidate.type === "daiminkan") return "0";
  if (candidate.type === "pon") return "1";
  return `2:${candidate.sequence.join("-")}`;
}

/** Ron > pon/daiminkan > chi, with every tie ordered from the discarder clockwise. */
export function arbitrateDiscardResponses(
  discarderSeat: number,
  playerCount: number,
  candidates: readonly DiscardResponseCandidate[]
): DiscardResponseResolution {
  const rons = candidates
    .filter((candidate): candidate is RonCandidate => candidate.type === "ron")
    .sort((a, b) => seatDistance(discarderSeat, a.seat, playerCount) - seatDistance(discarderSeat, b.seat, playerCount));
  if (rons.length > 0) return { type: "ron", winners: rons, closestWinner: rons[0]! };

  const calls = candidates.filter((candidate): candidate is NonWinningCallCandidate => candidate.type !== "ron");
  if (calls.length === 0) return { type: "none" };
  const highestPriority = Math.max(...calls.map(callPriority));
  const highest = calls.filter((candidate) => callPriority(candidate) === highestPriority);
  const winningSeat = highest.reduce((closest, candidate) =>
    seatDistance(discarderSeat, candidate.seat, playerCount) < seatDistance(discarderSeat, closest, playerCount)
      ? candidate.seat
      : closest
  , highest[0]!.seat);
  const options = highest
    .filter((candidate) => candidate.seat === winningSeat)
    .sort((a, b) => candidateTieOrder(a).localeCompare(candidateTieOrder(b)));
  return { type: "call", seat: winningSeat, candidates: options };
}
