// 규칙 옵션 (로비 "규칙"): 검증, 기본값과 같은 항목 제거, RuleConfig 적용, 이름 표시, 실제 대국 길이/적도라 반영.
import { describe, expect, it } from "vitest";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";
import { buildTileSet } from "../src/core/tiles.js";
import { parseGuiGameConfig, parseRuleOptions, ruleOptionLabels, rulesFor } from "../src/gui/gameSetup.js";
import { gameFromSpec } from "../src/gui/engineRunner.js";
import { GameState } from "../src/core/GameState.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";

describe("parseRuleOptions", () => {
  it("없거나 기본값과 같은 항목은 빈 옵션이 된다", () => {
    expect(parseRuleOptions(undefined, "yonma")).toEqual({});
    expect(parseRuleOptions({ gameLength: "east", akaDora: "default", kuitan: true, kuikae: true, doubleRon: "all", kazoeYakuman: true, doubleYakuman: true, kiriageMangan: false }, "yonma")).toEqual({});
  });

  it("기본과 다른 항목만 남긴다 (산마 기본에는 쿠이카에가 없다)", () => {
    expect(parseRuleOptions({ gameLength: "east-south", kuitan: false, kiriageMangan: true, akaDora: "none" }, "sanma")).toEqual({ gameLength: "east-south", kuitan: false, kiriageMangan: true, akaDora: "none" });
    expect(parseRuleOptions({ kuikae: false }, "yonma")).toEqual({ kuikae: false });
  });

  it("모르는 항목, 잘못된 값, 산마의 쿠이카에는 거절한다", () => {
    expect(() => parseRuleOptions({ foo: 1 }, "yonma")).toThrow(/알 수 없는/);
    expect(() => parseRuleOptions({ gameLength: "south" }, "yonma")).toThrow();
    expect(() => parseRuleOptions({ kuitan: "yes" }, "yonma")).toThrow();
    expect(() => parseRuleOptions([], "yonma")).toThrow();
    expect(() => parseRuleOptions({ kuikae: false }, "sanma")).toThrow(/치가 없어/);
  });

  it("대국 구성에 실리고, 기본이면 필드가 없다", () => {
    const base = { mode: "yonma", opponents: ["jegalmina", "jegalnahui", "byeonari"] };
    expect(parseGuiGameConfig({ ...base, rules: { gameLength: "east" } })).not.toHaveProperty("rules");
    expect(parseGuiGameConfig({ ...base, rules: { gameLength: "east-south" } }).rules).toEqual({ gameLength: "east-south" });
  });
});

describe("rulesFor", () => {
  it("옵션이 없으면 기본 규칙과 같은 값이다", () => {
    expect(rulesFor("yonma")).toEqual(MAJSOUL_YONMA_RULES);
    expect(rulesFor("sanma", {})).toEqual(DEFAULT_SANMA_RULES);
  });

  it("옵션을 RuleConfig에 적용한다", () => {
    const r = rulesFor("yonma", { gameLength: "east-south", kuitan: false, kuikae: false, doubleRon: "atamahane", kazoeYakuman: false, doubleYakuman: false, kiriageMangan: true });
    expect(r).toMatchObject({ gameLength: "east-south", kuitan: false, kuikae: false, doubleRonMode: "atamahane", kazoeYakumanEnabled: false, doubleYakumanEnabled: false, kiriageMangan: true });
    // 다른 항목은 그대로
    expect(r.startingScore).toBe(MAJSOUL_YONMA_RULES.startingScore);
  });

  it("적도라: 없음은 전부 0, 많이는 있는 수트마다 한 장 더 (산마의 만수는 0 그대로)", () => {
    expect(rulesFor("yonma", { akaDora: "none" }).akaDoraCount).toEqual({ man: 0, pin: 0, sou: 0 });
    expect(rulesFor("yonma", { akaDora: "more" }).akaDoraCount).toEqual({ man: 2, pin: 2, sou: 2 });
    expect(rulesFor("sanma", { akaDora: "more" }).akaDoraCount).toEqual({ man: 0, pin: 2, sou: 2 });
    const redCount = (rules: ReturnType<typeof rulesFor>) => buildTileSet(rules).filter((t) => t.isRed).length;
    expect(redCount(rulesFor("yonma", { akaDora: "none" }))).toBe(0);
    expect(redCount(rulesFor("yonma"))).toBe(3);
    expect(redCount(rulesFor("yonma", { akaDora: "more" }))).toBe(6);
  });
});

describe("ruleOptionLabels", () => {
  it("기본 규칙이면 비어 있고, 바뀐 항목은 한국어 이름으로 나온다", () => {
    expect(ruleOptionLabels(undefined)).toEqual([]);
    expect(ruleOptionLabels({})).toEqual([]);
    expect(ruleOptionLabels({ gameLength: "east-south", akaDora: "none", kuitan: false, doubleRon: "atamahane", kiriageMangan: true })).toEqual(["동남전", "적도라 없음", "쿠이탕 없음", "머리박기", "절상만관"]);
  });
});

describe("실제 대국에 반영", () => {
  it("gameFromSpec은 고른 규칙으로 GameState를 만든다 (사람 자리 선택과 함께여도)", () => {
    const opponents = ["jegalmina", "jegalnahui", "byeonari"].map((characterId) => ({ characterId }));
    const a = gameFromSpec({ mode: "yonma", seed: "rules-a", opponents, rules: { gameLength: "east-south", akaDora: "none" } });
    expect(a.rules.gameLength).toBe("east-south");
    expect(a.rules.akaDoraCount).toEqual({ man: 0, pin: 0, sou: 0 });
    const b = gameFromSpec({ mode: "yonma", seed: "rules-b", opponents, humanSeat: 2, rules: { kuitan: false } });
    expect(b.rules.kuitan).toBe(false);
    expect(b.controllers[2]).toBe("human");
    expect(gameFromSpec({ mode: "yonma", seed: "rules-c", opponents }).rules).toEqual(MAJSOUL_YONMA_RULES);
  });

  it("동남전은 같은 시드의 동풍전보다 국이 더 많다 (AI끼리 한 게임)", () => {
    const profiles = ["jegalmina", "jegalnahui", "byeonari"].map(getCharacterProfile);
    const handsOf = (rules: typeof DEFAULT_SANMA_RULES) => {
      const game = new GameState({ rules, seed: "rules-length", characterProfiles: profiles });
      game.playGame();
      return game.log.filter((e) => e.type === "hand_start").length;
    };
    const east = handsOf(rulesFor("sanma"));
    const eastSouth = handsOf(rulesFor("sanma", { gameLength: "east-south" }));
    expect(eastSouth).toBeGreaterThan(east);
  }, 180_000);
});
