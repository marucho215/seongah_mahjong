import type { GameEvent } from "../core/GameLog.js";

/** Rare-path occurrence counters (section 21). Purely observational - never affects pass/fail. */
export interface EventCoverage {
  hands: number;
  ron: number;
  tsumo: number;
  riichi: number;
  doubleRiichi: number;
  ippatsu: number;
  chi: number;
  pon: number;
  daiminkan: number;
  ankan: number;
  shouminkan: number;
  kita: number;
  rinshan: number;
  chankan: number;
  haitei: number;
  houtei: number;
  exhaustiveDraw: number;
  abortiveByReason: Record<string, number>;
  multiRon: number;
  yakuman: number;
  multipleYakuman: number;
  tenhou: number;
  chiihou: number;
  nagashiMangan: number;
  dealerContinuation: number;
  gameExtension: number;
}

export function emptyEventCoverage(): EventCoverage {
  return {
    hands: 0,
    ron: 0,
    tsumo: 0,
    riichi: 0,
    doubleRiichi: 0,
    ippatsu: 0,
    chi: 0,
    pon: 0,
    daiminkan: 0,
    ankan: 0,
    shouminkan: 0,
    kita: 0,
    rinshan: 0,
    chankan: 0,
    haitei: 0,
    houtei: 0,
    exhaustiveDraw: 0,
    abortiveByReason: {},
    multiRon: 0,
    yakuman: 0,
    multipleYakuman: 0,
    tenhou: 0,
    chiihou: 0,
    nagashiMangan: 0,
    dealerContinuation: 0,
    gameExtension: 0,
  };
}

function handSlices(events: readonly GameEvent[]): { start: number; end: number }[] {
  const starts = events.map((e, i) => (e.type === "hand_start" ? i : -1)).filter((i) => i >= 0);
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? events.length }));
}

export function accumulateEventCoverage(coverage: EventCoverage, events: readonly GameEvent[]): void {
  for (const { start, end } of handSlices(events)) {
    coverage.hands++;
    const slice = events.slice(start, end);
    const wins = slice.filter((e): e is Extract<GameEvent, { type: "win" }> => e.type === "win");
    if (wins.length > 1) coverage.multiRon++;
    for (const w of wins) {
      if (w.isTsumo) coverage.tsumo++;
      else coverage.ron++;
      for (const y of w.yaku) {
        if (y.name === "Ippatsu") coverage.ippatsu++;
        if (y.name === "Rinshan Kaihou") coverage.rinshan++;
        if (y.name === "Chankan") coverage.chankan++;
        if (y.name === "Haitei Raoyue") coverage.haitei++;
        if (y.name === "Houtei Raoyui") coverage.houtei++;
        if (y.name === "Tenhou") coverage.tenhou++;
        if (y.name === "Chiihou") coverage.chiihou++;
      }
      if (w.yakumanUnits >= 2) coverage.multipleYakuman++;
      else if (w.yakumanUnits === 1) coverage.yakuman++;
    }
    for (const e of slice) {
      if (e.type === "riichi") coverage.riichi++;
      if (e.type === "call") {
        if (e.call === "chi") coverage.chi++;
        if (e.call === "pon") coverage.pon++;
        if (e.call === "kan_open") coverage.daiminkan++;
        if (e.call === "kan_closed") coverage.ankan++;
        if (e.call === "kan_added") coverage.shouminkan++;
      }
      if (e.type === "kita") coverage.kita++;
      if (e.type === "exhaustive_draw") coverage.exhaustiveDraw++;
      if (e.type === "abortive_draw") {
        coverage.abortiveByReason[e.reason] = (coverage.abortiveByReason[e.reason] ?? 0) + 1;
      }
    }
    // double riichi and nagashi mangan are only distinguishable via the win's yaku list /
    // hand_end's authoritative result snapshot, not a standalone event type.
    for (const w of wins) {
      if (w.yaku.some((y) => y.name === "Double Riichi")) coverage.doubleRiichi++;
    }
    const handEnd = slice.find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end");
    if (handEnd?.result?.kind === "exhaustive_draw" && handEnd.result.nagashiManganSeats.length > 0) {
      coverage.nagashiMangan += handEnd.result.nagashiManganSeats.length;
    }
    if (handEnd?.result) {
      const startEvt = slice[0] as Extract<GameEvent, { type: "hand_start" }>;
      if (handEnd.nextDealer === startEvt.dealer) coverage.dealerContinuation++;
    }
  }
  const gameEnd = events.find((e): e is Extract<GameEvent, { type: "game_end" }> => e.type === "game_end");
  if (gameEnd?.reason === "extension_end") coverage.gameExtension++;
}
