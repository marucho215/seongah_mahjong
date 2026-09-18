/**
 * Character AI parameter schema, per character-ai-spec.txt.
 *
 * GLOBAL RULES (apply to every profile, enforced in characterAI.ts, never bypassed):
 * - All parameters are evaluation weights, not direct action probabilities.
 * - Illegal actions are rejected before personality evaluation ever runs (the engine's
 *   existing legality/yaku/furiten/riichi/call rules are untouched by any parameter here).
 * - skill affects evaluation quality (noise/blind spots), never a direct chance of
 *   "picking the correct answer."
 * - aggression/riskTolerance modify push/fold evaluation; they never create arbitrary
 *   dangerous play (danger is always weighed, just more or less heavily).
 * - defense/foldThreshold modify defensive evaluation; they never force automatic folding.
 * - callBias only modifies calls that are already strategically plausible.
 * - riichiBias/damaBias only modify the relative evaluation between two already-legal choices.
 * - valueGreed trades off speed vs. hand value.
 * - honitsuBias/chiitoitsuBias/yakumanGreed only bias already-viable routes.
 * - entropy only varies selection among reasonably close candidates.
 * - mistakeRate may widen the candidate pool to a moderately inferior legal choice; it
 *   never produces an illegal, catastrophic, or nonsensical action.
 * - candidateScoreTolerance defines the normal width of the "reasonably close" pool.
 */
export interface CharacterProfile {
  characterId: string;
  displayName: string;
  archetype: string;

  skill: number;
  aggression: number;
  defense: number;
  riichiBias: number;
  damaBias: number;
  callBias: number;
  foldThreshold: number;
  valueGreed: number;
  honitsuBias: number;
  chiitoitsuBias: number;
  yakumanGreed: number;
  riskTolerance: number;

  entropy: number;
  mistakeRate: number;
  candidateScoreTolerance: number;

  // Character-specific mechanics - only ever read for the four characters that declare them.
  /** Nahui: raises glitch probability as decision complexity rises. */
  overloadSensitivity?: number;
  /** Nahui: limits how far below the best candidate a glitch may fall. */
  overloadErrorSeverity?: number;
  /** Kyle: increases the evaluation of unusual but plausible routes. */
  experimentBias?: number;
  /** Kyle: keeps a chosen experimental route active through minor setbacks. */
  routePersistence?: number;
  /** Tosuke: may select a slightly inferior but still reasonable candidate after computing the true best. */
  sandbagging?: number;
  /** Tosuke: pressure level (score deficit, decisive hands, danger, high value) that disables sandbagging. */
  interventionThreshold?: number;
  /** Ari: favors connected shapes, fewer isolated tiles, stable waits when efficiency is close. */
  shapeCleanlinessBias?: number;
  /** Ari: penalizes marginally dangerous pushes and fragile/dead isolated tiles. */
  contaminationAversion?: number;
  /** Mageuna: small bonus for candidates consistent with the hand's already-forming
   *  development direction, among otherwise-close candidates. */
  planPersistence?: number;
  /** Mageuna: briefly widens the close-candidate pool after multiple overlapping
   *  disruption signals (opponent riichi, a call reshaping the hand, a core shape tile
   *  becoming impractical, a sharp danger-landscape shift) hit in close succession. */
  disruptionInstability?: number;
  /** Effie: small retention bonus (penalty for discarding) on tiles that have
   *  accumulated value-relevant attachment over several turns. */
  attachmentBias?: number;
  /** Effie: how readily accumulated attachment releases once the material is no longer
   *  the best-shanten line, is meaningfully dangerous, or no longer contributes value. */
  attachmentReleaseThreshold?: number;
  /** Optima-215: how strongly a clear (large) score gap between the top two candidates
   *  collapses entropy toward a near-deterministic top pick. */
  binaryConfidence?: number;
  /** Optima-215: how strongly a tight cluster of close-scored candidates (within
   *  candidateScoreTolerance) inflates effective entropy among just that cluster. */
  ambiguitySensitivity?: number;
  /** Jo Sangmin: small cost against calls/route-changes that don't clearly help. */
  effortAversion?: number;
  /** Jo Sangmin: small cost against irreversible commitments (riichi, calls) unless
   *  the evaluation advantage clearly exceeds it. */
  commitmentAversion?: number;
}
