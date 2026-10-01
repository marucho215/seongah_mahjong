/* Factory extracted from server.ts so tests can start/stop a real instance on an ephemeral
 * port without spawning a subprocess - see tests/guiServer.test.ts. server.ts (the `npm run
 * play:gui` entry point) just calls this and listens; no behavior lives only in server.ts. */
import { createServer, type Server } from "node:http";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameState } from "../core/GameState.js";
import type { GuiSession, GuiSessionPhase, WatchFrame } from "./guiSession.js";
import type { GameEvent } from "../core/GameLog.js";
import { InlineEngineRunner, gameFromSpec, runAiWatchGame, type AiWatchSpec, type EngineRunner, type EngineSnapshot, type EngineStart, type GameSpec, type OpponentSpec } from "./engineRunner.js";
import type { EngineWorkerPool } from "./engineWorkerPool.js";
import { AudioCueTracker, toPublicAction, type AudioCue, type PublicAction } from "./audioCues.js";
import type { DecisionResponse, SeatDecisionRequest, SeatDecisionResponse } from "../core/decisions.js";
import { replayFileNamePart, resolveReplayDir, writeGameReplay, type GameReplayRecord } from "../sim/replayRecorder.js";
import { aggregateWatchStats, summarizeWatchGame, type WatchGameSummary } from "../sim/watchStats.js";
import { reproduceReplay, type ReplayReproduction } from "../replay/replayReproduction.js";
import { getCharacterProfile } from "../ai/characterProfiles.js";
import { buildCharacterRoster } from "./characterRoster.js";
import { DEFAULT_PLAYBACK_SPEED, PLAYBACK_FRAME_DELAY_MS, parsePlaybackSpeed } from "./playbackSpeed.js";
import {
  DEFAULT_OPPONENTS,
  DEFAULT_WATCH_SEATS,
  parseAiWatchBatchConfig,
  parseAiWatchConfig,
  parseGuiGameConfig,
  parseGuiMode,
  playerCountOf,
  type AiWatchBatchConfig,
  type AiWatchConfig,
  type GuiGameConfig,
  type GuiGameMode,
} from "./gameSetup.js";
import { CustomAiStore } from "../customai/customAiStore.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../rules/RuleConfig.js";
import {
  CUSTOM_AI_CHARACTER_PREFIX,
  CUSTOM_AI_FIELDS,
  CUSTOM_AI_NAME_MAX,
  SLIDER_MAX,
  SLIDER_MIN,
  customAiCharacterId,
  customAiNotices,
  customAiToProfile,
  isCustomAiCharacterId,
} from "../customai/customAiSchema.js";
import type { CharacterProfile } from "../ai/characterProfile.js";
import { AccessError, AccessGate } from "./accessGate.js";
import { substituteResponse } from "./substitute.js";
import { DEFAULT_THINKING_TIME, FriendRoomError, FriendRoomStore, THINKING_TIME_OPTIONS, parseThinkingTime, type FriendRoom } from "./friendRooms.js";

export const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

/** The frontend files that change constantly during development are never cached, so a normal
 *  reload always shows the current UI. Tile SVGs and other static assets are left cacheable. */
const NO_STORE_FILES = new Set(["/index.html", "/app.js", "/audioManager.js", "/style.css", "/replay.html", "/replay.js", "/join.html", "/join.js"]);

/** 입장 게이트가 켜져 있을 때 입장 전에도 열리는 경로 (입장 화면과 그 스타일). */
const JOIN_PUBLIC_PATHS = new Set(["/join.html", "/join.js", "/style.css"]);
/** 입장 전이면 입장 화면으로 보내는 페이지 (그 밖의 경로는 401). */
const GATED_PAGES = new Set(["/", "/index.html", "/replay.html"]);

/** 리플레이 뷰어가 여는 파일 이름: 폴더 밖을 가리킬 수 없는 단순한 이름만 허용한다. */
const REPLAY_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

/** 리플레이 좌석의 표시 이름: 캐릭터 이름, 사람이면 "플레이어", 캐릭터가 없는 AI면 종류. */
function replaySeatName(seat: { kind: string; characterId?: string; customProfile?: { displayName?: unknown }; nickname?: unknown }): string {
  if (typeof seat.nickname === "string" && seat.nickname) return seat.nickname; // 친선전 사람 좌석
  // CustomAI 좌석은 기록에 남은 그 대국의 프로필 이름을 쓴다 (characterId "custom:<id>"는 등록 캐릭터 표에 없다)
  if (typeof seat.customProfile?.displayName === "string") return seat.customProfile.displayName;
  if (seat.characterId) {
    try {
      return getCharacterProfile(seat.characterId).displayName;
    } catch {
      return seat.characterId;
    }
  }
  return seat.kind === "human" ? "플레이어" : seat.kind;
}

export interface GuiServerHandle {
  server: Server;
  session: GuiSession;
}

export interface GuiServerOptions {
  /** 지정하면 게임이 끝날 때(game_end) 이 대국의 리플레이 JSON을 기존 AI 리플레이와 같은 형식/규칙으로 한 번 저장한다.
   *  파일: <dir>/<label>_game0.json (dir 기본 "replays" = 프로젝트 루트 기준). 서버가 게임 도중 종료되면 저장되지 않는다. */
  replay?: {
    label: string;
    dir?: string;
    onSaved?: (path: string) => void;
    /** 같은 파일을 더 저장할 폴더들 (친선전: 다른 참가자의 리플레이 폴더) */
    alsoDirs?: string[];
    /** 사람 좌석의 닉네임 (친선전, meta.seats[].nickname으로 남긴다) */
    seatNames?: (string | null)[];
  };
  /** 일반 타패 한 장면을 보여주는 기본 시간(ms). 울기/리치/화료는 이것의 배수만큼 더 오래 보여준다.
   *  0이면 장면 재생 없이 곧바로 다음 상태만 보낸다. 클라이언트가 POST /speed로 바꿀 수 있다. */
  frameDelayMs?: number;
}

export const DEFAULT_FRAME_DELAY_MS = PLAYBACK_FRAME_DELAY_MS[DEFAULT_PLAYBACK_SPEED];

/** 장면 종류별 유지 시간 배수: 타패 x1 / 울기·북 x1.5 / 리치 x2.2 / 쯔모 x2.5 / 론 x3 (론은 결과창 전에 충분히 보여준다). */
function holdMultiplier(actions: PublicAction[]): number {
  const kinds = new Set(actions.map((a) => a.action));
  if (kinds.has("ron")) return 3;
  if (kinds.has("tsumo")) return 2.5;
  if (kinds.has("riichi")) return 2.2;
  if (kinds.has("chi") || kinds.has("pon") || kinds.has("kan") || kinds.has("kita")) return 1.5;
  return 1;
}

/** 한 게임을 엔진 실행기(engineRunner.ts - 같은 스레드 또는 worker)로 진행하며 SSE 메시지를 만든다. HTTP 서버는 이것을 게임마다
 *  새로 만든다. 엔진 상태는 실행기가 돌려준 스냅샷으로만 알며, 로그는 받은 이벤트를 이어 붙인 사본을 쓴다(인덱스는 원본과 같다).
 *  메시지 받는 쪽(viewer):
 *  - null: 대국의 모든 사람 좌석 사용자가 같은 메시지를 받는다 (사람 1명 대국, 사람끼리 대국 모드가 아닌 대국 - 지금까지와 같음).
 *  - 좌석 번호: 사람끼리 대국 모드. 좌석마다 자기 요청(없으면 "waiting")과 자기 시점의 장면만 받는다. */
interface GameHost {
  /** 같은 스레드에서 도는 대국이면 그 세션 (테스트/직접 게임용), worker면 null */
  session: GuiSession | null;
  /** 사람끼리 대국 모드 (좌석마다 메시지를 따로 만든다) */
  multiplayer: boolean;
  phase(): GuiSessionPhase;
  connectMessage(viewer: number | null): string;
  /** 장면 재생 중이거나 엔진이 응답을 처리하는 중 */
  isPlaying(): boolean;
  /** 지금 답해야 하는 좌석들 (결정 대기가 아니면 빈 배열) */
  pendingSeats(): number[];
  respond(response: SeatDecisionResponse, seat?: number): Promise<void>;
  continueToNextHand(): Promise<void>;
  /** 친선전: 좌석을 자리 비움으로 두거나(중립 AI가 대신 둔다) 되돌린다. 친선전 대국이 아니면 아무것도 하지 않는다. */
  setAway(seat: number, away: boolean): void;
  /** 대국 그만두기: 이후 이 호스트는 아무 메시지도 보내지 않는다 (재생 중이던 장면 타이머 포함). 리플레이는 저장하지 않는다. */
  dispose(): void;
}

/** 시작한 대국의 구성. `friendRoom`: 친선전 방에서 시작한 대국 (종료 화면은 "다시 하기" 대신 방으로 돌아간다) */
export type StartedGameConfig = GuiGameConfig & { seed: string; friendRoom?: true };

/** 같은 순간(같은 행동 좌석, 같은 로그 위치)에 사람 좌석마다 만들어진 장면들을 한 묶음으로 모은다 (사람이 1명이면 장면 하나씩). */
function groupFrames(frames: WatchFrame[]): WatchFrame[][] {
  const moments: WatchFrame[][] = [];
  for (const frame of frames) {
    const last = moments.at(-1);
    if (last && last[0]!.actor === frame.actor && last[0]!.logLength === frame.logLength && !last.some((f) => f.view.seat === frame.view.seat)) last.push(frame);
    else moments.push([frame]);
  }
  return moments;
}

interface GameHostOptions {
  /** 사람 좌석의 표시 이름 (친선전: 닉네임). 없으면 엔진의 캐릭터 이름(사람 좌석은 null)을 그대로 쓴다. */
  humanNames?: (string | null)[];
  /** 사람끼리 대국에서 대국을 끝낼(그만둘) 수 있는 좌석 (방장). 없으면 모든 좌석이 startedConfig 규칙을 따른다. */
  abandonSeat?: number;
  /** 친선전 시간 제한(C단계): 한 수마다 perTurnMs, 넘기면 국마다 새로 채워지는 여유 bankMs를 쓴다. 다 쓰면 중립 AI가 그 결정을
   *  대신 내리고(substitute.ts), 두 번 연속이면 자리 비움이 된다. 주면 자리 비움(setAway)도 켜진다. */
  timeLimit?: { perTurnMs: number; bankMs: number };
  /** 자리 비움 좌석을 대신 둘 때 기다리는 시간 (기본 AWAY_ANSWER_DELAY_MS) */
  awayAnswerDelayMs?: number;
}

/** 연속으로 시간을 다 쓰면 자리 비움이 되는 횟수 */
const AWAY_AFTER_TIMEOUTS = 2;
/** 자리 비움 좌석을 대신 둘 때 기다리는 시간 (화면이 바뀌는 것을 볼 수 있게) */
const AWAY_ANSWER_DELAY_MS = 400;

/** 대국마다 새 번호. 메시지의 `gameId`로 보내 클라이언트가 새 대국을 알아채게 한다 (효과음 seq가 새 대국에서 1부터 다시 매겨지므로). */
let nextGameId = 1;

