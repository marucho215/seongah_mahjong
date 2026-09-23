import { afterEach, describe, expect, it, vi } from "vitest";
import { GameState } from "../src/core/GameState.js";
import { ALL_HUMAN, ATAMAHANE, J0, J2, J2_PON, RonFixture, W, ronGame } from "./helpers/ronFixture.js";
import { Hand } from "../src/core/Hand.js";
import { FuritenTracker } from "../src/actions/furiten.js";
import { buildPlayerView } from "../src/core/playerView.js";
import type { TileKind } from "../src/core/tiles.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import type { DecisionRequest, DecisionResponse, RonDecisionRequest } from "../src/core/decisions.js";
import type { GameEvent } from "../src/core/GameLog.js";

interface Script {
  discards: Record<number, { kind: TileKind; riichi?: boolean }[]>;
  ron?: Record<number, boolean[]>;
  pon?: Record<number, boolean[]>;
}

/** Drives playHandInteractive() with fixed answers; stops (abandoning the hand) as soon as a
 *  seat needs a discard it has no scripted answer for. */
function runScript(game: GameState, script: Script): { requests: DecisionRequest[]; log: readonly GameEvent[] } {
  const discards = structuredClone(script.discards);
  const ron = structuredClone(script.ron ?? {});
  const pon = structuredClone(script.pon ?? {});
  const requests: DecisionRequest[] = [];
  const session = game.playHandInteractive();
  let step = session.next();
  while (!step.done) {
    const req = step.value;
    requests.push(req);
    let response: DecisionResponse;
    if (req.type === "discard") {
      const want = discards[req.seat]?.shift();
      if (!want) break;
      const chosen = [...req.view.concealedTiles].reverse().find((t) => t.kind === want.kind && req.legalTileIds.includes(t.id));
      if (!chosen) throw new Error(`seat ${req.seat} cannot discard ${want.kind}`);
      response = { type: "discard", tileId: chosen.id, declareRiichi: !!want.riichi };
    } else if (req.type === "ron") {
      response = { type: "ron", declare: ron[req.seat]?.shift() ?? false };
    } else if (req.type === "call_pon") {
      response = { type: "call_pon", declare: pon[req.seat]?.shift() ?? false };
    } else {
      response = { type: req.type, declare: false };
    }
    step = session.next(response);
  }
  if (!step.done) session.return(undefined);
  return { requests, log: game.log };
}

const wins = (log: readonly GameEvent[]) => log.filter((e): e is Extract<GameEvent, { type: "win" }> => e.type === "win");
const ronRequests = (reqs: DecisionRequest[]) => reqs.filter((r): r is RonDecisionRequest => r.type === "ron");

afterEach(() => vi.restoreAllMocks());

describe("FuritenTracker.snapshot / PlayerView furiten", () => {
  it("reports each cause separately and `active` equals isFuriten()", () => {
    const t = new FuritenTracker();
    expect(t.snapshot(["p5"], [])).toEqual({ active: false, selfDiscard: false, temporary: false, riichi: false });
    expect(t.snapshot(["p5"], ["p5"])).toEqual({ active: true, selfDiscard: true, temporary: false, riichi: false });
    t.onMissedRonChance();
    expect(t.snapshot(["p5"], [])).toEqual({ active: true, selfDiscard: false, temporary: true, riichi: false });
    t.onOwnDraw();
    expect(t.snapshot(["p5"], []).active).toBe(false);
    t.onDeclareRiichi();
    t.onMissedRonChance();
    t.onOwnDraw();
    expect(t.snapshot(["p5"], [])).toEqual({ active: true, selfDiscard: false, temporary: true, riichi: true });
    for (const [waits, discards] of [[["p5"], []], [["p5"], ["p5"]], [[], []]] as [TileKind[], TileKind[]][]) {
      expect(t.snapshot(waits, discards).active).toBe(t.isFuriten(waits, discards));
    }
  });

  it("buildPlayerView passes the furiten snapshot through and defaults to not-furiten", () => {
    const hands = [new Hand(), new Hand(), new Hand()];
    const base = { seat: 0, hands, doraIndicators: [], scores: [35000, 35000, 35000], dealerSeat: 0, roundWind: 1, roundHandNumber: 1, honba: 0, kyotaku: 0, wallRemainingLive: 50 };
    expect(buildPlayerView(base).furiten).toEqual({ active: false, selfDiscard: false, temporary: false, riichi: false });
    const snap = { active: true, selfDiscard: false, temporary: true, riichi: false };
    expect(buildPlayerView({ ...base, furiten: snap }).furiten).toEqual(snap);
  });
});

