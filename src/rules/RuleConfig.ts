import { MAJSOUL_SANMA_RULESET, MAJSOUL_YONMA_RULESET } from "./RuleSet.js";

/**
 * Riichi mahjong rule configuration shared by the supported sanma and yonma formats.
 * All game-affecting rule toggles live here, separate from engine logic.
 *
 * DEFAULT_SANMA_RULES targets Mahjong Soul's ranked 3-player ruleset as closely as this
 * engine's scope allows. Fields that reflect genuinely fixed Mahjong Soul behavior (rather
 * than a real rule variant) are documented as such rather than exposed as toggles.
 */

export type GameLength = "east" | "east-south";

export interface RuleConfig {
  /** Structural values are copied from the selected RuleSet for the current engine API. */
  playerCount: number;
  handsPerRound: number;
  maxExtensionRounds: number;
  /** Automatically end on the final dealer's qualifying win/tenpai continuation. */
  automaticDealerEnd: boolean;

  /** Remove manzu 2-8 from the wall, leaving only man1/man9 (standard sanma). */
  removeManzu2to8: boolean;

  /** Enable kita (north-tile) extraction as a bonus-draw mechanic. */
  kitaEnabled: boolean;

  /** Number of red-five (aka dora) tiles to inject per suit. Suits absent from the wall are ignored. */
  akaDoraCount: { man: number; pin: number; sou: number };

  /** Open hands may contain tanyao (all-simples) as a valid yaku ("kuitan"/open tanyao). */
  kuitan: boolean;

  /** Atozuke: a hand may win on a call/tile where its only yaku becomes valid at completion
   *  (e.g. an open hand whose sole yaku is realized by the winning tile itself). This engine
   *  never restricts wins by "when" a yaku became valid, only by whether one exists at
   *  completion, so this flag is documentation of that default rather than an active gate. */
  atozuke: boolean;

  /** Kuikae (forbidding the called kind and any opposite-end swap immediately after chi).
   *  It has no effect in sanma while chiForbidden is true. */
  kuikae: boolean;

  /** Sanma tsumo-loss rule: on tsumo, is payment split evenly among the two non-winners (true,
   *  "no loss" - matches the discarder-pays-full-share total a ron would produce), or does
   *  the dealer pay double what the other non-dealer pays (false, "tsumo loss" - sanma's
   *  standard behavior, since only 2 payers collect less total than a 3-payer 4p tsumo)?
   *  Yonma uses its standard three-payer payment calculation independently of this toggle. */
  tsumoSplitEven: boolean;

  startingScore: number;
  /** "Return score" (oka baseline): final placement points are (finalScore - returnScore) / 1000 + uma. */
  returnScore: number;
  /** Score threshold used only for all-last, extension, and automatic dealer-end decisions. */
  targetScore: number;
  /** Placement bonus/penalty in raw points, applied at game end in finishing-place order.
   *  Does not mutate mid-game scores - see GameState.computeFinalStandings(). */
  uma: number[];

  gameLength: GameLength;

  /** Renchan (dealer repeat) conditions. */
  renchanOnDealerWin: boolean;
  renchanOnDealerTenpaiDraw: boolean;

  /** How to handle multiple simultaneous ron on the same discard: every eligible player wins
   *  independently ("all", Mahjong Soul default) vs. only the closest downstream player wins
   *  ("atamahane" / head bump). Riichi-stick recipient is governed separately - see
   *  GameState's riichi-stick-to-closest-winner handling, independent of this setting. */
  doubleRonMode: "atamahane" | "all";

  /** No chi is allowed in sanma regardless of this flag; kept explicit for clarity/tests. */
  chiForbidden: boolean;

  /** Kan constraints (real kans only; kita replacement draws don't count against this). */
  maxKans: number;

  /** Wall-layout values supplied by the ruleset rather than embedded in Wall. */
  wallLayout: "sanma-r1-r8" | "yonma-standard";
  deadWallSize: number;
  initialReplacementSlots: number;
  doraIndicatorSlots: number;
  tileCopiesPerKind: number;
  northTileCopies: number;

  /** Whether North tiles participate as a yakuhai possibility. False in Mahjong Soul sanma:
   *  North is an ordinary guest wind in the concealed hand - a North pair/triplet/quad scores
   *  no yakuhai han, and merely holding North does not make it dora (only kita extraction does). */
  northIsYakuhai: boolean;

  /** Total point pot redistributed at exhaustive draw among tenpai/noten players
   *  (Mahjong Soul sanma: 2000, e.g. 1 tenpai player receives all 2000). */
  notenPenaltyTotal: number;

  /** Total points one honba is worth. Ron charges the discarder; tsumo distributes the
   *  charge among the ruleset's non-winners (Mahjong Soul-style sanma: 200, yonma: 300). */
  honbaValue: number;

  /** Hands that reach 13+ han purely through yaku+dora stacking (no actual yakuman shape)
   *  score as a yakuman ("kazoe yakuman") when true; when false they cap at sanbaiman
   *  regardless of how high han climbs. */
  kazoeYakumanEnabled: boolean;

  /** Whether a "double" yakuman condition (kokushi 13-wait, suuankou tanki, junsei chuuren,
   *  daisuushii) actually pays double. When false, every yakuman hit is worth exactly one unit. */
  doubleYakumanEnabled: boolean;

