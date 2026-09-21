import { describe, expect, it } from "vitest";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import type { GameEvent } from "../src/core/GameLog.js";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";
import { buildGameReplayRecord, type GameReplayRecord, type ReplaySeatInfo } from "../src/sim/replayRecorder.js";
import { collectReplayInvariantViolations } from "./helpers/replayQa.js";

const baseIds = ["jegalmina", "toumesuayo", "byeonari", "seiyakouri"];
const yonmaRecords: Array<GameReplayRecord | undefined> = [];
let sanmaRecord: GameReplayRecord | undefined;

function seats(ids: readonly string[]): ReplaySeatInfo[] {
  return ids.map((characterId, seat) => ({ seat, kind: "characterAI", characterId }));
}

function yonmaRecord(index: number): GameReplayRecord {
  const cached = yonmaRecords[index];
  if (cached) return cached;
  const rotations = [[...baseIds.slice(1), baseIds[0]!], baseIds];
  const seed = ["yonma-qa-002", "yonma-qa-003"][index]!;
  const ids = rotations[index]!;
  const game = new GameState({
    rules: MAJSOUL_YONMA_RULES,
    seed,
    characterProfiles: ids.map((id) => getCharacterProfile(id)),
  });
  game.playGame();
  const record = buildGameReplayRecord(game, `phase-d-${seed}`, index, seats(ids));
  yonmaRecords[index] = record;
  return record;
}

function getSanmaRecord(): GameReplayRecord {
  if (sanmaRecord) return sanmaRecord;
  const sanmaIds = baseIds.slice(0, 3);
  const sanma = new GameState({
    rules: DEFAULT_SANMA_RULES,
    seed: "phase-d-sanma-no-chi",
    characterProfiles: sanmaIds.map((id) => getCharacterProfile(id)),
  });
  sanma.playGame();
  sanmaRecord = buildGameReplayRecord(sanma, "phase-d-sanma-no-chi", 0, seats(sanmaIds));
  return sanmaRecord;
}

describe("Phase D deterministic replay invariants", () => {
  it.each([0, 1])("checks fixed yonma replay %i without snapshotting its action array", (index) => {
    const record = yonmaRecord(index);
    expect(collectReplayInvariantViolations({ rules: record.meta.rules, events: record.events })).toEqual([]);
    expect(record.events.at(-1)?.type).toBe("game_end");
  });

  it("covers representative seat rotations and live call/riichi/kan paths", () => {
    const records = [yonmaRecord(0), yonmaRecord(1)];
    expect(records.map((record) => record.meta.seats.map((seat) => seat.characterId))).toEqual([
      ["toumesuayo", "byeonari", "seiyakouri", "jegalmina"],
      baseIds,
    ]);
    const events = records.flatMap((record) => record.events);
    expect(events.some((event) => event.type === "call" && event.call === "chi")).toBe(true);
    expect(events.some((event) => event.type === "call" && event.call === "pon")).toBe(true);
    expect(events.some((event) => event.type === "riichi")).toBe(true);
    expect(events.some((event) => event.type === "call" && (event.call === "kan_closed" || event.call === "kan_added"))).toBe(true);
  });

  it("verifies a real sanma replay contains no chi", () => {
    const sanmaRecord = getSanmaRecord();
    expect(sanmaRecord.events.some((event) => event.type === "call" && event.call === "chi")).toBe(false);
    expect(collectReplayInvariantViolations({ rules: sanmaRecord.meta.rules, events: sanmaRecord.events })).toEqual([]);
  });
});

