import { describe, expect, it } from "vitest";
import {
  arbitrateDiscardResponses,
  chiCandidatesForDiscard,
  generateDiscardResponseCandidates,
  type DiscardResponseCandidate,
} from "../src/core/discardResponses.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

function emptyYonmaHands(): string[][] {
  return [[], [], [], []];
}

describe("Phase 7D chi legality", () => {
  it("offers chi only to the immediately next seat", () => {
    const hands = emptyYonmaHands();
    hands[1] = ["m1", "m2"];
    hands[2] = ["m1", "m2"];
    hands[3] = ["m1", "m2"];
    const candidates = generateDiscardResponseCandidates({
      rules: MAJSOUL_YONMA_RULES,
      discarderSeat: 0,
      discardedKind: "m3",
      concealedKindsBySeat: hands,
    });
    expect(candidates.filter((candidate) => candidate.type === "chi").map((candidate) => candidate.seat)).toEqual([1]);
  });

  it("rejects honors and enumerates every legal suited sequence deterministically", () => {
    expect(chiCandidatesForDiscard(MAJSOUL_YONMA_RULES, 1, ["z1", "z2"], "z3")).toEqual([]);
    const candidates = chiCandidatesForDiscard(MAJSOUL_YONMA_RULES, 1, ["m2", "m3", "m4", "m6", "m7"], "m5");
    expect(candidates.map((candidate) => candidate.sequence)).toEqual([
      ["m3", "m4", "m5"],
      ["m4", "m5", "m6"],
      ["m5", "m6", "m7"],
    ]);
  });

  it("never creates a chi candidate under sanma rules", () => {
    expect(chiCandidatesForDiscard(DEFAULT_SANMA_RULES, 1, ["p1", "p2"], "p3")).toEqual([]);
  });

  it("excludes an established-riichi player from chi, pon, and daiminkan candidates", () => {
    const hands = emptyYonmaHands();
    hands[2] = ["s6", "s7", "s8", "s8", "s8"];
    const candidates = generateDiscardResponseCandidates({
      rules: MAJSOUL_YONMA_RULES,
      discarderSeat: 1,
      discardedKind: "s8",
      concealedKindsBySeat: hands,
      riichiSeats: [2],
      ronEligibleSeats: [2],
    });

    expect(candidates).toEqual([{ type: "ron", seat: 2 }]);
  });
});

describe("Phase 7D discard-response arbitration", () => {
  it("gives pon and daiminkan priority over chi", () => {
    const chi: DiscardResponseCandidate = { type: "chi", seat: 1, sequence: ["m1", "m2", "m3"], consumedKinds: ["m1", "m2"] };
    const pon: DiscardResponseCandidate = { type: "pon", seat: 2, kind: "m3" };
    const daiminkan: DiscardResponseCandidate = { type: "daiminkan", seat: 3, kind: "m3" };
    expect(arbitrateDiscardResponses(0, 4, [chi, pon])).toEqual({ type: "call", seat: 2, candidates: [pon] });
    expect(arbitrateDiscardResponses(0, 4, [chi, daiminkan])).toEqual({ type: "call", seat: 3, candidates: [daiminkan] });
    expect(arbitrateDiscardResponses(0, 4, [chi, daiminkan, pon])).toEqual({ type: "call", seat: 2, candidates: [pon] });
  });

  it("gives ron priority over every non-winning call", () => {
    const candidates: DiscardResponseCandidate[] = [
      { type: "chi", seat: 1, sequence: ["p1", "p2", "p3"], consumedKinds: ["p1", "p2"] },
      { type: "daiminkan", seat: 2, kind: "p3" },
      { type: "ron", seat: 3 },
    ];
    expect(arbitrateDiscardResponses(0, 4, candidates)).toEqual({
      type: "ron",
      winners: [{ type: "ron", seat: 3 }],
      closestWinner: { type: "ron", seat: 3 },
    });
  });

  it("keeps double and triple ron ordered by distance from the discarder", () => {
    const doubleRon = arbitrateDiscardResponses(2, 4, [
      { type: "ron", seat: 1 },
      { type: "ron", seat: 3 },
    ]);
    expect(doubleRon.type === "ron" ? doubleRon.winners.map((winner) => winner.seat) : []).toEqual([3, 1]);

    const tripleRon = arbitrateDiscardResponses(1, 4, [
      { type: "ron", seat: 0 },
      { type: "ron", seat: 3 },
      { type: "ron", seat: 2 },
    ]);
    expect(tripleRon.type === "ron" ? tripleRon.winners.map((winner) => winner.seat) : []).toEqual([2, 3, 0]);
    expect(tripleRon.type === "ron" ? tripleRon.closestWinner.seat : -1).toBe(2);
  });

  it("generates candidates in deterministic turn and action order", () => {
    const hands = emptyYonmaHands();
    hands[1] = ["s1", "s2"];
    hands[2] = ["s3", "s3"];
    hands[3] = ["s3", "s3", "s3"];
    const input = {
      rules: MAJSOUL_YONMA_RULES,
      discarderSeat: 0,
      discardedKind: "s3",
      concealedKindsBySeat: hands,
      ronEligibleSeats: [3, 1],
    } as const;
    expect(generateDiscardResponseCandidates(input)).toEqual(generateDiscardResponseCandidates(input));
    expect(generateDiscardResponseCandidates(input).map((candidate) => `${candidate.type}:${candidate.seat}`)).toEqual([
      "ron:1",
      "ron:3",
      "pon:2",
      "daiminkan:3",
      "pon:3",
      "chi:1",
    ]);
  });
});
