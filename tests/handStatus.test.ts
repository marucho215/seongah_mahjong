import { describe, expect, it } from "vitest";
import type { GameState } from "../src/core/GameState.js";
import type { DecisionRequest, DecisionResponse } from "../src/core/decisions.js";
import { unseenCountOf } from "../src/core/playerView.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES, type RuleConfig } from "../src/rules/RuleConfig.js";
import { minShanten } from "../src/shanten/shanten.js";
import { kindToSlot } from "../src/core/tileIndex.js";
import type { TileKind } from "../src/core/tiles.js";
import { J0, J2_PON, RonFixture, W } from "./helpers/ronFixture.js";

// 좌석 1의 W는 처음부터 p5/p8 대기 텐파이다 (tests/riichiWaits.test.ts와 같은 고정 패).
const SANMA_DRAWS: TileKind[] = ["z2", "z6", "z7", "z4", "p8"];
const WAIT_KINDS = ["p5", "p8"];
const kindsOf = (waits: { kind: string }[]): string[] => waits.map((w) => w.kind).sort();

function fixture(rules: RuleConfig, hands: TileKind[][], draws: TileKind[]): GameState {
  const controllers = hands.map(() => "human" as const);
  return new RonFixture({ rules, seed: "hand-status", controllers }, { hands, draws });
}

/** 뽑은 패를 그대로 버린다. `riichiSeat`이면 그 좌석의 첫 버림에서 리치, 아니면 아무도 리치하지 않는다(다마). */
function makeRespond(riichiSeat: number | null) {
  let riichiDone = false;
  return (request: DecisionRequest): DecisionResponse => {
    switch (request.type) {
      case "discard": {
        const drawn = request.view.concealedTiles.at(-1)!;
        const declare = request.seat === riichiSeat && !riichiDone;
        if (declare) riichiDone = true;
        return { type: "discard", tileId: drawn.id, declareRiichi: declare };
      }
      case "ron":
        return { type: "ron", declare: false };
      case "tsumo":
        return { type: "tsumo", declare: false };
      case "chi":
        return { type: "chi", optionId: null };
      default:
        return { type: request.type, declare: false };
    }
  };
}

function collectUntilTsumo(game: GameState, respond: (r: DecisionRequest) => DecisionResponse): DecisionRequest[] {
  const session = game.playHandInteractive();
  const seen: DecisionRequest[] = [];
  let step = session.next();
  while (!step.done) {
    seen.push(step.value);
    if (step.value.type === "tsumo") return seen;
    step = session.next(respond(step.value));
  }
  throw new Error("tsumo request never reached");
}

function ownShanten(request: DecisionRequest): number {
  const counts = new Array(34).fill(0);
  for (const t of request.view.concealedTiles) counts[kindToSlot(t.kind)]++;
  return minShanten(counts, request.view.melds.length);
}

