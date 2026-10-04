// 유효패 표시 (사람 플레이 보조, 표시 전용): 타패 후보별 샹텐과 유효패, 위험도 근거(현물/스지)는 공개 정보와 자기 손패만으로 계산한다.
import { describe, expect, it } from "vitest";
import { Hand } from "../src/core/Hand.js";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";
import { buildPlayerView } from "../src/core/playerView.js";
import { computeDiscardUkeire } from "../src/ai/discardUkeire.js";
import { kindToSlot, tilesToCounts } from "../src/core/tileIndex.js";
import { minShanten } from "../src/shanten/shanten.js";
import { allKindsForRules } from "../src/core/tiles.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

let nextId = 1;
function tile(kind: TileKind, isRed = false): Tile {
  const parsed = parseKind(kind);
  return { id: nextId++, kind, suit: parsed.suit, rank: parsed.rank, isRed };
}
const tiles = (kinds: string) => kinds.split(" ").map((k) => tile(k as TileKind));

function viewOf(hands: Hand[], seat = 0) {
  return buildPlayerView({
    seat,
    hands,
    doraIndicators: [],
    scores: hands.map(() => 25000),
    dealerSeat: 0,
    roundWind: 1,
    roundHandNumber: 1,
    honba: 0,
    kyotaku: 0,
    wallRemainingLive: 40,
  });
}

function fourHands(mine: Tile[]): Hand[] {
  const hands = [new Hand(), new Hand(), new Hand(), new Hand()];
  hands[0]!.dealIn(mine);
  return hands;
}

describe("computeDiscardUkeire", () => {
  // 123m 456p 789s 11z + 45m + 5z (14장): 5z를 버리면 양면 텐파이(3m/6m)
  const mine = tiles("m1 m2 m3 p4 p5 p6 s7 s8 s9 z1 z1 m4 m5 z5");

  it("버린 뒤의 샹텐과 유효패(미확인 장수 포함)를 센다", () => {
    const view = viewOf(fourHands(mine));
    const result = computeDiscardUkeire(mine, 0, MAJSOUL_YONMA_RULES, view);
    const dropHonor = result.find((r) => r.kind === "z5")!;
    expect(dropHonor.shanten).toBe(0);
    // 3m은 손에 1장(보이는 1장), 6m은 0장 → 미확인 3 + 4
    expect(Object.fromEntries(dropHonor.ukeire.map((w) => [w.kind, w.unseenCount]))).toEqual({ m3: 3, m6: 4 });
    expect(dropHonor.total).toBe(7);
    // 텐파이를 유지하는 타패가 앞에 온다
    expect(result[0]!.shanten).toBe(0);
    expect(result[0]!.kind).toBe("z5");
    // 같은 종류는 한 번만 (z1은 2장이어도 한 항목)
    expect(result.filter((r) => r.kind === "z1")).toHaveLength(1);
  });

  it("보이는 패(상대 강)는 미확인 장수에서 빠지고, 0장이 된 종류는 유효패에서 뺀다", () => {
    const hands = fourHands(mine);
    for (const k of ["m6", "m6", "m6", "m6"] as TileKind[]) {
      hands[1]!.discards.push({ tile: tile(k), calledAway: false, isRiichiDeclaration: false, tsumogiri: false });
    }
    const result = computeDiscardUkeire(mine, 0, MAJSOUL_YONMA_RULES, viewOf(hands));
    expect(result.find((r) => r.kind === "z5")!.ukeire.map((w) => w.kind)).toEqual(["m3"]);
  });

  it("산마에서는 없는 패(2~8만)와 북을 유효패로 세지 않는다", () => {
    const sanma = tiles("m1 m9 p1 p2 p3 p5 p6 p7 s1 s2 s3 s5 s6 z5");
    const view = viewOf([...fourHands(sanma).slice(0, 3)]);
    const kinds = new Set(computeDiscardUkeire(sanma, 0, DEFAULT_SANMA_RULES, view).flatMap((r) => r.ukeire.map((w) => w.kind)));
    for (const k of ["m2", "m3", "m4", "m5", "m6", "m7", "m8", "z4"]) expect(kinds.has(k as TileKind)).toBe(false);
  });

  it("상대의 손패는 읽지 않는다: 상대 손패만 바꿔도 결과가 같다", () => {
    const a = fourHands(mine);
    const b = fourHands(mine);
    a[1]!.dealIn(tiles("m6 m6 m3 z2"));
    b[1]!.dealIn(tiles("s1 s2 s3 z3"));
    expect(computeDiscardUkeire(mine, 0, MAJSOUL_YONMA_RULES, viewOf(a))).toEqual(computeDiscardUkeire(mine, 0, MAJSOUL_YONMA_RULES, viewOf(b)));
  });

  it("한 요청을 계산하는 데 오래 걸리지 않는다 (14장, 4마)", () => {
    const view = viewOf(fourHands(mine));
    const start = performance.now();
    for (let i = 0; i < 20; i++) computeDiscardUkeire(mine, 0, MAJSOUL_YONMA_RULES, view);
    expect((performance.now() - start) / 20).toBeLessThan(100);
  });
});

