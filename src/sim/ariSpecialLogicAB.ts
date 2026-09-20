/* Paired same-seed A/B simulation isolating Ari (byeonari)'s two special mechanics -
 * shapeCleanlinessBias and contaminationAversion - from her general personality
 * parameters. Not part of the automated test suite. Run with
 * `npx tsx src/sim/ariSpecialLogicAB.ts [games] [--save-replays]`.
 *
 * A = Ari's real profile, unmodified.
 * B = identical profile except shapeCleanlinessBias and contaminationAversion are both
 *     undefined (the exact same "no special mechanic" state every other non-Ari
 *     character is already in - not a zero override, an absence, so the `!== undefined`
 *     gates throughout characterAI.ts skip both terms entirely, same code path as any
 *     profile that never had them).
 *
 * A and B use the SAME game seed per paired sample, so opponents' CharacterAI RNG
 * streams (`${wallSeed}::ai0` / `::ai1`) are byte-identical between the two runs, and
 * Ari's own streams are seeded identically too (only her profile's two fields differ -
 * computeAriSpecialDeltas draws no RNG, so this cannot desync the noise sequence). This
 * is exactly the paired-seed methodology already used for Tosuke's sandbagging
 * verification (tests/characterAI.test.ts, comparativeCharacterSim.ts).
 *
 * IMPORTANT: this only holds up to Ari's first discard decision that actually differs
 * between A and B. From that point on, the physical game state can diverge (a different
 * discard changes what's callable, what opponents draw next in turn order, etc.), so
 * "decision-level" (isolated, same-situation) and "game-level" (full-game outcome,
 * post-divergence) comparisons answer different questions and are reported separately.
 */
import { GameState } from "../core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../rules/RuleConfig.js";
import { getCharacterProfile } from "../ai/characterProfiles.js";
import type { CharacterProfile } from "../ai/characterProfile.js";
import type { GameEvent, AiDiscardDecisionEntry } from "../core/GameLog.js";
import { minShanten } from "../shanten/shanten.js";
import { kindToSlot } from "../core/tileIndex.js";
import { buildGameReplayRecord, writeGameReplay, type ReplaySeatInfo } from "./replayRecorder.js";

const ARI_SEAT = 2; // matches the seiyakouri/toumesuayo/byeonari combo already sampled by hand

function buildProfileB(base: CharacterProfile): CharacterProfile {
  return { ...base, shapeCleanlinessBias: undefined, contaminationAversion: undefined };
}

function fmt(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : "n/a";
}

function handSlices(events: GameEvent[]): { start: number; end: number }[] {
  const starts = events.map((e, i) => (e.type === "hand_start" ? i : -1)).filter((i) => i >= 0);
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? events.length }));
}

// ---------------------------------------------------------------------------
// Game-level outcome stats (both A and B)
// ---------------------------------------------------------------------------
interface GameOutcomeStats {
  games: number;
  hands: number;
  placementSum: number;
  placementCounts: [number, number, number]; // 1st/2nd/3rd
  winCount: number;
  ronCount: number;
  tsumoCount: number;
  dealInCount: number;
  totalHanOnWin: number;
  totalPointsOnWin: number;
  riichiCount: number;
  callCount: number;
  exhaustiveTenpaiCount: number;
  tenpaiHandsTotal: number;
  tenpaiTurnSum: number;
  tenpaiThenWinCount: number;
}

function emptyOutcome(): GameOutcomeStats {
  return {
    games: 0,
    hands: 0,
    placementSum: 0,
    placementCounts: [0, 0, 0],
    winCount: 0,
    ronCount: 0,
    tsumoCount: 0,
    dealInCount: 0,
    totalHanOnWin: 0,
    totalPointsOnWin: 0,
    riichiCount: 0,
    callCount: 0,
    exhaustiveTenpaiCount: 0,
    tenpaiHandsTotal: 0,
    tenpaiTurnSum: 0,
    tenpaiThenWinCount: 0,
  };
}

