// 패보: PlayerView.discardLog는 모두의 버림패를 버린 순서대로 전부(울려 간 패, 쯔모기리, 리치 선언패 표시) 담는다.
// 테이블에 보이는 정보만이고, 내 손패/상대 손패에 대한 정보는 없다.
import { describe, expect, it } from "vitest";
import { Hand } from "../src/core/Hand.js";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";
import { buildPlayerView } from "../src/core/playerView.js";

let nextId = 1;
function tile(kind: TileKind, isRed = false): Tile {
  const parsed = parseKind(kind);
  return { id: nextId++, kind, suit: parsed.suit, rank: parsed.rank, isRed };
}

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

describe("PlayerView.discardLog (패보)", () => {
  it("버린 순서 그대로 울려 간 패와 쯔모기리, 리치 선언패를 표시한다 (강 `discards`에는 울려 간 패가 없다)", () => {
    const hands = [new Hand(), new Hand(), new Hand(), new Hand()];
    hands[1]!.discards.push(
      { tile: tile("m5", true), calledAway: false, isRiichiDeclaration: false, tsumogiri: false },
      { tile: tile("p3"), calledAway: true, isRiichiDeclaration: false, tsumogiri: true },
      { tile: tile("z1"), calledAway: false, isRiichiDeclaration: true, tsumogiri: false }
    );
    hands[0]!.discards.push({ tile: tile("s9"), calledAway: false, isRiichiDeclaration: false, tsumogiri: true });

    const view = viewOf(hands);
    const log = view.opponents.find((o) => o.seat === 1)!.discardLog;
    expect(log.map((d) => d.tile.kind)).toEqual(["m5", "p3", "z1"]);
    expect(log[0]).toMatchObject({ tsumogiri: false, calledAway: false, riichiDeclaration: false });
    expect(log[0]!.tile.red).toBe(true); // 적5도 공개 정보
    expect(log[1]).toMatchObject({ tsumogiri: true, calledAway: true });
    expect(log[2]).toMatchObject({ riichiDeclaration: true });
    expect(view.opponents.find((o) => o.seat === 1)!.discards).toEqual(["m5", "z1"]); // 강은 그대로: 울려 간 패는 빠진다
    expect(view.discardLog.map((d) => d.tile.kind)).toEqual(["s9"]);
    expect(view.discardLog[0]!.tsumogiri).toBe(true);
  });

  it("상대의 손패를 바꿔도 패보는 그대로다 (공개 정보만 쓴다)", () => {
    const a = [new Hand(), new Hand(), new Hand()];
    const b = [new Hand(), new Hand(), new Hand()];
    for (const hands of [a, b]) hands[1]!.discards.push({ tile: tile("s1"), calledAway: false, isRiichiDeclaration: false, tsumogiri: false });
    a[1]!.dealIn([tile("m1"), tile("m2")]);
    b[1]!.dealIn([tile("z1"), tile("z2")]);
    expect(viewOf(a).opponents[0]!.discardLog.map((d) => d.tile.kind)).toEqual(viewOf(b).opponents[0]!.discardLog.map((d) => d.tile.kind));
  });
});