describe("Phase D checker regressions", () => {
  it("detects wrong-direction chi and established-riichi open calls/non-tsumogiri", () => {
    const events: GameEvent[] = [
      {
        type: "hand_start",
        handIndex: 0,
        roundWind: 1,
        roundHandNumber: 1,
        dealer: 0,
        honba: 0,
        kyotaku: 0,
        scores: [25000, 25000, 25000, 25000],
        wallSeed: 0,
      },
      { type: "discard", player: 2, tile: "p1", tsumogiri: true, riichiDeclaration: true },
      { type: "riichi", player: 2 },
      { type: "discard", player: 0, tile: "m3", tsumogiri: false, riichiDeclaration: false },
      { type: "call", call: "chi", player: 2, fromPlayer: 0, kind: "m3" },
      { type: "discard", player: 2, tile: "p1", tsumogiri: false, riichiDeclaration: false },
    ];
    const violations = collectReplayInvariantViolations({ rules: MAJSOUL_YONMA_RULES, events });
    expect(violations.some((message) => message.includes("open call"))).toBe(true);
    expect(violations.some((message) => message.includes("not next"))).toBe(true);
    expect(violations.some((message) => message.includes("non-tsumogiri"))).toBe(true);
  });

  it("detects replay-level false Toitoi and Sankantsu without reevaluating the hand", () => {
    const events: GameEvent[] = [
      { type: "call", call: "chi", player: 1, fromPlayer: 0, kind: "m3" },
      {
        type: "win",
        player: 1,
        isTsumo: true,
        yaku: [{ name: "Toitoi", han: 2 }, { name: "Sankantsu", han: 2 }],
        han: 4,
        fu: 30,
        yakumanUnits: 0,
        points: 0,
        deltas: { 0: 0, 1: 0, 2: 0, 3: 0 },
      },
    ];
    const violations = collectReplayInvariantViolations({ rules: MAJSOUL_YONMA_RULES, events });
    expect(violations.some((message) => message.includes("Toitoi"))).toBe(true);
    expect(violations.some((message) => message.includes("Sankantsu"))).toBe(true);
  });

  it("accepts replacement/chankan ordering for every kan event kind", () => {
    const replacement = (call: "kan_closed" | "kan_added" | "kan_open"): GameEvent[] => [
      { type: "call", call, player: 1, ...(call === "kan_open" ? { fromPlayer: 0 } : {}), kind: "p5" },
      { type: "draw", player: 1, tile: "s1", source: "rinshan" },
    ];
    for (const call of ["kan_closed", "kan_added", "kan_open"] as const) {
      expect(collectReplayInvariantViolations({ rules: MAJSOUL_YONMA_RULES, events: replacement(call) })).toEqual([]);
    }
    const chankan: GameEvent[] = [
      { type: "call", call: "kan_added", player: 1, kind: "p5" },
      {
        type: "win",
        player: 2,
        isTsumo: false,
        ronFrom: 1,
        yaku: [{ name: "Chankan", han: 1 }],
        han: 1,
        fu: 30,
        yakumanUnits: 0,
        points: 1000,
        deltas: { 0: 0, 1: -1000, 2: 1000, 3: 0 },
      },
    ];
    expect(collectReplayInvariantViolations({ rules: MAJSOUL_YONMA_RULES, events: chankan })).toEqual([]);
  });

  it.each(["nine_terminals", "four_winds", "four_riichi", "four_kans"] as const)(
    "keeps %s identifiable and conserves its replay transition",
    (reason) => {
      const game = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: `phase-d-${reason}` });
      game.scores = [23000, 25000, 25000, 25000];
      game.kyotaku = 2;
      game.honba = 1;
      game.log.push({
        type: "hand_start",
        handIndex: 0,
        roundWind: 1,
        roundHandNumber: 1,
        dealer: 0,
        honba: 1,
        kyotaku: 2,
        scores: [...game.scores],
        wallSeed: 0,
      });
      game.applyAbortiveDraw(reason);

      expect(game.log.some((event) => event.type === "abortive_draw" && event.reason === reason)).toBe(true);
      expect(collectReplayInvariantViolations({ rules: MAJSOUL_YONMA_RULES, events: game.log })).toEqual([]);
    }
  );
});