  /** Kiriage mangan: a hand computing to just under mangan (4han30fu or 3han60fu, base 1920)
   *  is rounded up to a full mangan payout. */
  kiriageMangan: boolean;

  /** Whether a double-wind pair (round wind === seat wind, e.g. dealer's East during the
   *  East round) stacks its fu (+4 total, Mahjong Soul default) or is capped at the
   *  single-wind value (+2). */
  doubleWindFuStacks: boolean;
}

export const DEFAULT_SANMA_RULES: RuleConfig = {
  playerCount: MAJSOUL_SANMA_RULESET.playerCount,
  handsPerRound: MAJSOUL_SANMA_RULESET.rounds.handsPerRound,
  maxExtensionRounds: MAJSOUL_SANMA_RULESET.rounds.maxExtensionRounds,
  automaticDealerEnd: MAJSOUL_SANMA_RULESET.rounds.automaticDealerEnd,
  removeManzu2to8: MAJSOUL_SANMA_RULESET.tiles.removeManzu2to8,
  kitaEnabled: MAJSOUL_SANMA_RULESET.calls.allowKita,
  akaDoraCount: { man: 0, pin: 1, sou: 1 },
  kuitan: true,
  atozuke: true,
  kuikae: false,
  tsumoSplitEven: false,
  startingScore: MAJSOUL_SANMA_RULESET.scores.starting,
  returnScore: MAJSOUL_SANMA_RULESET.scores.return,
  targetScore: MAJSOUL_SANMA_RULESET.scores.target,
  uma: [15000, 0, -15000],
  gameLength: MAJSOUL_SANMA_RULESET.rounds.normalGameLength,
  renchanOnDealerWin: true,
  renchanOnDealerTenpaiDraw: true,
  doubleRonMode: "all",
  chiForbidden: !MAJSOUL_SANMA_RULESET.calls.allowChi,
  maxKans: MAJSOUL_SANMA_RULESET.calls.maxKans,
  wallLayout: MAJSOUL_SANMA_RULESET.wall.layout,
  deadWallSize: MAJSOUL_SANMA_RULESET.wall.deadWallSize,
  initialReplacementSlots: MAJSOUL_SANMA_RULESET.wall.initialReplacementSlots,
  doraIndicatorSlots: MAJSOUL_SANMA_RULESET.wall.doraIndicatorSlots,
  tileCopiesPerKind: MAJSOUL_SANMA_RULESET.tiles.copiesPerKind,
  northTileCopies: MAJSOUL_SANMA_RULESET.tiles.northTileCopies,
  northIsYakuhai: false,
  notenPenaltyTotal: 2000,
  honbaValue: 200,
  kazoeYakumanEnabled: true,
  doubleYakumanEnabled: true,
  kiriageMangan: false,
  doubleWindFuStacks: true,
};

/** Mahjong Soul-style four-player configuration used by full GameState gameplay. */
export const MAJSOUL_YONMA_RULES: RuleConfig = {
  playerCount: MAJSOUL_YONMA_RULESET.playerCount,
  handsPerRound: MAJSOUL_YONMA_RULESET.rounds.handsPerRound,
  maxExtensionRounds: MAJSOUL_YONMA_RULESET.rounds.maxExtensionRounds,
  automaticDealerEnd: MAJSOUL_YONMA_RULESET.rounds.automaticDealerEnd,
  removeManzu2to8: MAJSOUL_YONMA_RULESET.tiles.removeManzu2to8,
  kitaEnabled: MAJSOUL_YONMA_RULESET.calls.allowKita,
  akaDoraCount: { man: 1, pin: 1, sou: 1 },
  kuitan: true,
  atozuke: true,
  kuikae: true,
  tsumoSplitEven: false,
  startingScore: MAJSOUL_YONMA_RULESET.scores.starting,
  returnScore: MAJSOUL_YONMA_RULESET.scores.return,
  targetScore: MAJSOUL_YONMA_RULESET.scores.target,
  uma: [15000, 5000, -5000, -15000],
  gameLength: MAJSOUL_YONMA_RULESET.rounds.normalGameLength,
  renchanOnDealerWin: true,
  renchanOnDealerTenpaiDraw: true,
  doubleRonMode: "all",
  chiForbidden: !MAJSOUL_YONMA_RULESET.calls.allowChi,
  maxKans: MAJSOUL_YONMA_RULESET.calls.maxKans,
  wallLayout: MAJSOUL_YONMA_RULESET.wall.layout,
  deadWallSize: MAJSOUL_YONMA_RULESET.wall.deadWallSize,
  initialReplacementSlots: MAJSOUL_YONMA_RULESET.wall.initialReplacementSlots,
  doraIndicatorSlots: MAJSOUL_YONMA_RULESET.wall.doraIndicatorSlots,
  tileCopiesPerKind: MAJSOUL_YONMA_RULESET.tiles.copiesPerKind,
  northTileCopies: MAJSOUL_YONMA_RULESET.tiles.northTileCopies,
  northIsYakuhai: false,
  notenPenaltyTotal: 3000,
  honbaValue: 300,
  kazoeYakumanEnabled: true,
  doubleYakumanEnabled: true,
  kiriageMangan: false,
  doubleWindFuStacks: true,
};

export function cloneRuleConfig(rules: RuleConfig): RuleConfig {
  return {
    ...rules,
    akaDoraCount: { ...rules.akaDoraCount },
    uma: [...rules.uma],
  };
}
