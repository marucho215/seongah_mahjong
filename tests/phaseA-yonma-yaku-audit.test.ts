import { describe, expect, it } from "vitest";
import { allKindsForRules } from "../src/core/tiles.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import type { Group, WinContext } from "../src/yaku/types.js";
import { groupToKinds } from "../src/yaku/types.js";
import { evaluateStandardYaku } from "../src/yaku/yakuStandard.js";

function baseContext(): WinContext {
  return {
    seatWind: 1,
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
}

function sanshokuGroups(open: boolean): Group[] {
  return [
    { type: "sequence", kind: "m2", concealed: !open },
    { type: "sequence", kind: "p2", concealed: true },
    { type: "sequence", kind: "s2", concealed: true },
    { type: "sequence", kind: "p6", concealed: true },
    { type: "pair", kind: "z2", concealed: true },
  ];
}

function evaluate(groups: Group[], isMenzen: boolean) {
  return evaluateStandardYaku(
    groups,
    "ryanmen",
    isMenzen,
    groups.flatMap(groupToKinds),
    baseContext(),
    true
  );
}

describe("Phase A yonma yaku coverage: Sanshoku Doujun", () => {
  it("scores a closed same-number sequence in all three suits as 2 han", () => {
    const hit = evaluate(sanshokuGroups(false), true).find((yaku) => yaku.name === "Sanshoku Doujun");
    expect(hit).toEqual({ name: "Sanshoku Doujun", han: 2 });
  });

  it("scores an open same-number sequence in all three suits as 1 han", () => {
    const hit = evaluate(sanshokuGroups(true), false).find((yaku) => yaku.name === "Sanshoku Doujun");
    expect(hit).toEqual({ name: "Sanshoku Doujun", han: 1 });
  });

  it("does not score sequences whose starting ranks differ", () => {
    const groups = sanshokuGroups(false);
    groups[2] = { type: "sequence", kind: "s3", concealed: true };
    expect(evaluate(groups, true).some((yaku) => yaku.name === "Sanshoku Doujun")).toBe(false);
  });

  it("remains structurally impossible with the sanma tile set", () => {
    const sanmaKinds = new Set(allKindsForRules(DEFAULT_SANMA_RULES));
    for (let start = 1; start <= 7; start++) {
      const manzuSequenceExists = [start, start + 1, start + 2].every((rank) => sanmaKinds.has(`m${rank}`));
      expect(manzuSequenceExists).toBe(false);
    }
  });
});