describe("가지치기 없는 전수 계산과 같은 결과", () => {
  it("무작위 14장 손패에서 샹텐이 가장 낮은 타패의 유효패가 전수 계산과 같다", () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const kinds = allKindsForRules(MAJSOUL_YONMA_RULES);
    for (let trial = 0; trial < 40; trial++) {
      const copies = new Map<string, number>();
      const hand: Tile[] = [];
      while (hand.length < 14) {
        // 핀즈/자패에 치우친 손패를 자주 만들어 텐파이/이샹텐을 많이 만난다
        const pool = rand() < 0.7 ? kinds.filter((k) => k[0] === "p" || k[0] === "z") : kinds;
        const kind = pool[Math.floor(rand() * pool.length)]!;
        if ((copies.get(kind) ?? 0) >= 4) continue;
        copies.set(kind, (copies.get(kind) ?? 0) + 1);
        hand.push(tile(kind));
      }
      const view = viewOf(fourHands(hand));
      const result = computeDiscardUkeire(hand, 0, MAJSOUL_YONMA_RULES, view);
      const counts = tilesToCounts(hand);
      for (const row of result.filter((r) => r.best)) {
        counts[kindToSlot(row.kind)]!--;
        const base = minShanten(counts, 0);
        const expected: Record<string, number> = {};
        for (const draw of kinds) {
          const slot = kindToSlot(draw);
          if (counts[slot]! >= 4) continue;
          counts[slot]!++;
          const better = minShanten(counts, 0) < base;
          counts[slot]!--;
          const unseen = view.concealedTiles.filter((t) => t.kind === draw).length;
          if (better && 4 - unseen > 0) expected[draw] = 4 - unseen;
        }
        counts[kindToSlot(row.kind)]!++;
        expect(row.shanten).toBe(base);
        expect(Object.fromEntries(row.ukeire.map((w) => [w.kind, w.unseenCount]))).toEqual(expected);
      }
    }
  });
});

describe("PlayerView.discardRisk의 근거", () => {
  it("리치한 상대마다 현물/스지/없음과 미확인 장수를 담는다", () => {
    const hands = [new Hand(), new Hand(), new Hand()];
    hands[0]!.dealIn(tiles("m5 m1 p9"));
    hands[1]!.riichi = true;
    hands[2]!.riichi = true;
    for (const k of ["m5", "m4"] as TileKind[]) hands[1]!.discards.push({ tile: tile(k), calledAway: false, isRiichiDeclaration: false, tsumogiri: false });
    hands[2]!.discards.push({ tile: tile("p9"), calledAway: true, isRiichiDeclaration: false, tsumogiri: false });
    const risk = Object.fromEntries(viewOf(hands).discardRisk.map((r) => [r.kind, r]));
    expect(risk.m5!.against).toEqual([{ seat: 1, basis: "genbutsu" }, { seat: 2, basis: "none" }]);
    expect(risk.m5!.level).toBe("high");
    expect(risk.m1!.against).toEqual([{ seat: 1, basis: "suji" }, { seat: 2, basis: "none" }]);
    expect(risk.p9!.against).toEqual([{ seat: 1, basis: "none" }, { seat: 2, basis: "genbutsu" }]);
    expect(risk.m5!.unseenCount).toBe(2); // 내 손 1 + 상대 강 1
  });
});