/** `startedConfig`: 시작 화면이 있는 서버에서 시작한 대국이면 그 구성. 있으면 종료 화면에 새 대국/다시 하기 버튼이 나온다. */
/** `frameDelayMs`: 재생 속도 설정. 장면마다 새로 읽는다 (재생 중에 바꾸면 다음 장면부터 적용). */
function createGameHost(
  runner: EngineRunner,
  start: EngineStart,
  options: GuiServerOptions,
  deliver: (viewer: number | null, payload: string) => void,
  startedConfig: StartedGameConfig | null,
  frameDelayMs: () => number,
  hostOptions: GameHostOptions = {}
): GameHost {
  const multiplayer = start.multiplayer;
  const gameId = nextGameId++;
  /** 메시지 받는 쪽들: 사람끼리 대국이면 사람 좌석마다, 아니면 null 하나 (모두 같은 메시지) */
  const viewers: (number | null)[] = multiplayer ? start.controllers.flatMap((c, seat) => (c === "human" ? [seat] : [])) : [null];
  const keyOf = (viewer: number | null): number => viewer ?? -1;

  // --- 친선전 시간 제한과 자리 비움 (C단계). timeLimit이 없으면(로비 대국 등) 아무것도 하지 않는다. ---
  const timeLimit = hostOptions.timeLimit ?? null;
  const humanSeats = start.controllers.flatMap((c, seat) => (c === "human" ? [seat] : []));
  const away = new Set<number>();
  const bankLeft = new Map<number, number>();
  const consecutiveTimeouts = new Map<number, number>();
  const resetBanks = (): void => {
    for (const seat of humanSeats) bankLeft.set(seat, timeLimit?.bankMs ?? 0);
  };
  resetBanks();
  /** 좌석마다 지금 걸린 시계 (같은 요청이 계속 대기 중이면 key가 같아 다시 시작하지 않는다) */
  const clocks = new Map<number, { key: string; timer: ReturnType<typeof setTimeout>; startedAt: number; deadline: number }>();
  let awayTimer: ReturnType<typeof setTimeout> | null = null;
  /** 엔진 로그 사본: 스냅샷의 newEvents를 순서대로 이어 붙인다. */
  const log: GameEvent[] = [];
  let snapshot: EngineSnapshot = start.initial;
  log.push(...snapshot.newEvents);
  /** 받는 쪽마다 가장 최근 장면(화료/유국 포함)의 view. 국/게임 종료 상태를 새로고침으로 다시 받을 때, 그리고 사람끼리 대국에서 자기
   *  차례가 아닐 때 작탁을 그 상태로 그리는 데 쓴다. 접속 전의 AI 턴은 재생하지 않는다. */
  const lastFrameView = new Map<number, WatchFrame["view"]>();
  const lastRequestView = new Map<number, WatchFrame["view"]>();
  const rememberFrames = (frames: WatchFrame[]): void => {
    for (const f of frames) lastFrameView.set(multiplayer ? f.view.seat : -1, f.view);
  };
  rememberFrames(snapshot.frames);
  let disposed = false;

  /** 시작 화면이 있는 서버에서 시작한 대국만 도중에 그만두고 로비로 돌아갈 수 있다. 사람끼리 대국은 정해진 좌석(방장)만. */
  const canAbandonFor = (viewer: number | null): boolean =>
    startedConfig !== null && (hostOptions.abandonSeat === undefined || viewer === hostOptions.abandonSeat);

  /** 스냅샷을 반영한다: 로그 사본에 이벤트를 붙이고 현재 상태를 바꾼다. 장면(frames)은 호출한 쪽이 쓴다. */
  function apply(next: EngineSnapshot): WatchFrame[] {
    log.push(...next.newEvents);
    snapshot = next;
    // 국이 새로 시작되면 여유 시간을 다시 채운다 (작혼과 같이 국마다)
    if (next.newEvents.some((ev) => ev.type === "hand_start")) resetBanks();
    return next.frames;
  }

  /** 지금 답해야 하는 좌석별 요청 */
  function currentPending(): SeatDecisionRequest[] {
    if (runner.session) return runner.session.pendingSeatRequests();
    return snapshot.phase === "decision" ? snapshot.pending : [];
  }
  /** 같은 대기 요청인지 가르는 값: 엔진 로그 위치 + 요청 종류 + 좌석 (여러 좌석 동시 묻기 중에는 로그가 그대로라 같은 값) */
  const clockKey = (request: SeatDecisionRequest): string => `${log.length}:${request.type}:${request.seat}`;

  function clearClock(seat: number): void {
    const clock = clocks.get(seat);
    if (clock) clearTimeout(clock.timer);
    clocks.delete(seat);
  }

  /** 대기 중인 좌석에 시계를 걸고, 자리 비움 좌석은 대신 둔다. 상태를 보내기 직전에 부른다. */
  function scheduleClocks(): void {
    if (!timeLimit || disposed) return;
    const pending = currentPending();
    for (const seat of [...clocks.keys()]) {
      const request = pending.find((r) => r.seat === seat);
      if (!request || clocks.get(seat)!.key !== clockKey(request)) clearClock(seat);
    }
    for (const request of pending) {
      const seat = request.seat;
      if (away.has(seat) || clocks.has(seat)) continue;
      const allowed = timeLimit.perTurnMs + (bankLeft.get(seat) ?? 0);
      const key = clockKey(request);
      const startedAt = Date.now();
      const timer = setTimeout(() => onTimeout(seat, key), allowed);
      timer.unref?.();
      clocks.set(seat, { key, timer, startedAt, deadline: startedAt + allowed });
    }
    // 사람이 모두 자리를 비웠으면 국 결과에서 기다리지 않고 다음 국으로 넘어간다 (한 명이라도 있으면 그 사람이 누른다)
    const phaseNow = runner.session?.getPhase() ?? snapshot.phase;
    if (phaseNow === "hand_end" && humanSeats.length > 0 && humanSeats.every((seat) => away.has(seat)) && !awayTimer) {
      awayTimer = setTimeout(() => {
        awayTimer = null;
        if (disposed || playing || busy || (runner.session?.getPhase() ?? snapshot.phase) !== "hand_end") return;
        void advance(() => runner.continueToNextHand()).catch(() => {});
      }, hostOptions.awayAnswerDelayMs ?? AWAY_ANSWER_DELAY_MS);
      awayTimer.unref?.();
    }
    if (pending.some((r) => away.has(r.seat)) && !awayTimer) {
      awayTimer = setTimeout(() => {
        awayTimer = null;
        answerAwaySeats();
      }, hostOptions.awayAnswerDelayMs ?? AWAY_ANSWER_DELAY_MS);
      awayTimer.unref?.();
    }
  }

  function answerAwaySeats(): void {
    if (disposed) return;
    if (playing || busy) return; // 진행이 끝나면 scheduleClocks가 다시 부른다
    for (const request of currentPending()) {
      if (away.has(request.seat)) void answerFor(request).catch(() => {});
    }
  }

  function onTimeout(seat: number, key: string): void {
    if (disposed) return;
    const request = currentPending().find((r) => r.seat === seat);
    if (!request || clockKey(request) !== key) return;
    if (playing || busy) {
      // 엔진이 다른 응답을 처리하는 중이면 잠깐 뒤에 다시 본다 (시계는 이미 다 됐다)
      const retry = setTimeout(() => onTimeout(seat, key), 200);
      retry.unref?.();
      return;
    }
    clocks.delete(seat);
    bankLeft.set(seat, 0);
    const count = (consecutiveTimeouts.get(seat) ?? 0) + 1;
    consecutiveTimeouts.set(seat, count);
    if (count >= AWAY_AFTER_TIMEOUTS) away.add(seat);
    void answerFor(request).catch(() => {});
  }

  /** 중립 AI가 이 요청에 대신 답한다 (사람 응답과 같은 경로라 사람 결정으로 기록된다) */
  function answerFor(request: SeatDecisionRequest): Promise<void> {
    return queueRespond(substituteResponse(request), request.seat);
  }

  /** 사람이 직접 답했다: 기본 시간을 넘겨 쓴 만큼 여유 시간에서 빼고, 연속 시간 초과와 자리 비움을 푼다 */
  function noteManualAnswer(seat: number): void {
    const clock = clocks.get(seat);
    if (clock && timeLimit) {
      const over = Math.max(0, Date.now() - clock.startedAt - timeLimit.perTurnMs);
      bankLeft.set(seat, Math.max(0, (bankLeft.get(seat) ?? 0) - over));
    }
    clearClock(seat);
    consecutiveTimeouts.set(seat, 0);
    away.delete(seat);
  }

  /** 메시지에 실을 자리 비움 좌석과, 받는 쪽 자신의 남은 시간 */
  function presenceFields(viewer: number | null): { awaySeats?: number[]; timer?: { remainingMs: number; perTurnMs: number; bankMs: number } } {
    if (!timeLimit) return {};
    const out: { awaySeats?: number[]; timer?: { remainingMs: number; perTurnMs: number; bankMs: number } } = { awaySeats: [...away].sort() };
    const seat = viewer ?? currentPending()[0]?.seat;
    const clock = seat === undefined ? undefined : clocks.get(seat);
    if (clock && seat !== undefined) {
      const elapsed = Date.now() - clock.startedAt;
      out.timer = {
        remainingMs: Math.max(0, clock.deadline - Date.now()),
        perTurnMs: Math.max(0, timeLimit.perTurnMs - elapsed),
        bankMs: Math.max(0, (bankLeft.get(seat) ?? 0) - Math.max(0, elapsed - timeLimit.perTurnMs)),
      };
    }
    return out;
  }

  let replaySaved = false;
  /** 저장한 리플레이 파일 이름 (종료 화면의 "리플레이 보기" 링크). 저장하지 않는 대국이면 null. */
  let savedReplayFile: string | null = null;
  async function saveReplayIfFinished(): Promise<void> {
    if (!options.replay || replaySaved || snapshot.phase !== "game_end") return;
    replaySaved = true;
    const record = await runner.replayRecord(options.replay.label);
    const names = options.replay.seatNames;
    if (names) for (const seatInfo of record.meta.seats) if (seatInfo.kind === "human" && names[seatInfo.seat]) seatInfo.nickname = names[seatInfo.seat]!;
    const path = writeGameReplay(record, options.replay.dir ?? "replays");
    savedReplayFile = basename(path);
    options.replay.onSaved?.(path);
    for (const dir of options.replay.alsoDirs ?? []) options.replay.onSaved?.(writeGameReplay(record, dir));
  }

  // Identity-only, presentation-layer detail: each seat's display name (or null when that seat has no
  // character profile) so the client never hardcodes a name and never confuses "who this seat is" with
  // "who controls it". 친선전에서는 사람 좌석에 닉네임을 넣는다.
  const characterNames: (string | null)[] = start.characterNames.map((name, seat) => hostOptions.humanNames?.[seat] ?? name);

  // 효과음 신호: 로그를 서버에서 공개 정보만 담은 AudioCue로 바꿔 보낸다 (audioCues.ts).
  // 접속 전에 이미 쌓인 신호는 "과거"이므로 다시 재생하지 않는다.
  const cueTracker = new AudioCueTracker(log);
  cueTracker.sync();
  let lastBroadcastSeq = cueTracker.latestSeq();

  /** 장면 재생 중에는 사람이 응답할 수 없다 (클라이언트는 아직 요청을 받지 못했다). */
  let playing = false;
  /** 엔진이 응답/다음 국을 처리하는 중 (worker 결과를 기다리는 동안) */
  let busy = false;
  /** 사람끼리 대국: 여러 사람의 응답을 받은 순서대로 하나씩 엔진에 넣는다 */
  let respondQueue: Promise<void> = Promise.resolve();
  /** 받는 쪽마다 재생 중인 마지막 장면 메시지 (재생 중에 접속하면 이것을 준다) */
  const lastWatchMessage = new Map<number, string>();
  /** 최근 행동 목록을 만들 때 어디까지 읽었는지 (로그 인덱스) */
  let actionLogIndex = log.length;

  function currentStateMessage(viewer: number | null, cueFields: { cues: AudioCue[]; cueBase?: number }): string {
    const extra = { gameId, ...cueFields };
    const key = keyOf(viewer);
    const phase = snapshot.phase;
    const canAbandon = canAbandonFor(viewer);
    // 종료 화면 뒤에 그릴 작탁: 마지막 장면, 없으면 마지막 결정 요청의 view (그 좌석 view라 숨은 정보가 없다)
    const view = lastFrameView.get(key) ?? lastRequestView.get(key);
    if (phase === "game_end") {
      // 순위는 엔진의 computeFinalStandings() 결과를 그대로 보낸다 (GUI가 따로 정렬하지 않는다).
      return JSON.stringify({
        type: "game_end",
        event: snapshot.gameEndEvent,
        handEvent: snapshot.handEndEvent,
        standings: snapshot.standings,
        characterNames,
        ...(view ? { view } : {}),
        canStartNewGame: startedConfig !== null,
        ...(startedConfig ? { gameConfig: startedConfig } : {}),
        ...(savedReplayFile ? { replayFile: savedReplayFile } : {}),
        // 친선전: 방장은 종료 화면에서 같은 멤버로 바로 다시 시작할 수 있다
        ...(startedConfig?.friendRoom ? { canRestartFriend: hostOptions.abandonSeat === undefined || viewer === hostOptions.abandonSeat } : {}),
        ...extra,
      });
    }
    if (phase === "hand_end") {
      return JSON.stringify({ type: "hand_end", event: snapshot.handEndEvent, ...(view ? { view } : {}), characterNames, canAbandon, ...presenceFields(viewer), ...extra });
    }
    if (viewer === null) {
      // 지금까지와 같다: 한 좌석의 요청을 모두에게 (사람끼리 대국 모드가 아니면 묶음 요청은 나오지 않는다)
      const request = snapshot.request?.type === "multi" ? null : snapshot.request;
      if (request) lastRequestView.set(key, request.view);
      return JSON.stringify({ type: "decision", request, characterNames, canAbandon, ...presenceFields(viewer), ...extra });
    }
    const mine = snapshot.pending.find((r) => r.seat === viewer);
    if (mine) {
      lastRequestView.set(key, mine.view);
      return JSON.stringify({ type: "decision", request: mine, characterNames, canAbandon, ...presenceFields(viewer), ...extra });
    }
    // 이 좌석은 지금 할 일이 없다 (다른 사람의 차례이거나, 이미 답하고 다른 사람을 기다리는 중)
    const waitingView = lastFrameView.get(key) ?? lastRequestView.get(key);
    return JSON.stringify({ type: "waiting", ...(waitingView ? { view: waitingView } : {}), waitingFor: snapshot.pending.map((r) => r.seat), characterNames, canAbandon, ...presenceFields(viewer), ...extra });
  }

  /** 새로 접속한 클라이언트: 과거 신호는 보내지 않고, 현재 seq만 기준점(cueBase)으로 알려준다. */
  function connectMessage(viewer: number | null): string {
    // 같은 스레드의 대국이 서버 밖에서 진행됐으면(테스트가 세션을 직접 조작한 경우) 그 장면은 새 접속에 재생하지 않되 마지막 상태로는 반영한다
    if (!playing && !busy) {
      const fresh = runner.pollSync();
      if (fresh) rememberFrames(apply(fresh));
    }
    cueTracker.sync();
    // 대국을 막 열었을 때 첫 요청은 이 메시지로 전달된다 - 시계도 여기서 건다 (같은 요청이면 다시 시작하지 않아 새로고침으로 시간이 늘지 않는다)
    if (!playing && !busy) scheduleClocks();
    // 재생 중에 접속하면 가장 최근 장면을 보여준다 (최종 상태는 재생이 끝난 뒤 보낸다).
    const watching = lastWatchMessage.get(keyOf(viewer));
    if (playing && watching) return watching;
    return currentStateMessage(viewer, { cues: [], cueBase: cueTracker.latestSeq() });
  }

  /** 한 순간(좌석마다의 장면 묶음)의 공개 정보를 한 번만 계산하고, 받는 쪽마다 자기 시점의 장면 메시지를 만든다. */
  function watchMessages(moment: WatchFrame[]): Map<number, string> {
    const { actor, logLength } = moment[0]!;
    cueTracker.sync();
    const upTo = cueTracker.seqThroughLogLength(logLength);
    const cues = cueTracker.cuesAfter(lastBroadcastSeq).filter((c) => c.seq <= upTo);
    if (upTo > lastBroadcastSeq) lastBroadcastSeq = upTo;
    // 이 장면 직전까지 새로 생긴 공개 행동들
    const actions: PublicAction[] = [];
    for (; actionLogIndex < logLength; actionLogIndex++) {
      const a = toPublicAction(log[actionLogIndex]!);
      if (a) actions.push(a);
    }
    // 방금 버려진 패의 주인 (론이면 방총자): 그 패를 강조하는 데 쓴다
    let latestDiscardSeat: number | null = null;
    for (let i = logLength - 1; i >= 0; i--) {
      const e = log[i]!;
      if (e.type === "discard") { latestDiscardSeat = e.player; break; }
      if (e.type === "hand_start") break;
    }
    lastHold = frameDelayMs() * holdMultiplier(actions);
    const out = new Map<number, string>();
    for (const viewer of viewers) {
      const frame = viewer === null ? moment[0]! : moment.find((f) => f.view.seat === viewer);
      if (!frame) continue;
      out.set(keyOf(viewer), JSON.stringify({ type: "watch", view: frame.view, actor, latestDiscardSeat, actions, characterNames, canAbandon: canAbandonFor(viewer), ...(timeLimit ? { awaySeats: [...away].sort() } : {}), gameId, cues }));
    }
    return out;
  }
  let lastHold = 0;

  /** 응답 처리 뒤 상태를 보낸다. 그 사이 AI 턴이 있었다면 한 수씩 간격을 두고 보여준 다음 최종 상태를 보낸다. */
  function broadcastAfterAction(frames: WatchFrame[]): void {
    rememberFrames(frames);
    if (frameDelayMs() <= 0 || frames.length === 0) {
      broadcastState();
      return;
    }
    const moments = groupFrames(frames);
    playing = true;
    let i = 0;
    const step = (): void => {
      if (disposed) return;
      if (i < moments.length) {
        const messages = watchMessages(moments[i++]!);
        for (const viewer of viewers) {
          const message = messages.get(keyOf(viewer));
          if (!message) continue;
          lastWatchMessage.set(keyOf(viewer), message);
          deliver(viewer, `data: ${message}\n\n`);
        }
        setTimeout(step, lastHold).unref();
      } else {
        playing = false;
        lastWatchMessage.clear();
        broadcastState();
      }
    };
    step();
  }

  function broadcastState(): void {
    if (disposed) return;
    cueTracker.sync();
    const cues = cueTracker.cuesAfter(lastBroadcastSeq);
    lastBroadcastSeq = cueTracker.latestSeq();
    cueTracker.discardThrough(lastBroadcastSeq);
    scheduleClocks();
    for (const viewer of viewers) deliver(viewer, `data: ${currentStateMessage(viewer, { cues })}\n\n`);
  }

  /** 응답을 엔진에 넣는다. 사람끼리 대국/친선전(시간 제한)은 여러 응답(대신 둔 것 포함)이 겹쳐도 거절하지 않고 받은 순서대로 넣는다. */
  function queueRespond(response: SeatDecisionResponse, seat?: number): Promise<void> {
    const seatForEngine = multiplayer ? seat : undefined;
    const run = (): Promise<void> => (disposed ? Promise.resolve() : advance(() => runner.respond(response, seatForEngine)));
    if (!multiplayer && !timeLimit) return run();
    const queued = respondQueue.then(run);
    respondQueue = queued.catch(() => {});
    return queued;
  }

  /** 엔진에 한 번 진행을 맡기고, 결과를 반영해 보낸다. */
  async function advance(run: () => Promise<EngineSnapshot>): Promise<void> {
    busy = true;
    let next: EngineSnapshot;
    try {
      next = await run();
    } finally {
      busy = false;
    }
    if (disposed) return;
    const frames = apply(next);
    await saveReplayIfFinished();
    if (disposed) return;
    broadcastAfterAction(frames);
  }

  return {
    session: runner.session,
    multiplayer,
    // 같은 스레드의 대국은 서버 밖(테스트)에서 진행될 수 있으므로 세션을 바로 읽는다. worker 대국은 마지막 스냅샷이 곧 현재 상태다.
    phase: () => runner.session?.getPhase() ?? snapshot.phase,
    connectMessage,
    isPlaying: () => playing || busy,
    pendingSeats: () => {
      if (runner.session) return runner.session.pendingSeatRequests().map((r) => r.seat);
      return snapshot.phase === "decision" ? snapshot.pending.map((r) => r.seat) : [];
    },
    respond(response, seat) {
      if (playing) return Promise.reject(new Error("GuiServer: 장면 재생 중에는 응답할 수 없습니다"));
      if (!multiplayer && !timeLimit && busy) return Promise.reject(new Error("GuiServer: 앞의 응답을 처리하는 중입니다"));
      const answering = seat ?? currentPending()[0]?.seat;
      if (answering !== undefined) noteManualAnswer(answering);
      return queueRespond(response, seat);
    },
    setAway(seat, isAway) {
      if (!timeLimit || disposed || !humanSeats.includes(seat) || away.has(seat) === isAway) return;
      if (isAway) away.add(seat);
      else {
        away.delete(seat);
        consecutiveTimeouts.set(seat, 0);
      }
      if (playing || busy) return; // 진행이 끝나면 새 상태와 함께 알린다
      broadcastState();
    },
    continueToNextHand() {
      // 사람끼리 대국: 국 결과에서 누구든 먼저 "다음 국"을 누르면 모두 함께 넘어간다. 거의 동시에 누른 뒤의 것은 조용히 무시한다.
      if (multiplayer && (playing || busy || (runner.session?.getPhase() ?? snapshot.phase) !== "hand_end")) return Promise.resolve();
      if (playing) return Promise.reject(new Error("GuiServer: 장면 재생 중에는 진행할 수 없습니다"));
      if (busy) return Promise.reject(new Error("GuiServer: 앞의 응답을 처리하는 중입니다"));
      return advance(() => runner.continueToNextHand());
    },
    dispose() {
      disposed = true;
      playing = false;
      for (const seat of [...clocks.keys()]) clearClock(seat);
      if (awayTimer) clearTimeout(awayTimer);
      runner.dispose();
    },
  };
}

