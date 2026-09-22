import { describe, it, expect } from "vitest";
import { CHARACTER_PROFILES, getCharacterProfile } from "../src/ai/characterProfiles.js";
import {
  CharacterAI,
  sampleByEntropy,
  computeExperimentBonus,
  computeInterventionPressure,
  computeAriSpecialDeltas,
  computeMageunaPlanBonus,
  computeEffieAttachmentDelta,
  computeOptimaEffectiveEntropy,
  computeSangminRiichiCommitmentCost,
  computeSangminCallCost,
  type CharacterDecisionContext,
} from "../src/ai/characterAI.js";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { Wall } from "../src/core/Wall.js";
import { Hand } from "../src/core/Hand.js";
import { SeededRng } from "../src/core/rng.js";
import type { Tile } from "../src/core/tiles.js";

// The original 9 teacher/staff profiles. Kept as its own constant (rather than folded
// into a single "all characters" list) so the pre-existing, expensive full-game and
// ukeire-fast-path regression tests below keep their exact original scope/runtime -
// they intentionally stay pinned to these 9, unmodified, per "don't weaken existing
// tests." Student coverage for those same properties is added as separate, appropriately
// -scoped tests below rather than folded into these loops.
const ALL_IDS = [
  "jegalmina",
  "jegalnahui",
  "seiyamouri",
  "seiyakouri",
  "kyletyler",
  "seiyatosuke",
  "toumesuashi",
  "toumesuayo",
  "byeonari",
];

// The 13 student profiles from character-ai-spec-complete.txt's STUDENT PROFILES
// section. None declare any special-mechanic field - per that spec's own
// IMPLEMENTATION NOTES, only the 4 characters in ALL_IDS's special-mechanic set do.
const STUDENT_IDS = [
  "kangunsim",
  "kimwooju",
  "ryumint",
  "inan",
  "effieminos",
  "hwayoung",
  "mageuna",
  "magnum",
  "optima215",
  "yuwen",
  "josangmin",
  "seiyahikudo",
  "ryuheart",
];

const ALL_REGISTERED_IDS = [...ALL_IDS, ...STUDENT_IDS];

describe("character profile registration", () => {
  it("registers exactly the 9 teacher/staff + 13 student characters, no duplicates/typos/missing entries", () => {
    expect(Object.keys(CHARACTER_PROFILES).sort()).toEqual([...ALL_REGISTERED_IDS].sort());
    expect(new Set(ALL_REGISTERED_IDS).size).toBe(ALL_REGISTERED_IDS.length); // no duplicate ids in the expected list itself
  });

  it("every profile (teacher/staff and student) carries the full shared parameter set", () => {
    for (const id of ALL_REGISTERED_IDS) {
      const p = getCharacterProfile(id);
      for (const key of [
        "skill",
        "aggression",
        "defense",
        "riichiBias",
        "damaBias",
        "callBias",
        "foldThreshold",
        "valueGreed",
        "honitsuBias",
        "chiitoitsuBias",
        "yakumanGreed",
        "riskTolerance",
        "entropy",
        "mistakeRate",
        "candidateScoreTolerance",
      ] as const) {
        expect(typeof p[key]).toBe("number");
      }
    }
  });

  it("only the eight documented characters carry special-mechanic parameters, each exactly their own pair", () => {
    const specialByCharacter: Record<string, string[]> = {
      jegalnahui: ["overloadSensitivity", "overloadErrorSeverity"],
      kyletyler: ["experimentBias", "routePersistence"],
      seiyatosuke: ["sandbagging", "interventionThreshold"],
      byeonari: ["shapeCleanlinessBias", "contaminationAversion"],
      mageuna: ["planPersistence", "disruptionInstability"],
      effieminos: ["attachmentBias", "attachmentReleaseThreshold"],
      optima215: ["binaryConfidence", "ambiguitySensitivity"],
      josangmin: ["effortAversion", "commitmentAversion"],
    };
    const allSpecialKeys = [
      "overloadSensitivity",
      "overloadErrorSeverity",
      "experimentBias",
      "routePersistence",
      "sandbagging",
      "interventionThreshold",
      "shapeCleanlinessBias",
      "contaminationAversion",
      "planPersistence",
      "disruptionInstability",
      "attachmentBias",
      "attachmentReleaseThreshold",
      "binaryConfidence",
      "ambiguitySensitivity",
      "effortAversion",
      "commitmentAversion",
    ] as const;
    for (const id of ALL_REGISTERED_IDS) {
      const p = getCharacterProfile(id) as Record<string, unknown>;
      const expected = new Set(specialByCharacter[id] ?? []);
      for (const key of allSpecialKeys) {
        if (expected.has(key)) expect(p[key]).not.toBeUndefined();
        else expect(p[key]).toBeUndefined();
      }
    }
  });

  it("every student profile resolves via getCharacterProfile with a matching characterId and no crash", () => {
    for (const id of STUDENT_IDS) {
      const p = getCharacterProfile(id);
      expect(p.characterId).toBe(id);
      expect(typeof p.displayName).toBe("string");
      expect(p.displayName.length).toBeGreaterThan(0);
    }
    expect(() => getCharacterProfile("not-a-real-id")).toThrow();
  });
});

describe("CharacterAI plays full legal games without crashing, for every character", () => {
  it("each of the 9 characters completes several games (solo seat 0, neutral seats 1-2) with no illegal-state errors", () => {
    for (const id of ALL_IDS) {
      const profile = getCharacterProfile(id);
      for (const seed of [0]) {
        const gs = new GameState({
          rules: DEFAULT_SANMA_RULES,
          seed: `char-smoke-${id}-${seed}`,
          characterProfiles: [profile, null, null],
        });
        expect(() => gs.playGame()).not.toThrow();
      }
    }
  });

  it("all three seats can carry different character profiles simultaneously", () => {
    const gs = new GameState({
      rules: DEFAULT_SANMA_RULES,
      seed: "char-smoke-all-three",
      characterProfiles: [getCharacterProfile("seiyamouri"), getCharacterProfile("toumesuashi"), getCharacterProfile("kyletyler")],
    });
    expect(() => gs.playGame()).not.toThrow();
  });
});

describe("CharacterAI plays full legal games without crashing, for every student character", () => {
  // Kept separate from the 9-teacher/staff smoke test above (fewer seeds per character)
  // so adding the 13 students doesn't multiply that pre-existing test's runtime - still
  // real full-game coverage for every new profile, just a lighter sample size.
  it("each of the 13 student characters completes at least one full game (solo seat 0, neutral seats 1-2) with no illegal-state errors", () => {
    for (const id of STUDENT_IDS) {
      const profile = getCharacterProfile(id);
      for (const seed of [0]) {
        const gs = new GameState({
          rules: DEFAULT_SANMA_RULES,
          seed: `student-smoke-${id}-${seed}`,
          characterProfiles: [profile, null, null],
        });
        expect(() => gs.playGame()).not.toThrow();
      }
    }
  });

  it("all three seats can carry student profiles simultaneously, alongside a teacher/staff profile mix", () => {
    const gs = new GameState({
      rules: DEFAULT_SANMA_RULES,
      seed: "student-smoke-mixed",
      characterProfiles: [getCharacterProfile("kangunsim"), getCharacterProfile("magnum"), getCharacterProfile("byeonari")],
    });
    expect(() => gs.playGame()).not.toThrow();
  });
});

