import { describe, expect, it } from "vitest";
import { GameState } from "../src/core/GameState.js";
import type { AuditableWinResult, GameEvent, HandEndEvent } from "../src/core/GameLog.js";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";
import { buildGameReplayRecord } from "../src/sim/replayRecorder.js";
import { Hand } from "../src/core/Hand.js";
import { buildDoraBreakdown } from "../src/yaku/doraBreakdown.js";
import { buildWinSnapshot, meldToSnapshot } from "../src/yaku/winSnapshot.js";
import { collectAllInvariantViolations } from "../src/validation/invariants.js";

function tile(kind: TileKind, id: number, isRed = false): Tile {
  const parsed = parseKind(kind);
  return { id, kind, suit: parsed.suit, rank: parsed.rank, isRed };
}

describe("buildDoraBreakdown", () => {
  it("1. omote dora only: one indicator, one matching tile, totalHan 1", () => {
    const result = buildDoraBreakdown({
      scoringTiles: [tile("p2", 1), tile("m3", 2), tile("m3", 3)],
      kitaTiles: [],
      doraIndicators: [tile("p1", 10)],
      uraDoraIndicators: [],
      rules: DEFAULT_SANMA_RULES,
    });
    expect(result.totalHan).toBe(1);
    expect(result.sources).toEqual([
      { type: "omote", indicator: { kind: "p1", id: 10 }, doraKind: "p2", matchedTileIds: [1] },
    ]);
  });

  it("2. aka dora: a red tile with no indicator match", () => {
    const result = buildDoraBreakdown({
      scoringTiles: [tile("m5", 5, true), tile("s3", 6)],
      kitaTiles: [],
      doraIndicators: [tile("p1", 10)], // -> p2, matches nothing
      uraDoraIndicators: [],
      rules: DEFAULT_SANMA_RULES,
    });
    expect(result.totalHan).toBe(1);
    expect(result.sources).toContainEqual({ type: "aka", matchedTileIds: [5] });
  });

  it("3. kita dora: extracted north tiles are always 1 dora each", () => {
    const result = buildDoraBreakdown({
      scoringTiles: [tile("m3", 2)],
      kitaTiles: [tile("z4", 20), tile("z4", 21)],
      doraIndicators: [tile("p1", 10)],
      uraDoraIndicators: [],
      rules: DEFAULT_SANMA_RULES,
    });
    expect(result.totalHan).toBe(2);
    expect(result.sources).toContainEqual({ type: "kita", matchedTileIds: [20, 21] });
  });

  it("4. kan dora: a second (kan-revealed) indicator with a real match", () => {
    const result = buildDoraBreakdown({
      scoringTiles: [tile("p4", 30)],
      kitaTiles: [],
      doraIndicators: [tile("p1", 10), tile("p3", 18)], // index 0 = omote(p1->p2), index 1+ = kan(p3->p4)
      uraDoraIndicators: [],
      rules: DEFAULT_SANMA_RULES,
    });
    expect(result.totalHan).toBe(1);
    expect(result.sources).toContainEqual({ type: "kan", indicator: { kind: "p3", id: 18 }, doraKind: "p4", matchedTileIds: [30] });
  });

  it("5. ura dora: only emitted when the caller passes uraDoraIndicators (riichi)", () => {
    const withRiichi = buildDoraBreakdown({
      scoringTiles: [tile("s6", 40)],
      kitaTiles: [],
      doraIndicators: [tile("p1", 10)],
      uraDoraIndicators: [tile("s5", 41)], // -> s6
      rules: DEFAULT_SANMA_RULES,
    });
    expect(withRiichi.sources).toContainEqual({ type: "ura", indicator: { kind: "s5", id: 41 }, doraKind: "s6", matchedTileIds: [40] });
    expect(withRiichi.totalHan).toBe(1);

    const withoutRiichi = buildDoraBreakdown({
      scoringTiles: [tile("s6", 40)],
      kitaTiles: [],
      doraIndicators: [tile("p1", 10)],
      uraDoraIndicators: [],
      rules: DEFAULT_SANMA_RULES,
    });
    expect(withoutRiichi.sources.some((s) => s.type === "ura")).toBe(false);
  });

  it("6. one tile is simultaneously aka and omote dora - both sources claim the same id", () => {
    const result = buildDoraBreakdown({
      scoringTiles: [tile("p5", 50, true)],
      kitaTiles: [],
      doraIndicators: [tile("p4", 49)], // -> p5
      uraDoraIndicators: [],
      rules: DEFAULT_SANMA_RULES,
    });
    expect(result.totalHan).toBe(2);
    expect(result.sources).toContainEqual({ type: "omote", indicator: { kind: "p4", id: 49 }, doraKind: "p5", matchedTileIds: [50] });
    expect(result.sources).toContainEqual({ type: "aka", matchedTileIds: [50] });
  });

  it("7. two indicators pointing at the same kind are independent sources, both counting", () => {
    const result = buildDoraBreakdown({
      scoringTiles: [tile("p2", 60)],
      kitaTiles: [],
      doraIndicators: [tile("p1", 10), tile("p1", 11)], // both -> p2
      uraDoraIndicators: [],
      rules: DEFAULT_SANMA_RULES,
    });
    expect(result.totalHan).toBe(2);
    expect(result.sources.filter((s) => "doraKind" in s && s.doraKind === "p2")).toHaveLength(2);
    expect(result.sources).toEqual(expect.arrayContaining([
      { type: "omote", indicator: { kind: "p1", id: 10 }, doraKind: "p2", matchedTileIds: [60] },
      { type: "kan", indicator: { kind: "p1", id: 11 }, doraKind: "p2", matchedTileIds: [60] },
    ]));
  });

  it("8. an indicator is revealed but matches nothing - recorded with an empty matchedTileIds, not omitted", () => {
    const result = buildDoraBreakdown({
      scoringTiles: [tile("m3", 2)],
      kitaTiles: [],
      doraIndicators: [tile("p1", 10)], // -> p2, no p2 tile present
      uraDoraIndicators: [],
      rules: DEFAULT_SANMA_RULES,
    });
    expect(result.totalHan).toBe(0);
    expect(result.sources).toEqual([
      { type: "omote", indicator: { kind: "p1", id: 10 }, doraKind: "p2", matchedTileIds: [] },
    ]);
  });

  it("12. a win with zero dora produces totalHan 0 and no aka/kita sources", () => {
    const result = buildDoraBreakdown({
      scoringTiles: [tile("m3", 2), tile("s7", 3)],
      kitaTiles: [],
      doraIndicators: [tile("p1", 10)],
      uraDoraIndicators: [],
      rules: DEFAULT_SANMA_RULES,
    });
    expect(result.totalHan).toBe(0);
    expect(result.sources.every((s) => s.matchedTileIds.length === 0)).toBe(true);
  });
});

