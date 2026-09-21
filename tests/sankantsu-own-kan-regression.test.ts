import { describe, expect, it } from "vitest";
import type { Meld } from "../src/core/Hand.js";
import type { Tile } from "../src/core/tiles.js";
import { countOwnKanMelds } from "../src/yaku/kanCount.js";
import { meldsToGroups } from "../src/yaku/meldConvert.js";
import type { Group, WinContext } from "../src/yaku/types.js";
import { groupToKinds } from "../src/yaku/types.js";
import { evaluateStandardYaku } from "../src/yaku/yakuStandard.js";

let nextId = 980000;
function tile(kind: string): Tile {
  return {
    id: nextId++,
    kind,
    suit: kind[0] as "m" | "p" | "s" | "z",
    rank: Number(kind.slice(1)),
    isRed: false,
  };
}

function meld(type: Meld["type"], kind: string, size: 3 | 4): Meld {
  const tiles = Array.from({ length: size }, () => tile(kind));
  return {
    type,
    tiles,
    ...(type === "kan_closed" ? {} : { calledFrom: 0, calledTile: tiles[0] }),
  };
}

describe("Sankantsu uses the winner's own kan melds", () => {
  it("preserves replay chi melds as sequences and does not award Toitoi or Sankantsu", () => {
    const winnerMelds: Meld[] = [
      { type: "chi", tiles: [tile("m1"), tile("m2"), tile("m3")], calledFrom: 1, calledTile: tile("m3") },
      { type: "chi", tiles: [tile("p2"), tile("p3"), tile("p4")], calledFrom: 1, calledTile: tile("p4") },
      { type: "chi", tiles: [tile("s6"), tile("s7"), tile("s8")], calledFrom: 1, calledTile: tile("s6") },
    ];
    const groups: Group[] = [
      ...meldsToGroups(winnerMelds),
      { type: "triplet", kind: "p5", concealed: true },
      { type: "pair", kind: "s2", concealed: true },
    ];
    const ctx: WinContext = {
      seatWind: 3,
      roundWind: 1,
      isTsumo: false,
      isRiichi: false,
      isDoubleRiichi: false,
      isIppatsu: false,
      isHaitei: false,
      isHoutei: false,
      isRinshan: false,
      isChankan: false,
      isTenhou: false,
      isChiihou: false,
      doraCount: 0,
      uraDoraCount: 0,
      akaDoraCount: 0,
      kanCount: 0,
    };

    expect(groups.slice(0, 3).map((group) => group.type)).toEqual(["sequence", "sequence", "sequence"]);
    const yaku = evaluateStandardYaku(groups, "tanki", false, groups.flatMap(groupToKinds), ctx, true);
    expect(yaku.map((hit) => hit.name)).not.toContain("Toitoi");
    expect(yaku.map((hit) => hit.name)).not.toContain("Sankantsu");
  });

  it("does not count a replay hand containing only chi/pon calls as three kans", () => {
    const winnerMelds: Meld[] = [
      {
        type: "chi",
        tiles: [tile("m1"), tile("m2"), tile("m3")],
        calledFrom: 1,
        calledTile: tile("m3"),
      },
      meld("pon", "p5", 3),
      meld("pon", "z1", 3),
    ];
    expect(countOwnKanMelds(winnerMelds)).toBe(0);
  });

  it("counts open, closed, and added kans owned by the winner", () => {
    const winnerMelds: Meld[] = [
      meld("kan_open", "m9", 4),
      meld("kan_closed", "p9", 4),
      meld("kan_added", "s9", 4),
    ];
    expect(countOwnKanMelds(winnerMelds)).toBe(3);
  });
});
