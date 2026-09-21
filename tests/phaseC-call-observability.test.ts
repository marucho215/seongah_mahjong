import { describe, expect, it } from "vitest";
import { CharacterAI, type CharacterDecisionContext } from "../src/ai/characterAI.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import { Hand } from "../src/core/Hand.js";
import { GameState } from "../src/core/GameState.js";
import type { ChiCandidate } from "../src/core/discardResponses.js";
import type { Tile } from "../src/core/tiles.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES, type RuleConfig } from "../src/rules/RuleConfig.js";

let nextId = 995000;
function tile(kind: string): Tile {
  return { id: nextId++, kind, suit: kind[0] as Tile["suit"], rank: Number(kind.slice(1)), isRed: false };
}

function context(rules: RuleConfig): CharacterDecisionContext {
  return {
    rules,
    riichiOpponentDiscardKinds: [],
    doraIndicatorKinds: ["z1"],
    visibleTileKinds: [],
    seatWind: 1,
    roundWind: 1,
    wallRemainingLive: 45,
    ownScore: rules.startingScore,
    opponentScores: Array.from({ length: rules.playerCount - 1 }, () => rules.startingScore),
    opponentSeats: Array.from({ length: rules.playerCount - 1 }, (_, index) => index + 1),
    riichiOpponentSeats: [],
    isLastHandOfGame: false,
    isDealer: true,
  };
}

function callHand(copies: 2 | 3): Hand {
  const hand = new Hand();
  const base = ["m1", "m2", "m3", "p1", "p2", "p3", "s1", "s2", "s3", "z5", "z5", "m9", "p9"];
  if (copies === 3) base[12] = "z5";
  hand.dealIn(base.map(tile));
  return hand;
}

function expectJsonSafe(value: unknown, path = "$root"): void {
  expect(value, `${path} must not be undefined`).not.toBeUndefined();
  if (typeof value === "number") {
    expect(Number.isFinite(value), `${path} must be finite`).toBe(true);
    expect(Object.is(value, -0), `${path} must not be negative zero`).toBe(false);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectJsonSafe(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) expectJsonSafe(entry, `${path}.${key}`);
  }
}

describe("Phase C CharacterAI call observability", () => {
  it("records pon progression, score components, and the exact evaluator decision in sanma", () => {
    const ai = new CharacterAI(getCharacterProfile("seiyamouri"), "phase-c-sanma-pon");
    const called = ai.shouldCallPon(callHand(2), "z5", context(DEFAULT_SANMA_RULES), true);
    const trace = ai.lastCallTrace;

    expect(trace).not.toBeNull();
    expect(trace).toMatchObject({ callKind: "pon", isYakuhai: true, called });
    expect(trace!.shantenGain).toBe(trace!.beforeShanten - trace!.afterShanten);
    expect(trace!.ukeireGain).toBe(trace!.afterUkeire - trace!.beforeUkeire);
    expect(trace!.actualDecision).toBe(called ? "call" : "pass");
    expect(trace!.callScore).toBeCloseTo(
      trace!.adjustedCallScore + trace!.components.entropyJitter + trace!.components.mistakeJitter,
      12
    );
  });

  it("records daiminkan call/pass without changing the seeded decision or RNG order", () => {
    const profile = getCharacterProfile("seiyakouri");
    const observed = new CharacterAI(profile, "phase-c-daiminkan");
    const control = new CharacterAI(profile, "phase-c-daiminkan");
    const observedDecision = observed.shouldCallDaiminkan(callHand(3), "z5", context(MAJSOUL_YONMA_RULES), true);
    const trace = observed.lastCallTrace;
    const controlDecision = control.shouldCallDaiminkan(callHand(3), "z5", context(MAJSOUL_YONMA_RULES), true);

    expect(trace).not.toBeNull();
    expect(trace!.callKind).toBe("daiminkan");
    expect(trace!.actualDecision).toBe(observedDecision ? "call" : "pass");
    expect(observedDecision).toBe(controlDecision);
    expectJsonSafe(trace, "$trace");
    expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
    expect(control.lastCallTrace).toEqual(trace);
  });

  it("keeps the existing chi evaluation observable with the common progression fields", () => {
    const hand = new Hand();
    hand.dealIn(["m1", "m2", "p1", "p2", "p3", "s1", "s2", "s3", "z5", "z5", "m9", "p9", "s9"].map(tile));
    const candidate: ChiCandidate = {
      type: "chi",
      seat: 0,
      sequence: ["m1", "m2", "m3"],
      consumedKinds: ["m1", "m2"],
    };
    const evaluation = new CharacterAI(getCharacterProfile("seiyakouri"), "phase-c-chi")
      .evaluateChiCandidate(hand, candidate, context(MAJSOUL_YONMA_RULES));

    expect(evaluation.shantenGain).toBe(evaluation.beforeShanten - evaluation.afterShanten);
    expect(evaluation.ukeireGain).toBe(evaluation.afterUkeire - evaluation.beforeUkeire);
    expect(evaluation.components).toMatchObject({ shantenBonus: expect.any(Number), callBias: expect.any(Number) });
  });

  it("distinguishes chi and pon in a fixed yonma replay and matches actual calls", () => {
    const ids = ["jegalmina", "toumesuayo", "byeonari", "seiyakouri"];
    const game = new GameState({
      rules: MAJSOUL_YONMA_RULES,
      seed: "yonma-qa-003",
      characterProfiles: ids.map((id) => getCharacterProfile(id)),
    });
    game.playGame();

    const calls = game.aiDecisionLog.filter((entry) => entry.type === "call_decision");
    const kinds = new Set(calls.map((entry) => entry.callKind));
    expect(kinds.has("chi")).toBe(true);
    expect(kinds.has("pon")).toBe(true);
    expect(calls.every((entry) => entry.called === (entry.actualDecision === "call"))).toBe(true);
    expect(calls.every((entry) => entry.fromPlayer !== entry.player && entry.candidateId.length > 0)).toBe(true);

    const actualPonDecisions = calls.filter((entry) => entry.callKind === "pon" && entry.actualDecision === "call");
    const ponEvents = game.log.filter((entry) => entry.type === "call" && entry.call === "pon");
    expect(actualPonDecisions).toHaveLength(ponEvents.length);
    const actualChiDecisions = calls.filter((entry) => entry.callKind === "chi" && entry.actualDecision === "call");
    const chiEvents = game.log.filter((entry) => entry.type === "call" && entry.call === "chi");
    expect(actualChiDecisions).toHaveLength(chiEvents.length);
    expectJsonSafe(game.aiDecisionLog);
    expect(JSON.parse(JSON.stringify(game.aiDecisionLog))).toEqual(game.aiDecisionLog);
  });
});