describe("human ron decision (Milestone 2)", () => {
  it("offers the human a ron carrying the engine's own preview, and accepting settles exactly that", () => {
    const game = ronGame(DEFAULT_SANMA_RULES, ["human", "human", undefined], [J0, W, J2]);
    const { requests, log } = runScript(game, { discards: { 0: [{ kind: "p8" }] }, ron: { 1: [true] } });

    const [req] = ronRequests(requests);
    expect(req).toBeDefined();
    expect(req!.seat).toBe(1);
    expect(req!.fromSeat).toBe(0);
    expect(req!.context).toBe("discard");
    expect(req!.winningTile.kind).toBe("p8");
    expect(req!.preview.yaku.map((y) => y.name)).toEqual(expect.arrayContaining(["Tanyao", "Pinfu"]));

    const [win] = wins(log);
    expect(win!.player).toBe(1);
    expect(req!.preview.han).toBe(win!.han);
    expect(req!.preview.fu).toBe(win!.fu);
    expect(req!.preview.totalPoints).toBe(win!.points);
    expect(req!.preview.yaku).toEqual(win!.yaku.map((y) => ({ name: y.name, han: y.han })));
    expect(req!.view.opponents.every((o) => !("concealedTiles" in o))).toBe(true);
  });

  it("passing a valid ron continues the hand and counts as a missed ron chance", () => {
    const spy = vi.spyOn(FuritenTracker.prototype, "onMissedRonChance");
    const game = ronGame(DEFAULT_SANMA_RULES, ["human", "human", undefined], [J0, W, J2], ["p8", "z7"]);
    const { log } = runScript(game, { discards: { 0: [{ kind: "p8" }], 1: [{ kind: "z7" }] }, ron: { 1: [false] } });
    expect(wins(log)).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(log.some((e) => e.type === "discard" && e.player === 1 && e.tile === "z7")).toBe(true);
  });

  it("temporary furiten: no request while un-drawn, and released by the seat's own next draw", () => {
    // 0 discards p8 -> seat 1 passes. Seat 2 pons it (skipping seat 1's turn) and discards p5;
    // seat 0 draws/discards p5. Seat 1 has not drawn yet, so it is still furiten for both.
    // Seat 1 then draws (release); seat 2's later p5 must be offered to seat 1 again.
    const game = ronGame(DEFAULT_SANMA_RULES, ALL_HUMAN, [J0, W, J2_PON], ["p8", "p5", "z7", "p5"]);
    const { requests } = runScript(game, {
      discards: {
        0: [{ kind: "p8" }, { kind: "p5" }],
        2: [{ kind: "p5" }, { kind: "p5" }],
        1: [{ kind: "z7" }],
      },
      ron: { 1: [false, true] },
      pon: { 2: [true] },
    });

    const seat1Rons = ronRequests(requests).filter((r) => r.seat === 1);
    // Exactly two: the original p8 (passed), then the post-release p5 from seat 2. The p5s
    // discarded by seat 2 (after pon) and by seat 0 in between were never offered.
    expect(seat1Rons.map((r) => [r.fromSeat, r.winningTile.kind])).toEqual([[0, "p8"], [2, "p5"]]);
    expect(seat1Rons[1]!.view.furiten.active).toBe(false);
    // ...and the re-offer only came AFTER seat 1's own draw/discard (that draw is what released it)
    const seat1FirstDiscard = requests.findIndex((r) => r.type === "discard" && r.seat === 1);
    expect(seat1FirstDiscard).toBeGreaterThan(-1);
    expect(requests.indexOf(seat1Rons[1]!)).toBeGreaterThan(seat1FirstDiscard);
  });

  it("riichi furiten: a missed ron while in riichi is never released, even by the seat's own draws", () => {
    const spy = vi.spyOn(FuritenTracker.prototype, "onMissedRonChance");
    // seat 1 declares riichi on its z6 draw; seat 2's p8 is passed (riichi miss); seat 0's p5,
    // seat 1's own draw, then seat 2's p8 again are all NOT offered to seat 1.
    const game = ronGame(DEFAULT_SANMA_RULES, ALL_HUMAN, [J0, W, J2], ["z7", "z6", "p8", "p5", "z5", "p8"]);
    const { requests, log } = runScript(game, {
      discards: {
        0: [{ kind: "z7" }, { kind: "p5" }],
        1: [{ kind: "z6", riichi: true }],
        2: [{ kind: "p8" }, { kind: "p8" }],
      },
      ron: { 1: [false] },
    });

    expect(log.some((e) => e.type === "riichi" && e.player === 1)).toBe(true);
    const seat1Rons = ronRequests(requests).filter((r) => r.seat === 1);
    expect(seat1Rons).toHaveLength(1);
    expect(seat1Rons[0]!.fromSeat).toBe(2);
    expect(seat1Rons[0]!.preview.yaku.some((y) => y.name.includes("Riichi"))).toBe(true);
    // the declaration tile (z6) is seat 1's first river tile; both its own and seat 2's view say so
    expect(seat1Rons[0]!.view.riichiDiscardIndex).toBe(0);
    const seat2Discard = requests.find((r) => r.type === "discard" && r.seat === 2)!;
    expect(seat2Discard.view.opponents.find((o) => o.seat === 1)!.riichiDiscardIndex).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    // the second p8 by seat 2 was really discarded (the scenario got that far), just not offered
    expect(log.filter((e) => e.type === "discard" && e.player === 2 && e.tile === "p8")).toHaveLength(2);
    expect(wins(log)).toHaveLength(0);
  });

  it("never asks a seat that is already furiten, and shows the cause in its view (self-discard furiten)", () => {
    // seat 1 waits p5/p8 but already has p8 in its own river, so seat 0's p5 is not offered to it
    const game = new RonFixture(
      { rules: DEFAULT_SANMA_RULES, seed: "ron-decision", controllers: ALL_HUMAN },
      { hands: [J0, W, J2], draws: ["p5", "z7"], ownDiscards: [[], ["p8"], []] }
    );
    const { requests } = runScript(game, { discards: { 0: [{ kind: "p5" }], 1: [{ kind: "z7" }] } });
    expect(ronRequests(requests)).toHaveLength(0);
    const seat1Discard = requests.find((r) => r.type === "discard" && r.seat === 1)!;
    expect(seat1Discard.view.furiten).toEqual({ active: true, selfDiscard: true, temporary: false, riichi: false });
  });
});

