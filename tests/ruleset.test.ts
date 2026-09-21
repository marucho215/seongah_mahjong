import { describe, expect, it } from "vitest";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { DEFAULT_RULESET, MAJSOUL_SANMA_RULESET } from "../src/rules/RuleSet.js";

describe("Mahjong Soul sanma ruleset", () => {
  it("describes the current default game format explicitly", () => {
    expect(DEFAULT_RULESET).toBe(MAJSOUL_SANMA_RULESET);
    expect(MAJSOUL_SANMA_RULESET.id).toBe("mahjongsoul-sanma");
    expect(MAJSOUL_SANMA_RULESET.playerCount).toBe(3);
    expect(MAJSOUL_SANMA_RULESET.scores.starting).toBe(35000);
    expect(MAJSOUL_SANMA_RULESET.scores.return).toBe(35000);
    expect(MAJSOUL_SANMA_RULESET.scores.target).toBe(40000);
    expect(MAJSOUL_SANMA_RULESET.calls.allowChi).toBe(false);
    expect(MAJSOUL_SANMA_RULESET.calls.allowKita).toBe(true);
    expect(MAJSOUL_SANMA_RULESET.rounds.handsPerRound).toBe(3);
    expect(MAJSOUL_SANMA_RULESET.rounds.normalGameLength).toBe("east");
    expect(MAJSOUL_SANMA_RULESET.rounds.maxExtensionRounds).toBe(1);
  });

  it("feeds the existing sanma RuleConfig without changing its values", () => {
    expect(DEFAULT_SANMA_RULES.playerCount).toBe(MAJSOUL_SANMA_RULESET.playerCount);
    expect(DEFAULT_SANMA_RULES.startingScore).toBe(MAJSOUL_SANMA_RULESET.scores.starting);
    expect(DEFAULT_SANMA_RULES.returnScore).toBe(MAJSOUL_SANMA_RULESET.scores.return);
    expect(DEFAULT_SANMA_RULES.targetScore).toBe(MAJSOUL_SANMA_RULESET.scores.target);
    expect(DEFAULT_SANMA_RULES.removeManzu2to8).toBe(MAJSOUL_SANMA_RULESET.tiles.removeManzu2to8);
    expect(DEFAULT_SANMA_RULES.chiForbidden).toBe(!MAJSOUL_SANMA_RULESET.calls.allowChi);
    expect(DEFAULT_SANMA_RULES.kitaEnabled).toBe(MAJSOUL_SANMA_RULESET.calls.allowKita);
    expect(DEFAULT_SANMA_RULES.handsPerRound).toBe(MAJSOUL_SANMA_RULESET.rounds.handsPerRound);
    expect(DEFAULT_SANMA_RULES.maxExtensionRounds).toBe(MAJSOUL_SANMA_RULESET.rounds.maxExtensionRounds);
    expect(DEFAULT_SANMA_RULES.maxKans).toBe(MAJSOUL_SANMA_RULESET.calls.maxKans);
    expect(DEFAULT_SANMA_RULES.deadWallSize).toBe(MAJSOUL_SANMA_RULESET.wall.deadWallSize);
    expect(DEFAULT_SANMA_RULES.initialReplacementSlots).toBe(MAJSOUL_SANMA_RULESET.wall.initialReplacementSlots);
    expect(DEFAULT_SANMA_RULES.doraIndicatorSlots).toBe(MAJSOUL_SANMA_RULESET.wall.doraIndicatorSlots);
    expect(DEFAULT_SANMA_RULES.tileCopiesPerKind).toBe(MAJSOUL_SANMA_RULESET.tiles.copiesPerKind);
    expect(DEFAULT_SANMA_RULES.northTileCopies).toBe(MAJSOUL_SANMA_RULESET.tiles.northTileCopies);
  });
});