/** 시작 화면(대국 설정)부터 여는 서버의 옵션. 설정 화면의 초기값과, 게임마다 쓸 리플레이 저장 위치를 받는다. */
export interface GuiLobbyOptions {
  frameDelayMs?: number;
  /** 시작 화면 초기값 (CLI 인자에서 온다). opponents를 생략하면 모드별 기본 상대. */
  defaults?: { mode?: GuiGameMode; seed?: string; saveReplays?: boolean; opponents?: Partial<Record<GuiGameMode, string[]>> };
  replayDir?: string;
  /** CustomAI 저장 폴더 (기본 "custom-ai", 프로젝트 루트 기준) */
  customAiDir?: string;
  onReplaySaved?: (path: string) => void;
  onGameStarted?: (config: StartedGameConfig, userId: string) => void;
  /** 온라인 입장 게이트. 지정하면 입장한 브라우저(공개 모드: 닉네임만, 비공개 모드: 초대 코드 + 닉네임)만 로비/대국/API를
   *  쓸 수 있고 사용자마다 로비/저장이 나뉜다 (accessGate.ts). 생략하면 입장 없이 로비 하나를 쓰는 로컬 모드다. */
  access?: AccessGate;
  /** 대국과 리플레이 재현을 돌릴 엔진 worker 풀 (engineWorkerPool.ts). 생략하면 같은 스레드에서 돌린다(테스트용).
   *  풀은 호출한 쪽이 만들고 닫는다. */
  engine?: EngineWorkerPool;
  /** 입장 게이트가 있을 때 사용자별 저장 폴더의 상위 폴더 (기본 "server-data/users"). 사용자마다 <폴더>/<사용자 id>/custom-ai,
   *  <폴더>/<사용자 id>/replays를 쓴다. 로컬 모드는 customAiDir/replayDir을 그대로 쓴다. */
  userDataDir?: string;
  /** 자원 제한 (온라인 서버용). 생략하면 제한 없음(로컬 모드). */
  limits?: ResourceLimits;
  /** 이벤트 연결 유지 신호 간격 (ms, 기본 SSE_HEARTBEAT_MS). 0이면 보내지 않는다. */
  heartbeatMs?: number;
  /** 친선전 시간 제한과 자리 비움 대행 간격에 곱하는 값 (기본 1, 테스트에서 줄인다) */
  friendTimeScale?: number;
  /** 친선전: 연결이 모두 끊긴 뒤 자리 비움으로 보기까지의 시간 (ms, 기본 PRESENCE_GRACE_MS) */
  presenceGraceMs?: number;
}

