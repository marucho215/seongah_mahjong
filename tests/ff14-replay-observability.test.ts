import { describe, expect, it } from "vitest";
import { GameState } from "../src/core/GameState.js";
import type { AuditableWinResult, GameEvent } from "../src/core/GameLog.js";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";
import { MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";
import { buildGameReplayRecord } from "../src/sim/replayRecorder.js";
import { evaluateInitialDealerWin } from "../src/yaku/evaluate.js";
import type { WinContext } from "../src/yaku/types.js";

type PendingResult = Parameters<(
  dealerRepeats: boolean,
  isExhaustiveDraw: boolean,
  allowDealerEnd?: boolean,
  pendingResult?: unknown
) => void>[3];

function commit(
  game: GameState,
  dealerRepeats: boolean,
  isDraw: boolean,
  pending: PendingResult
) {
  (game as unknown as {
    advanceAfterHand(repeats: boolean, draw: boolean, allowDealerEnd: boolean, result: unknown): void;
  }).advanceAfterHand(dealerRepeats, isDraw, true, pending);
  return game.log.at(-1) as Extract<GameEvent, { type: "hand_end" }>;
}

function winner(overrides: Partial<AuditableWinResult> = {}): AuditableWinResult {
  return {
    winnerSeat: 1,
    loserSeat: 2,
    method: "ron",
    winningTile: { kind: "m5", id: 401 },
    isDealer: false,
    yaku: [{ name: "Riichi", han: 1 }],
    han: 1,
    fu: 40,
    yakumanUnits: 0,
    basePoints: 320,
    totalPoints: 1300,
    paymentDeltas: { 0: 0, 1: 1300, 2: -1300, 3: 0 },
    scoringFlags: {
      riichi: true,
      doubleRiichi: false,
      ippatsu: false,
      rinshan: false,
      chankan: false,
      haitei: false,
      houtei: false,
      tenhou: false,
      chiihou: false,
    },
    ...overrides,
  };
}

function tile(kind: TileKind, id: number): Tile {
  const parsed = parseKind(kind);
  return { id, kind, suit: parsed.suit, rank: parsed.rank, isRed: false };
}

function tenhouContext(): WinContext {
  return {
    seatWind: 1,
    roundWind: 1,
    isTsumo: true,
    isRiichi: false,
    isDoubleRiichi: false,
    isIppatsu: false,
    isHaitei: false,
    isHoutei: false,
    isRinshan: false,
    isChankan: false,
    isTenhou: true,
    isChiihou: false,
    doraCount: 0,
    uraDoraCount: 0,
    akaDoraCount: 0,
    kanCount: 0,
  };
}

describe("FF-14 auditable hand-result replay logging", () => {
  it("records an authoritative ron settlement and progression transition additively", () => {
    const game = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "ff14-ron" });
    game.honba = 2;
    game.kyotaku = 0; // settlement has already awarded the previously deposited stick
    game.scores = [25000, 26300, 23700, 25000];
    const end = commit(game, false, false, {
      kind: "agari",
      winners: [winner()],
      kyotakuRecipient: 1,
      kyotakuAwarded: 1000,
      scoresBeforeSettlement: [25000, 24000, 25000, 25000],
      pointDeltas: { 0: 0, 1: 2300, 2: -1300, 3: 0 },
      kyotakuBefore: 1,
    });

    expect(end).toMatchObject({ scores: [25000, 26300, 23700, 25000], nextDealer: 1 });
    expect(end.result).toMatchObject({
      kind: "agari",
      dealerSeat: 0,
      dealerContinues: false,
      honbaBefore: 2,
      honbaAfter: 0,
      kyotakuBefore: 1,
      kyotakuAfter: 0,
      kyotakuRecipient: 1,
      kyotakuAwarded: 1000,
      pointDeltas: { 0: 0, 1: 2300, 2: -1300, 3: 0 },
      winners: [{
        winnerSeat: 1,
        loserSeat: 2,
        method: "ron",
        winningTile: { kind: "m5", id: 401 },
        yaku: [{ name: "Riichi", han: 1 }],
        han: 1,
        fu: 40,
        basePoints: 320,
        totalPoints: 1300,
      }],
    });
  });

  it("records tsumo payer deltas and special scoring context", () => {
    const game = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "ff14-tsumo" });
    game.scores = [26800, 24400, 24400, 24400];
    const tsumo = winner({
      winnerSeat: 0,
      loserSeat: null,
      method: "tsumo",
      winningTile: { kind: "p9", id: 777 },
      isDealer: true,
      yaku: [{ name: "Rinshan Kaihou", han: 1 }],
      paymentDeltas: { 0: 1800, 1: -600, 2: -600, 3: -600 },
      totalPoints: 1800,
      scoringFlags: { ...winner().scoringFlags, riichi: false, rinshan: true },
    });
    const end = commit(game, true, false, {
      kind: "agari",
      winners: [tsumo],
      kyotakuRecipient: null,
      kyotakuAwarded: 0,
      scoresBeforeSettlement: [25000, 25000, 25000, 25000],
      pointDeltas: { 0: 1800, 1: -600, 2: -600, 3: -600 },
      kyotakuBefore: 0,
    });

    expect(end.result).toMatchObject({
      kind: "agari",
      dealerContinues: true,
      winners: [{
        method: "tsumo",
        winningTile: { kind: "p9", id: 777 },
        paymentDeltas: { 0: 1800, 1: -600, 2: -600, 3: -600 },
        scoringFlags: { rinshan: true },
      }],
    });
  });

  it("exposes FF-13's selected initial-14 winning tile and yakuman multiplier", () => {
    const kinds: TileKind[] = [
      "m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "z3", "z4", "z5", "z6", "z7", "m1",
    ];
    const concealed = kinds.map((kind, index) => tile(kind, 900 + index));
    const scored = evaluateInitialDealerWin({
      concealedTiles: concealed,
      melds: [],
      context: tenhouContext(),
      rules: MAJSOUL_YONMA_RULES,
      winner: 0,
      dealer: 0,
      honba: 0,
    })!;

    expect(scored.winningTile).toMatchObject({ kind: "m1", id: 900 });
    expect(scored.yaku).toEqual(expect.arrayContaining([
      { name: "Kokushi Musou (13-wait)", han: 26 },
      { name: "Tenhou", han: 13 },
    ]));
    expect(scored.yakumanUnits).toBe(3);
  });

  it("records exhaustive draw seats, noten movement, carry-over, and next round state", () => {
    const game = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "ff14-draw" });
    game.honba = 1;
    game.kyotaku = 2;
    game.scores = [26500, 26500, 23500, 23500];
    const end = commit(game, true, true, {
      kind: "exhaustive_draw",
      tenpaiSeats: [0, 1],
      notenSeats: [2, 3],
      nagashiManganSeats: [],
      scoresBeforeSettlement: [25000, 25000, 25000, 25000],
      pointDeltas: { 0: 1500, 1: 1500, 2: -1500, 3: -1500 },
      kyotakuBefore: 2,
    });

    expect(end.result).toMatchObject({
      kind: "exhaustive_draw",
      tenpaiSeats: [0, 1],
      notenSeats: [2, 3],
      nagashiManganSeats: [],
      dealerContinues: true,
      honbaBefore: 1,
      honbaAfter: 2,
      kyotakuBefore: 2,
      kyotakuAfter: 2,
      pointDeltas: { 0: 1500, 1: 1500, 2: -1500, 3: -1500 },
    });
  });

  it("records existing abortive reasons without inventing settlement", () => {
    const game = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "ff14-abort" });
    game.applyAbortiveDraw("four_winds");
    const end = game.log.at(-1) as Extract<GameEvent, { type: "hand_end" }>;

    expect(end.result).toMatchObject({
      kind: "abortive_draw",
      reason: "four_winds",
      dealerContinues: true,
      pointDeltas: { 0: 0, 1: 0, 2: 0, 3: 0 },
    });
  });

  it("serializes a real seeded hand deterministically while retaining legacy replay fields", () => {
    const make = () => {
      const game = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: "ff14-determinism" });
      game.playHand();
      return buildGameReplayRecord(game, "ff14", 0, [0, 1, 2, 3].map((seat) => ({
        seat,
        kind: "simpleAI" as const,
      })));
    };
    const first = make();
    const second = make();
    const handEnd = first.events.findLast(
      (event): event is Extract<GameEvent, { type: "hand_end" }> => event.type === "hand_end"
    )!;

    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(first).toEqual(second);
    expect(handEnd.result).toBeDefined();
    expect(handEnd).toEqual(expect.objectContaining({
      type: "hand_end",
      scores: expect.any(Array),
      nextDealer: expect.any(Number),
      honba: expect.any(Number),
      kyotaku: expect.any(Number),
    }));
  });
});
