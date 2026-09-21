/**
 * Stable, high-level identity of a supported ruleset.
 *
 * RuleConfig keeps the detailed scoring/yaku switches used by the engine today. RuleSet
 * groups the structural values that define the game format, so future formats can add
 * policies without scattering more format constants through the engine.
 */
export interface RuleSet {
  readonly id: string;
  readonly playerCount: number;

  readonly scores: {
    readonly starting: number;
    /** Baseline subtracted when converting final raw points to game-result points. */
    readonly return: number;
    /** Minimum leading score used by all-last, extension, and automatic dealer-end rules. */
    readonly target: number;
  };

  readonly tiles: {
    readonly removeManzu2to8: boolean;
    readonly copiesPerKind: number;
    readonly northTileCopies: number;
  };

  readonly calls: {
    readonly allowChi: boolean;
    readonly allowKita: boolean;
    readonly maxKans: number;
  };

  readonly rounds: {
    readonly handsPerRound: number;
    readonly normalGameLength: "east" | "east-south";
    readonly maxExtensionRounds: number;
    readonly automaticDealerEnd: boolean;
  };

  readonly wall: {
    readonly layout: "sanma-r1-r8" | "yonma-standard";
    readonly deadWallSize: number;
    readonly initialReplacementSlots: number;
    readonly doraIndicatorSlots: number;
  };
}

/** Supported Mahjong Soul-style three-player riichi mahjong format. */
export const MAJSOUL_SANMA_RULESET = {
  id: "mahjongsoul-sanma",
  playerCount: 3,
  scores: {
    starting: 35000,
    return: 35000,
    target: 40000,
  },
  tiles: {
    removeManzu2to8: true,
    copiesPerKind: 4,
    northTileCopies: 4,
  },
  calls: {
    allowChi: false,
    allowKita: true,
    maxKans: 4,
  },
  rounds: {
    handsPerRound: 3,
    normalGameLength: "east",
    maxExtensionRounds: 1,
    automaticDealerEnd: true,
  },
  wall: {
    layout: "sanma-r1-r8",
    deadWallSize: 14,
    initialReplacementSlots: 8,
    doraIndicatorSlots: 5,
  },
} as const satisfies RuleSet;

/** Supported Mahjong Soul-style four-player riichi mahjong format. */
export const MAJSOUL_YONMA_RULESET = {
  id: "mahjongsoul-yonma",
  playerCount: 4,
  scores: {
    starting: 25000,
    return: 25000,
    target: 30000,
  },
  tiles: {
    removeManzu2to8: false,
    copiesPerKind: 4,
    northTileCopies: 4,
  },
  calls: {
    allowChi: true,
    allowKita: false,
    maxKans: 4,
  },
  rounds: {
    handsPerRound: 4,
    normalGameLength: "east",
    maxExtensionRounds: 1,
    automaticDealerEnd: true,
  },
  wall: {
    layout: "yonma-standard",
    deadWallSize: 14,
    initialReplacementSlots: 4,
    doraIndicatorSlots: 5,
  },
} as const satisfies RuleSet;

/** Ruleset used when the engine is run with its current default sanma configuration. */
export const DEFAULT_RULESET: RuleSet = MAJSOUL_SANMA_RULESET;
