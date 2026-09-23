import { describe, expect, it } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import { collectAllInvariantViolations } from "../src/validation/invariants.js";
import { buildPlayerView, riichiDiscardIndexOf } from "../src/core/playerView.js";
import { Hand } from "../src/core/Hand.js";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";
import type { DecisionRequest, DecisionResponse } from "../src/core/decisions.js";

/** The simplest possible human stand-in: never calls/kans/kitas, never riichis, always
 *  discards its first legal tile. Good enough to prove the interactive session drives a
 *  full hand end-to-end without throwing - this is the Milestone 1 CLI/test driver shape. */
function alwaysPassDriver(request: DecisionRequest): DecisionResponse {
  if (request.type === "discard") {
    return { type: "discard", tileId: request.legalTileIds[0]!, declareRiichi: false };
  }
  return { type: request.type, declare: false };
}

function driveInteractiveHand(gs: GameState, respond: (req: DecisionRequest) => DecisionResponse) {
  const session = gs.playHandInteractive();
  let step = session.next();
  let requestCount = 0;
  while (!step.done) {
    requestCount++;
    if (requestCount > 2000) throw new Error("driveInteractiveHand: runaway loop guard triggered");
    step = session.next(respond(step.value));
  }
  return requestCount;
}

function tile(kind: TileKind, id: number): Tile {
  const parsed = parseKind(kind);
  return { id, kind, suit: parsed.suit, rank: parsed.rank, isRed: false };
}

describe("Milestone 1: human-controlled seat plays a full hand via the interactive session", () => {
  it("a human seat 0 completes a full sanma hand start-to-finish against two AI seats, for many seeds", () => {
    let sawAtLeastOneRequest = false;
    for (let i = 0; i < 30; i++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `human-play-${i}`, humanSeats: [0] });
      const requestCount = driveInteractiveHand(gs, alwaysPassDriver);
      if (requestCount > 0) sawAtLeastOneRequest = true;
      expect(gs.log.some((e) => e.type === "hand_end")).toBe(true);
      const violations = collectAllInvariantViolations({ rules: DEFAULT_SANMA_RULES, events: gs.log });
      expect(violations, `seed human-play-${i}: ${JSON.stringify(violations)}`).toEqual([]);
    }
    expect(sawAtLeastOneRequest).toBe(true);
  });

  it("exercises all six Milestone 1 decision types across enough hands (discard, call_pon, call_daiminkan, ankan, kakan, kita)", () => {
    const seen = new Set<DecisionRequest["type"]>();
    const acceptPonAndKita = (request: DecisionRequest): DecisionResponse => {
      seen.add(request.type);
      if (request.type === "discard") {
        return { type: "discard", tileId: request.legalTileIds[0]!, declareRiichi: false };
      }
      // Accepting pon/kita (but not daiminkan/ankan) is what actually opens a meld a later
      // kakan can upgrade, while still leaving daiminkan/ankan/kita opportunities to occur
      // for real via the AI opponents' own discards/draws across enough seeds.
      return { type: request.type, declare: request.type === "call_pon" || request.type === "kita" };
    };
    for (let i = 0; i < 150; i++) {
      const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: `human-play-coverage-${i}`, humanSeats: [0] });
      driveInteractiveHand(gs, acceptPonAndKita);
    }
    // Later milestones add more request types (ron, nine_terminals); this test only guards that
    // all six Milestone 1 types keep occurring.
    expect([...seen].sort()).toEqual(expect.arrayContaining(["ankan", "call_daiminkan", "call_pon", "discard", "kakan", "kita"]));
  });

  it("playHand() (the AI-only sync entry point) throws instead of silently proceeding when a human seat is configured", () => {
    const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "human-play-guard", humanSeats: [0] });
    expect(() => gs.playHand()).toThrow(/playHandInteractive/);
  });

  it("a game with no controllers/humanSeats configured never yields (opt-in only)", () => {
    const withoutHuman = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "human-play-optin" });
    expect(() => withoutHuman.playHand()).not.toThrow();
  });

  it("a characterProfile no longer forces AI control: humanSeats still makes that seat human-controlled", () => {
    const gs = new GameState({
      rules: DEFAULT_SANMA_RULES,
      seed: "human-play-profile-plus-human",
      characterProfiles: [getCharacterProfile("jegalmina"), null, null],
      humanSeats: [0],
    });
    expect(gs.controllers[0]).toBe("human");
    const requestCount = driveInteractiveHand(gs, alwaysPassDriver);
    expect(requestCount).toBeGreaterThan(0);
    expect(gs.log.some((e) => e.type === "hand_end")).toBe(true);
  });

  it("explicit controllers array is authoritative over both characterProfiles and humanSeats", () => {
    const gs = new GameState({
      rules: DEFAULT_SANMA_RULES,
      seed: "human-play-explicit-controllers",
      characterProfiles: [getCharacterProfile("jegalmina"), null, null],
      humanSeats: [0], // would default seat 0 to "human", but the explicit entry below wins
      controllers: ["characterAI", undefined, undefined],
    });
    expect(gs.controllers).toEqual(["characterAI", "simpleAI", "simpleAI"]);
    expect(() => gs.playHand()).not.toThrow(); // never yields - seat 0 is CharacterAI-controlled
  });

  it("controllers default correctly from characterProfiles alone (backward compatibility)", () => {
    const gs = new GameState({
      rules: DEFAULT_SANMA_RULES,
      seed: "human-play-profile-default",
      characterProfiles: [getCharacterProfile("jegalmina"), null, null],
    });
    expect(gs.controllers).toEqual(["characterAI", "simpleAI", "simpleAI"]);
  });

  it("rejects the reserved \"customAI\" controller kind at construction time (not implemented yet)", () => {
    expect(
      () => new GameState({ rules: DEFAULT_SANMA_RULES, seed: "human-play-customai", controllers: ["customAI", undefined, undefined] })
    ).toThrow(/customAI/);
  });

  it("a characterAI-controlled seat without a characterProfile throws when the hand actually runs", () => {
    const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "human-play-missing-profile", controllers: ["characterAI", undefined, undefined] });
    expect(() => gs.playHand()).toThrow(/no characterProfile/);
  });

  it("rejects a discard response for a tileId not physically in the responding seat's hand", () => {
    const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "human-play-illegal-1", humanSeats: [0] });
    const session = gs.playHandInteractive();
    const step = session.next();
    expect(step.done).toBe(false);
    expect(() => session.next({ type: "discard", tileId: -999999, declareRiichi: false })).toThrow(/not a legal discard/);
  });

  it("rejects declaring riichi on a discard that would not leave the hand tenpai", () => {
    const gs = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "human-play-illegal-2", humanSeats: [0] });
    const session = gs.playHandInteractive();
    // Seat 0 is dealer, so a kita opportunity (or similar) may legally precede the first
    // discard request - pass through anything else with the same no-op driver used elsewhere.
    let step = session.next();
    while (!step.done && step.value.type !== "discard") {
      step = session.next(alwaysPassDriver(step.value));
    }
    expect(step.done).toBe(false);
    if (step.done || step.value.type !== "discard") throw new Error("expected a discard request before hand_end");
    // riichiLegalTileIds is a strict subset of legalTileIds for a fresh 14-tile hand (not
    // already tenpai) - anything in legalTileIds but NOT in riichiLegalTileIds is a real
    // illegal-riichi case to exercise, unless every legal tile happens to also be tenpai
    // (astronomically unlikely for a random opening hand, but guarded rather than assumed).
    const illegalRiichiTileId = step.value.legalTileIds.find((id) => !step.value.riichiLegalTileIds.includes(id));
    if (illegalRiichiTileId === undefined) return; // nothing to exercise this seed - not a failure
    expect(() => session.next({ type: "discard", tileId: illegalRiichiTileId, declareRiichi: true })).toThrow(/not a legal riichi discard/);
  });
});

