import { describe, it, expect } from "vitest";
import { collectAllInvariantViolations, type Violation } from "../src/validation/invariants.js";
import { emptyEventCoverage, accumulateEventCoverage } from "../src/validation/eventCoverage.js";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { CHARACTER_PROFILES } from "../src/ai/characterProfiles.js";
import type { GameEvent } from "../src/core/GameLog.js";
import type { RuleConfig } from "../src/rules/RuleConfig.js";

const RULES = DEFAULT_SANMA_RULES;
const S = RULES.startingScore;

/** A single unique-per-call tile kind generator so hand-crafted fixtures never accidentally
 *  trip the tile-kind ceiling check by reusing the same kind too many times. Sticks to pinzu
 *  and souzu (1-9) only - DEFAULT_SANMA_RULES removes manzu 2-8, so a naive m1..m9 sequence
 *  would itself be invalid under this ruleset. */
function kindSeq(n: number, offset = 0): string[] {
  const suits = ["p", "s"] as const;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = i + offset;
    const suit = suits[v % 2]!;
    const rank = 1 + (Math.floor(v / 2) % 9);
    out.push(`${suit}${rank}`);
  }
  return out;
}

/** Minimal, otherwise-clean single-hand event log: deal, one full go-around of draw+discard
 *  for each seat, then an exhaustive draw with nobody tenpai (deltas={}) so every existing
 *  replay-consistency check (score/kyotaku/honba/dealer progression) is satisfied too -
 *  isolating whatever mutation a given test applies to just the invariant it targets. */
function baselineHandEvents(): GameEvent[] {
  const dealKinds = kindSeq(39, 0); // 13 per seat, all distinct across the whole deal
  const events: GameEvent[] = [
    { type: "hand_start", handIndex: 0, roundWind: 1, roundHandNumber: 1, dealer: 0, honba: 0, kyotaku: 0, scores: [S, S, S], wallSeed: 1 },
    {
      type: "deal",
      hands: [dealKinds.slice(0, 13), dealKinds.slice(13, 26), dealKinds.slice(26, 39)],
      doraIndicator: "z1",
    },
    { type: "draw", player: 0, tile: "m1", source: "wall" },
    { type: "discard", player: 0, tile: "m1", tsumogiri: true, riichiDeclaration: false },
    { type: "draw", player: 1, tile: "p5", source: "wall" },
    { type: "discard", player: 1, tile: "p5", tsumogiri: true, riichiDeclaration: false },
    { type: "draw", player: 2, tile: "s5", source: "wall" },
    { type: "discard", player: 2, tile: "s5", tsumogiri: true, riichiDeclaration: false },
    { type: "exhaustive_draw", tenpaiPlayers: [], deltas: {} },
    { type: "hand_end", scores: [S, S, S], nextDealer: 1, honba: 1, kyotaku: 0 },
  ];
  return events;
}

function violationsOf(events: GameEvent[], rules: RuleConfig = RULES): Violation[] {
  return collectAllInvariantViolations({ rules, events });
}
function categories(violations: Violation[]): Set<string> {
  return new Set(violations.map((v) => v.category));
}