function recordOutcome(gs: GameState, stats: GameOutcomeStats) {
  stats.games++;
  const standing = gs.computeFinalStandings().find((s) => s.player === ARI_SEAT)!;
  stats.placementSum += standing.placement;
  stats.placementCounts[standing.placement - 1]!++;

  for (const { start, end } of handSlices(gs.log)) {
    const slice = gs.log.slice(start, end);
    stats.hands++;

    // reconstruct Ari's concealed-hand kind counts + meld count turn by turn (same
    // methodology as the earlier byeonari investigation, cross-checked there against
    // manually-reported win/riichi/call/dealIn counts and confirmed exact)
    const dealEvt = slice.find((e) => e.type === "deal")! as Extract<GameEvent, { type: "deal" }>;
    const counts = new Array(34).fill(0);
    for (const k of dealEvt.hands[ARI_SEAT]) counts[kindToSlot(k)]++;
    let melds = 0;
    let discardIdx = 0;
    let tenpaiTurn: number | null = null;

    for (const e of slice) {
      if (e.type === "draw" && e.player === ARI_SEAT) counts[kindToSlot(e.tile)]++;
      else if (e.type === "kita" && e.player === ARI_SEAT) counts[kindToSlot(e.tile)]--;
      else if (e.type === "call" && e.player === ARI_SEAT) {
        const removeCount = e.call === "pon" ? 2 : e.call === "kan_open" ? 3 : e.call === "kan_closed" ? 4 : 1;
        counts[kindToSlot(e.kind)] -= removeCount;
        if (e.call !== "kan_added") melds++;
        stats.callCount++;
      } else if (e.type === "riichi" && e.player === ARI_SEAT) {
        stats.riichiCount++;
      } else if (e.type === "discard" && e.player === ARI_SEAT) {
        counts[kindToSlot(e.tile)]--;
        discardIdx++;
        if (tenpaiTurn === null && minShanten(counts, melds) === 0) tenpaiTurn = discardIdx;
      } else if (e.type === "win" && e.ronFrom === ARI_SEAT && e.player !== ARI_SEAT) {
        stats.dealInCount++;
      } else if (e.type === "win" && e.player === ARI_SEAT) {
        stats.winCount++;
        stats.totalHanOnWin += e.han;
        stats.totalPointsOnWin += e.points;
        if (e.isTsumo) stats.tsumoCount++;
        else stats.ronCount++;
      } else if (e.type === "exhaustive_draw" && e.tenpaiPlayers.includes(ARI_SEAT)) {
        stats.exhaustiveTenpaiCount++;
      }
    }
    if (tenpaiTurn !== null) {
      stats.tenpaiHandsTotal++;
      stats.tenpaiTurnSum += tenpaiTurn;
      if (slice.some((e) => e.type === "win" && e.player === ARI_SEAT)) stats.tenpaiThenWinCount++;
    }
  }
}

function printOutcome(label: string, s: GameOutcomeStats) {
  console.log(`\n[${label}] games=${s.games} hands=${s.hands}`);
  console.log(`  avgPlacement=${fmt(s.placementSum / s.games, 2)} placements(1/2/3)=${s.placementCounts.join("/")}`);
  console.log(
    `  win/hand=${fmt(s.winCount / s.hands)} ron/hand=${fmt(s.ronCount / s.hands)} tsumo/hand=${fmt(s.tsumoCount / s.hands)} dealIn/hand=${fmt(s.dealInCount / s.hands)}`
  );
  console.log(`  avgHanOnWin=${fmt(s.totalHanOnWin / Math.max(1, s.winCount), 2)} avgPointsOnWin=${fmt(s.totalPointsOnWin / Math.max(1, s.winCount), 0)}`);
  console.log(`  riichi/hand=${fmt(s.riichiCount / s.hands)} call/hand=${fmt(s.callCount / s.hands)} exhaustiveTenpai/hand=${fmt(s.exhaustiveTenpaiCount / s.hands)}`);
  console.log(
    `  tenpaiReached=${s.tenpaiHandsTotal}/${s.hands} avgTurnToTenpai=${fmt(s.tenpaiTurnSum / Math.max(1, s.tenpaiHandsTotal), 2)} winRateAfterTenpai=${fmt(s.tenpaiThenWinCount / Math.max(1, s.tenpaiHandsTotal))}`
  );
}

// ---------------------------------------------------------------------------
// Decision-level stats: A-side only (B never populates ariChoiceChanged - both special
// params are undefined for her in B, so it's always null there, same as any other
// character - there is nothing to measure on the B side at the decision level).
// ---------------------------------------------------------------------------
interface DecisionStats {
  totalDecisions: number;
  changedCount: number;
  shapeNonZeroCount: number;
  contaminationNonZeroCount: number;
  // when changed: chosen vs {baseline, special}
  chosenEqualsSpecial: number; // A
  chosenEqualsBaseline: number; // B
  chosenEqualsNeither: number; // C
  scoreGapSum: number;
  scoreGapCount: number;
  shantenDiffSum: number;
  ukeireDiffSum: number;
  dangerDiffSum: number;
  diffSampleCount: number; // how many "changed" decisions had both candidates present in topCandidates to diff
  specialIsIsolatedCount: number;
  turnSum: number;
  turnCount: number;
  shapeOnlyCount: number;
  contaminationOnlyCount: number;
  bothOrAmbiguousCount: number;
}