describe("multiple ron", () => {
  it('"all": every valid candidate is asked independently and may win together', () => {
    const game = ronGame(DEFAULT_SANMA_RULES);
    const { requests, log } = runScript(game, { discards: { 0: [{ kind: "p8" }] }, ron: { 1: [true], 2: [true] } });
    expect(ronRequests(requests).map((r) => r.seat)).toEqual([1, 2]);
    expect(wins(log).map((w) => w.player).sort()).toEqual([1, 2]);
  });

  it('"all": one passing does not affect the other', () => {
    const spy = vi.spyOn(FuritenTracker.prototype, "onMissedRonChance");
    const game = ronGame(DEFAULT_SANMA_RULES);
    const { log } = runScript(game, { discards: { 0: [{ kind: "p8" }] }, ron: { 1: [false], 2: [true] } });
    expect(wins(log).map((w) => w.player)).toEqual([2]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('"atamahane": the first accepted ron ends the offer - later candidates are never asked and get no furiten', () => {
    const spy = vi.spyOn(FuritenTracker.prototype, "onMissedRonChance");
    const game = ronGame(ATAMAHANE);
    const { requests, log } = runScript(game, { discards: { 0: [{ kind: "p8" }] }, ron: { 1: [true], 2: [true] } });
    expect(ronRequests(requests).map((r) => r.seat)).toEqual([1]);
    expect(wins(log).map((w) => w.player)).toEqual([1]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('"atamahane": a genuine pass by the closer human passes the chance to the next candidate', () => {
    const spy = vi.spyOn(FuritenTracker.prototype, "onMissedRonChance");
    const game = ronGame(ATAMAHANE);
    const { requests, log } = runScript(game, { discards: { 0: [{ kind: "p8" }] }, ron: { 1: [false], 2: [true] } });
    expect(ronRequests(requests).map((r) => r.seat)).toEqual([1, 2]);
    expect(wins(log).map((w) => w.player)).toEqual([2]);
    expect(spy).toHaveBeenCalledTimes(1); // only seat 1's real pass
  });

  it('"atamahane": everyone passing continues the hand and furitens each passer', () => {
    const spy = vi.spyOn(FuritenTracker.prototype, "onMissedRonChance");
    const game = ronGame(ATAMAHANE, ALL_HUMAN, [J0, W, W], ["p8", "z7"]);
    const { log } = runScript(game, { discards: { 0: [{ kind: "p8" }], 1: [{ kind: "z7" }] } });
    expect(wins(log)).toHaveLength(0);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("AI / non-human seats keep the automatic ron", () => {
  it('"all": AI candidates ron without any request', () => {
    const spy = vi.spyOn(FuritenTracker.prototype, "onMissedRonChance");
    const game = ronGame(DEFAULT_SANMA_RULES, ["human", undefined, undefined]);
    const { requests, log } = runScript(game, { discards: { 0: [{ kind: "p8" }] } });
    expect(ronRequests(requests)).toHaveLength(0);
    expect(wins(log).map((w) => w.player).sort()).toEqual([1, 2]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('"atamahane": only the closest AI wins, still without a request', () => {
    const game = ronGame(ATAMAHANE, ["human", undefined, undefined]);
    const { requests, log } = runScript(game, { discards: { 0: [{ kind: "p8" }] } });
    expect(ronRequests(requests)).toHaveLength(0);
    expect(wins(log).map((w) => w.player)).toEqual([1]);
  });

  it("a game with no human seat never yields (ron path included)", () => {
    const game = ronGame(DEFAULT_SANMA_RULES, [undefined, undefined, undefined]);
    game.playHand(); // throws if any request were yielded
    expect(game.log.some((e) => e.type === "hand_end")).toBe(true);
  });

  it("a human seat asked with a wrong response type is rejected, not silently passed", () => {
    const game = ronGame(DEFAULT_SANMA_RULES, ["human", "human", undefined], [J0, W, J2]);
    const session = game.playHandInteractive();
    let step = session.next();
    while (!step.done && step.value.type !== "ron") {
      const req = step.value;
      if (req.type !== "discard") throw new Error("unexpected");
      const tileId = [...req.view.concealedTiles].reverse().find((t) => t.kind === "p8")!.id;
      step = session.next({ type: "discard", tileId, declareRiichi: false });
    }
    expect(step.done).toBe(false);
    expect(() => session.next({ type: "call_pon", declare: true })).toThrow(/expected a "ron" response/);
  });
});