describe("현재 손 상태 표시 (view.handStatus, 엔진 계산)", () => {
  it("리치하지 않은 텐파이(다마)에서도 대기패를 주고, 리치 중 대기(view.waits)의 의미는 그대로다", () => {
    const seen = collectUntilTsumo(fixture(DEFAULT_SANMA_RULES, [J0, W, J0], SANMA_DRAWS), makeRespond(null));
    const seat1 = seen.filter((r) => r.seat === 1);
    expect(seat1.length).toBeGreaterThan(1);
    for (const r of seat1) {
      expect(r.view.riichi).toBe(false);
      expect(r.view.waits).toEqual([]);
      expect(kindsOf(r.view.handStatus.tenpaiWaits)).toEqual(WAIT_KINDS);
    }
    const firstDiscard = seat1.find((r) => r.type === "discard")!;
    expect(firstDiscard.view.handStatus.shanten).toBe(0); // 14장: 한 장 버리면 텐파이
    const tsumo = seen.at(-1)!;
    expect(tsumo.seat).toBe(1);
    expect(tsumo.view.handStatus.shanten).toBe(-1); // 화료형
  });

  it("리치 중에는 handStatus.tenpaiWaits가 view.waits와 같다", () => {
    const seen = collectUntilTsumo(fixture(DEFAULT_SANMA_RULES, [J0, W, J0], SANMA_DRAWS), makeRespond(1));
    const afterRiichi = seen.filter((r) => r.seat === 1 && r.view.riichi);
    expect(afterRiichi.length).toBeGreaterThan(0);
    for (const r of afterRiichi) expect(r.view.handStatus.tenpaiWaits).toEqual(r.view.waits);
  });

  it("텐파이가 아니면 대기가 비어 있고, 샹텐은 자기 손패만으로 계산한 엔진 minShanten 값이다", () => {
    const seen = collectUntilTsumo(fixture(DEFAULT_SANMA_RULES, [J0, W, J0], SANMA_DRAWS), makeRespond(null));
    const others = seen.filter((r) => r.seat !== 1);
    expect(others.length).toBeGreaterThan(0);
    for (const r of others) {
      expect(r.view.handStatus.tenpaiWaits).toEqual([]);
      expect(r.view.handStatus.shanten).toBe(ownShanten(r));
      expect(r.view.handStatus.shanten).toBeGreaterThan(0);
    }
    for (const r of seen) expect(r.view.handStatus.shanten).toBe(ownShanten(r));
  });

  it("미확인 장수는 view의 공개 정보만으로 센 값이다 (unseenCountOf와 같다)", () => {
    const seen = collectUntilTsumo(fixture(DEFAULT_SANMA_RULES, [J0, W, J0], SANMA_DRAWS), makeRespond(null));
    for (const r of seen.filter((s) => s.seat === 1)) {
      for (const w of r.view.handStatus.tenpaiWaits) expect(w.unseenCount).toBe(unseenCountOf(r.view, w.kind));
    }
  });

  it("상대 손패나 패산의 실제 내용이 달라도 보이는 정보가 같으면 손 상태(대기/장수/샹텐)도 같다", () => {
    const run = (hands: TileKind[][], tail: TileKind[]) => {
      const seen = collectUntilTsumo(fixture(DEFAULT_SANMA_RULES, hands, [...SANMA_DRAWS, ...tail]), makeRespond(null));
      return seen.filter((r) => r.seat === 1).map((r) => r.view.handStatus);
    };
    const base = run([J0, W, J0], []);
    expect(base.at(-1)!.tenpaiWaits.length).toBe(2);
    // 상대가 p5/p8을 쥐고 있어도(J2_PON: p5 1장, p8 2장), 패산 뒤쪽이 달라도 내 화면의 값은 그대로다
    expect(run([J2_PON, W, J2_PON], [])).toEqual(base);
    expect(run([J0, W, J0], ["p5", "p8", "p5", "p8"])).toEqual(base);
  });

  it("상대의 손 상태는 내 화면에 담기지 않는다", () => {
    const seen = collectUntilTsumo(fixture(DEFAULT_SANMA_RULES, [J0, W, J0], SANMA_DRAWS), makeRespond(null));
    for (const r of seen) {
      for (const o of r.view.opponents) {
        expect(o).not.toHaveProperty("handStatus");
        expect(JSON.stringify(o)).not.toMatch(/shanten|tenpaiWaits/);
      }
    }
  });

  it("4마에서도 같다", () => {
    const seen = collectUntilTsumo(fixture(MAJSOUL_YONMA_RULES, [J0, W, J0, J0], ["z2", "z6", "z7", "z2", "z7", "p8"]), makeRespond(null));
    const seat1 = seen.filter((r) => r.seat === 1);
    expect(seat1.length).toBeGreaterThan(0);
    for (const r of seat1) {
      expect(r.view.waits).toEqual([]);
      expect(kindsOf(r.view.handStatus.tenpaiWaits)).toEqual(WAIT_KINDS);
    }
    expect(seen.at(-1)!.view.handStatus.shanten).toBe(-1);
  });
});