function emptyDecision(): DecisionStats {
  return {
    totalDecisions: 0,
    changedCount: 0,
    shapeNonZeroCount: 0,
    contaminationNonZeroCount: 0,
    chosenEqualsSpecial: 0,
    chosenEqualsBaseline: 0,
    chosenEqualsNeither: 0,
    scoreGapSum: 0,
    scoreGapCount: 0,
    shantenDiffSum: 0,
    ukeireDiffSum: 0,
    dangerDiffSum: 0,
    diffSampleCount: 0,
    specialIsIsolatedCount: 0,
    turnSum: 0,
    turnCount: 0,
    shapeOnlyCount: 0,
    contaminationOnlyCount: 0,
    bothOrAmbiguousCount: 0,
  };
}

function recordDecisions(gs: GameState, stats: DecisionStats) {
  // per-hand discard-index counter, to report "which turn the change happened on"
  const turnByHand = new Map<number, number>();
  for (const d of gs.aiDecisionLog) {
    if (d.type !== "discard_decision" || d.player !== ARI_SEAT) continue;
    const turn = (turnByHand.get(d.handIndex) ?? 0) + 1;
    turnByHand.set(d.handIndex, turn);
    if (d.ariChoiceChanged === null || d.ariChoiceChanged === undefined) continue; // not an Ari-diagnostics-active decision (shouldn't happen for A, but guard anyway)

    stats.totalDecisions++;
    if (d.chosenShapeCleanlinessDelta) stats.shapeNonZeroCount++;
    if (d.chosenContaminationDelta) stats.contaminationNonZeroCount++;
    if (!d.ariChoiceChanged) continue;

    stats.changedCount++;
    stats.turnSum += turn;
    stats.turnCount++;

    if (d.chosenKind === d.specialAdjustedBestKind) stats.chosenEqualsSpecial++;
    else if (d.chosenKind === d.baselineBestKind) stats.chosenEqualsBaseline++;
    else stats.chosenEqualsNeither++;

    const special = d.topCandidates.find((c) => c.kind === d.specialAdjustedBestKind);
    const baseline = d.topCandidates.find((c) => c.kind === d.baselineBestKind);
    if (special && baseline && special.baselineScore !== undefined && baseline.baselineScore !== undefined) {
      // score gap: how far ahead the special-adjusted #1 now is over the baseline #1,
      // measured on the REAL (special) score scale
      stats.scoreGapSum += special.score - (baseline.score ?? special.score);
      stats.scoreGapCount++;
    }
    if (special && baseline && special.shanten !== undefined && baseline.shanten !== undefined) {
      stats.shantenDiffSum += special.shanten - baseline.shanten;
      stats.ukeireDiffSum += (special.ukeire ?? 0) - (baseline.ukeire ?? 0);
      stats.dangerDiffSum += (special.danger ?? 0) - (baseline.danger ?? 0);
      stats.diffSampleCount++;
      if (special.isIsolated) stats.specialIsIsolatedCount++;
    }

    if (special) {
      const shapeNZ = (special.shapeCleanlinessDelta ?? 0) !== 0;
      const contamNZ = (special.contaminationDelta ?? 0) !== 0;
      if (shapeNZ && !contamNZ) stats.shapeOnlyCount++;
      else if (contamNZ && !shapeNZ) stats.contaminationOnlyCount++;
      else stats.bothOrAmbiguousCount++; // includes "neither" (can't attribute - shouldn't happen but stays safe) and "both"
    } else {
      stats.bothOrAmbiguousCount++; // winner not in recorded top5 - can't inspect its deltas
    }
  }
}