describe("PlayerView information boundary", () => {
  it("never exposes another seat's concealed tiles, even though the underlying Hand[] holds them", () => {
    const hands = [new Hand(), new Hand(), new Hand()];
    hands[0]!.dealIn([tile("p1", 1), tile("p2", 2)]);
    hands[1]!.dealIn([tile("s9", 90), tile("s8", 91)]); // opponent's secret hand
    hands[2]!.dealIn([tile("z1", 50), tile("z2", 51)]); // opponent's secret hand

    const view = buildPlayerView({
      seat: 0,
      hands,
      doraIndicators: [tile("m1", 200)],
      scores: [35000, 35000, 35000],
      dealerSeat: 0,
      roundWind: 1,
      roundHandNumber: 1,
      honba: 0,
      kyotaku: 0,
      wallRemainingLive: 50,
    });

    expect(view.concealedTiles.map((t) => t.id)).toEqual([1, 2]);
    const serialized = JSON.stringify(view);
    // No opponent concealed tile id or kind ever appears anywhere in the seat-0 view.
    expect(serialized).not.toContain("90");
    expect(serialized).not.toContain("91");
    expect(serialized).not.toContain('"s9"');
    expect(serialized).not.toContain('"s8"');
    expect(serialized).not.toContain('"z1"');
    expect(serialized).not.toContain('"z2"');
    expect(view.opponents.map((o) => o.seat)).toEqual([1, 2]);
    for (const opponent of view.opponents) {
      expect(opponent).not.toHaveProperty("concealedTiles");
    }
  });

  it("opponent discards/melds are still visible (publicly known information)", () => {
    const hands = [new Hand(), new Hand()];
    hands[0]!.dealIn([tile("p1", 1)]);
    hands[1]!.dealIn([tile("s5", 5)]);
    hands[1]!.discards.push({ tile: tile("z3", 60), calledAway: false, isRiichiDeclaration: false, tsumogiri: false });

    const view = buildPlayerView({
      seat: 0,
      hands,
      doraIndicators: [],
      scores: [35000, 35000],
      dealerSeat: 0,
      roundWind: 1,
      roundHandNumber: 1,
      honba: 0,
      kyotaku: 0,
      wallRemainingLive: 50,
    });

    expect(view.opponents[0]!.discards).toEqual(["z3"]);
  });

  it("own discards mirror the opponent-discards convention (visible, excludes called-away tiles)", () => {
    const hands = [new Hand(), new Hand()];
    hands[0]!.dealIn([tile("p1", 1)]);
    hands[0]!.discards.push({ tile: tile("m3", 10), calledAway: false, isRiichiDeclaration: false, tsumogiri: false });
    hands[0]!.discards.push({ tile: tile("m4", 11), calledAway: true, isRiichiDeclaration: false, tsumogiri: false });
    hands[1]!.dealIn([tile("s5", 5)]);

    const view = buildPlayerView({
      seat: 0,
      hands,
      doraIndicators: [],
      scores: [35000, 35000],
      dealerSeat: 0,
      roundWind: 1,
      roundHandNumber: 1,
      honba: 0,
      kyotaku: 0,
      wallRemainingLive: 50,
    });

    expect(view.discards).toEqual(["m3"]);
  });
});

