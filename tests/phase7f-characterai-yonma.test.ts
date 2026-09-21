import { describe, expect, it } from "vitest";
import { CharacterAI, type CharacterDecisionContext } from "../src/ai/characterAI.js";
import { scoreChiStrategicFactors } from "../src/ai/chiDecision.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import { GameState } from "../src/core/GameState.js";
import { Hand } from "../src/core/Hand.js";
import type { ChiCandidate } from "../src/core/discardResponses.js";
import type { Tile } from "../src/core/tiles.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

let nextId = 970000;
function tile(kind: string): Tile {
  return {
    id: nextId++,
    kind,
    suit: kind[0] as "m" | "p" | "s" | "z",
    rank: Number(kind.slice(1)),
    isRed: false,
  };
}

function context(rules = MAJSOUL_YONMA_RULES, pressure = false): CharacterDecisionContext {
  const opponentCount = rules.playerCount - 1;
  return {
    rules,
    riichiOpponentDiscardKinds: pressure ? Array.from({ length: opponentCount }, () => ["m9", "p9"]) : [],
    riichiOpponentSeats: pressure ? Array.from({ length: opponentCount }, (_, index) => index + 1) : [],
    doraIndicatorKinds: ["z1"],
    visibleTileKinds: [],
    seatWind: 1,
    roundWind: 1,
    wallRemainingLive: 50,
    ownScore: rules.startingScore,
    opponentScores: Array.from({ length: opponentCount }, () => rules.startingScore),
    opponentSeats: Array.from({ length: opponentCount }, (_, index) => index + 1),
    isLastHandOfGame: false,
    isDealer: true,
  };
}