describe("buildWinSnapshot", () => {
  it("10. tsumo: winning tile is already part of concealedTiles (Hand's normal draw behavior)", () => {
    const hand = new Hand();
    hand.concealed = [tile("m1", 1), tile("m2", 2), tile("m3", 3)];
    const winningTile = tile("m3", 3);
    const snapshot = buildWinSnapshot({ hand, winningTile, isTsumo: true });
    expect(snapshot.winningTileSource).toBe("tsumo");
    expect(snapshot.concealedTiles.map((t) => t.id)).toContain(3);
  });

  it("9. ron: winning tile is NOT duplicated into concealedTiles (it belongs to the discarder)", () => {
    const hand = new Hand();
    hand.concealed = [tile("m1", 1), tile("m2", 2)]; // the ron tile (id 99) was popped back out by tryRon
    const winningTile = tile("m3", 99);
    const snapshot = buildWinSnapshot({ hand, winningTile, isTsumo: false });
    expect(snapshot.winningTileSource).toBe("ron");
    expect(snapshot.concealedTiles.map((t) => t.id)).not.toContain(99);
    expect(snapshot.winningTile).toEqual({ kind: "m3", id: 99 });
  });

  it("riichiState reflects double riichi over single riichi over none", () => {
    const hand = new Hand();
    hand.riichi = true;
    hand.doubleRiichi = true;
    expect(buildWinSnapshot({ hand, winningTile: tile("m1", 1), isTsumo: true }).riichiState).toBe("double_riichi");
    hand.doubleRiichi = false;
    expect(buildWinSnapshot({ hand, winningTile: tile("m1", 1), isTsumo: true }).riichiState).toBe("riichi");
    hand.riichi = false;
    expect(buildWinSnapshot({ hand, winningTile: tile("m1", 1), isTsumo: true }).riichiState).toBe("none");
  });

  it("11. meld type mapping: internal MeldType names translate to replay-facing names, tiles preserved", () => {
    expect(meldToSnapshot({ type: "pon", tiles: [tile("z1", 1), tile("z1", 2), tile("z1", 3)], calledFrom: 1 }))
      .toEqual({ type: "pon", tiles: [{ kind: "z1", id: 1 }, { kind: "z1", id: 2 }, { kind: "z1", id: 3 }], fromPlayer: 1 });
    expect(meldToSnapshot({ type: "chi", tiles: [tile("m1", 1), tile("m2", 2), tile("m3", 3)], calledFrom: 0 }).type).toBe("chi");
    expect(meldToSnapshot({ type: "kan_open", tiles: [tile("s1", 1), tile("s1", 2), tile("s1", 3), tile("s1", 4)], calledFrom: 2 }).type).toBe("daiminkan");
    expect(meldToSnapshot({ type: "kan_closed", tiles: [tile("p1", 1), tile("p1", 2), tile("p1", 3), tile("p1", 4)] }).type).toBe("ankan");
    expect(meldToSnapshot({ type: "kan_added", tiles: [tile("p9", 1), tile("p9", 2), tile("p9", 3), tile("p9", 4)], calledFrom: 1 }).type).toBe("kakan");
  });

  it("meld with no calledFrom (ankan) omits fromPlayer entirely rather than serializing undefined", () => {
    const snapshot = meldToSnapshot({ type: "kan_closed", tiles: [tile("p1", 1), tile("p1", 2), tile("p1", 3), tile("p1", 4)] });
    expect("fromPlayer" in snapshot).toBe(false);
  });
});

