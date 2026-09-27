// 위험도 표시 (사람 플레이 보조, 표시 전용): CharacterAI와 같은 현물/스지 규칙(src/ai/discardDanger.ts)으로 자기 손패 종류별 등급을
// 매기고, PlayerView.discardRisk로만 내보낸다. 입력은 리치한 상대의 강(울어 간 패 포함)과 자기 손패뿐이어야 한다.
import { describe, expect, it } from "vitest";
import { Hand } from "../src/core/Hand.js";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";
import { buildPlayerView } from "../src/core/playerView.js";
import { dangerOf, discardRiskLevel, isSuji } from "../src/ai/discardDanger.js";

function tile(kind: TileKind, id: number, isRed = false): Tile {
  const parsed = parseKind(kind);
  return { id, kind, suit: parsed.suit, rank: parsed.rank, isRed };
}

let nextId = 1000;
function discard(hand: Hand, kind: TileKind, calledAway = false): void {
  hand.discards.push({ tile: tile(kind, nextId++), calledAway, isRiichiDeclaration: false, tsumogiri: false });
}

function viewFor(hands: Hand[], seat = 0) {
  return buildPlayerView({
    seat,
    hands,
    doraIndicators: [],
    scores: hands.map(() => 35000),
    dealerSeat: 0,
    roundWind: 1,
    roundHandNumber: 1,
    honba: 0,
    kyotaku: 0,
    wallRemainingLive: 40,
  });
}

const levels = (view: ReturnType<typeof viewFor>) => Object.fromEntries(view.discardRisk.map((r) => [r.kind, r.level]));

describe("현물/스지 규칙 (discardDanger.ts, CharacterAI와 공용)", () => {
  it("현물 0, 스지 0.35, 그 밖 1이며 useSuji가 꺼지면 스지를 보지 않는다", () => {
    expect(dangerOf("m5", ["m5"], true)).toBe(0);
    expect(dangerOf("m5", ["m2"], true)).toBe(0.35);
    expect(dangerOf("m5", ["m2"], false)).toBe(1);
    expect(dangerOf("m5", ["p2"], true)).toBe(1);
  });

  it("스지는 같은 수패의 ±3이며 자패에는 없다 (1-4-7, 3-6-9 양 끝 포함)", () => {
    expect(isSuji("m1", ["m4"])).toBe(true);
    expect(isSuji("m7", ["m4"])).toBe(true);
    expect(isSuji("m9", ["m6"])).toBe(true);
    expect(isSuji("m4", ["m1"])).toBe(true);
    expect(isSuji("m4", ["m7"])).toBe(true);
    expect(isSuji("m2", ["m4"])).toBe(false);
    expect(isSuji("p4", ["m1"])).toBe(false);
    expect(isSuji("z1", ["z1"])).toBe(false);
  });
});

describe("위험도 등급 (discardRiskLevel)", () => {
  it("리치한 상대 모두에게 현물이면 낮음", () => {
    expect(discardRiskLevel("m5", [["m5"]])).toBe("low");
    expect(discardRiskLevel("z1", [["z1", "p3"], ["z1"]])).toBe("low");
  });

  it("스지뿐이면 주의, 현물도 스지도 아니면 높음", () => {
    expect(discardRiskLevel("m5", [["m2"]])).toBe("caution");
    expect(discardRiskLevel("m5", [["p5"]])).toBe("high");
    expect(discardRiskLevel("z7", [["z1"]])).toBe("high"); // 자패는 스지가 없다
  });

  it("상대가 여럿이면 가장 위험한 상대 기준이다 (CharacterAI의 최댓값과 같다)", () => {
    expect(discardRiskLevel("m5", [["m5"], ["m2"]])).toBe("caution");
    expect(discardRiskLevel("m5", [["m5"], ["p1"]])).toBe("high");
    expect(discardRiskLevel("m5", [["m2"], ["m8"]])).toBe("caution");
  });
});

describe("PlayerView.discardRisk (공개 정보만 사용)", () => {
  function table() {
    const hands = [new Hand(), new Hand(), new Hand()];
    hands[0]!.dealIn([tile("m5", 1), tile("m5", 2, true), tile("m1", 3), tile("p9", 4), tile("z5", 5)]);
    hands[1]!.dealIn([tile("s1", 50), tile("s2", 51)]);
    hands[2]!.dealIn([tile("s3", 60), tile("s4", 61)]);
    return hands;
  }

  it("리치한 상대가 없으면 빈 배열이다 (다른 상대의 강이 있어도)", () => {
    const hands = table();
    discard(hands[1]!, "m5");
    expect(viewFor(hands).discardRisk).toEqual([]);
  });

  it("자기 손패 종류마다 한 번씩(적5도 같은 종류로) 리치한 상대의 강 기준 등급을 매긴다", () => {
    const hands = table();
    hands[1]!.riichi = true;
    discard(hands[1]!, "m5");
    discard(hands[1]!, "m4");
    expect(viewFor(hands).discardRisk.map((r) => r.kind)).toEqual(["m5", "m1", "p9", "z5"]);
    expect(levels(viewFor(hands))).toEqual({ m5: "low", m1: "caution", p9: "high", z5: "high" });
  });

  it("남이 울어 간 버림패도 그 상대의 현물이다 (view.opponents[].discards에는 없지만 공개된 패)", () => {
    const hands = table();
    hands[1]!.riichi = true;
    discard(hands[1]!, "p9", true);
    const view = viewFor(hands);
    expect(view.opponents[0]!.discards).not.toContain("p9");
    expect(levels(view).p9).toBe("low");
  });

  it("리치하지 않은 상대의 강과 내 강은 보지 않는다", () => {
    const hands = table();
    hands[1]!.riichi = true;
    discard(hands[2]!, "z5"); // 리치하지 않은 상대
    discard(hands[0]!, "p9"); // 나
    expect(levels(viewFor(hands))).toMatchObject({ z5: "high", p9: "high" });
  });

  it("상대 손패가 달라도 등급은 같다 (숨은 정보를 쓰지 않는다)", () => {
    const a = table();
    const b = table();
    for (const hands of [a, b]) {
      hands[1]!.riichi = true;
      discard(hands[1]!, "m4");
    }
    b[1]!.concealed = [tile("m1", 70), tile("m1", 71), tile("z5", 72)];
    b[2]!.concealed = [tile("p9", 80)];
    expect(viewFor(b).discardRisk).toEqual(viewFor(a).discardRisk);
  });
});