describe("riichiDiscardIndexOf (which visible river tile is drawn sideways)", () => {
  const entry = (kind: TileKind, id: number, opts: { riichi?: boolean; called?: boolean } = {}) => ({
    tile: tile(kind, id),
    calledAway: !!opts.called,
    isRiichiDeclaration: !!opts.riichi,
    tsumogiri: false,
  });
  const handWith = (...entries: ReturnType<typeof entry>[]) => {
    const h = new Hand();
    h.discards.push(...entries);
    return h;
  };

  it("is null without a riichi declaration", () => {
    expect(riichiDiscardIndexOf(handWith(entry("m1", 1), entry("p2", 2)))).toBeNull();
  });

  it("is the declaration tile's position among the visible discards", () => {
    expect(riichiDiscardIndexOf(handWith(entry("m1", 1), entry("p2", 2, { riichi: true }), entry("s3", 3)))).toBe(1);
    // an earlier called-away tile is not in the visible river, so it does not shift the count wrongly
    expect(riichiDiscardIndexOf(handWith(entry("m1", 1, { called: true }), entry("p2", 2, { riichi: true })))).toBe(0);
  });

  it("moves to the next visible discard when the declaration tile itself was called away", () => {
    expect(riichiDiscardIndexOf(handWith(entry("m1", 1), entry("p2", 2, { riichi: true, called: true }), entry("s3", 3)))).toBe(1);
  });

  it("is null when the declaration tile was called away and nothing was discarded after it", () => {
    expect(riichiDiscardIndexOf(handWith(entry("m1", 1), entry("p2", 2, { riichi: true, called: true })))).toBeNull();
  });

  it("is exposed for the seat itself and for opponents in a PlayerView", () => {
    const hands = [handWith(entry("m1", 1), entry("p2", 2, { riichi: true })), handWith(entry("s3", 3, { riichi: true })), new Hand()];
    const view = buildPlayerView({ seat: 0, hands, doraIndicators: [], scores: [35000, 35000, 35000], dealerSeat: 0, roundWind: 1, roundHandNumber: 1, honba: 0, kyotaku: 0, wallRemainingLive: 50 });
    expect(view.riichiDiscardIndex).toBe(1);
    expect(view.opponents.map((o) => o.riichiDiscardIndex)).toEqual([0, null]);
  });

  it("reports every seat's seat wind relative to the dealer", () => {
    const hands = [new Hand(), new Hand(), new Hand()];
    const base = { seat: 0, hands, doraIndicators: [], scores: [35000, 35000, 35000], roundWind: 1, roundHandNumber: 1, honba: 0, kyotaku: 0, wallRemainingLive: 50 };
    expect(buildPlayerView({ ...base, dealerSeat: 0 }).seatWinds).toEqual([1, 2, 3]);
    expect(buildPlayerView({ ...base, dealerSeat: 1 }).seatWinds).toEqual([3, 1, 2]);
    expect(buildPlayerView({ ...base, dealerSeat: 2 }).seatWinds).toEqual([2, 3, 1]);
  });

  it("exposes only the SIZE of an opponent's concealed hand, never its tiles", () => {
    const hands = [new Hand(), new Hand(), new Hand()];
    hands[1]!.dealIn([tile("s9", 90), tile("s8", 91), tile("z1", 92)]);
    const view = buildPlayerView({ seat: 0, hands, doraIndicators: [], scores: [35000, 35000, 35000], dealerSeat: 0, roundWind: 1, roundHandNumber: 1, honba: 0, kyotaku: 0, wallRemainingLive: 50 });
    expect(view.opponents.map((o) => o.concealedCount)).toEqual([3, 0]);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('"s9"');
    expect(serialized).not.toContain('"z1"');
  });
});
