import { describe, expect, it } from "vitest";
import { reproduceReplay, type ReplayReproduction } from "../src/replay/replayReproduction.js";
import type { GameReplayRecord } from "../src/sim/replayRecorder.js";
import { aiOnlyRecord, humanRecord } from "./helpers/replayParityGames.js";

type Ok = Extract<ReplayReproduction, { ok: true }>;

function expectOk(r: ReplayReproduction): Ok {
  if (!r.ok) throw new Error(`expected reproduction, got: ${r.reason}`);
  return r;
}

const clone = (record: GameReplayRecord): GameReplayRecord => JSON.parse(JSON.stringify(record)) as GameReplayRecord;

/** 재현 결과의 표시용 상태가 엔진 기록과 맞는지 확인한다 (추측 없이 원본 이벤트/화료 스냅샷과 비교). */
function checkStates(record: GameReplayRecord, r: Ok): void {
  expect(r.steps.length).toBe(record.events.length);
  r.steps.forEach((step, i) => {
    expect(step.eventIndex).toBe(i);
    expect(step.event).toEqual(record.events[i]);
  });
  // 이벤트별로 붙인 AI 판단을 이어 붙이면 원본 AI 판단 기록 전체와 같다 (빠짐/중복/순서 바뀜 없음)
  expect(r.steps.flatMap((s) => s.aiDecisions)).toEqual(record.aiDecisions);

  for (const step of r.steps) {
    const t = step.table;
    if (!t) continue;
    // 손패 장수: 손패 + 멘츠당 3장 = 13 또는 14 (깡은 3장으로 센다, 북은 제외)
    t.seats.forEach((seat) => expect([13, 14]).toContain(seat.concealed.length + seat.melds.length * 3));
    const e = step.event;
    if (e.type === "discard") {
      const last = t.seats[e.player]!.discards.at(-1)!;
      expect(last.tile.kind).toBe(e.tile);
      expect(last.riichi).toBe(e.riichiDeclaration);
    }
    if (e.type === "draw") expect(t.seats[e.player]!.concealed.some((tile) => tile.kind === e.tile)).toBe(true);
  }
  // 화료 시점 손패는 엔진이 기록한 화료 스냅샷(패 id 포함)과 같다
  let checkedWins = 0;
  for (const step of r.steps) {
    if (step.event.type !== "hand_end" || step.event.result?.kind !== "agari") continue;
    const winStep = r.steps.slice(0, step.eventIndex).reverse().find((s) => s.event.type === "win")!;
    for (const w of step.event.result.winners) {
      const seat = winStep.table!.seats[w.winnerSeat]!;
      expect(seat.concealed.map((t) => t.id).sort()).toEqual(w.snapshot!.concealedTiles.map((t) => t.id).sort());
      expect(seat.melds).toEqual(w.snapshot!.melds);
      checkedWins++;
    }
  }
  expect(checkedWins).toBeGreaterThan(0);
}

describe("리플레이 재시뮬레이션 (현재 엔진으로 재현 + 표시용 상태 관찰)", () => {
  it("AI 대국(산마)을 끝까지 재현하고, 매 수의 상태가 엔진 기록과 맞는다", () => {
    const record = aiOnlyRecord("sanma", "replay-repro-sanma");
    const r = expectOk(reproduceReplay(record));
    checkStates(record, r);
    expect(r.hands.length).toBe(record.events.filter((e) => e.type === "hand_start").length);
    for (const h of r.hands) {
      expect(r.steps[h.firstStep]!.event.type).toBe("hand_start");
      expect(r.steps[h.lastStep]!.event.type).toBe("hand_end");
      for (const i of h.resultSteps) expect(["win", "exhaustive_draw", "abortive_draw"]).toContain(r.steps[i]!.event.type);
    }
  }, 120_000);

  it("AI 대국(4마, 치 포함)을 재현하면 치로 만든 멘츠도 엔진 기록 그대로다", () => {
    const record = aiOnlyRecord("yonma", "replay-repro-yonma");
    const r = expectOk(reproduceReplay(record));
    checkStates(record, r);
  }, 120_000);

  it("사람 대국을 기록된 사람 결정으로 재현한다", () => {
    const record = humanRecord("sanma", "replay-repro-human");
    expect(record.humanDecisions!.length).toBeGreaterThan(0);
    const r = expectOk(reproduceReplay(record));
    checkStates(record, r);
  }, 120_000);

  it("이벤트 하나라도 원본과 다르면 그 지점에서 멈추고 재현 불가로 처리한다 (이후 상태를 만들지 않는다)", () => {
    const record = aiOnlyRecord("sanma", "replay-repro-mismatch");
    const k = record.events.findIndex((e, i) => i > 50 && e.type === "discard");
    const tampered = clone(record);
    const e = tampered.events[k]!;
    if (e.type !== "discard") throw new Error("fixture");
    e.tile = e.tile === "p1" ? "p2" : "p1";
    const r = reproduceReplay(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mismatchAtEvent).toBe(k);
    expect(r).not.toHaveProperty("steps");
  }, 120_000);

  it("시드가 다르거나 사람 결정 기록이 다르면 재현 불가다", () => {
    const record = humanRecord("sanma", "replay-repro-human");
    const otherSeed = clone(record);
    otherSeed.meta.gameSeed = "something-else";
    expect(reproduceReplay(otherSeed).ok).toBe(false);

    const otherChoice = clone(record);
    const d = otherChoice.humanDecisions!.find((h) => h.type === "discard")!;
    d.choice = { ...d.choice, riichi: !d.choice.riichi };
    expect(reproduceReplay(otherChoice).ok).toBe(false);

    const missingDecision = clone(record);
    missingDecision.humanDecisions = missingDecision.humanDecisions!.slice(0, -1);
    expect(reproduceReplay(missingDecision).ok).toBe(false);
  }, 120_000);

  it("시드/규칙/좌석 정보가 없는 기록은 예외 없이 재현 불가로 처리한다", () => {
    const r = reproduceReplay({ events: [] } as unknown as GameReplayRecord);
    expect(r.ok).toBe(false);
  });
});
