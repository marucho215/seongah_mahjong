import { describe, it, expect } from "vitest";
import { CHARACTER_PROFILES, getCharacterProfile, resolveCharacterId } from "../src/ai/characterProfiles.js";
import { GameState } from "../src/core/GameState.js";
import { MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";

describe("ryuheart canonical characterId + legacy ryuhart alias", () => {
  it("ryuheart is the registered canonical id", () => {
    expect(CHARACTER_PROFILES.ryuheart).toBeDefined();
    expect(CHARACTER_PROFILES.ryuheart!.characterId).toBe("ryuheart");
    expect(CHARACTER_PROFILES.ryuhart).toBeUndefined();
  });

  it("resolveCharacterId maps the legacy alias to the canonical id, and leaves everything else unchanged", () => {
    expect(resolveCharacterId("ryuhart")).toBe("ryuheart");
    expect(resolveCharacterId("ryuheart")).toBe("ryuheart");
    expect(resolveCharacterId("byeonari")).toBe("byeonari");
  });

  it("getCharacterProfile accepts the legacy alias as input but the returned profile's own characterId is canonical", () => {
    const viaLegacy = getCharacterProfile("ryuhart");
    const viaCanonical = getCharacterProfile("ryuheart");
    expect(viaLegacy).toBe(viaCanonical); // same object, not just equal
    expect(viaLegacy.characterId).toBe("ryuheart");
  });

  it("getCharacterProfile still throws on a genuinely unknown id", () => {
    expect(() => getCharacterProfile("not_a_real_character")).toThrow();
  });
});

describe("yonma CLI per-game seed derivation pattern (--games N / --seed S)", () => {
  // Mirrors src/sim/yonmaCharacterSim.ts's own gameSeed derivation (`${baseSeed}::game${i}`)
  // directly against GameState, rather than spawning the CLI subprocess, matching this
  // project's existing test convention of exercising the engine directly.
  const roster = ["yuwen", "toumesuayo", "optima215", "ryuheart"].map((id) => getCharacterProfile(id));

  it("games derived from the same base seed are distinct from each other", () => {
    const baseSeed = "cli-fix-repro-A";
    const logs: unknown[] = [];
    for (let gameIndex = 0; gameIndex < 3; gameIndex++) {
      const gs = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: `${baseSeed}::game${gameIndex}`, characterProfiles: roster });
      gs.playGame();
      logs.push(gs.log);
    }
    expect(logs[0]).not.toEqual(logs[1]);
    expect(logs[1]).not.toEqual(logs[2]);
    expect(logs[0]).not.toEqual(logs[2]);
  });

  it("the same base seed reproduces an identical sequence of per-game seeds/results across two runs", () => {
    const baseSeed = "cli-fix-repro-B";
    const runOnce = () => {
      const logs: unknown[] = [];
      for (let gameIndex = 0; gameIndex < 3; gameIndex++) {
        const gs = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: `${baseSeed}::game${gameIndex}`, characterProfiles: roster });
        gs.playGame();
        logs.push(gs.log);
      }
      return logs;
    };
    expect(runOnce()).toEqual(runOnce());
  });

  it("two different base seeds produce different game0 results (sanity check that base seed actually matters)", () => {
    const runGame0 = (baseSeed: string) => {
      const gs = new GameState({ rules: MAJSOUL_YONMA_RULES, seed: `${baseSeed}::game0`, characterProfiles: roster });
      gs.playGame();
      return gs.log;
    };
    expect(runGame0("base-seed-X")).not.toEqual(runGame0("base-seed-Y"));
  });
});
