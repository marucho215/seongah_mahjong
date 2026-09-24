/* Minimal, opt-in kifu/replay writer for simulation runs. Reuses GameState's existing
 * event log (GameLog.ts) and aiDecisionLog verbatim - does not reinterpret or duplicate
 * any rule logic. One JSON file per game (simpler and more crash-safe than a shared
 * JSONL file for a run that may be interrupted partway through). */
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameState, FinalStanding } from "../core/GameState.js";
import type { GameEvent, AiDecisionEntry } from "../core/GameLog.js";
import type { HumanDecisionEntry } from "../core/humanDecisionLog.js";
import type { RuleConfig } from "../rules/RuleConfig.js";

/** This file lives at <project root>/src/sim/replayRecorder.ts, so two levels up from
 *  its own location is always the project root - regardless of the process's current
 *  working directory at invocation time. A bare relative dir like "replays" previously
 *  resolved against `process.cwd()`, which silently wrote (or "wrote" - no error either
 *  way) to a different, unexpected location whenever the script was launched from
 *  somewhere other than the project root: same console output, same "success", replay
 *  files just not where anyone was looking for them. Anchoring to the module's own
 *  location instead makes the output location invocation-cwd-independent. */
const PROJECT_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export function resolveReplayDir(dir: string): string {
  return isAbsolute(dir) ? dir : join(PROJECT_ROOT, dir);
}

export interface ReplaySeatInfo {
  seat: number;
  /** 이 좌석을 누가 조종했는가 (GameState.controllers). 캐릭터 정체성(characterId)과는 별개다. */
  kind: "characterAI" | "simpleAI" | "human" | "customAI";
  characterId?: string;
}

/** GameState의 controllers/characterProfiles에서 리플레이용 좌석 정보를 만든다 (사람 대국용). */
export function replaySeatsFromGame(gs: GameState): ReplaySeatInfo[] {
  return gs.controllers.map((kind, seat) => {
    const characterId = gs.characterProfiles[seat]?.characterId;
    return { seat, kind, ...(characterId ? { characterId } : {}) };
  });
}

export interface GameReplayRecord {
  /** Everything needed to reconstruct `new GameState({ rules, seed: gameSeed, characterProfiles })`
   *  and reproduce this exact game (GameState's own determinism is already covered by
   *  tests/characterAI.test.ts's "determinism with character profiles" test). */
  meta: {
    /** Absent on records written before Schema v2 - treat as 1 (`?? 1`) when reading.
     *  v2 adds `AuditableWinResult.doraBreakdown`/`.snapshot` and the
     *  "dora_indicator_revealed" event; nothing existing was removed or renamed. */
    replaySchemaVersion: 2;
    simulationLabel: string;
    gameIndex: number;
    gameSeed: string;
    rules: RuleConfig;
    seats: ReplaySeatInfo[];
  };
  /** The engine's own rule-accurate event log, verbatim and in chronological order -
   *  haipai, every draw/discard/riichi/call/kan/kita/win/exhaustive-draw/hand-end event. */
  events: GameEvent[];
  /** CharacterAI decision-debug entries, kept separate from the rule events above. */
  aiDecisions: AiDecisionEntry[];
  /** 사람이 내린 결정 기록. 사람 좌석이 있는 대국에만 존재하는 선택 필드다 (v2 유지, AI-only 리플레이에는 없음). */
  humanDecisions?: HumanDecisionEntry[];
  finalStandings: FinalStanding[];
}

export function buildGameReplayRecord(
  gs: GameState,
  simulationLabel: string,
  gameIndex: number,
  seats: ReplaySeatInfo[]
): GameReplayRecord {
  return {
    meta: { replaySchemaVersion: 2, simulationLabel, gameIndex, gameSeed: gs.baseSeed, rules: gs.rules, seats },
    events: gs.log,
    aiDecisions: gs.aiDecisionLog,
    ...(gs.controllers.includes("human") ? { humanDecisions: gs.humanDecisionLog } : {}),
    finalStandings: gs.computeFinalStandings(),
  };
}

/** Writes one game's replay to `<dir>/<simulationLabel>_game<gameIndex>.json`, where a
 *  non-absolute `dir` resolves against the project root (see PROJECT_ROOT above), not
 *  the process's current working directory. Creates `dir` if it doesn't exist yet. Only
 *  ever called when replay-saving is opted into - callers should skip building/calling
 *  this entirely when the flag is off, so a plain (non-saving) run pays no extra cost.
 *  Returns the absolute path actually written to. */
export function writeGameReplay(record: GameReplayRecord, dir: string): string {
  const resolvedDir = resolveReplayDir(dir);
  mkdirSync(resolvedDir, { recursive: true });
  const fileName = `${record.meta.simulationLabel}_game${record.meta.gameIndex}.json`;
  const filePath = join(resolvedDir, fileName);
  writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
  return filePath;
}