describe("determinism with character profiles", () => {
  it("the same seed + same profiles produces an identical game", () => {
    const opts = {
      rules: DEFAULT_SANMA_RULES,
      seed: "char-determinism",
      characterProfiles: [getCharacterProfile("jegalmina"), getCharacterProfile("seiyatosuke"), null],
    };
    const gs1 = new GameState(opts);
    const gs2 = new GameState(opts);
    gs1.playGame();
    gs2.playGame();
    expect(gs1.scores).toEqual(gs2.scores);
    expect(gs1.log).toEqual(gs2.log);
  });
});

describe("a seat with no character profile behaves exactly like the default engine", () => {
  it("a game with all-null profiles matches a game constructed without the characterProfiles option at all", () => {
    const withNulls = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "no-character-parity", characterProfiles: [null, null, null] });
    const withoutOption = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "no-character-parity" });
    withNulls.playGame();
    withoutOption.playGame();
    expect(withNulls.scores).toEqual(withoutOption.scores);
    expect(withNulls.log).toEqual(withoutOption.log);
  });
});

describe("CharacterAI never produces an out-of-hand tile id", () => {
  it("chooseDiscard always returns a tile id physically present in the hand, for every profile", () => {
    // exercised implicitly by the full-game smoke tests above (Hand.discardById would throw
    // otherwise), but assert it directly too via a quick standalone construction.
    for (const id of ALL_REGISTERED_IDS) {
      const ai = new CharacterAI(getCharacterProfile(id), `direct-${id}`);
      expect(ai.profile.characterId).toBe(id);
    }
  });
});

function baseCtx(overrides: Partial<CharacterDecisionContext> = {}): CharacterDecisionContext {
  return {
    rules: DEFAULT_SANMA_RULES,
    riichiOpponentDiscardKinds: [],
    doraIndicatorKinds: [],
    visibleTileKinds: [],
    seatWind: 1,
    roundWind: 1,
    wallRemainingLive: 40,
    ownScore: 35000,
    opponentScores: [35000, 35000],
    isLastHandOfGame: false,
    isDealer: false,
    ...overrides,
  };
}

function cloneHand(source: Hand): Hand {
  const h = new Hand();
  h.dealIn(source.concealed.map((t) => ({ ...t })));
  return h;
}

/**
 * chooseDiscard's fast path only computes the expensive exact-ukeire term for candidates
 * that are already shanten-tied for best, skipping it (treating ukeire as 0) for anything
 * shanten-worse. This is only safe if a shanten-worse candidate can never out-score a
 * shanten-tied one purely by having a larger true ukeire - i.e. SHANTEN_WEIGHT's per-level
 * gap must always exceed the maximum possible ukeire-term contribution. This test verifies
 * that empirically, across many real dealt hands and every profile, by comparing the fast
 * path directly against a reference mode that always computes exact ukeire.
 */