describe("validation harness: invariant helper self-test (intentional invalid states)", () => {
  it("baseline fixture itself is clean (sanity check for every other test in this file)", () => {
    expect(violationsOf(baselineHandEvents())).toEqual([]);
  });

  it("detects a turn_sequencing violation: a discard with no draw/call/kita ever giving that seat a tile", () => {
    const events = baselineHandEvents();
    // seat 0 discards twice in a row with nothing in between - structurally impossible
    events.splice(4, 0, { type: "discard", player: 0, tile: "z2", tsumogiri: false, riichiDeclaration: false });
    expect(categories(violationsOf(events))).toContain("turn_sequencing");
  });

  it("detects a hand_size violation: the deal itself hands a seat the wrong tile count", () => {
    const events = baselineHandEvents();
    const dealEvt = events.find((e): e is Extract<GameEvent, { type: "deal" }> => e.type === "deal")!;
    dealEvt.hands[0]!.pop(); // seat 0 dealt only 12 tiles instead of 13
    expect(categories(violationsOf(events))).toContain("hand_size");
  });

  it("detects a tile_kind_ceiling violation: the same kind revealed 5 times in one hand", () => {
    const events = baselineHandEvents();
    const dealEvt = events.find((e): e is Extract<GameEvent, { type: "deal" }> => e.type === "deal")!;
    // stuff 5 copies of m1 into the deal (4 is the legal max)
    dealEvt.hands[0]![0] = "m1";
    dealEvt.hands[0]![1] = "m1";
    dealEvt.hands[1]![0] = "m1";
    dealEvt.hands[1]![1] = "m1";
    dealEvt.hands[2]![0] = "m1";
    expect(categories(violationsOf(events))).toContain("tile_kind_ceiling");
  });

  it("detects a riichi_menzen violation: riichi declared after an open pon", () => {
    const events = baselineHandEvents();
    events.splice(2, 0, { type: "call", call: "pon", player: 0, kind: "z2", fromPlayer: 1 });
    events.splice(3, 0, { type: "riichi", player: 0 });
    expect(categories(violationsOf(events))).toContain("riichi_menzen");
  });

  it("detects a riichi_single_deduction violation: two riichi events for the same seat in one hand", () => {
    const events = baselineHandEvents();
    events.splice(3, 0, { type: "riichi", player: 0 });
    events.splice(4, 0, { type: "riichi", player: 0 });
    expect(categories(violationsOf(events))).toContain("riichi_single_deduction");
  });

  it("detects an ippatsu_timing violation: Ippatsu claimed after a call broke the window", () => {
    const events = baselineHandEvents();
    events.splice(3, 0, { type: "riichi", player: 0 });
    events.splice(4, 0, { type: "call", call: "pon", player: 1, kind: "z2", fromPlayer: 0 });
    // replace the exhaustive draw's surrounding win with a bogus Ippatsu win for player 0
    const idx = events.findIndex((e) => e.type === "exhaustive_draw");
    events[idx] = {
      type: "win",
      player: 0,
      isTsumo: true,
      yaku: [{ name: "Ippatsu", han: 1 }],
      han: 2,
      fu: 30,
      yakumanUnits: 0,
      points: 2000,
      deltas: { 0: 2000, 1: -1000, 2: -1000 },
    } as Extract<GameEvent, { type: "win" }>;
    expect(categories(violationsOf(events))).toContain("ippatsu_timing");
  });

  it("detects a kita_replacement violation: a kita event not followed by a rinshan draw or robbing ron", () => {
    const events = baselineHandEvents();
    events.splice(3, 0, { type: "kita", player: 0, tile: "z4" });
    // next event stays a normal wall draw for player 1 - no rinshan replacement for player 0
    expect(categories(violationsOf(events))).toContain("kita_replacement");
  });

  it("detects a win_legality violation: tsumo winningTile that doesn't match the seat's last draw", () => {
    const events = baselineHandEvents();
    const handEnd = events.find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end")!;
    handEnd.result = {
      kind: "agari",
      winners: [
        {
          winnerSeat: 0,
          loserSeat: null,
          method: "tsumo",
          winningTile: { kind: "z7", id: 1 }, // player 0's last draw in the baseline is "m1", not z9
          isDealer: true,
          yaku: [{ name: "Riichi", han: 1 }],
          han: 1,
          fu: 30,
          yakumanUnits: 0,
          basePoints: 1000,
          totalPoints: 1000,
          paymentDeltas: { 0: 2000, 1: -1000, 2: -1000 },
          scoringFlags: { riichi: false, doubleRiichi: false, ippatsu: false, rinshan: false, chankan: false, haitei: false, houtei: false, tenhou: false, chiihou: false },
        },
      ],
      kyotakuRecipient: null,
      kyotakuAwarded: 0,
      roundWind: 1,
      roundHandNumber: 1,
      dealerSeat: 0,
      dealerContinues: true,
      nextDealer: 0,
      nextRoundWind: 1,
      nextRoundHandNumber: 1,
      honbaBefore: 0,
      honbaAfter: 1,
      kyotakuBefore: 0,
      kyotakuAfter: 0,
      scoresBeforeSettlement: [S, S, S],
      scoresAfterSettlement: [S, S, S],
      pointDeltas: {},
    };
    expect(categories(violationsOf(events))).toContain("win_legality");
  });

  it("detects a furiten_own_discard violation: ron declared on a kind this seat already discarded", () => {
    const events = baselineHandEvents();
    const handEnd = events.find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end")!;
    // player 1 discarded "p5" earlier in the baseline hand - have player 0 "ron" that exact kind
    handEnd.result = {
      kind: "agari",
      winners: [
        {
          winnerSeat: 0,
          loserSeat: 1,
          method: "ron",
          winningTile: { kind: "m1", id: 1 }, // player 0's OWN earlier discard kind
          isDealer: true,
          yaku: [{ name: "Riichi", han: 1 }],
          han: 1,
          fu: 30,
          yakumanUnits: 0,
          basePoints: 1000,
          totalPoints: 1000,
          paymentDeltas: { 0: 1000, 1: -1000 },
          scoringFlags: { riichi: false, doubleRiichi: false, ippatsu: false, rinshan: false, chankan: false, haitei: false, houtei: false, tenhou: false, chiihou: false },
        },
      ],
      kyotakuRecipient: null,
      kyotakuAwarded: 0,
      roundWind: 1,
      roundHandNumber: 1,
      dealerSeat: 0,
      dealerContinues: true,
      nextDealer: 0,
      nextRoundWind: 1,
      nextRoundHandNumber: 1,
      honbaBefore: 0,
      honbaAfter: 1,
      kyotakuBefore: 0,
      kyotakuAfter: 0,
      scoresBeforeSettlement: [S, S, S],
      scoresAfterSettlement: [S, S, S],
      pointDeltas: {},
    };
    expect(categories(violationsOf(events))).toContain("furiten_own_discard");
  });
});