/** 이벤트 연결(SSE) 유지 신호 간격. 터널/프록시는 한동안 데이터가 없는 연결을 끊기도 하므로(흔히 60~100초),
 *  그보다 짧게 SSE 주석 줄(": ping")을 보낸다. 브라우저 EventSource는 주석 줄을 무시한다. */
export const SSE_HEARTBEAT_MS = 25_000;

/** 친선전: 이벤트 연결이 모두 끊긴 뒤 이만큼 지나도 돌아오지 않으면 자리 비움으로 본다 (새로고침은 이보다 빠르다) */
export const PRESENCE_GRACE_MS = 10_000;

/** 온라인 서버의 자원 제한 (1.2 4단계). */
export interface ResourceLimits {
  /** 서버 전체에서 동시에 열려 있는 대국 수 */
  maxOpenGames: number;
  /** 사용자의 요청이 이 시간 동안 없으면 그 사용자의 대국을 정리한다 (ms) */
  idleGameMs: number;
  /** 접속도 대국도 없는 로비를 메모리에서 지우기까지의 시간 (ms) */
  idleRoomMs: number;
  /** 사용자별 요청 빈도: 초당 채워지는 요청 수와 최대 연속 요청 수 */
  requestsPerSecond: number;
  requestBurst: number;
  /** 사용자별 동시 이벤트 연결(탭) 수 */
  maxStreamsPerUser: number;
  /** 사용자별 CustomAI 수 */
  maxCustomAisPerUser: number;
  /** 사용자별로 남겨 두는 리플레이 수 (넘으면 오래된 것부터 지운다) */
  maxReplaysPerUser: number;
}

export const ONLINE_LIMITS: ResourceLimits = {
  maxOpenGames: 8,
  idleGameMs: 30 * 60 * 1000,
  idleRoomMs: 60 * 60 * 1000,
  requestsPerSecond: 20,
  requestBurst: 40,
  maxStreamsPerUser: 5,
  maxCustomAisPerUser: 20,
  maxReplaysPerUser: 50,
};

/** 요청 본문 최대 크기 (모든 서버) */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export interface GuiLobbyServerHandle {
  server: Server;
  /** 사용자(기본: 로컬 모드의 유일한 사용자)가 앉아 있는 게임의 세션 (로비에 있으면 null) */
  getSession(userId?: string): GuiSession | null;
}

/** Builds (but does not start listening) an http.Server driving `game` via one GuiSession -
 *  one human seat, continuing across every hand of the game on the same GameState until
 *  GuiSession reaches "game_end" (see GuiSession's own doc comment for the phase model). */
export function createGuiServer(game: GameState, options: GuiServerOptions = {}): GuiServerHandle {
  const { server, getSession } = buildServer({ game, options }, null);
  return { server, session: getSession()! };
}

/** 시작 화면에서 모드/상대/시드를 고른 뒤 게임을 시작하고, 게임이 끝나면 다시 시작 화면으로 돌아갈 수 있는 서버. */
export function createGuiLobbyServer(options: GuiLobbyOptions = {}): GuiLobbyServerHandle {
  return buildServer(null, options);
}

/** 입장 게이트가 없는 서버(로컬 모드)의 유일한 사용자 id. */
export const LOCAL_USER_ID = "local";

type LobbySetup = {
  mode: GuiGameMode;
  opponents: Record<GuiGameMode, string[]>;
  /** AI 관전 좌석 (seat 0부터 전부 AI) */
  watchSeats: Record<GuiGameMode, string[]>;
  /** AI 관전 판 수(1이면 한 판 관전)와 여러 판일 때 판마다 리플레이 저장 여부 */
  watchGames: number;
  watchSaveReplays: boolean;
  seed: string;
  saveReplays: boolean;
};

/** 로비 설정 화면의 용도: 사람이 앉는 대국(play) 또는 AI끼리 관전(watch). */
type LobbyPurpose = "play" | "watch";

/** 한 사용자의 로비 (1.2 2단계). 로컬 모드에서는 서버에 하나(LOCAL_USER_ID)뿐이고, 입장 게이트가 있으면 입장한 사용자마다
 *  하나씩 생긴다. 같은 사용자의 새로고침/다른 탭은 같은 로비를 본다. 서로 다른 사용자의 로비와 대국은 섞이지 않는다. */
interface Room {
  userId: string;
  sseClients: Set<import("node:http").ServerResponse>;
  /** 로비 화면: 처음에는 모드를 고르는 허브, 모드를 고르면 그 모드의 대국 설정. */
  lobbyScreen: "hub" | "setup";
  /** 설정 화면이 사람 대국용인지 AI 관전용인지 (허브에서 고른 항목) */
  lobbyPurpose: LobbyPurpose;
  /** 시작 화면에 채워 둘 값: 처음에는 CLI 기본값, 한 판을 한 뒤에는 마지막으로 고른 구성 */
  lastSetup: LobbySetup;
  /** AI 진행 속도 (사용자 설정) */
  frameDelayMs: number;
  /** 이 사용자가 앉아 있는 대국. 없으면 로비. */
  table: Table | null;
  /** 엔진이 새 대국을 만드는 중 (worker 응답 대기) */
  starting: boolean;
  /** 이 사용자의 CustomAI 저장소 (로컬 모드는 서버 설정 폴더, 온라인은 사용자 폴더). 로비가 없는 서버면 null. */
  customAiStore: CustomAiStore | null;
  /** 이 사용자의 리플레이 폴더 */
  replayDir: string;
  /** 마지막으로 요청을 보낸 시각 (방치 정리 기준) */
  lastActivity: number;
  /** 요청 빈도 제한 토큰 */
  tokens: number;
  tokensAt: number;
  /** 로비에 한 번 보여줄 안내 (예: 방치된 대국 정리) */
  notice: string | null;
  /** AI 관전 여러 판 연속 실행 (진행 중이거나, 끝난 뒤 결과를 지우기 전까지 남는다) */
  watchBatch: WatchBatch | null;
}

/** AI 관전 여러 판 연속 실행 하나. 판은 한 번에 하나씩 엔진에서 끝까지 돌리고, 판이 끝날 때마다 요약만 남긴다
 *  (리플레이 전체는 저장 옵션을 켰을 때만 파일로 남긴다). 취소는 지금 도는 판이 끝난 뒤에 멈춘다. */
interface WatchBatch {
  id: number;
  config: AiWatchBatchConfig & { seed: string };
  /** 좌석별 표시 이름 (CustomAI는 시작 순간의 프로필 이름) */
  seatNames: string[];
  playerCount: number;
  status: "running" | "done" | "cancelled" | "failed";
  cancelRequested: boolean;
  results: WatchGameSummary[];
  error?: string;
}

/** 대국 하나. 사람 좌석마다 그 좌석을 가진 사용자가 연결된다 (seatUsers[seat], AI 좌석은 null).
 *  대국 메시지는 사람 좌석의 사용자들에게만 가고, 결정 응답은 그 결정을 요청받은 좌석의 사용자만 보낼 수 있다.
 *  1.2에서는 대국을 연 사용자 한 명이 사람 좌석을 모두 가진다. 사람끼리 대전은 좌석마다 다른 사용자를 앉히는 식으로 이 구조 위에 얹는다. */
interface Table {
  host: GameHost;
  seatUsers: (string | null)[];
}