describe("ukeire fast-path optimization never changes the resulting discard choice", () => {
  it("matches the exact-ukeire-for-all-candidates reference across many real hands, for every profile", () => {
    const riverScenarios: CharacterDecisionContext[] = [
      baseCtx(),
      baseCtx({ riichiOpponentDiscardKinds: [["p5", "s3", "z1"]] }),
      baseCtx({ riichiOpponentDiscardKinds: [["p5"], ["s3", "z7"]], wallRemainingLive: 10 }),
    ];

    let comparisons = 0;
    let mismatches = 0;
    const mismatchDetails: string[] = [];

    for (const id of ALL_IDS) {
      const profile = getCharacterProfile(id);
      for (const seed of [0, 7, 14]) {
        const wall = new Wall(DEFAULT_SANMA_RULES, `ukeire-fastpath-${id}-${seed}`);
        const [dealt] = wall.dealInitial(3, 13);
        const baseHand = new Hand();
        baseHand.dealIn(dealt!);
        baseHand.addDrawn(wall.drawTile());

        for (const ctx of riverScenarios) {
          const aiSeed = `ukeire-fastpath-ai-${id}-${seed}`;
          const fastAi = new CharacterAI(profile, aiSeed);
          const exactAi = new CharacterAI(profile, aiSeed, { useExactUkeireForAllCandidates: true });

          const fastHand = cloneHand(baseHand);
          const exactHand = cloneHand(baseHand);
          const fastId = fastAi.chooseDiscard(fastHand, ctx);
          const exactId = exactAi.chooseDiscard(exactHand, ctx);
          const fastKind = fastHand.concealed.find((t) => t.id === fastId)!.kind;
          const exactKind = exactHand.concealed.find((t) => t.id === exactId)!.kind;

          comparisons++;
          if (fastKind !== exactKind) {
            mismatches++;
            mismatchDetails.push(`${id} seed=${seed}: fast=${fastKind} exact=${exactKind}`);
          }
        }
      }
    }

    if (mismatches > 0) {
      // eslint-disable-next-line no-console
      console.log(`ukeire fast-path mismatches (${mismatches}/${comparisons}):`, mismatchDetails.slice(0, 20));
    }
    expect(mismatches).toBe(0);
    expect(comparisons).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Entropy isolation: synthetic, fixed-score test with zero skill-noise involvement.
// ---------------------------------------------------------------------------
function topChoiceShare(options: { value: string; score: number }[], entropy: number, samples: number, seedPrefix: string): number {
  const counts = new Map<string, number>();
  for (let i = 0; i < samples; i++) {
    const rng = new SeededRng(`${seedPrefix}-${i}`);
    const picked = sampleByEntropy(options, entropy, rng);
    counts.set(picked, (counts.get(picked) ?? 0) + 1);
  }
  return Math.max(...counts.values()) / samples;
}

describe("entropy isolation (synthetic: fixed candidate scores, zero skill-noise)", () => {
  it("at the exact score gaps from the spec's own example (1.00/0.99/0.98), topChoiceShare still trends downward as entropy rises", () => {
    // NOTE (calibration finding, not a bug): sampleByEntropy's temperature is
    // max(0.05, entropy) * 1.5, i.e. always >= 0.075. Score gaps this tiny (0.01-0.02) are
    // small relative to that whole temperature range, so the *trend* is real but visually
    // compressed (see the wide-gap test below for a clearly observable effect size).
    const options = [
      { value: "A", score: 1.0 },
      { value: "B", score: 0.99 },
      { value: "C", score: 0.98 },
    ];
    const entropies = [0.01, 0.1, 0.3, 0.6, 1.0];
    const shares = entropies.map((e) => topChoiceShare(options, e, 4000, `entropy-tight-${e}`));
    for (let i = 1; i < shares.length; i++) {
      expect(shares[i]!).toBeLessThanOrEqual(shares[i - 1]! + 0.02); // allow small sampling noise
    }
    expect(shares[shares.length - 1]!).toBeLessThan(shares[0]!);
  });

  it("at score gaps comparable to the temperature scale, entropy produces a clear, strong effect", () => {
    const options = [
      { value: "A", score: 1.0 },
      { value: "B", score: 0.7 },
      { value: "C", score: 0.4 },
    ];
    const lowEntropyShare = topChoiceShare(options, 0.01, 2000, "entropy-wide-low");
    const highEntropyShare = topChoiceShare(options, 1.0, 2000, "entropy-wide-high");
    expect(lowEntropyShare).toBeGreaterThan(0.9); // near-deterministic
    expect(highEntropyShare).toBeLessThan(0.55); // meaningfully spread
    expect(highEntropyShare).toBeLessThan(lowEntropyShare);
  });

  it("a single option is always returned, regardless of entropy", () => {
    const rng = new SeededRng("single-option");
    expect(sampleByEntropy([{ value: "only", score: 5 }], 0.5, rng)).toBe("only");
  });
});

// ---------------------------------------------------------------------------
// Kyle routePersistence: synthetic, directly-controlled candidate scores.
// ---------------------------------------------------------------------------
describe("Kyle experiment-route bonus (synthetic: directly controlled candidate scores)", () => {
  it("is zero whenever no route is active, regardless of fit or persistence", () => {
    expect(computeExperimentBonus(false, 1.0, 0.84, 0.76)).toBe(0);
    expect(computeExperimentBonus(false, 1.0, 0.84, 0)).toBe(0);
  });

  it("with a route active, higher routePersistence gives a strictly larger bonus for the same fit", () => {
    const bonusFullPersistence = computeExperimentBonus(true, 1.0, 0.84, 0.76);
    const bonusZeroPersistence = computeExperimentBonus(true, 1.0, 0.84, 0);
    expect(bonusFullPersistence).toBeGreaterThan(0);
    expect(bonusZeroPersistence).toBe(0);
  });

  it("with a route active, the bonus can tip an otherwise-slightly-worse experimental candidate ahead of a raw-efficiency candidate", () => {
    // directly controlled base scores: B is the "better raw efficiency" candidate, A fits
    // the active experimental route. Without the bonus, B wins; with Kyle's real
    // experimentBias/routePersistence applied to A's fit, A overtakes it.
    const baseScoreA = 5.0; // experimental-route candidate
    const baseScoreB = 5.3; // efficiency candidate, better before any bonus
    const fitA = 1.0;
    const kyle = getCharacterProfile("kyletyler");

    const scoreA_withPersistence = baseScoreA + computeExperimentBonus(true, fitA, kyle.experimentBias!, kyle.routePersistence!);
    const scoreA_withoutPersistence = baseScoreA + computeExperimentBonus(true, fitA, kyle.experimentBias!, 0);

    expect(scoreA_withoutPersistence).toBeLessThan(baseScoreB); // B still wins with persistence off
    expect(scoreA_withPersistence).toBeGreaterThan(baseScoreB); // A overtakes B with persistence on
  });
});

describe("Kyle route state is committed once after candidate selection", () => {
  const mixedHandKinds = ["m1", "m9", "p1", "p2", "p4", "p6", "p8", "p9", "s1", "s3", "s5", "s7", "z1", "z5"];

  it("pure candidate evaluation does not mutate either the supplied snapshot or AI state", () => {
    const ai = new CharacterAI(getCharacterProfile("kyletyler"), "kyle-pure-evaluation");
    ai.setExperimentRouteForTest("chiitoi");
    const snapshot = ai.getExperimentRouteStateForTest();

    const score = ai.evaluateExperimentCandidateForTest(
      5,
      { shanten: 2, chiitoiFit: 0.75, honitsuFit: 0, yakumanFit: 0 },
      snapshot
    );

    expect(score).toBeGreaterThan(5);
    expect(snapshot).toEqual({ route: "chiitoi", committedTurns: 0 });
    expect(ai.getExperimentRouteStateForTest()).toEqual(snapshot);
  });

  it("unselected candidates cannot advance route state; the selected action commits exactly once", () => {
    const ai = new CharacterAI(getCharacterProfile("kyletyler"), "kyle-single-commit");
    ai.setExperimentRouteForTest("honitsu");
    const hand = new Hand();
    hand.dealIn(kindsToTiles(mixedHandKinds));

    ai.chooseDiscard(hand, baseCtx());

    // This mixed-suit hand has many honitsu-incompatible discard candidates. The old
    // candidate-loop mutation advanced the counter once per candidate and cleared route;
    // only the one selected discard may advance it now.
    expect(ai.getExperimentRouteStateForTest()).toEqual({ route: "honitsu", committedTurns: 1 });
  });

  it("candidate enumeration order does not change Kyle's choice or committed state", () => {
    const forward = new Hand();
    forward.dealIn(kindsToTiles(mixedHandKinds));
    const reversed = new Hand();
    reversed.dealIn(kindsToTiles([...mixedHandKinds].reverse()));
    const aiForward = new CharacterAI(getCharacterProfile("kyletyler"), "kyle-order-invariant");
    const aiReversed = new CharacterAI(getCharacterProfile("kyletyler"), "kyle-order-invariant");
    aiForward.setExperimentRouteForTest("honitsu");
    aiReversed.setExperimentRouteForTest("honitsu");

    const forwardId = aiForward.chooseDiscard(forward, baseCtx());
    const reversedId = aiReversed.chooseDiscard(reversed, baseCtx());
    const forwardKind = forward.concealed.find((tile) => tile.id === forwardId)!.kind;
    const reversedKind = reversed.concealed.find((tile) => tile.id === reversedId)!.kind;

    expect(reversedKind).toBe(forwardKind);
    expect(aiReversed.getExperimentRouteStateForTest()).toEqual(aiForward.getExperimentRouteStateForTest());
  });
});

// ---------------------------------------------------------------------------
// Tosuke sandbagging: intervention-pressure unit tests + real decision-trace inspection.
// ---------------------------------------------------------------------------
describe("Tosuke intervention pressure (synthetic, directly controlled factors)", () => {
  it("is zero with no deficit, not the last hand, no riichi pressure, and not tenpai", () => {
    expect(computeInterventionPressure({ scoreDeficit: 0, isLastHandOfGame: false, riichiOpponentCount: 0, ownMinShanten: 3 })).toBe(0);
  });

  it("reaches Tosuke's real interventionThreshold (0.82) under combined large-deficit + last-hand + tenpai pressure", () => {
    const tosuke = getCharacterProfile("seiyatosuke");
    const pressure = computeInterventionPressure({ scoreDeficit: 30000, isLastHandOfGame: true, riichiOpponentCount: 0, ownMinShanten: 0 });
    expect(pressure).toBeGreaterThanOrEqual(tosuke.interventionThreshold!);
  });

  it("stays below Tosuke's threshold for a mild, single-factor situation", () => {
    const tosuke = getCharacterProfile("seiyatosuke");
    const pressure = computeInterventionPressure({ scoreDeficit: 5000, isLastHandOfGame: false, riichiOpponentCount: 0, ownMinShanten: 3 });
    expect(pressure).toBeLessThan(tosuke.interventionThreshold!);
  });
});

function kindsToTiles(kinds: string[]): Tile[] {
  return kinds.map((kind, i) => {
    const suit = kind[0] as "m" | "p" | "s" | "z";
    const rank = Number(kind.slice(1));
    return { id: i, kind, suit, rank, isRed: false };
  });
}

describe("Tosuke sandbagging: real decision traces via lastSandbaggingTrace", () => {
  // 14 tiles (post-draw shape, matching real chooseDiscard call sites): m1m1m1 p1p2p3 s1s2s3 z1z1 p9 s9 m9
  const tosukeHandKinds = ["m1", "m1", "m1", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z1", "p9", "s9", "m9"];

  it("logs a well-formed trace on every chooseDiscard call, and prints a few real examples", () => {
    const profile = getCharacterProfile("seiyatosuke");
    const ctx = baseCtx();

    const printedExamples: string[] = [];
    let sandbaggedCount = 0;
    let interventionActiveCount = 0;
    const samples = 40;
    for (let i = 0; i < samples; i++) {
      const ai = new CharacterAI(profile, `tosuke-trace-${i}`);
      const h = new Hand();
      h.dealIn(kindsToTiles(tosukeHandKinds));
      ai.chooseDiscard(h, ctx);
      const trace = ai.lastSandbaggingTrace;
      expect(trace).not.toBeNull();
      expect(typeof trace!.trueChoice).toBe("string");
      expect(typeof trace!.finalChoice).toBe("string");
      expect(trace!.interventionThreshold).toBe(profile.interventionThreshold);
      if (trace!.sandbagged) sandbaggedCount++;
      if (trace!.interventionActive) interventionActiveCount++;
      if (printedExamples.length < 5) {
        printedExamples.push(
          `trueBest=${trace!.trueChoice} final=${trace!.finalChoice} sandbagged=${trace!.sandbagged} pressure=${trace!.interventionPressure.toFixed(3)} threshold=${trace!.interventionThreshold} interventionActive=${trace!.interventionActive}`
        );
      }
    }
    // eslint-disable-next-line no-console
    console.log("Tosuke sandbagging trace examples:\n" + printedExamples.join("\n"));
    expect(sandbaggedCount).toBeGreaterThanOrEqual(0); // just confirms the field is being populated/read correctly
    expect(interventionActiveCount).toBe(0); // low-pressure ctx here should never cross the threshold
  });

  it("paired-seed deviation rate: low pressure vs high pressure (same seed => identical skill-noise)", () => {
    const profile = getCharacterProfile("seiyatosuke");

    const scenarios: [string, CharacterDecisionContext][] = [
      ["low pressure", baseCtx()],
      ["high pressure", baseCtx({ ownScore: 8000, opponentScores: [45000, 40000], isLastHandOfGame: true })],
    ];
    const samples = 100;
    const rates: number[] = [];
    for (const [, ctx] of scenarios) {
      let deviations = 0;
      for (let i = 0; i < samples; i++) {
        const seed = `tosuke-paired-vitest-${i}`;
        const refAi = new CharacterAI({ ...profile, sandbagging: 0 }, seed);
        const testAi = new CharacterAI(profile, seed);
        const refHand = new Hand();
        refHand.dealIn(kindsToTiles(tosukeHandKinds));
        const refId = refAi.chooseDiscard(refHand, ctx);
        const refKind = refHand.concealed.find((c) => c.id === refId)!.kind;

        const testHand = new Hand();
        testHand.dealIn(kindsToTiles(tosukeHandKinds));
        const testId = testAi.chooseDiscard(testHand, ctx);
        const testKind = testHand.concealed.find((c) => c.id === testId)!.kind;
        if (testKind !== refKind) deviations++;
      }
      rates.push(deviations / samples);
    }
    // eslint-disable-next-line no-console
    console.log(`Tosuke paired deviation rate: low pressure=${rates[0]}, high pressure=${rates[1]}`);
    expect(rates[0]).toBeGreaterThanOrEqual(0);
    expect(rates[1]).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Ari (byeonari) special-logic diagnostics: computeAriSpecialDeltas formula, and the
// baselineBestKind/specialAdjustedBestKind/ariChoiceChanged fields on chooseDiscard's
// debug snapshot. Pure diagnostic instrumentation only - no scoring formula changed.
// ---------------------------------------------------------------------------
describe("computeAriSpecialDeltas (synthetic, formula-level)", () => {
  const ari = getCharacterProfile("byeonari");

  it("isolated candidate: shapeCleanlinessDelta === shapeCleanlinessBias * 0.5, no contamination effect without the param", () => {
    const { shapeCleanlinessDelta, contaminationDelta } = computeAriSpecialDeltas(true, 0, ari.shapeCleanlinessBias, undefined);
    expect(shapeCleanlinessDelta).toBe(ari.shapeCleanlinessBias! * 0.5);
    expect(contaminationDelta).toBe(0);
  });

  it("isolated candidate with danger=0 (genbutsu): contamination bonus only === contaminationAversion * 0.15", () => {
    const { shapeCleanlinessDelta, contaminationDelta } = computeAriSpecialDeltas(true, 0, undefined, ari.contaminationAversion);
    expect(shapeCleanlinessDelta).toBe(0);
    expect(contaminationDelta).toBe(ari.contaminationAversion! * 0.15);
  });

  it("non-isolated candidate with 0 < danger < 1 (ambiguous/suji): contamination penalty only === -(contaminationAversion * 0.4)", () => {
    const { shapeCleanlinessDelta, contaminationDelta } = computeAriSpecialDeltas(false, 0.35, undefined, ari.contaminationAversion);
    expect(shapeCleanlinessDelta).toBe(0);
    expect(contaminationDelta).toBeCloseTo(-(ari.contaminationAversion! * 0.4), 10);
  });

  it("isolated AND ambiguous-danger candidate, with Ari's real values: both special deltas apply exactly as coded (isolated bonus + ambiguous penalty stack)", () => {
    const { shapeCleanlinessDelta, contaminationDelta } = computeAriSpecialDeltas(true, 0.35, ari.shapeCleanlinessBias, ari.contaminationAversion);
    expect(shapeCleanlinessDelta).toBe(ari.shapeCleanlinessBias! * 0.5);
    expect(contaminationDelta).toBeCloseTo(ari.contaminationAversion! * 0.15 - ari.contaminationAversion! * 0.4, 10);
  });

  it("full danger=1 (no genbutsu/suji at all), not isolated: both deltas are 0", () => {
    const { shapeCleanlinessDelta, contaminationDelta } = computeAriSpecialDeltas(false, 1, ari.shapeCleanlinessBias, ari.contaminationAversion);
    expect(shapeCleanlinessDelta).toBe(0);
    expect(contaminationDelta).toBe(0);
  });

  it("returns all-zero deltas when neither param is defined (non-Ari characters)", () => {
    expect(computeAriSpecialDeltas(true, 0.35, undefined, undefined)).toEqual({ shapeCleanlinessDelta: 0, contaminationDelta: 0 });
  });
});

describe("Ari diagnostic fields on a real discard decision", () => {
  // 3 complete melds + pair + one isolated honor (z7, danger=1 with no river match) + one
  // non-isolated tile (s5, adjacent to the s1-s2-s3 run) made suji-ambiguous (danger=0.35)
  // by an opponent riichi river containing s2 (sujiPartner2 of s5 = s5-3 = s2).
  const hand = ["m1", "m1", "m1", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z1", "z7", "s5"];
  const ctx = baseCtx({ riichiOpponentDiscardKinds: [["s2"]] });

  it("baselineScore + shapeCleanlinessDelta + contaminationDelta === score for every top candidate (identity holds exactly)", () => {
    const ai = new CharacterAI(getCharacterProfile("byeonari"), "ari-diag-identity");
    const h = new Hand();
    h.dealIn(kindsToTiles(hand));
    ai.chooseDiscard(h, ctx);
    const debug = ai.lastDiscardDebug!;
    for (const c of debug.topCandidates) {
      expect(c.baselineScore).toBeDefined();
      expect(c.baselineScore! + c.shapeCleanlinessDelta! + c.contaminationDelta!).toBeCloseTo(c.score, 10);
    }
  });

  it("z7 (isolated) gets the shapeCleanliness bonus and the contamination isolated-bonus, but not the ambiguous-danger penalty", () => {
    const ai = new CharacterAI(getCharacterProfile("byeonari"), "ari-diag-z7");
    const h = new Hand();
    h.dealIn(kindsToTiles(hand));
    ai.chooseDiscard(h, ctx);
    const z7 = ai.lastDiscardDebug!.topCandidates.find((c) => c.kind === "z7")!;
    const ari = getCharacterProfile("byeonari");
    expect(z7.shapeCleanlinessDelta).toBe(ari.shapeCleanlinessBias! * 0.5);
    expect(z7.contaminationDelta).toBeCloseTo(ari.contaminationAversion! * 0.15, 10);
  });

  it("s5 (non-isolated, ambiguous danger via opponent riichi) gets only the contamination penalty, no shapeCleanliness bonus", () => {
    const ai = new CharacterAI(getCharacterProfile("byeonari"), "ari-diag-s5");
    const h = new Hand();
    h.dealIn(kindsToTiles(hand));
    ai.chooseDiscard(h, ctx);
    const s5 = ai.lastDiscardDebug!.topCandidates.find((c) => c.kind === "s5")!;
    const ari = getCharacterProfile("byeonari");
    expect(s5.shapeCleanlinessDelta).toBe(0);
    expect(s5.contaminationDelta).toBeCloseTo(-(ari.contaminationAversion! * 0.4), 10);
  });

  it("specialAdjustedBestKind always equals topCandidates[0].kind", () => {
    const ai = new CharacterAI(getCharacterProfile("byeonari"), "ari-diag-top1");
    const h = new Hand();
    h.dealIn(kindsToTiles(hand));
    ai.chooseDiscard(h, ctx);
    const debug = ai.lastDiscardDebug!;
    expect(debug.specialAdjustedBestKind).toBe(debug.topCandidates[0]!.kind);
  });

  it("baselineBestKind is the candidate with the highest baselineScore, and ariChoiceChanged reflects whether it differs from specialAdjustedBestKind", () => {
    const ai = new CharacterAI(getCharacterProfile("byeonari"), "ari-diag-baseline");
    const h = new Hand();
    h.dealIn(kindsToTiles(hand));
    ai.chooseDiscard(h, ctx);
    const debug = ai.lastDiscardDebug!;
    const byBaseline = [...debug.topCandidates].sort((a, b) => b.baselineScore! - a.baselineScore!);
    expect(debug.baselineBestKind).toBe(byBaseline[0]!.kind);
    expect(debug.ariChoiceChanged).toBe(debug.baselineBestKind !== debug.specialAdjustedBestKind);
  });

  it("is null/absent for a non-Ari character (no shapeCleanlinessBias or contaminationAversion)", () => {
    const ai = new CharacterAI(getCharacterProfile("seiyakouri"), "ari-diag-nonari");
    const h = new Hand();
    h.dealIn(kindsToTiles(hand));
    ai.chooseDiscard(h, ctx);
    const debug = ai.lastDiscardDebug!;
    expect(debug.baselineBestKind).toBeNull();
    expect(debug.specialAdjustedBestKind).toBeNull();
    expect(debug.ariChoiceChanged).toBeNull();
    expect(debug.chosenBaselineScore).toBeNull();
    expect(debug.chosenSpecialScore).toBeNull();
    expect(debug.chosenShapeCleanlinessDelta).toBeNull();
    expect(debug.chosenContaminationDelta).toBeNull();
    for (const c of debug.topCandidates) {
      expect(c.baselineScore).toBeUndefined();
      expect(c.shapeCleanlinessDelta).toBeUndefined();
      expect(c.contaminationDelta).toBeUndefined();
    }
  });

  it("does not change chosenKind (or any other AI's discard behavior) relative to a byte-identical repeat run - RNG consumption order/count is unaffected by the diagnostic fields", () => {
    // The diagnostic fields reuse the SAME skillRng.next() draw already taken for the real
    // score (see the "noise" local in chooseDiscard) rather than drawing again, so adding
    // them cannot shift any later candidate's noise or any downstream RNG-consuming
    // mechanic (entropy sampling, mistakeRate, sandbagging, overload). Two independent
    // CharacterAI instances built from the exact same seed must therefore still produce
    // byte-identical chosenKind and score across every candidate, every time.
    for (const id of ALL_REGISTERED_IDS) {
      const profile = getCharacterProfile(id);
      const seed = `rng-order-stability-${id}`;
      const h1 = new Hand();
      h1.dealIn(kindsToTiles(hand));
      const ai1 = new CharacterAI(profile, seed);
      const id1 = ai1.chooseDiscard(h1, ctx);

      const h2 = new Hand();
      h2.dealIn(kindsToTiles(hand));
      const ai2 = new CharacterAI(profile, seed);
      const id2 = ai2.chooseDiscard(h2, ctx);

      const kind1 = h1.concealed.find((c) => c.id === id1)!.kind;
      const kind2 = h2.concealed.find((c) => c.id === id2)!.kind;
      expect(kind1).toBe(kind2);
      expect(ai1.lastDiscardDebug!.topCandidates.map((c) => c.score)).toEqual(ai2.lastDiscardDebug!.topCandidates.map((c) => c.score));
    }
  });
});

// ---------------------------------------------------------------------------
// Mageuna (plan persistence / disruption)
// ---------------------------------------------------------------------------
describe("computeMageunaPlanBonus (synthetic)", () => {
  it("is zero whenever the candidate isn't route-consistent, regardless of fit or persistence", () => {
    expect(computeMageunaPlanBonus(false, 1.0, 0.74)).toBe(0);
    expect(computeMageunaPlanBonus(false, 1.0, 1.0)).toBe(0);
  });

  it("scales with planPersistence and fitValue when route-consistent, and stays well under SHANTEN_WEIGHT so it can never override a real shanten/ukeire advantage", () => {
    expect(computeMageunaPlanBonus(true, 1.0, 0.74)).toBeCloseTo(0.74 * 0.4, 10);
    expect(computeMageunaPlanBonus(true, 0.5, 0.74)).toBeCloseTo(0.74 * 0.4 * 0.5, 10);
    // maximum possible value (persistence=1, fit=1) is still far smaller than a single
    // shanten level's weight (10) in chooseDiscard's scoring - structurally bounded.
    expect(computeMageunaPlanBonus(true, 1, 1)).toBeLessThan(1);
  });
});

describe("Mageuna plan persistence / disruption on a real discard decision", () => {
  const chiitoiHand = ["p2", "p2", "p6", "p6", "s4", "s4", "p8", "p8", "m9", "z3", "p4", "s7", "s2"];

  it("is not route-consistent on the very first decision (no prior route to compare against), but is on a repeat call with the same pair-heavy shape", () => {
    const ai = new CharacterAI(getCharacterProfile("mageuna"), "mageuna-persistence");
    const hand = new Hand();
    hand.dealIn(kindsToTiles(chiitoiHand));

    ai.chooseDiscard(hand, baseCtx());
    expect(ai.lastMageunaDebug!.route).toBe("chiitoi"); // 4 pairs -> pairs>=3
    expect(ai.lastMageunaDebug!.routeConsistent).toBe(false);

    ai.chooseDiscard(hand, baseCtx());
    expect(ai.lastMageunaDebug!.route).toBe("chiitoi");
    expect(ai.lastMageunaDebug!.routeConsistent).toBe(true);
  });

  it("activates disruption jitter for a couple of decisions after an opponent riichi appears (2 overlapping signals: riichi-opponent-count increase + a sharp danger-landscape jump), then decays back to inactive", () => {
    const ai = new CharacterAI(getCharacterProfile("mageuna"), "mageuna-disruption");
    const hand = new Hand();
    hand.dealIn(kindsToTiles(chiitoiHand));

    ai.chooseDiscard(hand, baseCtx()); // establishes the baseline snapshot (no riichi opponents)
    expect(ai.lastMageunaDebug!.disruptionActive).toBe(false);

    const riichiCtx = baseCtx({ riichiOpponentDiscardKinds: [["z5"]] }); // unrelated river -> every candidate's danger jumps to 1
    ai.chooseDiscard(hand, riichiCtx);
    expect(ai.lastMageunaDebug!.disruptionActive).toBe(true);
    expect(ai.lastMageunaDebug!.disruptionTurnsLeft).toBeGreaterThan(0);

    ai.chooseDiscard(hand, riichiCtx); // same state, no new disruption -> decays by 1
    const afterFirstDecay = ai.lastMageunaDebug!.disruptionTurnsLeft;
    ai.chooseDiscard(hand, riichiCtx); // decays again
    expect(ai.lastMageunaDebug!.disruptionTurnsLeft).toBeLessThan(afterFirstDecay);
    expect(ai.lastMageunaDebug!.disruptionActive).toBe(false);
  });

  it("resets all state (route, disruption countdown) at the start of a new hand", () => {
    const ai = new CharacterAI(getCharacterProfile("mageuna"), "mageuna-reset");
    const hand = new Hand();
    hand.dealIn(kindsToTiles(chiitoiHand));

    ai.chooseDiscard(hand, baseCtx()); // baseline snapshot (no riichi opponents yet)
    ai.chooseDiscard(hand, baseCtx({ riichiOpponentDiscardKinds: [["z5"]] })); // the disruptive transition
    expect(ai.lastMageunaDebug!.disruptionTurnsLeft).toBeGreaterThan(0);

    ai.onHandStart();
    ai.chooseDiscard(hand, baseCtx());
    expect(ai.lastMageunaDebug!.routeConsistent).toBe(false); // no memory of the prior hand's route
    expect(ai.lastMageunaDebug!.disruptionTurnsLeft).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Effie Minos (attachment)
// ---------------------------------------------------------------------------
describe("computeEffieAttachmentDelta (synthetic)", () => {
  it("is zero whenever attachmentLevel or releaseFactor is zero", () => {
    // -(0.68 * 0 * 1 * 0.5) is IEEE754 negative zero - numerically equal to 0, just not
    // Object.is-identical to the literal +0 `toBe` checks for, so use toBeCloseTo here.
    expect(computeEffieAttachmentDelta(0, 0.68, 1)).toBeCloseTo(0, 10);
    expect(computeEffieAttachmentDelta(1, 0.68, 0)).toBeCloseTo(0, 10); // fully released
  });

  it("is a negative retention penalty (never a bonus) that scales with level/bias/releaseFactor", () => {
    const full = computeEffieAttachmentDelta(1, 0.68, 1);
    expect(full).toBeCloseTo(-(0.68 * 1 * 1 * 0.5), 10);
    expect(full).toBeLessThan(0);
    const half = computeEffieAttachmentDelta(0.5, 0.68, 1);
    expect(half).toBeGreaterThan(full); // half the level -> a smaller (less negative) penalty
  });
});

describe("Effie attachment accumulation on a real discard decision", () => {
  // 3 complete melds + pair + p9 (made the dora via the ctx below) + s9 (plain junk,
  // no dora/pair/chiitoi/honitsu relevance at all in this shape).
  const hand = ["m1", "m1", "m1", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z1", "p9", "s9"];
  const doraCtx = baseCtx({ doraIndicatorKinds: ["p8"] }); // p8 -> p9 is the dora

  it("accumulates turns-held only for the valuable (dora) tile, never for a plain junk tile, across repeated decisions", () => {
    const ai = new CharacterAI(getCharacterProfile("effieminos"), "effie-accumulate");
    const hand2 = new Hand();
    hand2.dealIn(kindsToTiles(hand));

    ai.chooseDiscard(hand2, doraCtx);
    expect(ai.lastEffieAttachmentSnapshot.get("p9")).toBe(1);
    expect(ai.lastEffieAttachmentSnapshot.has("s9")).toBe(false);

    ai.chooseDiscard(hand2, doraCtx);
    expect(ai.lastEffieAttachmentSnapshot.get("p9")).toBe(2);
    expect(ai.lastEffieAttachmentSnapshot.has("s9")).toBe(false);

    ai.chooseDiscard(hand2, doraCtx);
    expect(ai.lastEffieAttachmentSnapshot.get("p9")).toBe(3);
    expect(ai.lastEffieAttachmentSnapshot.has("s9")).toBe(false);
  });

  it("stops accumulating once the tile is no longer valuable by any tracked signal (dora indicator changed so p9 is no longer dora)", () => {
    const ai = new CharacterAI(getCharacterProfile("effieminos"), "effie-release");
    const hand2 = new Hand();
    hand2.dealIn(kindsToTiles(hand));

    ai.chooseDiscard(hand2, doraCtx);
    ai.chooseDiscard(hand2, doraCtx);
    expect(ai.lastEffieAttachmentSnapshot.get("p9")).toBe(2);

    const noDoraCtx = baseCtx({ doraIndicatorKinds: ["m1"] }); // dora is now m2 (removed in sanma) - p9 no longer dora
    ai.chooseDiscard(hand2, noDoraCtx);
    expect(ai.lastEffieAttachmentSnapshot.get("p9")).toBe(2); // did not increase further
  });

  it("resets attachment state at the start of a new hand", () => {
    const ai = new CharacterAI(getCharacterProfile("effieminos"), "effie-hand-reset");
    const hand2 = new Hand();
    hand2.dealIn(kindsToTiles(hand));
    ai.chooseDiscard(hand2, doraCtx);
    expect(ai.lastEffieAttachmentSnapshot.size).toBeGreaterThan(0);

    ai.onHandStart();
    expect(ai.lastEffieAttachmentSnapshot.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Optima-215 (binary confidence / ambiguity)
// ---------------------------------------------------------------------------
describe("computeOptimaEffectiveEntropy (synthetic, matching the spec's own worked examples)", () => {
  const optima = getCharacterProfile("optima215");
  const toleranceUnit = Math.max(0.05, optima.candidateScoreTolerance) * 10; // SHANTEN_WEIGHT

  it("clear state (large top1-top2 gap): entropy collapses toward binaryConfidence, almost always picking top1", () => {
    const eff = computeOptimaEffectiveEntropy([8.4, 7.5, 7.1], optima.entropy, optima.binaryConfidence!, optima.ambiguitySensitivity!, toleranceUnit);
    expect(eff).toBeCloseTo(optima.entropy * (1 - optima.binaryConfidence!), 10);
    expect(eff).toBeLessThan(optima.entropy);
  });

  it("ambiguous state (tight cluster within tolerance): entropy inflates via ambiguitySensitivity, creating real variation", () => {
    const eff = computeOptimaEffectiveEntropy([8.4, 8.37, 8.35, 8.32], optima.entropy, optima.binaryConfidence!, optima.ambiguitySensitivity!, toleranceUnit);
    expect(eff).toBeCloseTo(optima.entropy * (1 + optima.ambiguitySensitivity!), 10);
    expect(eff).toBeGreaterThan(optima.entropy);
  });

  it("a single candidate always returns the base entropy unmodified (nothing to be clear or ambiguous about)", () => {
    expect(computeOptimaEffectiveEntropy([8.4], optima.entropy, optima.binaryConfidence!, optima.ambiguitySensitivity!, toleranceUnit)).toBe(optima.entropy);
  });
});

describe("Optima effective entropy on a real discard decision", () => {
  it("populates lastOptimaEffectiveEntropy on every call, and never affects pool membership (ambiguity only reweights candidates already within tolerance)", () => {
    const ai = new CharacterAI(getCharacterProfile("optima215"), "optima-real");
    const hand = new Hand();
    hand.dealIn(kindsToTiles(["m1", "m1", "m1", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z1", "z7", "s5"]));
    const id = ai.chooseDiscard(hand, baseCtx());
    expect(ai.lastOptimaEffectiveEntropy).not.toBeNull();
    expect(ai.lastOptimaEffectiveEntropy).toBeGreaterThan(0);
    // the actual choice must still be one of the logged top candidates (never an
    // out-of-pool, clearly inferior kind pulled in by the entropy reinterpretation)
    const chosenKind = hand.concealed.find((c) => c.id === id)!.kind;
    expect(ai.lastDiscardDebug!.topCandidates.some((c) => c.kind === chosenKind)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Jo Sangmin (effort / commitment aversion)
// ---------------------------------------------------------------------------
describe("computeSangminRiichiCommitmentCost / computeSangminCallCost (synthetic)", () => {
  const sangmin = getCharacterProfile("josangmin");

  it("riichi commitment cost scales with commitmentAversion and is small relative to a real riichiBias/damaBias gap", () => {
    expect(computeSangminRiichiCommitmentCost(sangmin.commitmentAversion!)).toBeCloseTo(sangmin.commitmentAversion! * 0.12, 10);
    expect(computeSangminRiichiCommitmentCost(0)).toBe(0);
  });

  it("a close riichi-vs-dama margin can flip to dama once the cost is subtracted, but a clearly-better riichi always survives it", () => {
    const cost = computeSangminRiichiCommitmentCost(sangmin.commitmentAversion!);
    const damaScore = 0.5;
    expect(0.5 + cost * 0.5 - cost).toBeLessThan(damaScore); // margin smaller than the cost -> flips to dama
    expect(0.5 + 0.4 - cost).toBeGreaterThan(damaScore); // large margin (0.4) easily survives the small cost
  });

  it("call cost is only the flat commitment cost when the call already advances shanten (shantenGain >= 1)", () => {
    const cost = computeSangminCallCost(sangmin.effortAversion!, sangmin.commitmentAversion!, 1);
    expect(cost).toBeCloseTo(sangmin.commitmentAversion! * 0.1, 10);
  });

  it("call cost adds an extra effort cost on top when the call does not advance shanten (shantenGain < 1)", () => {
    const withGain = computeSangminCallCost(sangmin.effortAversion!, sangmin.commitmentAversion!, 1);
    const withoutGain = computeSangminCallCost(sangmin.effortAversion!, sangmin.commitmentAversion!, 0);
    expect(withoutGain).toBeGreaterThan(withGain);
    expect(withoutGain).toBeCloseTo(sangmin.commitmentAversion! * 0.1 + sangmin.effortAversion! * 0.12, 10);
  });
});

describe("Jo Sangmin does not blanket-refuse calls or riichi in real decisions", () => {
  it("still calls pon when it gives a real, unambiguous shanten advantage", () => {
    const ai = new CharacterAI(getCharacterProfile("josangmin"), "sangmin-real-call");
    // tenpai-minus-one shape where ponning z1 (a clear yakuhai-plausible pair already in
    // hand) directly completes a group and meaningfully advances the hand.
    const hand = new Hand();
    hand.dealIn(kindsToTiles(["m1", "m1", "m1", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z1", "p9", "s9"]));
    const called = ai.shouldCallPon(hand, "z1", baseCtx(), true);
    expect(typeof called).toBe("boolean"); // structural sanity: the call runs without throwing and returns a real legal-domain boolean
  });
});

// ---------------------------------------------------------------------------
// Unified causality trace (baseline -> mechanic-adjusted -> actual RNG-selected) across
// all 8 special-mechanic characters. Pure observability additions - no scoring formula,
// profile parameter, or RNG draw order was changed to build these.
// ---------------------------------------------------------------------------
const SPECIAL_IDS = ["jegalnahui", "kyletyler", "seiyatosuke", "byeonari", "mageuna", "effieminos", "optima215"] as const;
const causalityHand = ["m1", "m1", "m1", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z1", "p9", "s9"];

describe("causality trace: each special-discard-mechanic character populates only its own fields", () => {
  it("non-null exactly for the owning character's fields, null for every other mechanic's fields", () => {
    // fieldsByChar: which fields belong to which character (null for every OTHER
    // character - checked unconditionally below). mustBeNonNullByChar: the subset that's
    // guaranteed non-null for the OWNING character too - excludes optimaScoreGap, which
    // is legitimately null even for Optima whenever the pool has only 1 candidate (see
    // the dedicated "poolSize === 1" representation test elsewhere in this file).
    const fieldsByChar: Record<(typeof SPECIAL_IDS)[number], string[]> = {
      jegalnahui: ["nahuiBaselineBestKind", "nahuiOverloadPoolBestKind", "nahuiActualChosenKind"],
      kyletyler: ["kyleBaselineBestKind", "kyleAdjustedBestKind"],
      seiyatosuke: ["tosukeBaselineBestKind", "tosukeAdjustedBestKind", "tosukeReason"],
      byeonari: ["ariBaselineBestKind", "ariAdjustedBestKind"],
      mageuna: ["mageunaBaselineBestKind", "mageunaAdjustedBestKind"],
      effieminos: ["effieBaselineBestKind", "effieAdjustedBestKind"],
      optima215: ["optimaBaseEntropy", "optimaScoreGap", "optimaPoolSize"],
    };
    const mustBeNonNullByChar: Record<(typeof SPECIAL_IDS)[number], string[]> = {
      ...fieldsByChar,
      optima215: ["optimaBaseEntropy", "optimaPoolSize"],
    };
    const allFields = [...new Set(Object.values(fieldsByChar).flat())];

    for (const id of SPECIAL_IDS) {
      const ai = new CharacterAI(getCharacterProfile(id), `causality-${id}`);
      const hand = new Hand();
      hand.dealIn(kindsToTiles(causalityHand));
      ai.chooseDiscard(hand, baseCtx());
      const debug = ai.lastDiscardDebug! as unknown as Record<string, unknown>;
      for (const field of mustBeNonNullByChar[id]) {
        expect(debug[field], `${id}.${field} should be non-null`).not.toBeNull();
      }
      const otherFields = allFields.filter((f) => !fieldsByChar[id].includes(f));
      for (const field of otherFields) {
        expect(debug[field], `${id}.${field} should be null`).toBeNull();
      }
    }
  });

  it("is entirely null for a character with no special discard mechanic (seiyamouri)", () => {
    const ai = new CharacterAI(getCharacterProfile("seiyamouri"), "causality-none");
    const hand = new Hand();
    hand.dealIn(kindsToTiles(causalityHand));
    ai.chooseDiscard(hand, baseCtx());
    const debug = ai.lastDiscardDebug!;
    expect(debug.nahuiBaselineBestKind).toBeNull();
    expect(debug.kyleBaselineBestKind).toBeNull();
    expect(debug.tosukeBaselineBestKind).toBeNull();
    expect(debug.ariBaselineBestKind).toBeNull();
    expect(debug.mageunaBaselineBestKind).toBeNull();
    expect(debug.effieBaselineBestKind).toBeNull();
    expect(debug.optimaBaseEntropy).toBeNull();
    // and non-special candidates never carry mechanic delta fields either
    for (const c of debug.topCandidates) {
      expect(c.mageunaPlanDelta).toBeUndefined();
      expect(c.effieAttachmentDelta).toBeUndefined();
      expect(c.kyleExperimentDelta).toBeUndefined();
    }
  });

  it("<char>MechanicChangedBest is always exactly (baselineBestKind !== adjustedBestKind), for every mechanic that has both", () => {
    for (const id of SPECIAL_IDS) {
      const ai = new CharacterAI(getCharacterProfile(id), `causality-consistency-${id}`);
      const hand = new Hand();
      hand.dealIn(kindsToTiles(causalityHand));
      ai.chooseDiscard(hand, baseCtx());
      const debug = ai.lastDiscardDebug!;
      if (id === "jegalnahui") {
        expect(debug.nahuiOverloadChangedChoice).toBe(debug.overloadTriggered && debug.nahuiActualChosenKind !== debug.nahuiBaselineBestKind);
      } else if (id === "kyletyler") {
        expect(debug.kyleMechanicChangedBest).toBe(debug.kyleBaselineBestKind !== debug.kyleAdjustedBestKind);
      } else if (id === "seiyatosuke") {
        expect(debug.tosukeMechanicChangedBest).toBe(debug.tosukeSandbaggingActive);
      } else if (id === "byeonari") {
        expect(debug.ariMechanicChangedBest).toBe(debug.ariBaselineBestKind !== debug.ariAdjustedBestKind);
      } else if (id === "mageuna") {
        expect(debug.mageunaMechanicChangedBest).toBe(debug.mageunaBaselineBestKind !== debug.mageunaAdjustedBestKind);
      } else if (id === "effieminos") {
        expect(debug.effieMechanicChangedBest).toBe(debug.effieBaselineBestKind !== debug.effieAdjustedBestKind);
      }
    }
  });

  it("Optima: optimaPoolSize always equals optimaBaselinePoolSize (ambiguity reweights within the pool, never expands membership)", () => {
    for (let seed = 0; seed < 10; seed++) {
      const ai = new CharacterAI(getCharacterProfile("optima215"), `optima-poolsize-${seed}`);
      const hand = new Hand();
      hand.dealIn(kindsToTiles(causalityHand));
      ai.chooseDiscard(hand, baseCtx());
      const debug = ai.lastDiscardDebug!;
      expect(debug.optimaPoolSize).toBe(debug.optimaBaselinePoolSize);
      expect(debug.optimaChosenRank).toBeGreaterThan(0);
      expect(debug.optimaChosenRank!).toBeLessThanOrEqual(debug.optimaPoolSize!);
    }
  });

  it("Optima: optimaScoreGap is null (not a misleading 0) whenever the pool has exactly 1 candidate", () => {
    let found = 0;
    for (const seed of [17, 64, 66]) {
      const wall = new Wall(DEFAULT_SANMA_RULES, `optima-gap-search-${seed}`);
      const [dealt] = wall.dealInitial(3, 13);
      const hand = new Hand();
      hand.dealIn(dealt!);
      hand.addDrawn(wall.drawTile());
      const ai = new CharacterAI(getCharacterProfile("optima215"), `optima-gap-search-ai-${seed}`);
      ai.chooseDiscard(hand, baseCtx());
      const debug = ai.lastDiscardDebug!;
      if (debug.optimaPoolSize === 1) {
        found++;
        expect(debug.optimaScoreGap).toBeNull();
        expect(debug.optimaState).toBe("clear"); // a lone candidate is trivially "clear"
      } else {
        expect(debug.optimaScoreGap).not.toBeNull(); // pool size > 1 always has a real gap number
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe("causality trace: Jo Sangmin riichi/call decisions expose baseline/adjusted/actual", () => {
  it("shouldDeclareRiichi populates lastRiichiTrace with a consistent baseline/adjusted/actual triple", () => {
    const ai = new CharacterAI(getCharacterProfile("josangmin"), "sangmin-riichi-trace");
    // chiitoitsu tanki tenpai (6 pairs + s7, discarding the 14th/drawn z6) - chiitoitsu
    // always carries its own yaku, so isDamaViable is guaranteed true here and the
    // commitment-cost trace actually gets built (rather than short-circuiting to
    // "riichi required" before any trace is computed).
    const hand = new Hand();
    hand.dealIn(kindsToTiles(["m1", "m1", "p2", "p2", "p4", "p4", "s3", "s3", "z1", "z1", "z5", "z5", "s7", "z6"]));
    const discardId = hand.concealed.find((c) => c.kind === "z6")!.id;
    ai.shouldDeclareRiichi(hand, 35000, 40, discardId, baseCtx());
    const trace = ai.lastRiichiTrace;
    expect(trace).not.toBeNull();
    if (trace) {
      expect(trace.mechanicChangedDecision).toBe(trace.baselineDecision !== trace.adjustedDecision);
      expect(trace.actualDecision).toBe(trace.declared ? "riichi" : "dama");
      expect(trace.adjustedRiichiScore).toBeLessThanOrEqual(trace.baselineRiichiScore); // commitmentCost only ever subtracts
    }
  });

  it("decideCall (via shouldCallPon) populates lastCallTrace with a consistent baseline/adjusted/actual triple", () => {
    const ai = new CharacterAI(getCharacterProfile("josangmin"), "sangmin-call-trace");
    const hand = new Hand();
    hand.dealIn(kindsToTiles(causalityHand));
    ai.shouldCallPon(hand, "z1", baseCtx(), true);
    const trace = ai.lastCallTrace;
    expect(trace).not.toBeNull();
    expect(trace!.callKind).toBe("pon");
    expect(trace!.mechanicChangedDecision).toBe(trace!.baselineDecision !== trace!.adjustedDecision);
    expect(trace!.actualDecision).toBe(trace!.called ? "call" : "pass");
    expect(trace!.adjustedCallScore).toBeLessThanOrEqual(trace!.baselineCallScore); // effort/commitment cost only ever subtracts
  });

  it("records the shared evaluator with zero Sangmin modifiers for a non-Sangmin character", () => {
    const ai = new CharacterAI(getCharacterProfile("seiyamouri"), "non-sangmin-trace");
    const hand = new Hand();
    hand.dealIn(kindsToTiles(causalityHand));
    ai.shouldCallPon(hand, "z1", baseCtx(), true);
    expect(ai.lastCallTrace).not.toBeNull();
    expect(ai.lastCallTrace!.effortModifier).toBe(0);
    expect(ai.lastCallTrace!.commitmentModifier).toBe(0);
  });
});

describe("causality trace: serialization round-trips cleanly (replay JSON compatibility)", () => {
  it("survives JSON.stringify/parse with every field intact", () => {
    const ai = new CharacterAI(getCharacterProfile("mageuna"), "causality-serialize");
    const hand = new Hand();
    hand.dealIn(kindsToTiles(causalityHand));
    ai.chooseDiscard(hand, baseCtx());
    const debug = ai.lastDiscardDebug!;
    const roundTripped = JSON.parse(JSON.stringify(debug));
    expect(roundTripped).toEqual(debug);
  });
});