describe("validation harness: false-positive avoidance (section 25)", () => {
  it("a legal 'robbing the kita' ron (sanma: ronning an extracted North tile) is not misread as an illegal win (regression: found by real 1000-game self-play, this harness's own bug, not an engine bug)", () => {
    const events = baselineHandEvents();
    const handEnd = events.find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end")!;
    // player 1 draws and extracts North (kita), player 0 immediately robs it via ron
    events.splice(4, 0, { type: "draw", player: 1, tile: "z4", source: "wall" });
    events.splice(5, 0, { type: "kita", player: 1, tile: "z4" });
    const winIdx = events.findIndex((e) => e.type === "exhaustive_draw");
    events[winIdx] = {
      type: "win",
      player: 0,
      isTsumo: false,
      ronFrom: 1,
      yaku: [{ name: "Kokushi Musou", han: 13 }],
      han: 13,
      fu: 0,
      yakumanUnits: 1,
      points: 48400,
      deltas: { 0: 48400, 1: -48400, 2: 0 },
    } as Extract<GameEvent, { type: "win" }>;
    handEnd.result = {
      kind: "agari",
      winners: [
        {
          winnerSeat: 0,
          loserSeat: 1,
          method: "ron",
          winningTile: { kind: "z4", id: 1 },
          isDealer: true,
          yaku: [{ name: "Kokushi Musou", han: 13 }],
          han: 13,
          fu: 0,
          yakumanUnits: 1,
          basePoints: 48400,
          totalPoints: 48400,
          paymentDeltas: { 0: 48400, 1: -48400 },
          scoringFlags: { riichi: false, doubleRiichi: false, ippatsu: false, rinshan: false, chankan: false, haitei: false, houtei: false, tenhou: false, chiihou: false },
        },
      ],
      kyotakuRecipient: null,
      kyotakuAwarded: 0,
      roundWind: 1,
      roundHandNumber: 1,
      dealerSeat: 0,
      dealerContinues: true,
      nextDealer: 0,
      nextRoundWind: 1,
      nextRoundHandNumber: 1,
      honbaBefore: 0,
      honbaAfter: 1,
      kyotakuBefore: 0,
      kyotakuAfter: 0,
      scoresBeforeSettlement: [S, S, S],
      scoresAfterSettlement: [S, S, S],
      pointDeltas: {},
    };
    expect(categories(violationsOf(events))).not.toContain("win_legality");
  });

  it("a called-away discard is not misread as a duplicate/impossible state", () => {
    const events = baselineHandEvents();
    // player 1's discard gets ponned by player 2 (called-away), then play continues normally
    events.splice(6, 0, { type: "call", call: "pon", player: 2, kind: "p5", fromPlayer: 1 });
    events.splice(7, 0, { type: "discard", player: 2, tile: "z6", tsumogiri: false, riichiDeclaration: false });
    // remove the now-redundant original seat-2 wall draw/discard that followed in the baseline,
    // since seat 2 acted via the call instead of a normal draw this go-around
    const drawIdx = events.findIndex((e, i) => i > 7 && e.type === "draw" && e.player === 2);
    events.splice(drawIdx, 2);
    expect(violationsOf(events)).toEqual([]);
  });

  it("a legal shouminkan (kan_added) upgrade does not trip a false hand_size violation (regression: this harness's own bug, fixed during development)", () => {
    const events = baselineHandEvents();
    // player 0 pons z9 earlier, then later upgrades it to a kan via kan_added + rinshan draw
    events.splice(2, 0, { type: "call", call: "pon", player: 0, kind: "z7", fromPlayer: 1 });
    events.splice(3, 0, { type: "discard", player: 0, tile: "z6", tsumogiri: false, riichiDeclaration: false });
    events.splice(4, 0, { type: "draw", player: 0, tile: "z7", source: "wall" });
    events.splice(5, 0, { type: "call", call: "kan_added", player: 0, kind: "z7" });
    events.splice(6, 0, { type: "draw", player: 0, tile: "z7", source: "rinshan" });
    events.splice(7, 0, { type: "discard", player: 0, tile: "z7", tsumogiri: true, riichiDeclaration: false });
    expect(categories(violationsOf(events))).not.toContain("hand_size");
  });

  it("riichi stick asset accounting: kyotaku conservation holds across a riichi declaration mid-hand", () => {
    const events = baselineHandEvents();
    events.splice(3, 0, { type: "riichi", player: 0 });
    const handEnd = events.find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end")!;
    handEnd.scores = [S - 1000, S, S];
    handEnd.kyotaku = 1;
    expect(categories(violationsOf(events))).not.toContain("replay_consistency");
  });
});