function buildServer(initial: { game: GameState; options: GuiServerOptions } | null, lobby: GuiLobbyOptions | null): GuiLobbyServerHandle {

  const access = lobby?.access ?? null;
  const limits = lobby?.limits ?? null;
  // 리플레이 뷰어: 사용자가 리플레이를 저장하는 폴더를 그대로 읽는다. 로컬 모드는 기본 "replays"(프로젝트 루트 기준),
  // 입장 게이트가 있으면 사용자별 폴더.
  const localReplayDir = resolveReplayDir((initial ? initial.options.replay?.dir : lobby?.replayDir) ?? "replays");
  const userDataDir = resolve(lobby?.userDataDir ?? join("server-data", "users"));
  /** 재현은 한 판에 수 초 걸리므로 파일(경로+수정 시각)별로 결과를 캐시한다. */
  const reproductionCache = new Map<string, { mtimeMs: number; body: string }>();

  async function listReplays(replayDir: string): Promise<{ name: string; size: number; modified: number }[]> {
    let names: string[];
    try {
      names = await readdir(replayDir);
    } catch {
      return [];
    }
    const files = await Promise.all(
      names
        .filter((n) => REPLAY_FILE_NAME.test(n))
        .map(async (name) => {
          const st = await stat(join(replayDir, name));
          return { name, size: st.size, modified: st.mtimeMs };
        })
    );
    return files.sort((a, b) => b.modified - a.modified);
  }

  /** 사용자 폴더의 리플레이 파일 경로 (폴더 밖을 가리킬 수 없는 이름만) */
  function replayPath(replayDir: string, name: string): string {
    if (!REPLAY_FILE_NAME.test(name)) throw new Error("리플레이 파일 이름이 올바르지 않습니다");
    return join(replayDir, name);
  }

  async function replayBody(replayDir: string, name: string): Promise<string> {
    const filePath = replayPath(replayDir, name);
    const st = await stat(filePath);
    const cached = reproductionCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.body;
    const record = JSON.parse(await readFile(filePath, "utf-8")) as GameReplayRecord;
    const reproduction: ReplayReproduction = lobby?.engine ? await lobby.engine.reproduce(record) : reproduceReplay(record);
    const seats = Array.isArray(record.meta?.seats) ? record.meta.seats : [];
    const body = JSON.stringify({
      name,
      meta: record.meta ? { gameSeed: record.meta.gameSeed, rules: { playerCount: record.meta.rules?.playerCount }, replaySchemaVersion: record.meta.replaySchemaVersion ?? 1 } : null,
      seatNames: seats.map(replaySeatName),
      seatKinds: seats.map((s) => s.kind),
      reproduction,
    });
    reproductionCache.set(filePath, { mtimeMs: st.mtimeMs, body });
    return body;
  }

  const officialRoster = lobby ? buildCharacterRoster() : [];

  /** 시작 화면 목록: 등록 캐릭터 + 검증을 통과한 CustomAI (CustomAI에는 설명/태그를 자동으로 만들지 않는다). */
  function currentRoster(room: Room) {
    const customs = (room.customAiStore?.list() ?? []).flatMap((e) =>
      e.ok ? [{ characterId: customAiCharacterId(e.definition.id), displayName: e.definition.name, summary: "", tags: [] as string[], custom: true }] : []
    );
    return [...officialRoster, ...customs];
  }

  /** 대국 상대 id -> 프로필. CustomAI는 게임을 시작하는 순간 파일에서 읽어 검증한 값이 그 대국의 스냅샷이 된다. */
  function resolveOpponentProfile(room: Room, id: string): CharacterProfile {
    if (isCustomAiCharacterId(id)) {
      if (!room.customAiStore) throw new Error("이 서버에서는 CustomAI를 쓸 수 없습니다");
      return customAiToProfile(room.customAiStore.get(id.slice(CUSTOM_AI_CHARACTER_PREFIX.length)));
    }
    return getCharacterProfile(id);
  }
  /** 대국 상대 id -> 엔진에 넘길 구성. 등록 캐릭터는 id 그대로, CustomAI는 지금 파일에서 읽어 검증한 프로필이 그 대국의 스냅샷이 된다. */
  function opponentSpecOf(room: Room, id: string): OpponentSpec {
    return isCustomAiCharacterId(id) ? { profile: resolveOpponentProfile(room, id) } : { characterId: id };
  }

  const defaults = lobby?.defaults ?? {};
  const initialFrameDelayMs = (initial ? initial.options.frameDelayMs : lobby?.frameDelayMs) ?? DEFAULT_FRAME_DELAY_MS;

  const rooms = new Map<string, Room>();
  function roomOf(userId: string): Room {
    let room = rooms.get(userId);
    if (!room) {
      room = {
        userId,
        sseClients: new Set(),
        lobbyScreen: "hub",
        lobbyPurpose: "play",
        lastSetup: {
          mode: defaults.mode ?? "sanma",
          opponents: {
            sanma: [...(defaults.opponents?.sanma ?? DEFAULT_OPPONENTS.sanma)],
            yonma: [...(defaults.opponents?.yonma ?? DEFAULT_OPPONENTS.yonma)],
          },
          watchSeats: { sanma: [...DEFAULT_WATCH_SEATS.sanma], yonma: [...DEFAULT_WATCH_SEATS.yonma] },
          watchGames: 1,
          watchSaveReplays: false,
          seed: defaults.seed ?? "",
          saveReplays: defaults.saveReplays ?? false,
        },
        frameDelayMs: initialFrameDelayMs,
        table: null,
        starting: false,
        customAiStore: lobby ? new CustomAiStore(access ? join(userDataDir, userId, "custom-ai") : (lobby.customAiDir ?? "custom-ai")) : null,
        replayDir: access ? join(userDataDir, userId, "replays") : localReplayDir,
        lastActivity: Date.now(),
        tokens: limits?.requestBurst ?? 0,
        tokensAt: Date.now(),
        notice: null,
        watchBatch: null,
      };
      rooms.set(userId, room);
    }
    return room;
  }
  const sendToRoom = (room: Room, payload: string): void => {
    for (const res of room.sseClients) res.write(payload);
  };

  /** 대국을 만들고 사람 좌석에 사용자를 앉힌다. 로비 대국은 seat 0만 사람이고, 직접 만든 게임을 여는 createGuiServer는 사람 좌석이
   *  여럿일 수 있다(모두 대국을 연 사용자가 둔다). 친선전(사람끼리 대국)은 `seatUsers`로 좌석마다 다른 사용자를 앉힌다.
   *  메시지는 사람 좌석의 사용자 로비로만 가고, 사람끼리 대국이면 좌석마다 자기 것만 간다. */
  function openTable(
    room: Room,
    runner: EngineRunner,
    start: EngineStart,
    options: GuiServerOptions,
    startedConfig: StartedGameConfig | null,
    extra: { seatUsers?: (string | null)[]; hostOptions?: GameHostOptions } = {}
  ): Table {
    const seatUsers: (string | null)[] = extra.seatUsers ?? start.controllers.map((c) => (c === "human" ? room.userId : null));
    const deliver = (viewer: number | null, payload: string): void => {
      if (viewer !== null) {
        const userId = seatUsers[viewer];
        // 그 좌석 사용자가 아직 이 대국에 있을 때만 (먼저 방으로 돌아간 사람에게는 보내지 않는다)
        if (userId) {
          const member = roomOf(userId);
          if (member.table === table) sendToRoom(member, payload);
        }
        return;
      }
      for (const userId of new Set(seatUsers)) if (userId !== null) sendToRoom(roomOf(userId), payload);
    };
    // 재생 속도는 대국을 시작한 사용자의 설정을 장면마다 읽는다.
    const table: Table = { host: createGameHost(runner, start, options, deliver, startedConfig, () => room.frameDelayMs, extra.hostOptions), seatUsers };
    for (const userId of new Set(seatUsers)) {
      if (userId === null) continue;
      const member = roomOf(userId);
      leaveTable(member);
      member.table = table;
    }
    return table;
  }

  /** 사용자가 대국을 떠난다 (그만두기, 끝난 대국에서 로비로, 새 대국). 그 대국에 남은 사람이 없으면 대국을 버려 worker의 메모리도 비운다
   *  (사람끼리 대국은 여러 사용자가 같은 대국을 가리킨다). */
  function leaveTable(room: Room): void {
    const table = room.table;
    if (!table) return;
    room.table = null;
    const others = [...new Set(table.seatUsers)].some((userId) => userId !== null && userId !== room.userId && rooms.get(userId)?.table === table);
    if (!others) {
      table.host.dispose();
      return;
    }
    table.seatUsers.forEach((userId, seat) => {
      if (userId === room.userId) table.host.setAway(seat, true);
    });
  }

  /** 이 사용자가 대국에서 앉은 좌석 (사람끼리 대국의 메시지 받는 쪽). 사람끼리 대국이 아니면 null (모두 같은 메시지). */
  function viewerSeatOf(room: Room, table: Table): number | null {
    if (!table.host.multiplayer) return null;
    const seat = table.seatUsers.indexOf(room.userId);
    return seat >= 0 ? seat : null;
  }

  /** 친선전 자리 비움: 이 사용자가 앉은 좌석을 자리 비움으로 두거나 복귀시킨다 (친선전 대국이 아니면 GameHost가 무시한다) */
  function markPresence(room: Room, present: boolean): void {
    const table = room.table;
    if (!table) return;
    table.seatUsers.forEach((userId, seat) => {
      if (userId === room.userId) table.host.setAway(seat, !present);
    });
  }

  /** 대국 응답: 지금 결정을 요청받은 좌석의 사용자만 보낼 수 있다. 한 사용자가 여러 좌석을 두면(직접 만든 게임) `seat`로 고른다. */
  async function respondAt(room: Room, input: SeatDecisionResponse & { seat?: unknown }): Promise<void> {
    const table = room.table;
    if (!table) throw new Error("GuiServer: 진행 중인 게임이 없습니다");
    const { seat: wanted, ...response } = input;
    const pending = table.host.pendingSeats();
    if (pending.length === 0) return table.host.respond(response as SeatDecisionResponse); // 엔진이 거절한다 (지금 요청 없음)
    const mine = pending.filter((seat) => table.seatUsers[seat] === room.userId);
    if (mine.length === 0) throw new Error("GuiServer: 이 결정은 다른 좌석의 차례입니다");
    const seat = typeof wanted === "number" && mine.includes(wanted) ? wanted : mine[0]!;
    await table.host.respond(response as SeatDecisionResponse, table.host.multiplayer ? seat : undefined);
  }

  if (initial) {
    const { runner, start } = InlineEngineRunner.open(initial.game);
    openTable(roomOf(LOCAL_USER_ID), runner, start, initial.options, null);
  }

  function setupMessage(room: Room): string {
    const { lastSetup, lobbyScreen } = room;
    const roster = currentRoster(room);
    // 마지막 구성에 이제 없는 상대(삭제된 CustomAI 등)가 있으면 그 좌석만 기본 상대 중 남는 캐릭터로 바꿔 보여준다 (화면 초기값일 뿐).
    const known = new Set(roster.map((r) => r.characterId));
    const defaults = { ...lastSetup, opponents: { ...lastSetup.opponents }, watchSeats: { ...lastSetup.watchSeats } };
    const refill = (ids: readonly string[], fallback: readonly string[]): string[] => {
      const picked = ids.map((id) => (known.has(id) ? id : null));
      const spare = [...fallback, ...officialRoster.map((r) => r.characterId)].filter((id) => !picked.includes(id));
      return picked.map((id) => id ?? spare.shift()!);
    };
    for (const mode of ["sanma", "yonma"] as const) {
      defaults.opponents[mode] = refill(defaults.opponents[mode], DEFAULT_OPPONENTS[mode]);
      defaults.watchSeats[mode] = refill(defaults.watchSeats[mode], DEFAULT_WATCH_SEATS[mode]);
    }
    return JSON.stringify({
      type: "setup",
      screen: lobbyScreen,
      purpose: room.lobbyPurpose,
      // 친선전 (입장 게이트가 있는 서버만): 방 만들기 옵션과 지금 있는 방
      ...(friendRooms
        ? {
            friendRooms: { thinkingTimes: THINKING_TIME_OPTIONS.map((o) => o.id), defaultThinkingTime: DEFAULT_THINKING_TIME },
            friendRoom: friendRoomViewFor(room.userId),
          }
        : {}),
      mode: lastSetup.mode,
      ...(room.notice ? { notice: room.notice } : {}),
      ...(room.watchBatch ? { watchBatch: watchBatchView(room.watchBatch) } : {}),
      roster,
      playerCounts: { sanma: playerCountOf("sanma"), yonma: playerCountOf("yonma") },
      // 허브 카드에 보여줄 모드 차이: 규칙 설정(RuleConfig)에서 그대로 가져온다 (GUI가 규칙을 따로 적지 않는다).
      modes: (
        [
          ["sanma", DEFAULT_SANMA_RULES],
          ["yonma", MAJSOUL_YONMA_RULES],
        ] as const
      ).map(([mode, rules]) => ({
        mode,
        players: rules.playerCount,
        chi: !rules.chiForbidden,
        kita: rules.kitaEnabled,
        startingScore: rules.startingScore,
      })),
      defaults,
    });
  }

  function connectMessage(room: Room): string {
    return room.table ? room.table.host.connectMessage(viewerSeatOf(room, room.table)) : setupMessage(room);
  }

  /** 이 사용자가 진행 중인(끝나지 않았거나 장면 재생 중인) 대국에 앉아 있는지 */
  function inActiveGame(room: Room): boolean {
    if (room.starting) return true;
    const host = room.table?.host;
    return host !== undefined && (host.isPlaying() || host.phase() !== "game_end");
  }

  async function startGame(room: Room, config: GuiGameConfig, friend: { timeLimit: GameHostOptions["timeLimit"]; nickname: string } | null = null): Promise<void> {
    const fromFriendRoom = friend !== null;
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    if (inActiveGame(room)) throw new Error("GuiServer: 진행 중인 게임이 있습니다");
    assertNoWatchBatch(room);
    if (!fromFriendRoom) assertNotInFriendRoom(room);
    // 이 사용자의 끝난 대국은 새 대국으로 바뀌므로 세지 않는다
    if (limits && openGameCount() - (room.table ? 1 : 0) >= limits.maxOpenGames) {
      throw new Error(`지금은 서버에서 진행 중인 대국이 많습니다 (최대 ${limits.maxOpenGames}판). 잠시 뒤 다시 시도해 주세요`);
    }
    room.notice = null;
    const seed = config.seed ?? `gui-${Date.now()}`;
    room.lastSetup = {
      ...room.lastSetup,
      mode: config.mode,
      opponents: { ...room.lastSetup.opponents, [config.mode]: [...config.opponents] },
      seed: config.seed ?? "",
      saveReplays: config.saveReplays,
    };
    room.lobbyPurpose = "play"; // 끝난 뒤 "설정 바꾸기"는 사람 대국 설정 화면으로 돌아간다
    const spec: GameSpec = { mode: config.mode, seed, opponents: config.opponents.map((id) => opponentSpecOf(room, id)) };
    const options: GuiServerOptions = {
      ...(config.saveReplays
        ? {
            replay: {
              // 파일 이름에는 목록이 받는 문자만 쓴다 (시드는 기록 안에 원문 그대로 남는다)
              label: `${fromFriendRoom ? "friend" : "human"}-${config.mode}-${replayFileNamePart(seed)}`,
              dir: room.replayDir,
              ...(friend ? { seatNames: [friend.nickname] } : {}),
              onSaved: (path: string) => {
                lobby.onReplaySaved?.(path);
                pruneReplays(room.replayDir).catch(() => {});
              },
            },
          }
        : {}),
    };
    const started: StartedGameConfig = { ...config, opponents: [...config.opponents], seed, ...(fromFriendRoom ? { friendRoom: true as const } : {}) };
    room.starting = true;
    let opened: { runner: EngineRunner; start: EngineStart };
    try {
      opened = lobby.engine ? await lobby.engine.openGame(spec) : InlineEngineRunner.open(gameFromSpec(spec));
    } finally {
      room.starting = false;
    }
    openTable(room, opened.runner, opened.start, options, started, friend ? { hostOptions: { timeLimit: friend.timeLimit, humanNames: [friend.nickname], awayAnswerDelayMs: AWAY_ANSWER_DELAY_MS * (lobby.friendTimeScale ?? 1) } } : {});
    lobby.onGameStarted?.(started, room.userId);
    sendToRoom(room, `data: ${connectMessage(room)}\n\n`);
  }

  /** AI 관전: 모든 좌석이 AI인 게임을 엔진(worker)에서 끝까지 진행하고, 그 리플레이를 이 사용자의 리플레이 폴더에 저장한다.
   *  사람이 두는 대국 화면은 쓰지 않는다 - 결과는 리플레이 뷰어로 본다. 진행하는 동안은 대국 한 판으로 센다(동시 대국 제한).
   *  저장한 파일 이름을 돌려준다. */
  async function watchGame(room: Room, config: AiWatchConfig): Promise<string> {
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    if (inActiveGame(room)) throw new Error("GuiServer: 진행 중인 게임이 있습니다");
    assertNoWatchBatch(room);
    assertNotInFriendRoom(room);
    if (limits && openGameCount() - (room.table ? 1 : 0) >= limits.maxOpenGames) {
      throw new Error(`지금은 서버에서 진행 중인 대국이 많습니다 (최대 ${limits.maxOpenGames}판). 잠시 뒤 다시 시도해 주세요`);
    }
    room.notice = null;
    const seed = config.seed ?? `watch-${Date.now()}`;
    room.lastSetup = { ...room.lastSetup, mode: config.mode, watchSeats: { ...room.lastSetup.watchSeats, [config.mode]: [...config.seats] }, seed: config.seed ?? "", watchGames: 1 };
    const spec: AiWatchSpec = { mode: config.mode, seed, seats: config.seats.map((id) => opponentSpecOf(room, id)) };
    // 같은 시드를 다른 좌석으로 다시 봐도 앞 기록을 덮어쓰지 않게 시각을 붙인다
    const label = `watch-${config.mode}-${replayFileNamePart(seed, 40)}-${Date.now()}`;
    room.starting = true;
    let record: GameReplayRecord;
    try {
      record = lobby.engine ? await lobby.engine.runAiWatch(spec, label) : runAiWatchGame(spec, label);
    } finally {
      room.starting = false;
    }
    const path = writeGameReplay(record, room.replayDir);
    lobby.onReplaySaved?.(path);
    await pruneReplays(room.replayDir).catch(() => {});
    return `${label}_game0.json`;
  }

  // --- 친선전 방 (friendRooms.ts). 방 상태는 저장소에 있고, 바뀔 때마다 방에 있는 모든 사람의 로비에 설정 메시지를 다시
  // 보낸다. 공개 방 목록은 없다(코드를 아는 사람만 들어온다). 방장 + AI면 일반 대국(startGame)으로, 사람이 2명 이상이면
  // 사람끼리 대국(startFriendGame)으로 시작한다. ---

  const friendRooms = access ? new FriendRoomStore() : null;

  function requireFriendRooms(): FriendRoomStore {
    if (!friendRooms) throw new FriendRoomError("이 서버에서는 친선전을 쓸 수 없습니다 (공개/비공개 모드에서만)", 404);
    return friendRooms;
  }

  function assertNotInFriendRoom(room: Room): void {
    if (friendRooms?.roomOf(room.userId)) throw new Error("GuiServer: 친선전 방에 있습니다. 방에서 나간 뒤 시작해 주세요");
  }

  /** 좌석의 AI 이름: 등록 캐릭터, 또는 방장의 CustomAI (지워졌으면 id 그대로) */
  function friendAiName(friendRoom: FriendRoom, characterId: string): string {
    try {
      return resolveOpponentProfile(roomOf(friendRoom.hostUserId), characterId).displayName;
    } catch {
      return characterId;
    }
  }

  /** 빈자리가 없고, 방에 있는 사람 모두가 다른 대국/관전 중이 아니면 시작할 수 있다. 시작할 수 없으면 이유. */
  function friendStartBlocker(friendRoom: FriendRoom): string | null {
    if (friendRoom.seats.some((st) => st.kind === "open")) return "빈자리가 있습니다. 사람이 들어오거나 AI를 앉혀 주세요";
    for (const st of friendRoom.seats) {
      if (st.kind !== "human") continue;
      const member = roomOf(st.userId);
      if (inActiveGame(member) || watchBatchRunning(member)) return `${st.nickname}님이 아직 다른 대국이나 관전 중입니다`;
    }
    return null;
  }

  /** 방의 시간 제한 옵션 → 밀리초 */
  function timeLimitOf(friendRoom: FriendRoom): { perTurnMs: number; bankMs: number } {
    const option = THINKING_TIME_OPTIONS.find((o) => o.id === friendRoom.thinkingTime)!;
    const scale = lobby?.friendTimeScale ?? 1;
    return { perTurnMs: option.perTurnSeconds * 1000 * scale, bankMs: option.bankSeconds * 1000 * scale };
  }

  /** 사람 2명 이상인 친선전 대국을 연다 (사람끼리 대국 모드). 좌석은 방 좌석 그대로이고, 사람 좌석마다 그 사람이 앉는다.
   *  재생 속도는 방장 설정을 쓰고, 대국은 방장만 끝낼 수 있다. 끝나면 참가자 모두의 리플레이 폴더에 저장한다. */
  async function startFriendGame(hostRoom: Room, friendRoom: FriendRoom): Promise<void> {
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    if (limits && openGameCount() >= limits.maxOpenGames) {
      throw new Error(`지금은 서버에서 진행 중인 대국이 많습니다 (최대 ${limits.maxOpenGames}판). 잠시 뒤 다시 시도해 주세요`);
    }
    const seed = `friend-${Date.now()}`;
    const spec: GameSpec = {
      mode: friendRoom.mode,
      seed,
      opponents: [],
      seats: friendRoom.seats.map((st) => (st.kind === "human" ? null : opponentSpecOf(hostRoom, st.kind === "ai" ? st.characterId : ""))),
    };
    const seatUsers = friendRoom.seats.map((st) => (st.kind === "human" ? st.userId : null));
    const humanNames = friendRoom.seats.map((st) => (st.kind === "human" ? st.nickname : null));
    const started: StartedGameConfig = { mode: friendRoom.mode, opponents: [], seed, saveReplays: true, friendRoom: true };
    hostRoom.starting = true;
    let opened: { runner: EngineRunner; start: EngineStart };
    try {
      opened = lobby.engine ? await lobby.engine.openGame(spec) : InlineEngineRunner.open(gameFromSpec(spec));
    } finally {
      hostRoom.starting = false;
    }
    const memberDirs = [...new Set(seatUsers.filter((u): u is string => u !== null))].map((u) => roomOf(u).replayDir);
    const replay: GuiServerOptions["replay"] = {
      label: `friend-${friendRoom.mode}-${replayFileNamePart(seed)}`,
      dir: hostRoom.replayDir,
      alsoDirs: memberDirs.filter((d) => d !== hostRoom.replayDir),
      seatNames: humanNames,
      onSaved: (path: string) => {
        lobby!.onReplaySaved?.(path);
        for (const dir of memberDirs) pruneReplays(dir).catch(() => {});
      },
    };
    openTable(hostRoom, opened.runner, opened.start, { replay }, started, {
      seatUsers,
      hostOptions: { humanNames, abandonSeat: 0, timeLimit: timeLimitOf(friendRoom), awayAnswerDelayMs: AWAY_ANSWER_DELAY_MS * (lobby!.friendTimeScale ?? 1) },
    });
    for (const userId of new Set(seatUsers)) {
      if (userId === null) continue;
      const member = roomOf(userId);
      member.notice = null;
      sendToRoom(member, `data: ${connectMessage(member)}\n\n`);
    }
  }

  function friendRoomViewFor(userId: string) {
    const friendRoom = friendRooms?.roomOf(userId);
    if (!friendRoom) return null;
    const blocker = friendStartBlocker(friendRoom);
    return {
      code: friendRoom.code,
      mode: friendRoom.mode,
      thinkingTime: friendRoom.thinkingTime,
      isHost: friendRoom.hostUserId === userId,
      seats: friendRoom.seats.map((st, seat) =>
        st.kind === "human"
          ? { seat, kind: "human", name: st.nickname, isHost: st.userId === friendRoom.hostUserId, isMe: st.userId === userId }
          : st.kind === "ai"
            ? { seat, kind: "ai", name: friendAiName(friendRoom, st.characterId), characterId: st.characterId }
            : { seat, kind: "open" }
      ),
      canStart: blocker === null,
      ...(blocker ? { startBlocker: blocker } : {}),
    };
  }

  /** 방에 있는(있던) 사람들의 로비에 새 상태를 보낸다. 대국 화면에 있는 사람에게는 보내지 않는다(로비로 돌아오면 받는다). */
  function notifyFriendMembers(userIds: readonly string[], notice?: string): void {
    for (const userId of new Set(userIds)) {
      const member = roomOf(userId);
      if (notice) member.notice = notice;
      if (!member.table) sendToRoom(member, `data: ${setupMessage(member)}\n\n`);
    }
  }

  function nicknameOf(req: import("node:http").IncomingMessage): string {
    return access?.userOf(req)?.nickname ?? "플레이어";
  }

  function handleFriend(room: Room, req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, pathname: string): void {
    const fail = (err: unknown) =>
      res.writeHead(err instanceof FriendRoomError ? err.status : 400, { "Content-Type": "text/plain; charset=utf-8" }).end(String(err instanceof Error ? err.message : err));
    readBody(req, res, (body) => {
      Promise.resolve()
        .then(async () => {
          const store = requireFriendRooms();
          const input = (body ? JSON.parse(body) : {}) as Record<string, unknown>;
          const me = { userId: room.userId, nickname: nicknameOf(req) };
          if (pathname === "/friend/create") {
            if (inActiveGame(room) || watchBatchRunning(room)) throw new FriendRoomError("진행 중인 대국이나 관전이 끝난 뒤 방을 만들 수 있습니다");
            const created = store.create(me, parseGuiMode(typeof input.mode === "string" ? input.mode : String(input.mode)), parseThinkingTime(input.thinkingTime));
            room.notice = null;
            notifyFriendMembers(store.membersOf(created));
          } else if (pathname === "/friend/join") {
            if (inActiveGame(room) || watchBatchRunning(room)) throw new FriendRoomError("진행 중인 대국이나 관전이 끝난 뒤 들어갈 수 있습니다");
            const joined = store.join(me, input.code);
            room.notice = null;
            notifyFriendMembers(store.membersOf(joined));
          } else if (pathname === "/friend/leave") {
            const left = store.leave(room.userId);
            if (!left) throw new FriendRoomError("친선전 방에 있지 않습니다");
            notifyFriendMembers([room.userId]);
            notifyFriendMembers(left.members.filter((u) => u !== room.userId), left.closed ? "방장이 방을 닫았습니다." : undefined);
          } else if (pathname === "/friend/seat") {
            const current = store.roomOf(room.userId);
            if (!current) throw new FriendRoomError("친선전 방에 있지 않습니다");
            let seat: { kind: "open" } | { kind: "ai"; characterId: string };
            if (input.characterId === null || input.characterId === undefined) seat = { kind: "open" };
            else if (typeof input.characterId !== "string") throw new FriendRoomError("characterId는 문자열이어야 합니다");
            // AI는 등록 캐릭터나 방장의 CustomAI (legacy id는 정식 id로)
            else seat = { kind: "ai", characterId: resolveOpponentProfile(room, input.characterId).characterId };
            const { room: changed, removedUserId } = store.setSeat(room.userId, input.seat, seat);
            if (removedUserId) notifyFriendMembers([removedUserId], "방장이 좌석을 바꿔 방에서 나왔습니다.");
            notifyFriendMembers(store.membersOf(changed));
          } else if (pathname === "/friend/start") {
            const current = store.roomOf(room.userId);
            if (!current) throw new FriendRoomError("친선전 방에 있지 않습니다");
            if (current.hostUserId !== room.userId) throw new FriendRoomError("방장만 시작할 수 있습니다", 403);
            const blocker = friendStartBlocker(current);
            if (blocker) throw new FriendRoomError(blocker, 409);
            store.touch(current);
            if (current.seats.filter((st) => st.kind === "human").length >= 2) {
              await startFriendGame(room, current);
            } else {
              const opponents = current.seats.slice(1).map((st) => (st.kind === "ai" ? st.characterId : ""));
              // 친선전은 리플레이를 항상 남긴다 (D단계)
              await startGame(room, { mode: current.mode, opponents, saveReplays: true }, { timeLimit: timeLimitOf(current), nickname: me.nickname });
            }
          } else {
            res.writeHead(404).end("Not found");
            return;
          }
          res.writeHead(204).end();
        })
        .catch(fail);
    });
  }

  const friendSweepTimer = friendRooms
    ? setInterval(() => {
        for (const { members } of friendRooms.sweepIdle()) notifyFriendMembers(members, "오래 쓰이지 않아 친선전 방이 닫혔습니다.");
      }, 60_000)
    : null;
  friendSweepTimer?.unref();

  /** 여러 판 관전이 도는 동안에는 이 사용자의 새 대국/관전을 시작하지 않는다 (로비 화면 이동은 된다). */
  function watchBatchRunning(room: Room): boolean {
    return room.watchBatch?.status === "running";
  }
  function assertNoWatchBatch(room: Room): void {
    if (watchBatchRunning(room)) throw new Error("GuiServer: 여러 판 관전이 진행 중입니다. 끝나거나 취소한 뒤 다시 시도해 주세요");
  }

  /** 화면에 보낼 여러 판 관전 상태: 진행률, 판별 결과, 좌석별 통계(watchStats.ts). */
  function watchBatchView(batch: WatchBatch) {
    return {
      id: batch.id,
      status: batch.status,
      cancelRequested: batch.cancelRequested,
      mode: batch.config.mode,
      seed: batch.config.seed,
      total: batch.config.games,
      done: batch.results.length,
      saveReplays: batch.config.saveReplays,
      seatNames: batch.seatNames,
      ...(batch.error ? { error: batch.error } : {}),
      games: batch.results.map((g) => ({
        index: g.index,
        seed: g.seed,
        hands: g.hands,
        placements: g.seats.map((st) => st.placement),
        ...(g.replayFile ? { replayFile: g.replayFile } : {}),
      })),
      stats: aggregateWatchStats(batch.results, batch.playerCount),
    };
  }

  function sendWatchBatch(room: Room): void {
    if (room.watchBatch) sendToRoom(room, `data: ${JSON.stringify({ type: "watch_batch", batch: watchBatchView(room.watchBatch) })}\n\n`);
  }

  let nextWatchBatchId = 1;

  /** 여러 판 관전을 시작한다. 요청은 바로 끝나고, 판이 끝날 때마다 "watch_batch" 메시지로 진행 상황을 보낸다.
   *  판 i(1부터)의 시드는 "<시드>-i"라 같은 시드로 다시 돌리면 같은 대국들이 나온다. */
  function startWatchBatch(room: Room, config: AiWatchBatchConfig): void {
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    if (inActiveGame(room)) throw new Error("GuiServer: 진행 중인 게임이 있습니다");
    assertNoWatchBatch(room);
    assertNotInFriendRoom(room);
    if (limits && openGameCount() - (room.table ? 1 : 0) >= limits.maxOpenGames) {
      throw new Error(`지금은 서버에서 진행 중인 대국이 많습니다 (최대 ${limits.maxOpenGames}판). 잠시 뒤 다시 시도해 주세요`);
    }
    room.notice = null;
    const seed = config.seed ?? `watch-${Date.now()}`;
    room.lastSetup = { ...room.lastSetup, mode: config.mode, watchSeats: { ...room.lastSetup.watchSeats, [config.mode]: [...config.seats] }, seed: config.seed ?? "", watchGames: config.games, watchSaveReplays: config.saveReplays };
    // 좌석 구성(CustomAI 프로필 포함)은 시작 순간의 것을 모든 판에 쓴다
    const seats = config.seats.map((id) => opponentSpecOf(room, id));
    const batch: WatchBatch = {
      id: nextWatchBatchId++,
      config: { ...config, seats: [...config.seats], seed },
      seatNames: seats.map((o) => ("profile" in o ? o.profile.displayName : replaySeatName({ kind: "characterAI", characterId: o.characterId }))),
      playerCount: playerCountOf(config.mode),
      status: "running",
      cancelRequested: false,
      results: [],
    };
    room.watchBatch = batch;
    sendWatchBatch(room);
    void runWatchBatch(room, batch, seats);
  }

  async function runWatchBatch(room: Room, batch: WatchBatch, seats: OpponentSpec[]): Promise<void> {
    const { mode, games, saveReplays } = batch.config;
    try {
      for (let i = 0; i < games && !batch.cancelRequested; i++) {
        const seed = `${batch.config.seed}-${i + 1}`;
        const label = `watch-${mode}-${replayFileNamePart(seed, 40)}-${Date.now()}`;
        const spec: AiWatchSpec = { mode, seed, seats };
        let record: GameReplayRecord;
        if (lobby!.engine) record = await lobby!.engine.runAiWatch(spec, label);
        else {
          // 같은 스레드에서 돌릴 때(테스트 서버)도 판 사이에 취소 요청과 다른 요청을 받을 수 있게 한 번 양보한다
          await new Promise((r) => setImmediate(r));
          record = runAiWatchGame(spec, label);
        }
        let replayFile: string | undefined;
        if (saveReplays) {
          const path = writeGameReplay(record, room.replayDir);
          replayFile = basename(path);
          lobby!.onReplaySaved?.(path);
          await pruneReplays(room.replayDir).catch(() => {});
        }
        batch.results.push(summarizeWatchGame(record, i, replayFile));
        if (i + 1 < games) sendWatchBatch(room);
      }
      batch.status = batch.results.length < games ? "cancelled" : "done";
    } catch (err) {
      batch.status = "failed";
      batch.error = err instanceof Error ? err.message : String(err);
    }
    sendWatchBatch(room);
  }

  function cancelWatchBatch(room: Room): void {
    if (!watchBatchRunning(room)) throw new Error("GuiServer: 진행 중인 여러 판 관전이 없습니다");
    room.watchBatch!.cancelRequested = true;
    sendWatchBatch(room);
  }

  /** 끝난 여러 판 관전의 결과를 로비에서 지운다 (저장한 리플레이 파일은 그대로 둔다). */
  function clearWatchBatch(room: Room): void {
    if (watchBatchRunning(room)) throw new Error("GuiServer: 진행 중에는 결과를 지울 수 없습니다. 먼저 취소해 주세요");
    room.watchBatch = null;
    sendToRoom(room, `data: ${JSON.stringify({ type: "watch_batch", batch: null })}\n\n`);
  }

  function returnToSetup(room: Room): void {
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    if (inActiveGame(room)) throw new Error("GuiServer: 게임이 끝난 뒤에만 시작 화면으로 돌아갈 수 있습니다");
    leaveTable(room);
    room.lobbyScreen = "setup"; // 마지막으로 사용한 모드(lastSetup.mode)의 설정 화면으로 돌아간다
    sendToRoom(room, `data: ${setupMessage(room)}\n\n`);
  }

  /** 진행 중인 대국을 그만두고 그 모드의 설정 화면(로비)으로 돌아간다. 리플레이는 저장하지 않는다(저장은 게임 종료 때만 한다).
   *  게임이 이미 끝났다면 "설정 바꾸기"(/setup)를 쓴다. */
  function abandonGame(room: Room): void {
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    const table = room.table;
    const host = table?.host;
    if (!table || !host) throw new Error("GuiServer: 진행 중인 대국이 없습니다");
    if (host.phase() === "game_end") throw new Error("GuiServer: 이미 끝난 대국입니다");
    if (host.multiplayer) {
      // 사람끼리 대국은 방장만 끝낼 수 있고, 끝내면 모두 방으로 돌아간다
      if (table.seatUsers[0] !== room.userId) throw new Error("GuiServer: 사람끼리 대국은 방장만 끝낼 수 있습니다");
      for (const userId of new Set(table.seatUsers)) {
        if (userId === null || userId === room.userId) continue;
        const member = roomOf(userId);
        if (member.table !== table) continue;
        member.table = null;
        member.lobbyScreen = "setup";
        member.notice = "방장이 대국을 끝냈습니다.";
        sendToRoom(member, `data: ${setupMessage(member)}\n\n`);
      }
    }
    leaveTable(room);
    room.lobbyScreen = "setup";
    sendToRoom(room, `data: ${setupMessage(room)}\n\n`);
  }

  /** 로비 안에서 화면을 옮긴다: 허브로 가거나, 모드를 골라 그 모드의 설정 화면으로 간다. 대국 중에는 할 수 없다. */
  function moveLobby(room: Room, input: unknown): void {
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    if (inActiveGame(room)) throw new Error("GuiServer: 진행 중인 게임이 있습니다");
    const raw = (typeof input === "object" && input !== null ? input : {}) as { screen?: unknown; mode?: unknown; purpose?: unknown };
    room.notice = null;
    if (raw.screen === "hub") {
      room.lobbyScreen = "hub";
    } else if (raw.screen === "setup") {
      if (raw.purpose !== undefined && raw.purpose !== "play" && raw.purpose !== "watch") throw new Error('purpose는 "play" 또는 "watch"여야 합니다');
      room.lastSetup = { ...room.lastSetup, mode: parseGuiMode(typeof raw.mode === "string" ? raw.mode : String(raw.mode)) };
      room.lobbyPurpose = raw.purpose ?? "play";
      room.lobbyScreen = "setup";
    } else {
      throw new Error('screen은 "hub" 또는 "setup"이어야 합니다');
    }
    leaveTable(room);
    sendToRoom(room, `data: ${setupMessage(room)}\n\n`);
  }

  /** CustomAI 편집 화면용 목록: 스키마(표시 이름/설명/범위)와 저장된 CustomAI(검증 실패 파일은 이유만). */
  function customAiListBody(store: CustomAiStore): string {
    return JSON.stringify({
      schema: {
        nameMax: CUSTOM_AI_NAME_MAX,
        min: SLIDER_MIN,
        max: SLIDER_MAX,
        fields: CUSTOM_AI_FIELDS.map((f) => ({ key: f.key, group: f.group, label: f.label, description: f.description, initial: f.initial })),
      },
      entries: store.list().map((e) =>
        e.ok
          ? { ok: true, id: e.definition.id, characterId: customAiCharacterId(e.definition.id), name: e.definition.name, style: e.definition.style, notices: customAiNotices(e.definition.style) }
          : { ok: false, file: e.file, reason: e.reason }
      ),
    });
  }

  /** CustomAI가 바뀌면 그 사용자의 시작 화면에 새 목록을 보낸다. */
  function refreshSetupRoster(room: Room): void {
    if (!room.table) sendToRoom(room, `data: ${setupMessage(room)}\n\n`);
  }

  /** CustomAI 개수 제한 (온라인 서버). 검증에 실패한 파일도 한 개로 센다. */
  function assertCustomAiRoom(store: CustomAiStore): void {
    if (limits && store.list().length >= limits.maxCustomAisPerUser) throw new Error(`CustomAI는 한 사람당 ${limits.maxCustomAisPerUser}개까지 만들 수 있습니다`);
  }

  function handleCustomAi(room: Room, req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, pathname: string): void {
    const json = (status: number, body: string) => res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(body);
    const error = (err: unknown) => res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(String(err instanceof Error ? err.message : err));
    if (!room.customAiStore) {
      res.writeHead(404).end("Not found");
      return;
    }
    const store = room.customAiStore;
    const rest = pathname.slice("/api/custom-ai".length).split("/").filter(Boolean); // [] | [id] | [id, "duplicate"]
    if (req.method === "GET" && rest.length === 0) {
      json(200, customAiListBody(store));
      return;
    }
    readBody(req, res, (body) => {
      try {
        let result: unknown;
        if (req.method === "POST" && rest.length === 0) {
          assertCustomAiRoom(store);
          result = store.create(JSON.parse(body));
        }
        else if (req.method === "PUT" && rest.length === 1) result = store.update(rest[0]!, JSON.parse(body));
        else if (req.method === "POST" && rest.length === 2 && rest[1] === "duplicate") {
          assertCustomAiRoom(store);
          result = store.duplicate(rest[0]!);
        }
        else if (req.method === "DELETE" && rest.length === 1) {
          store.delete(rest[0]!);
          result = { deleted: rest[0] };
        } else {
          res.writeHead(405).end("Method not allowed");
          return;
        }
        refreshSetupRoster(room);
        json(200, JSON.stringify(result));
      } catch (err) {
        error(err);
      }
    });
  }

  /** 요청 본문을 읽는다. MAX_REQUEST_BODY_BYTES를 넘으면 413으로 끝내고 onBody를 부르지 않는다. */
  function readBody(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, onBody: (body: string) => void): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" }).end("요청이 너무 큽니다");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) onBody(Buffer.concat(chunks).toString("utf-8"));
    });
  }

  function reply(res: import("node:http").ServerResponse, action: () => void | Promise<void>): void {
    const fail = (err: unknown) => res.writeHead(400, { "Content-Type": "text/plain" }).end(String(err instanceof Error ? err.message : err));
    try {
      Promise.resolve(action()).then(() => res.writeHead(204).end(), fail);
    } catch (err) {
      fail(err);
    }
  }


  /** 입장 게이트: 입장 화면/입장 요청은 통과시키고, 입장하지 않은 요청은 페이지면 입장 화면으로 보내고 나머지는 401로 막는다.
   *  요청을 여기서 끝냈으면 true. */
  function handleAccess(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, pathname: string): boolean {
    if (!access) return false;
    if (req.method === "POST" && pathname === "/join") {
      readBody(req, res, (body) => {
        try {
          const { token, user } = access.join(req, JSON.parse(body || "{}"));
          res
            .writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": AccessGate.cookieHeader(req, token) })
            .end(JSON.stringify({ nickname: user.nickname }));
        } catch (err) {
          const status = err instanceof AccessError ? err.status : 400;
          res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(err instanceof AccessError ? err.message : "입장 요청이 올바르지 않습니다");
        }
      });
      return true;
    }
    const user = access.userOf(req);
    // 입장 화면이 초대 코드 칸을 보일지 정한다 (입장 전에도 열린다)
    if (req.method === "GET" && pathname === "/api/join-info") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify({ inviteRequired: access.inviteRequired }));
      return true;
    }
    if (req.method === "GET" && pathname === "/api/me") {
      if (user) res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify({ nickname: user.nickname }));
      else res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" }).end("입장이 필요합니다");
      return true;
    }
    if (user || (req.method === "GET" && JOIN_PUBLIC_PATHS.has(pathname))) return false;
    if (req.method === "GET" && GATED_PAGES.has(pathname)) {
      res.writeHead(302, { Location: "/join.html", "Cache-Control": "no-store" }).end();
      return true;
    }
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" }).end("입장이 필요합니다");
    return true;
  }

  /** 사용자별 요청 빈도 제한 (토큰 버킷). 제한이 없는 서버면 항상 통과. */
  function takeToken(room: Room): boolean {
    if (!limits) return true;
    const now = Date.now();
    room.tokens = Math.min(limits.requestBurst, room.tokens + ((now - room.tokensAt) / 1000) * limits.requestsPerSecond);
    room.tokensAt = now;
    if (room.tokens < 1) return false;
    room.tokens -= 1;
    return true;
  }

  /** 방치 정리: 요청이 오래 없는 사용자의 대국을 정리하고(리플레이는 저장하지 않음, 로비에 안내), 접속도 대국도 없는 로비는 지운다. */
  function sweepIdle(): void {
    if (!limits) return;
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      const idle = now - room.lastActivity;
      if (room.table && idle > limits.idleGameMs) {
        const ended = room.table.host.phase() === "game_end";
        leaveTable(room);
        room.lobbyScreen = "setup";
        room.notice = ended ? null : "오래 응답이 없어 진행 중이던 대국을 정리했습니다 (리플레이는 저장하지 않았습니다).";
        sendToRoom(room, `data: ${setupMessage(room)}\n\n`);
      }
      if (!room.table && !room.starting && !watchBatchRunning(room) && room.sseClients.size === 0 && idle > limits.idleRoomMs) rooms.delete(room.userId);
    }
  }
  const sweepTimer = limits ? setInterval(sweepIdle, Math.min(60_000, Math.max(1_000, limits.idleGameMs / 2))) : null;
  sweepTimer?.unref();

  /** 서버 전체에서 열려 있는 대국 수 (끝났지만 아직 떠나지 않은 대국 포함, 만드는 중인 대국 포함) */
  function openGameCount(): number {
    // 사람끼리 대국은 여러 사용자가 같은 대국을 가리키므로 대국 단위로 센다
    const tables = new Set<Table>();
    let count = 0;
    for (const room of rooms.values()) {
      if (room.table) tables.add(room.table);
      if (room.starting || watchBatchRunning(room)) count++;
    }
    return count + tables.size;
  }

  /** 사용자 리플레이 폴더를 최근 maxReplaysPerUser개로 줄인다 (온라인 서버). */
  async function pruneReplays(replayDir: string): Promise<void> {
    if (!limits) return;
    const files = await listReplays(replayDir);
    for (const f of files.slice(limits.maxReplaysPerUser)) await rm(join(replayDir, f.name), { force: true });
  }

  function serveStatic(pathname: string, res: import("node:http").ServerResponse): void {
    const relative = pathname === "/" ? "/index.html" : pathname;
    const filePath = join(PUBLIC_DIR, relative);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    readFile(filePath)
      .then((data) => {
        const contentType = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
        const headers: Record<string, string> = { "Content-Type": contentType };
        if (NO_STORE_FILES.has(relative)) headers["Cache-Control"] = "no-store";
        res.writeHead(200, headers).end(data);
      })
      .catch(() => res.writeHead(404).end("Not found"));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (handleAccess(req, res, url.pathname)) return;
    // 입장 게이트가 있으면 handleAccess를 통과한 요청은 입장한 사용자의 것이거나, 입장 전에도 열리는 정적 파일(입장 화면)이다.
    // 로컬 모드는 로비가 하나다.
    const userId = access ? (access.userOf(req)?.userId ?? null) : LOCAL_USER_ID;
    if (userId === null) {
      serveStatic(url.pathname, res);
      return;
    }
    const room = roomOf(userId);

    // 로비/대국/API 요청만 사용자 활동으로 세고 빈도를 제한한다 (화면 파일, 패 그림 같은 정적 파일은 제외).
    const isAppRequest = req.method !== "GET" || url.pathname === "/events" || url.pathname.startsWith("/api/");
    if (isAppRequest) {
      room.lastActivity = Date.now();
      const friendRoom = friendRooms?.roomOf(userId);
      if (friendRoom) friendRooms!.touch(friendRoom);
      if (!takeToken(room)) {
        res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "1" }).end("요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요");
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/events") {
      if (limits && room.sseClients.size >= limits.maxStreamsPerUser) {
        res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end(`동시에 열 수 있는 화면은 ${limits.maxStreamsPerUser}개까지입니다`);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // 프록시가 이벤트를 모아 두지 않고 바로 흘려보내게 한다
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${connectMessage(room)}\n\n`);
      room.sseClients.add(res);
      markPresence(room, true);
      req.on("close", () => {
        room.sseClients.delete(res);
        if (room.sseClients.size > 0) return;
        const table = room.table;
        const timer = setTimeout(() => {
          if (room.sseClients.size === 0 && room.table === table) markPresence(room, false);
        }, lobby?.presenceGraceMs ?? PRESENCE_GRACE_MS);
        timer.unref?.();
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/respond") {
      readBody(req, res, (body) =>
        reply(res, () => respondAt(room, JSON.parse(body) as SeatDecisionResponse & { seat?: unknown }))
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/continue") {
      reply(res, () => {
        if (!room.table) throw new Error("GuiServer: 진행 중인 게임이 없습니다");
        return room.table.host.continueToNextHand();
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/start") {
      readBody(req, res, (body) => reply(res, () => startGame(room, parseGuiGameConfig(JSON.parse(body), (id) => resolveOpponentProfile(room, id)))));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/friend/")) {
      handleFriend(room, req, res, url.pathname);
      return;
    }

    if (req.method === "POST" && url.pathname === "/watch/batch") {
      readBody(req, res, (body) => reply(res, () => startWatchBatch(room, parseAiWatchBatchConfig(JSON.parse(body), (id) => resolveOpponentProfile(room, id)))));
      return;
    }
    if (req.method === "POST" && url.pathname === "/watch/batch/cancel") {
      reply(res, () => cancelWatchBatch(room));
      return;
    }
    if (req.method === "POST" && url.pathname === "/watch/batch/clear") {
      reply(res, () => clearWatchBatch(room));
      return;
    }

    if (req.method === "POST" && url.pathname === "/watch") {
      readBody(req, res, (body) => {
        Promise.resolve()
          .then(() => watchGame(room, parseAiWatchConfig(JSON.parse(body), (id) => resolveOpponentProfile(room, id))))
          .then((file) => res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify({ file })))
          .catch((err) => res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(String(err instanceof Error ? err.message : err)));
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/replays") {
      listReplays(room.replayDir)
        .then((files) => res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(files)))
        .catch((err) => res.writeHead(500, { "Content-Type": "text/plain" }).end(String(err instanceof Error ? err.message : err)));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/replays/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/replays/".length));
      if (url.searchParams.has("download")) {
        // 버그 제보용: 원본 파일을 그대로 내려받는다 (재현하지 않는다)
        Promise.resolve()
          .then(() => readFile(replayPath(room.replayDir, name)))
          .then((data) =>
            res
              .writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${name}"` })
              .end(data)
          )
          .catch((err) => res.writeHead(REPLAY_FILE_NAME.test(name) ? 404 : 400, { "Content-Type": "text/plain" }).end(String(err instanceof Error ? err.message : err)));
        return;
      }
      replayBody(room.replayDir, name)
        .then((body) => res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(body))
        .catch((err) => res.writeHead(REPLAY_FILE_NAME.test(name) ? 404 : 400, { "Content-Type": "text/plain" }).end(String(err instanceof Error ? err.message : err)));
      return;
    }

    if (url.pathname === "/api/custom-ai" || url.pathname.startsWith("/api/custom-ai/")) {
      handleCustomAi(room, req, res, url.pathname);
      return;
    }

    if (req.method === "POST" && url.pathname === "/speed") {
      readBody(req, res, (body) =>
        reply(res, () => {
          const { speed } = JSON.parse(body) as { speed?: unknown };
          room.frameDelayMs = PLAYBACK_FRAME_DELAY_MS[parsePlaybackSpeed(speed)];
        })
      );
      return;
    }

    // 자리 비움에서 복귀 ("복귀" 버튼)
    if (req.method === "POST" && url.pathname === "/presence") {
      reply(res, () => {
        if (!room.table) throw new Error("GuiServer: 진행 중인 대국이 없습니다");
        markPresence(room, true);
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/abandon") {
      reply(res, () => abandonGame(room));
      return;
    }

    if (req.method === "POST" && url.pathname === "/lobby") {
      readBody(req, res, (body) => reply(res, () => moveLobby(room, JSON.parse(body || "{}"))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/setup") {
      reply(res, () => returnToSetup(room));
      return;
    }

    if (req.method === "GET") {
      serveStatic(url.pathname, res);
      return;
    }

    res.writeHead(405).end("Method not allowed");
  });

  const heartbeatMs = lobby?.heartbeatMs ?? SSE_HEARTBEAT_MS;
  const heartbeatTimer =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const room of rooms.values()) sendToRoom(room, ": ping\n\n");
        }, heartbeatMs)
      : null;
  heartbeatTimer?.unref();

  server.on("close", () => {
    if (sweepTimer) clearInterval(sweepTimer);
    if (friendSweepTimer) clearInterval(friendSweepTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });

  // 같은 스레드에서 도는 대국만 세션을 돌려준다 (worker 대국은 null)
  return { server, getSession: (userId = LOCAL_USER_ID) => rooms.get(userId)?.table?.host.session ?? null };
}
