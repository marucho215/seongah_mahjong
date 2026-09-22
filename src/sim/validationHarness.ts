/* Mass self-play validation harness (not part of the automated test suite - run via
 * `npm run validate -- --games N [--seed S] [--save-failures] [--format sanma|yonma]`).
 *
 * Reuses the existing GameState engine, deterministic seed system, and replay recorder
 * verbatim - this script adds observation and invariant-checking, never new game logic.
 * A run never mutates GameState; every check operates on the finished event log.
 */
import { GameState } from "../core/GameState.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../rules/RuleConfig.js";
import { CHARACTER_PROFILES } from "../ai/characterProfiles.js";
import type { CharacterProfile } from "../ai/characterProfile.js";
import { SeededRng } from "../core/rng.js";
import { collectAllInvariantViolations, type Violation } from "../validation/invariants.js";
import { emptyEventCoverage, accumulateEventCoverage, type EventCoverage } from "../validation/eventCoverage.js";
import { buildGameReplayRecord, writeGameReplay, resolveReplayDir, type ReplaySeatInfo } from "./replayRecorder.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  return idx !== -1 ? argv[idx + 1] : undefined;
}
function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

const ARGV = process.argv.slice(2);
const GAMES = Number(parseFlag(ARGV, "games") ?? 100);
const MASTER_SEED = parseFlag(ARGV, "seed") ?? "validate";
const SAVE_FAILURES = hasFlag(ARGV, "save-failures");
const FORMAT = (parseFlag(ARGV, "format") ?? "sanma") as "sanma" | "yonma";
const RULES = FORMAT === "yonma" ? MAJSOUL_YONMA_RULES : DEFAULT_SANMA_RULES;

const ALL_CHARACTER_IDS = Object.keys(CHARACTER_PROFILES);

/** Deterministic roster selection: one running RNG stream keyed by the master seed, NOT
 *  reset per game, so the whole run's roster sequence is reproducible from (seed, games)
 *  alone. ~15% of games deliberately reuse the immediately preceding roster (section 19's
 *  "repeated roster" requirement) instead of always sampling fresh. */
function makeRosterPicker(masterSeed: string, playerCount: number): () => string[] {
  const rng = new SeededRng(`${masterSeed}::roster`);
  let previous: string[] | null = null;
  return () => {
    if (previous && rng.next() < 0.15) return previous;
    const pool = [...ALL_CHARACTER_IDS];
    const roster: string[] = [];
    for (let i = 0; i < playerCount; i++) {
      const idx = rng.nextInt(pool.length);
      roster.push(pool[idx]!);
      pool.splice(idx, 1);
    }
    previous = roster;
    return roster;
  };
}

interface GameFailure {
  kind: "invariant" | "crash" | "determinism";
  gameIndex: number;
  gameSeed: string;
  roster: string[];
  violations?: Violation[];
  error?: string;
}

function summarizeViolationsByCategory(violations: Violation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of violations) out[v.category] = (out[v.category] ?? 0) + 1;
  return out;
}

function saveFailureArtifacts(failure: GameFailure, gs: GameState | null, seats: ReplaySeatInfo[]): string[] {
  const dir = resolveReplayDir(join("validation-failures", `seed-${failure.gameSeed.replace(/[^a-zA-Z0-9_-]/g, "_")}-game-${failure.gameIndex}`));
  mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  const failurePath = join(dir, "failure.json");
  writeFileSync(failurePath, JSON.stringify(failure, null, 2), "utf-8");
  paths.push(failurePath);
  if (gs) {
    const record = buildGameReplayRecord(gs, failure.gameSeed, failure.gameIndex, seats);
    const replayPath = join(dir, "replay.json");
    writeFileSync(replayPath, JSON.stringify(record, null, 2), "utf-8");
    paths.push(replayPath);
  }
  return paths;
}

function runOneGame(gameSeed: string, roster: string[]): { gs: GameState; error?: string } {
  const profiles: (CharacterProfile | null)[] = roster.map((id) => CHARACTER_PROFILES[id]!);
  const gs = new GameState({ rules: RULES, seed: gameSeed, characterProfiles: profiles });
  try {
    gs.playGame();
    return { gs };
  } catch (err) {
    return { gs, error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) };
  }
}