describe("validation harness: determinism (section 15/18)", () => {
  it("identical seed + roster produce an identical event log, AI decision log, and final scores", () => {
    const roster = [CHARACTER_PROFILES.byeonari!, CHARACTER_PROFILES.seiyamouri!, CHARACTER_PROFILES.kyletyler!];
    const gs1 = new GameState({ rules: RULES, seed: "validation-harness-determinism", characterProfiles: roster });
    gs1.playGame();
    const gs2 = new GameState({ rules: RULES, seed: "validation-harness-determinism", characterProfiles: roster });
    gs2.playGame();
    expect(gs2.log).toEqual(gs1.log);
    expect(gs2.aiDecisionLog).toEqual(gs1.aiDecisionLog);
    expect(gs2.scores).toEqual(gs1.scores);
  });
});

describe("validation harness: failure seed serialization", () => {
  it("a failure record (seed + violations) round-trips through JSON without losing information", () => {
    const events = baselineHandEvents();
    events.splice(3, 0, { type: "riichi", player: 0 });
    events.splice(4, 0, { type: "riichi", player: 0 });
    const violations = violationsOf(events);
    const failure = { gameSeed: "repro-seed-123", gameIndex: 7, violations };
    const roundTripped = JSON.parse(JSON.stringify(failure));
    expect(roundTripped).toEqual(failure);
    expect(roundTripped.gameSeed).toBe("repro-seed-123");
    expect(roundTripped.violations.length).toBeGreaterThan(0);
  });
});

describe("validation harness: event coverage counting", () => {
  it("counts hands, wins, and calls correctly on a small real self-play sample", () => {
    const roster = [CHARACTER_PROFILES.byeonari!, CHARACTER_PROFILES.seiyamouri!, CHARACTER_PROFILES.jegalnahui!];
    const coverage = emptyEventCoverage();
    for (let i = 0; i < 3; i++) {
      const gs = new GameState({ rules: RULES, seed: `coverage-sample-${i}`, characterProfiles: roster });
      gs.playGame();
      accumulateEventCoverage(coverage, gs.log);
    }
    expect(coverage.hands).toBeGreaterThan(0);
    expect(coverage.ron + coverage.tsumo + coverage.exhaustiveDraw + Object.values(coverage.abortiveByReason).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });
});
