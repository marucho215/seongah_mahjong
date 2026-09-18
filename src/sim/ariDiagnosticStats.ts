/* Read-only diagnostic aggregation over existing replay JSON files under replays/ -
 * aggregates Ari (byeonari)'s discard_decision entries (aiDecisions) to measure how
 * often shapeCleanlinessBias/contaminationAversion actually change the #1 candidate,
 * and what that change looks like. Only replays saved AFTER the Ari diagnostic fields
 * were added carry usable data (older replays' entries have ariChoiceChanged undefined
 * and are skipped, reported separately below rather than silently ignored).
 * Not part of the automated test suite. Run with `npx tsx src/sim/ariDiagnosticStats.ts`. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveReplayDir } from "./replayRecorder.js";
import type { AiDiscardDecisionEntry } from "../core/GameLog.js";

const REPLAY_DIR = resolveReplayDir("replays");

function fmt(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : "n/a";
}

interface Agg {
  filesRead: number;
  filesUsable: number; // at least one byeonari discard_decision with ariChoiceChanged !== undefined/null
  filesSkippedNoAriDiagnostics: number;
  totalDecisions: number;
  changedCount: number;
  shapeNonZeroCount: number;
  contaminationNonZeroCount: number;
  chosenEqualsSpecial: number;
  chosenEqualsBaseline: number;
  chosenEqualsNeither: number;
  scoreGapSum: number;
  scoreGapCount: number;
  shantenDiffSum: number;
  ukeireDiffSum: number;
  dangerDiffSum: number;
  diffSampleCount: number;
  specialIsIsolatedCount: number;
  turnSum: number;
  turnCount: number;
  shapeOnlyCount: number;
  contaminationOnlyCount: number;
  bothOrAmbiguousCount: number;
}

function empty(): Agg {
  return {
    filesRead: 0,
    filesUsable: 0,
    filesSkippedNoAriDiagnostics: 0,
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

function main() {
  const files = readdirSync(REPLAY_DIR).filter((f) => f.endsWith(".json"));
  const agg = empty();

  for (const f of files) {
    const record = JSON.parse(readFileSync(join(REPLAY_DIR, f), "utf-8"));
    agg.filesRead++;
    const ariSeat = record.meta.seats.find((s: any) => s.characterId === "byeonari")?.seat;
    if (ariSeat === undefined) continue; // no byeonari at this table at all

    const ariDecisions: AiDiscardDecisionEntry[] = record.aiDecisions.filter(
      (d: AiDiscardDecisionEntry) => d.type === "discard_decision" && d.player === ariSeat
    );
    const usable = ariDecisions.filter((d) => d.ariChoiceChanged !== null && d.ariChoiceChanged !== undefined);
    if (usable.length === 0) {
      agg.filesSkippedNoAriDiagnostics++;
      continue;
    }
    agg.filesUsable++;

    // per-hand turn counter
    const turnByHand = new Map<number, number>();
    for (const d of ariDecisions) {
      const turn = (turnByHand.get(d.handIndex) ?? 0) + 1;
      turnByHand.set(d.handIndex, turn);
      if (d.ariChoiceChanged === null || d.ariChoiceChanged === undefined) continue;

      agg.totalDecisions++;
      if (d.chosenShapeCleanlinessDelta) agg.shapeNonZeroCount++;
      if (d.chosenContaminationDelta) agg.contaminationNonZeroCount++;
      if (!d.ariChoiceChanged) continue;

      agg.changedCount++;
      agg.turnSum += turn;
      agg.turnCount++;

      if (d.chosenKind === d.specialAdjustedBestKind) agg.chosenEqualsSpecial++;
      else if (d.chosenKind === d.baselineBestKind) agg.chosenEqualsBaseline++;
      else agg.chosenEqualsNeither++;

      const special = d.topCandidates.find((c) => c.kind === d.specialAdjustedBestKind);
      const baseline = d.topCandidates.find((c) => c.kind === d.baselineBestKind);
      if (special && baseline) {
        agg.scoreGapSum += special.score - baseline.score;
        agg.scoreGapCount++;
        if (special.shanten !== undefined && baseline.shanten !== undefined) {
          agg.shantenDiffSum += special.shanten - baseline.shanten;
          agg.ukeireDiffSum += (special.ukeire ?? 0) - (baseline.ukeire ?? 0);
          agg.dangerDiffSum += (special.danger ?? 0) - (baseline.danger ?? 0);
          agg.diffSampleCount++;
          if (special.isIsolated) agg.specialIsIsolatedCount++;
        }
      }
      if (special) {
        const shapeNZ = (special.shapeCleanlinessDelta ?? 0) !== 0;
        const contamNZ = (special.contaminationDelta ?? 0) !== 0;
        if (shapeNZ && !contamNZ) agg.shapeOnlyCount++;
        else if (contamNZ && !shapeNZ) agg.contaminationOnlyCount++;
        else agg.bothOrAmbiguousCount++;
      } else {
        agg.bothOrAmbiguousCount++;
      }
    }
  }

  console.log(`\n=== Ari diagnostic stats over ${REPLAY_DIR} ===\n`);
  console.log(`files read=${agg.filesRead} usable(has Ari diagnostics)=${agg.filesUsable} skipped(no byeonari or pre-instrumentation replay)=${agg.filesSkippedNoAriDiagnostics}`);
  console.log(`\ntotal discard decisions=${agg.totalDecisions}`);
  console.log(`ariChoiceChanged: ${agg.changedCount}/${agg.totalDecisions} (${fmt(agg.changedCount / Math.max(1, agg.totalDecisions))})`);
  console.log(`shapeCleanlinessDelta!=0 on chosen: ${agg.shapeNonZeroCount} (${fmt(agg.shapeNonZeroCount / Math.max(1, agg.totalDecisions))})`);
  console.log(`contaminationDelta!=0 on chosen: ${agg.contaminationNonZeroCount} (${fmt(agg.contaminationNonZeroCount / Math.max(1, agg.totalDecisions))})`);
  console.log(`\nwhen changed (n=${agg.changedCount}):`);
  console.log(`  A. chosen == specialAdjustedBestKind: ${agg.chosenEqualsSpecial}`);
  console.log(`  B. chosen == baselineBestKind:        ${agg.chosenEqualsBaseline}`);
  console.log(`  C. chosen == neither:                 ${agg.chosenEqualsNeither}`);
  console.log(`  avg score gap (special#1 - baseline#1) = ${fmt(agg.scoreGapSum / Math.max(1, agg.scoreGapCount), 3)} (n=${agg.scoreGapCount})`);
  console.log(
    `  avg shanten diff=${fmt(agg.shantenDiffSum / Math.max(1, agg.diffSampleCount), 3)} avg ukeire diff=${fmt(
      agg.ukeireDiffSum / Math.max(1, agg.diffSampleCount),
      3
    )} avg danger diff=${fmt(agg.dangerDiffSum / Math.max(1, agg.diffSampleCount), 3)} (n=${agg.diffSampleCount})`
  );
  console.log(`  special-adjusted winner was isolated: ${agg.specialIsIsolatedCount}/${agg.diffSampleCount}`);
  console.log(`  avg turn-of-change=${fmt(agg.turnSum / Math.max(1, agg.turnCount), 2)}`);
  console.log(`  attribution: shape-only=${agg.shapeOnlyCount} contamination-only=${agg.contaminationOnlyCount} both/ambiguous=${agg.bothOrAmbiguousCount}`);
}

main();