describe("Phase 7F generalized CharacterAI context", () => {
  it("represents two sanma opponents and three yonma opponents", () => {
    expect(context(DEFAULT_SANMA_RULES).opponentScores).toHaveLength(2);
    expect(context(DEFAULT_SANMA_RULES).opponentSeats).toEqual([1, 2]);
    expect(context(MAJSOUL_YONMA_RULES).opponentScores).toHaveLength(3);
    expect(context(MAJSOUL_YONMA_RULES).opponentSeats).toEqual([1, 2, 3]);
  });

  it("evaluates a legal chi using progress/ukeire and all three riichi opponents", () => {
    const hand = new Hand();
    hand.dealIn(["m1", "m2", "p1", "p2", "p3", "s1", "s2", "s3", "z5", "z5", "m9", "m9", "p9"].map(tile));
    const candidate: ChiCandidate = {
      type: "chi",
      seat: 0,
      sequence: ["m1", "m2", "m3"],
      consumedKinds: ["m1", "m2"],
    };
    const ai = new CharacterAI(getCharacterProfile("seiyakouri"), "phase7f-chi");
    const safe = ai.evaluateChiCandidate(hand, candidate, context(MAJSOUL_YONMA_RULES, false));
    const pressured = ai.evaluateChiCandidate(hand, candidate, context(MAJSOUL_YONMA_RULES, true));
    expect(Number.isFinite(safe.score)).toBe(true);
    expect(safe.afterShanten).toBeLessThanOrEqual(safe.beforeShanten);
    expect(pressured.score).toBeLessThan(safe.score);
    expect(context(MAJSOUL_YONMA_RULES, true).riichiOpponentDiscardKinds).toHaveLength(3);
  });

  it("treats a valueless zero-shanten-gain first chi conservatively", () => {
    const profile = { ...getCharacterProfile("seiyakouri"), callBias: 0.5, aggression: 0.5 };
    const result = scoreChiStrategicFactors(profile, {
      shantenGain: 0,
      ukeireGain: 0,
      isFirstOpen: true,
      hasOpenYaku: false,
      riichiPressure: 0,
    });
    expect(result.score).toBeLessThanOrEqual(0);
  });

  it("does not automatically call a one-shanten-gain chi that sacrifices a valuable menzen hand", () => {
    const profile = {
      ...getCharacterProfile("seiyakouri"),
      callBias: 0.5,
      aggression: 0.5,
      valueGreed: 1,
      riichiBias: 1,
      damaBias: 1,
    };
    const result = scoreChiStrategicFactors(profile, {
      shantenGain: 1,
      ukeireGain: 0,
      isFirstOpen: true,
      hasOpenYaku: false,
      riichiPressure: 0,
    });
    expect(result.score).toBeLessThanOrEqual(0);
  });

  it("allows clear speed and ukeire progress when an open yaku is secured", () => {
    const profile = { ...getCharacterProfile("seiyakouri"), callBias: 0.5, aggression: 0.5 };
    const result = scoreChiStrategicFactors(profile, {
      shantenGain: 1,
      ukeireGain: 6,
      isFirstOpen: true,
      hasOpenYaku: true,
      riichiPressure: 0,
    });
    expect(result.score).toBeGreaterThan(0);
  });

  it("charges a smaller opportunity cost once the hand is already open", () => {
    const profile = { ...getCharacterProfile("seiyakouri"), callBias: 0.5, aggression: 0.5 };
    const common = {
      shantenGain: 0,
      ukeireGain: 12,
      hasOpenYaku: true,
      riichiPressure: 0,
    };
    const firstChi = scoreChiStrategicFactors(profile, { ...common, isFirstOpen: true });
    const additionalChi = scoreChiStrategicFactors(profile, { ...common, isFirstOpen: false });
    expect(additionalChi.opportunityCost).toBeLessThan(firstChi.opportunityCost);
    expect(additionalChi.score).toBeGreaterThan(firstChi.score);
    expect(firstChi.score).toBeLessThanOrEqual(0);
    expect(additionalChi.score).toBeGreaterThan(0);
  });

  it("only relaxes zero-gain chi for an open yaku hand with substantial ukeire growth", () => {
    const profile = getCharacterProfile("seiyakouri");
    const common = {
      shantenGain: 0,
      isFirstOpen: false,
      hasOpenYaku: true,
      riichiPressure: 0,
    };
    const marginal = scoreChiStrategicFactors(profile, { ...common, ukeireGain: 4 });
    const substantial = scoreChiStrategicFactors(profile, { ...common, ukeireGain: 7 });

    expect(marginal.continuationBonus).toBe(0);
    expect(marginal.score).toBeLessThanOrEqual(0);
    expect(substantial.continuationBonus).toBe(0.15);
    expect(substantial.score).toBeGreaterThan(0);
  });
});

describe("Phase 7F CharacterAI yonma integration", () => {
  const profile = getCharacterProfile("seiyakouri");

  it("completes a yonma game with four CharacterAI seats and conserves score", () => {
    const gs = new GameState({
      rules: MAJSOUL_YONMA_RULES,
      seed: "phase7f-four-character-ai",
      characterProfiles: [profile, profile, profile, profile],
    });
    gs.playGame();
    expect(gs.log.at(-1)?.type).toBe("game_end");
    expect(gs.scores.reduce((sum, score) => sum + score, 0)).toBe(100000);
    expect(gs.aiDecisionLog.length).toBeGreaterThan(0);
  });

  it("completes a mixed CharacterAI/SimpleAI yonma game", () => {
    const gs = new GameState({
      rules: MAJSOUL_YONMA_RULES,
      seed: "phase7f-mixed-ai",
      characterProfiles: [profile, null, profile, null],
    });
    gs.playGame();
    expect(gs.log.at(-1)?.type).toBe("game_end");
    expect(gs.scores.reduce((sum, score) => sum + score, 0)).toBe(100000);
  });

  it("is deterministic for the same yonma seed and profile configuration", () => {
    const profiles = [profile, profile, null, null];
    const a = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7f-determinism", characterProfiles: profiles });
    const b = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "phase7f-determinism", characterProfiles: profiles });
    a.playGame();
    b.playGame();
    expect(a.log).toEqual(b.log);
    expect(a.aiDecisionLog).toEqual(b.aiDecisionLog);
    expect(a.scores).toEqual(b.scores);
  });
});