function printDecisions(s: DecisionStats) {
  console.log(`\n[A: decision-level] totalDiscardDecisions=${s.totalDecisions}`);
  console.log(`  ariChoiceChanged: ${s.changedCount}/${s.totalDecisions} (${fmt(s.changedCount / Math.max(1, s.totalDecisions))})`);
  console.log(`  shapeCleanlinessDelta!=0 on chosen: ${s.shapeNonZeroCount} contaminationDelta!=0 on chosen: ${s.contaminationNonZeroCount}`);
  console.log(`  when changed (n=${s.changedCount}): chosen==special(A)=${s.chosenEqualsSpecial} chosen==baseline(B)=${s.chosenEqualsBaseline} chosen==neither(C)=${s.chosenEqualsNeither}`);
  console.log(`  avg score gap (special#1 - baseline#1, n=${s.scoreGapCount})=${fmt(s.scoreGapSum / Math.max(1, s.scoreGapCount), 3)}`);
  console.log(
    `  avg shanten diff=${fmt(s.shantenDiffSum / Math.max(1, s.diffSampleCount), 3)} avg ukeire diff=${fmt(s.ukeireDiffSum / Math.max(1, s.diffSampleCount), 3)} avg danger diff=${fmt(
      s.dangerDiffSum / Math.max(1, s.diffSampleCount),
      3
    )} (n=${s.diffSampleCount}, special candidate isolated in ${s.specialIsIsolatedCount}/${s.diffSampleCount})`
  );
  console.log(`  avg turn-of-change=${fmt(s.turnSum / Math.max(1, s.turnCount), 2)}`);
  console.log(`  attribution: shape-only=${s.shapeOnlyCount} contamination-only=${s.contaminationOnlyCount} both/ambiguous=${s.bothOrAmbiguousCount}`);
}

// ---------------------------------------------------------------------------
// Paired A/B runner
// ---------------------------------------------------------------------------
function run(games: number, saveReplays: boolean) {
  const kouri = getCharacterProfile("seiyakouri");
  const toumesuayo = getCharacterProfile("toumesuayo");
  const ariA = getCharacterProfile("byeonari");
  const ariB = buildProfileB(ariA);

  const outcomeA = emptyOutcome();
  const outcomeB = emptyOutcome();
  const decisionStats = emptyDecision();
  const pairedPlacementDiffs: number[] = [];

  const seatsA: ReplaySeatInfo[] = [
    { seat: 0, kind: "characterAI", characterId: "seiyakouri" },
    { seat: 1, kind: "characterAI", characterId: "toumesuayo" },
    { seat: 2, kind: "characterAI", characterId: "byeonari" },
  ];
  const seatsB: ReplaySeatInfo[] = seatsA.map((s) => (s.seat === 2 ? { ...s, characterId: "byeonari-B-no-special" } : s));

  console.log(`\n=== Ari special-logic paired A/B: ${games} games vs seiyakouri+toumesuayo (fixed opponents, paired seed) ===`);
  if (saveReplays) console.log(`(saving replays for both A and B runs)`);

  for (let seed = 0; seed < games; seed++) {
    const gameSeed = `ari-ab-${seed}`;

    const gsA = new GameState({ rules: DEFAULT_SANMA_RULES, seed: gameSeed, characterProfiles: [kouri, toumesuayo, ariA] });
    gsA.playGame();
    recordOutcome(gsA, outcomeA);
    recordDecisions(gsA, decisionStats);
    const placementA = gsA.computeFinalStandings().find((s) => s.player === ARI_SEAT)!.placement;
    if (saveReplays) writeGameReplay(buildGameReplayRecord(gsA, `ari-ab-A-${seed}`, seed, seatsA), "replays");

    const gsB = new GameState({ rules: DEFAULT_SANMA_RULES, seed: gameSeed, characterProfiles: [kouri, toumesuayo, ariB] });
    gsB.playGame();
    recordOutcome(gsB, outcomeB);
    const placementB = gsB.computeFinalStandings().find((s) => s.player === ARI_SEAT)!.placement;
    if (saveReplays) writeGameReplay(buildGameReplayRecord(gsB, `ari-ab-B-${seed}`, seed, seatsB), "replays");

    pairedPlacementDiffs.push(placementA - placementB);
  }

  printOutcome("A: Ari as-is (shapeCleanlinessBias + contaminationAversion active)", outcomeA);
  printOutcome("B: Ari with both special params undefined", outcomeB);
  printDecisions(decisionStats);

  console.log(`\n[paired placement diff] A.placement - B.placement per game:`);
  console.log(`  ${pairedPlacementDiffs.join(", ")}`);
  const avgDiff = pairedPlacementDiffs.reduce((a, b) => a + b, 0) / pairedPlacementDiffs.length;
  const aBetter = pairedPlacementDiffs.filter((d) => d < 0).length;
  const bBetter = pairedPlacementDiffs.filter((d) => d > 0).length;
  const tied = pairedPlacementDiffs.filter((d) => d === 0).length;
  console.log(`  avg diff=${fmt(avgDiff, 3)} (negative = A placed better) A-better=${aBetter} B-better=${bBetter} tied=${tied}`);
}

const args = process.argv.slice(2);
const games = Number(args.find((a) => !a.startsWith("--")) ?? 50);
const saveReplays = args.includes("--save-replays");
run(games, saveReplays);