describe("Replay Schema v2 end-to-end via real self-play", () => {
  it("real seeded games produce zero v2 violations across sanma and yonma, including ron/tsumo/kan/ura/kita paths", () => {
    for (const [rules, label] of [[DEFAULT_SANMA_RULES, "sanma"], [MAJSOUL_YONMA_RULES, "yonma"]] as const) {
      let agariCount = 0;
      let ronSeen = false;
      let tsumoSeen = false;
      for (let i = 0; i < 40; i++) {
        const game = new GameState({ rules, seed: `schema-v2-e2e-${label}-${i}` });
        game.playGame();
        const violations = collectAllInvariantViolations({ rules, events: game.log });
        expect(violations, `seed schema-v2-e2e-${label}-${i}: ${JSON.stringify(violations)}`).toEqual([]);
        for (const e of game.log) {
          if (e.type === "hand_end" && e.result?.kind === "agari") {
            for (const w of e.result.winners) {
              agariCount++;
              if (w.method === "ron") ronSeen = true;
              if (w.method === "tsumo") tsumoSeen = true;
            }
          }
        }
      }
      expect(agariCount, `${label}: expected real wins in the sample`).toBeGreaterThan(0);
      expect(ronSeen, `${label}: expected at least one ron in the sample`).toBe(true);
      expect(tsumoSeen, `${label}: expected at least one tsumo in the sample`).toBe(true);
    }
  });

  it("replay records carry replaySchemaVersion 2 and round-trip through JSON", () => {
    const game = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "schema-v2-record" });
    game.playHand();
    const record = buildGameReplayRecord(game, "schema-v2-record", 0, [0, 1, 2, 3].map((seat) => ({ seat, kind: "simpleAI" as const })));
    expect(record.meta.replaySchemaVersion).toBe(2);
    const roundTripped = JSON.parse(JSON.stringify(record));
    expect(roundTripped.meta.replaySchemaVersion).toBe(2);
  });
});

describe("13. v1 replay compatibility", () => {
  function v1WinnerFixture(): AuditableWinResult {
    return {
      winnerSeat: 0,
      loserSeat: null,
      method: "tsumo",
      winningTile: { kind: "m1", id: 1 },
      isDealer: true,
      yaku: [{ name: "Riichi", han: 1 }, { name: "Dora", han: 1 }],
      han: 2,
      fu: 30,
      yakumanUnits: 0,
      basePoints: 480,
      totalPoints: 1920,
      paymentDeltas: { 0: 1920, 1: -640, 2: -640, 3: -640 },
      scoringFlags: {
        riichi: true, doubleRiichi: false, ippatsu: false, rinshan: false,
        chankan: false, haitei: false, houtei: false, tenhou: false, chiihou: false,
      },
      // no doraBreakdown, no snapshot - this is what every replay written before Schema v2 looks like
    };
  }

  function v1HandEndEvents(): GameEvent[] {
    const handEnd: HandEndEvent = {
      type: "hand_end",
      scores: [27920, 24360, 23360, 24360],
      nextDealer: 0,
      honba: 1,
      kyotaku: 0,
      result: {
        kind: "agari",
        winners: [v1WinnerFixture()],
        kyotakuRecipient: null,
        kyotakuAwarded: 0,
        dealerSeat: 0,
        dealerContinues: true,
        honbaBefore: 0,
        honbaAfter: 1,
        kyotakuBefore: 0,
        kyotakuAfter: 0,
        scoresBeforeSettlement: [26000, 25000, 24000, 25000],
        scoresAfterSettlement: [27920, 24360, 23360, 24360],
        pointDeltas: { 0: 1920, 1: -640, 2: -640, 3: -640 },
      },
    };
    return [
      { type: "hand_start", handIndex: 0, roundWind: 1, roundHandNumber: 1, dealer: 0, honba: 0, kyotaku: 0, scores: [25000, 25000, 25000, 25000], wallSeed: 1 },
      handEnd,
    ];
  }

  it("a v1 replay (missing doraBreakdown/snapshot) reading with schemaVersion 1 produces no v2 violations", () => {
    const violations = collectAllInvariantViolations({ rules: MAJSOUL_YONMA_RULES, events: v1HandEndEvents(), schemaVersion: 1 });
    expect(violations.filter((v) => v.category === "dora_breakdown" || v.category === "win_snapshot")).toEqual([]);
  });

  it("14. the same missing fields, read as schemaVersion 2 (the default), ARE flagged as violations", () => {
    const violations = collectAllInvariantViolations({ rules: MAJSOUL_YONMA_RULES, events: v1HandEndEvents() });
    const v2Violations = violations.filter((v) => v.category === "dora_breakdown" || v.category === "win_snapshot");
    expect(v2Violations.length).toBeGreaterThan(0);
    expect(v2Violations.some((v) => v.message.includes("doraBreakdown is missing"))).toBe(true);
    expect(v2Violations.some((v) => v.message.includes("snapshot is missing"))).toBe(true);
  });
});