function runPhase(phaseLabel: string, games: number, startIndex: number): {
  coverage: EventCoverage;
  failures: GameFailure[];
  gamesRun: number;
  invariantFailureCount: number;
  crashCount: number;
} {
  const coverage = emptyEventCoverage();
  const failures: GameFailure[] = [];
  const pickRoster = makeRosterPicker(MASTER_SEED, RULES.playerCount);
  let invariantFailureCount = 0;
  let crashCount = 0;
  let gamesRun = 0;

  console.log(`\n=== ${phaseLabel}: ${games} games (format=${FORMAT}, master seed="${MASTER_SEED}") ===`);
  const t0 = Date.now();

  for (let i = 0; i < games; i++) {
    const gameIndex = startIndex + i;
    const gameSeed = `${MASTER_SEED}::game${gameIndex}`;
    const roster = pickRoster();
    const seats: ReplaySeatInfo[] = roster.map((id, seat) => ({ seat, kind: "characterAI", characterId: id }));

    const { gs, error } = runOneGame(gameSeed, roster);
    gamesRun++;

    if (error) {
      crashCount++;
      const failure: GameFailure = { kind: "crash", gameIndex, gameSeed, roster, error };
      failures.push(failure);
      if (SAVE_FAILURES) saveFailureArtifacts(failure, gs, seats);
      continue; // state after a crash can't be trusted further - move to the next seed
    }

    accumulateEventCoverage(coverage, gs.log);
    const violations = collectAllInvariantViolations({ rules: RULES, events: gs.log });
    if (violations.length > 0) {
      invariantFailureCount++;
      const failure: GameFailure = { kind: "invariant", gameIndex, gameSeed, roster, violations };
      failures.push(failure);
      if (SAVE_FAILURES) saveFailureArtifacts(failure, gs, seats);
    }

    if ((i + 1) % Math.max(1, Math.floor(games / 10)) === 0) {
      console.log(`  ...${i + 1}/${games} (${Date.now() - t0}ms elapsed)`);
    }
  }

  console.log(`${phaseLabel} done: ${gamesRun} games in ${Date.now() - t0}ms, ${invariantFailureCount} invariant failures, ${crashCount} crashes`);
  return { coverage, failures, gamesRun, invariantFailureCount, crashCount };
}

function mergeCoverage(a: EventCoverage, b: EventCoverage): EventCoverage {
  const merged: EventCoverage = { ...a, abortiveByReason: { ...a.abortiveByReason } };
  for (const key of Object.keys(a) as (keyof EventCoverage)[]) {
    if (key === "abortiveByReason") continue;
    (merged[key] as number) = (a[key] as number) + (b[key] as number);
  }
  for (const [reason, count] of Object.entries(b.abortiveByReason)) {
    merged.abortiveByReason[reason] = (merged.abortiveByReason[reason] ?? 0) + count;
  }
  return merged;
}

function runDeterminismCheck(sampleCount: number): { checked: number; mismatches: string[] } {
  console.log(`\n=== Determinism check: ${sampleCount} seeds, each run twice with identical roster/config ===`);
  const pickRoster = makeRosterPicker(`${MASTER_SEED}::determinism`, RULES.playerCount);
  const mismatches: string[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const gameSeed = `${MASTER_SEED}::determinism::game${i}`;
    const roster = pickRoster();
    const a = runOneGame(gameSeed, roster);
    const b = runOneGame(gameSeed, roster);
    if (a.error || b.error) {
      mismatches.push(`${gameSeed}: one or both runs threw (a=${a.error ?? "ok"}, b=${b.error ?? "ok"})`);
      continue;
    }
    const logA = JSON.stringify(a.gs.log);
    const logB = JSON.stringify(b.gs.log);
    const aiA = JSON.stringify(a.gs.aiDecisionLog);
    const aiB = JSON.stringify(b.gs.aiDecisionLog);
    const scoresA = JSON.stringify(a.gs.scores);
    const scoresB = JSON.stringify(b.gs.scores);
    if (logA !== logB || aiA !== aiB || scoresA !== scoresB) {
      mismatches.push(`${gameSeed}: event log, AI decision log, or final scores differ between two identical-input runs`);
    }
  }
  console.log(`Determinism check done: ${sampleCount} seeds checked, ${mismatches.length} mismatches`);
  return { checked: sampleCount, mismatches };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const overallCoverage = emptyEventCoverage();
const allFailures: GameFailure[] = [];
let totalGamesRun = 0;
let totalInvariantFailures = 0;
let totalCrashes = 0;

const result = runPhase("Self-play", GAMES, 0);
Object.assign(overallCoverage, mergeCoverage(overallCoverage, result.coverage));
allFailures.push(...result.failures);
totalGamesRun += result.gamesRun;
totalInvariantFailures += result.invariantFailureCount;
totalCrashes += result.crashCount;

const determinism = runDeterminismCheck(Math.min(10, GAMES));

console.log("\n=== Event coverage ===");
console.log(JSON.stringify(overallCoverage, null, 2));

console.log("\n=== Summary ===");
console.log(`Games run: ${totalGamesRun}`);
console.log(`Invariant failures: ${totalInvariantFailures}`);
console.log(`Crashes: ${totalCrashes}`);
console.log(`Determinism mismatches: ${determinism.mismatches.length}/${determinism.checked}`);
if (allFailures.length > 0) {
  const byCategory: Record<string, number> = {};
  for (const f of allFailures) {
    if (f.violations) {
      for (const [cat, count] of Object.entries(summarizeViolationsByCategory(f.violations))) {
        byCategory[cat] = (byCategory[cat] ?? 0) + count;
      }
    }
    if (f.kind === "crash") byCategory["crash"] = (byCategory["crash"] ?? 0) + 1;
  }
  console.log("Failure categories:", JSON.stringify(byCategory, null, 2));
}
if (SAVE_FAILURES && allFailures.length > 0) {
  console.log(`Failure artifacts saved under: ${resolveReplayDir("validation-failures")}`);
}

process.exitCode = totalInvariantFailures > 0 || totalCrashes > 0 || determinism.mismatches.length > 0 ? 1 : 0;
