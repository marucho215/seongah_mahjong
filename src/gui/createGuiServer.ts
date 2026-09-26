/* Factory extracted from server.ts so tests can start/stop a real instance on an ephemeral
 * port without spawning a subprocess - see tests/guiServer.test.ts. server.ts (the `npm run
 * play:gui` entry point) just calls this and listens; no behavior lives only in server.ts. */
import { createServer, type Server } from "node:http";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameState } from "../core/GameState.js";
import type { GuiSession, GuiSessionPhase, WatchFrame } from "./guiSession.js";
import type { GameEvent } from "../core/GameLog.js";
import { InlineEngineRunner, gameFromSpec, type EngineRunner, type EngineSnapshot, type EngineStart, type GameSpec, type OpponentSpec } from "./engineRunner.js";
import type { EngineWorkerPool } from "./engineWorkerPool.js";
import { AudioCueTracker, toPublicAction, type AudioCue, type PublicAction } from "./audioCues.js";
import type { DecisionResponse } from "../core/decisions.js";
import { resolveReplayDir, writeGameReplay, type GameReplayRecord } from "../sim/replayRecorder.js";
import { reproduceReplay, type ReplayReproduction } from "../replay/replayReproduction.js";
import { getCharacterProfile } from "../ai/characterProfiles.js";
import { buildCharacterRoster } from "./characterRoster.js";
import { DEFAULT_PLAYBACK_SPEED, PLAYBACK_FRAME_DELAY_MS, parsePlaybackSpeed } from "./playbackSpeed.js";
import { DEFAULT_OPPONENTS, parseGuiGameConfig, parseGuiMode, playerCountOf, type GuiGameConfig, type GuiGameMode } from "./gameSetup.js";
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
function replaySeatName(seat: { kind: string; characterId?: string }): string {
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
  replay?: { label: string; dir?: string; onSaved?: (path: string) => void };
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
 *  새로 만든다. 엔진 상태는 실행기가 돌려준 스냅샷으로만 알며, 로그는 받은 이벤트를 이어 붙인 사본을 쓴다(인덱스는 원본과 같다). */
interface GameHost {
  /** 같은 스레드에서 도는 대국이면 그 세션 (테스트/직접 게임용), worker면 null */
  session: GuiSession | null;
  phase(): GuiSessionPhase;
  connectMessage(): string;
  /** 장면 재생 중이거나 엔진이 응답을 처리하는 중 */
  isPlaying(): boolean;
  /** 지금 결정을 요청받은 좌석 (결정 대기가 아니면 null) */
  currentRequestSeat(): number | null;
  respond(response: DecisionResponse): Promise<void>;
  continueToNextHand(): Promise<void>;
  /** 대국 그만두기: 이후 이 호스트는 아무 메시지도 보내지 않는다 (재생 중이던 장면 타이머 포함). 리플레이는 저장하지 않는다. */
  dispose(): void;
}

/** 시작 화면에서 시작한 대국의 구성 (실제로 쓰인 시드 포함). 종료 화면의 "다시 하기"가 이것을 그대로 /start에 보낸다. */
export type StartedGameConfig = GuiGameConfig & { seed: string };

/** `startedConfig`: 시작 화면이 있는 서버에서 시작한 대국이면 그 구성. 있으면 종료 화면에 새 대국/다시 하기 버튼이 나온다. */
/** `frameDelayMs`: 재생 속도 설정. 장면마다 새로 읽는다 (재생 중에 바꾸면 다음 장면부터 적용). */
function createGameHost(
  runner: EngineRunner,
  start: EngineStart,
  options: GuiServerOptions,
  broadcast: (payload: string) => void,
  startedConfig: StartedGameConfig | null,
  frameDelayMs: () => number
): GameHost {
  /** 엔진 로그 사본: 스냅샷의 newEvents를 순서대로 이어 붙인다. */
  const log: GameEvent[] = [];
  let snapshot: EngineSnapshot = start.initial;
  log.push(...snapshot.newEvents);
  /** 가장 최근 장면(화료/유국 포함)의 사람 좌석 view. 국/게임 종료 상태를 새로고침으로 다시 받을 때 작탁을 그 상태로 다시 그리는 데 쓴다. */
  let lastFrameView: WatchFrame["view"] | null = snapshot.frames.at(-1)?.view ?? null; // 접속 전의 AI 턴은 재생하지 않는다
  /** 시작 화면이 있는 서버에서 시작한 대국만 도중에 그만두고 로비로 돌아갈 수 있다. */
  const canAbandon = startedConfig !== null;
  let disposed = false;
  let lastRequestView: WatchFrame["view"] | null = null;

  /** 스냅샷을 반영한다: 로그 사본에 이벤트를 붙이고 현재 상태를 바꾼다. 장면(frames)은 호출한 쪽이 쓴다. */
  function apply(next: EngineSnapshot): WatchFrame[] {
    log.push(...next.newEvents);
    snapshot = next;
    return next.frames;
  }

  let replaySaved = false;
  async function saveReplayIfFinished(): Promise<void> {
    if (!options.replay || replaySaved || snapshot.phase !== "game_end") return;
    replaySaved = true;
    const record = await runner.replayRecord(options.replay.label);
    const path = writeGameReplay(record, options.replay.dir ?? "replays");
    options.replay.onSaved?.(path);
  }

  // Identity-only, presentation-layer detail: each seat's display name (or null when that seat has no
  // character profile) so the client never hardcodes a name and never confuses "who this seat is" with
  // "who controls it".
  const characterNames: (string | null)[] = start.characterNames;

  // 효과음 신호: 로그를 서버에서 공개 정보만 담은 AudioCue로 바꿔 보낸다 (audioCues.ts).
  // 접속 전에 이미 쌓인 신호는 "과거"이므로 다시 재생하지 않는다.
  const cueTracker = new AudioCueTracker(log);
  cueTracker.sync();
  let lastBroadcastSeq = cueTracker.latestSeq();

  /** 장면 재생 중에는 사람이 응답할 수 없다 (클라이언트는 아직 요청을 받지 못했다). */
  let playing = false;
  /** 엔진이 응답/다음 국을 처리하는 중 (worker 결과를 기다리는 동안 다른 요청을 받지 않는다) */
  let busy = false;
  let lastWatchMessage: string | null = null;
  /** 최근 행동 목록을 만들 때 어디까지 읽었는지 (로그 인덱스) */
  let actionLogIndex = log.length;

  function currentStateMessage(extra: { cues: AudioCue[]; cueBase?: number }): string {
    const phase = snapshot.phase;
    // 종료 화면 뒤에 그릴 작탁: 마지막 장면, 없으면 마지막 결정 요청의 view (사람 좌석 view라 숨은 정보가 없다)
    const view = lastFrameView ?? lastRequestView;
    if (phase === "game_end") {
      // 순위/우마는 엔진의 computeFinalStandings() 결과를 그대로 보낸다 (GUI가 따로 정렬하지 않는다).
      return JSON.stringify({
        type: "game_end",
        event: snapshot.gameEndEvent,
        handEvent: snapshot.handEndEvent,
        standings: snapshot.standings,
        characterNames,
        ...(view ? { view } : {}),
        canStartNewGame: startedConfig !== null,
        ...(startedConfig ? { gameConfig: startedConfig } : {}),
        ...extra,
      });
    }
    if (phase === "hand_end") {
      return JSON.stringify({ type: "hand_end", event: snapshot.handEndEvent, ...(view ? { view } : {}), characterNames, canAbandon, ...extra });
    }
    const request = snapshot.request;
    if (request) lastRequestView = request.view;
    return JSON.stringify({ type: "decision", request, characterNames, canAbandon, ...extra });
  }

  /** 새로 접속한 클라이언트: 과거 신호는 보내지 않고, 현재 seq만 기준점(cueBase)으로 알려준다. */
  function connectMessage(): string {
    // 같은 스레드의 대국이 서버 밖에서 진행됐으면(테스트가 세션을 직접 조작한 경우) 그 장면은 새 접속에 재생하지 않되 마지막 상태로는 반영한다
    if (!playing && !busy) {
      const fresh = runner.pollSync();
      if (fresh) {
        const pending = apply(fresh);
        if (pending.length > 0) lastFrameView = pending.at(-1)!.view;
      }
    }
    cueTracker.sync();
    // 재생 중에 접속하면 가장 최근 장면을 보여준다 (최종 상태는 재생이 끝난 뒤 브로드캐스트된다).
    if (playing && lastWatchMessage) return lastWatchMessage;
    return currentStateMessage({ cues: [], cueBase: cueTracker.latestSeq() });
  }

  function watchMessage(frame: WatchFrame): string {
    cueTracker.sync();
    const upTo = cueTracker.seqThroughLogLength(frame.logLength);
    const cues = cueTracker.cuesAfter(lastBroadcastSeq).filter((c) => c.seq <= upTo);
    if (upTo > lastBroadcastSeq) lastBroadcastSeq = upTo;
    // 이 장면 직전까지 새로 생긴 공개 행동들
    const actions: PublicAction[] = [];
    for (; actionLogIndex < frame.logLength; actionLogIndex++) {
      const a = toPublicAction(log[actionLogIndex]!);
      if (a) actions.push(a);
    }
    // 방금 버려진 패의 주인 (론이면 방총자): 그 패를 강조하는 데 쓴다
    let latestDiscardSeat: number | null = null;
    for (let i = frame.logLength - 1; i >= 0; i--) {
      const e = log[i]!;
      if (e.type === "discard") { latestDiscardSeat = e.player; break; }
      if (e.type === "hand_start") break;
    }
    const message = JSON.stringify({ type: "watch", view: frame.view, actor: frame.actor, latestDiscardSeat, actions, characterNames, canAbandon, cues });
    lastHold = frameDelayMs() * holdMultiplier(actions);
    return message;
  }
  let lastHold = 0;

  /** 응답 처리 뒤 상태를 보낸다. 그 사이 AI 턴이 있었다면 한 수씩 간격을 두고 보여준 다음 최종 상태를 보낸다. */
  function broadcastAfterAction(frames: WatchFrame[]): void {
    if (frames.length > 0) lastFrameView = frames.at(-1)!.view;
    if (frameDelayMs() <= 0 || frames.length === 0) {
      broadcastState();
      return;
    }
    playing = true;
    let i = 0;
    const step = (): void => {
      if (disposed) return;
      if (i < frames.length) {
        lastWatchMessage = watchMessage(frames[i++]!);
        broadcast(`data: ${lastWatchMessage}\n\n`);
        setTimeout(step, lastHold).unref();
      } else {
        playing = false;
        lastWatchMessage = null;
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
    broadcast(`data: ${currentStateMessage({ cues })}\n\n`);
  }

  /** 엔진에 한 번 진행을 맡기고, 결과를 반영해 보낸다. 처리 중에는 다른 진행 요청을 받지 않는다. */
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
    // 같은 스레드의 대국은 서버 밖(테스트)에서 진행될 수 있으므로 세션을 바로 읽는다. worker 대국은 마지막 스냅샷이 곧 현재 상태다.
    phase: () => runner.session?.getPhase() ?? snapshot.phase,
    connectMessage,
    isPlaying: () => playing || busy,
    currentRequestSeat: () => {
      if (runner.session) return runner.session.getCurrentRequest()?.seat ?? null;
      return snapshot.phase === "decision" ? (snapshot.request?.seat ?? null) : null;
    },
    respond(response) {
      if (playing) return Promise.reject(new Error("GuiServer: 장면 재생 중에는 응답할 수 없습니다"));
      if (busy) return Promise.reject(new Error("GuiServer: 앞의 응답을 처리하는 중입니다"));
      return advance(() => runner.respond(response));
    },
    continueToNextHand() {
      if (playing) return Promise.reject(new Error("GuiServer: 장면 재생 중에는 진행할 수 없습니다"));
      if (busy) return Promise.reject(new Error("GuiServer: 앞의 응답을 처리하는 중입니다"));
      return advance(() => runner.continueToNextHand());
    },
    dispose() {
      disposed = true;
      playing = false;
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
  /** 온라인 입장 게이트. 지정하면 초대 코드와 닉네임으로 입장한 브라우저만 로비/대국/API를 쓸 수 있다 (accessGate.ts).
   *  생략하면 지금까지처럼 누구나 쓰는 로컬 모드다. */
  access?: AccessGate;
  /** 대국과 리플레이 재현을 돌릴 엔진 worker 풀 (engineWorkerPool.ts). 생략하면 같은 스레드에서 돌린다(테스트용).
   *  풀은 호출한 쪽이 만들고 닫는다. */
  engine?: EngineWorkerPool;
  /** 입장 게이트가 있을 때 사용자별 저장 폴더의 상위 폴더 (기본 "server-data/users"). 사용자마다 <폴더>/<사용자 id>/custom-ai,
   *  <폴더>/<사용자 id>/replays를 쓴다. 로컬 모드는 customAiDir/replayDir을 그대로 쓴다. */
  userDataDir?: string;
  /** 자원 제한 (온라인 서버용). 생략하면 제한 없음(로컬 모드). */
  limits?: ResourceLimits;
}

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

type LobbySetup = { mode: GuiGameMode; opponents: Record<GuiGameMode, string[]>; seed: string; saveReplays: boolean };

/** 한 사용자의 로비 (1.2 2단계). 로컬 모드에서는 서버에 하나(LOCAL_USER_ID)뿐이고, 입장 게이트가 있으면 입장한 사용자마다
 *  하나씩 생긴다. 같은 사용자의 새로고침/다른 탭은 같은 로비를 본다. 서로 다른 사용자의 로비와 대국은 섞이지 않는다. */
interface Room {
  userId: string;
  sseClients: Set<import("node:http").ServerResponse>;
  /** 로비 화면: 처음에는 모드를 고르는 허브, 모드를 고르면 그 모드의 대국 설정. */
  lobbyScreen: "hub" | "setup";
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
        lastSetup: {
          mode: defaults.mode ?? "sanma",
          opponents: {
            sanma: [...(defaults.opponents?.sanma ?? DEFAULT_OPPONENTS.sanma)],
            yonma: [...(defaults.opponents?.yonma ?? DEFAULT_OPPONENTS.yonma)],
          },
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
      };
      rooms.set(userId, room);
    }
    return room;
  }
  const sendToRoom = (room: Room, payload: string): void => {
    for (const res of room.sseClients) res.write(payload);
  };

  /** 대국을 만들고 사람 좌석에 대국을 연 사용자를 앉힌다 (로비 대국은 seat 0만 사람이다. 직접 만든 게임을 여는 createGuiServer는
   *  사람 좌석이 여럿일 수 있고, 모두 로컬 사용자가 둔다). 메시지는 사람 좌석의 사용자 로비로만 간다. */
  function openTable(room: Room, runner: EngineRunner, start: EngineStart, options: GuiServerOptions, startedConfig: StartedGameConfig | null): Table {
    const seatUsers: (string | null)[] = start.controllers.map((c) => (c === "human" ? room.userId : null));
    const deliver = (payload: string): void => {
      for (const userId of new Set(seatUsers)) if (userId !== null) sendToRoom(roomOf(userId), payload);
    };
    // 재생 속도는 대국을 시작한 사용자의 설정을 장면마다 읽는다.
    const table: Table = { host: createGameHost(runner, start, options, deliver, startedConfig, () => room.frameDelayMs), seatUsers };
    leaveTable(room);
    room.table = table;
    return table;
  }

  /** 사용자가 대국을 떠난다 (그만두기, 끝난 대국에서 로비로, 새 대국). 대국을 버려 worker의 메모리도 비운다. */
  function leaveTable(room: Room): void {
    room.table?.host.dispose();
    room.table = null;
  }

  /** 대국 응답: 지금 결정을 요청받은 좌석의 사용자만 보낼 수 있다. */
  async function respondAt(room: Room, response: DecisionResponse): Promise<void> {
    const table = room.table;
    if (!table) throw new Error("GuiServer: 진행 중인 게임이 없습니다");
    const seat = table.host.currentRequestSeat();
    if (seat !== null && table.seatUsers[seat] !== room.userId) throw new Error("GuiServer: 이 결정은 다른 좌석의 차례입니다");
    await table.host.respond(response);
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
    const defaults = { ...lastSetup, opponents: { ...lastSetup.opponents } };
    for (const mode of ["sanma", "yonma"] as const) {
      const picked = defaults.opponents[mode].map((id) => (known.has(id) ? id : null));
      const spare = [...DEFAULT_OPPONENTS[mode], ...officialRoster.map((r) => r.characterId)].filter((id) => !picked.includes(id));
      defaults.opponents[mode] = picked.map((id) => id ?? spare.shift()!);
    }
    return JSON.stringify({
      type: "setup",
      screen: lobbyScreen,
      mode: lastSetup.mode,
      ...(room.notice ? { notice: room.notice } : {}),
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
    return room.table ? room.table.host.connectMessage() : setupMessage(room);
  }

  /** 이 사용자가 진행 중인(끝나지 않았거나 장면 재생 중인) 대국에 앉아 있는지 */
  function inActiveGame(room: Room): boolean {
    if (room.starting) return true;
    const host = room.table?.host;
    return host !== undefined && (host.isPlaying() || host.phase() !== "game_end");
  }

  async function startGame(room: Room, config: GuiGameConfig): Promise<void> {
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    if (inActiveGame(room)) throw new Error("GuiServer: 진행 중인 게임이 있습니다");
    // 이 사용자의 끝난 대국은 새 대국으로 바뀌므로 세지 않는다
    if (limits && openGameCount() - (room.table ? 1 : 0) >= limits.maxOpenGames) {
      throw new Error(`지금은 서버에서 진행 중인 대국이 많습니다 (최대 ${limits.maxOpenGames}판). 잠시 뒤 다시 시도해 주세요`);
    }
    room.notice = null;
    const seed = config.seed ?? `gui-${Date.now()}`;
    room.lastSetup = {
      mode: config.mode,
      opponents: { ...room.lastSetup.opponents, [config.mode]: [...config.opponents] },
      seed: config.seed ?? "",
      saveReplays: config.saveReplays,
    };
    const spec: GameSpec = { mode: config.mode, seed, opponents: config.opponents.map((id) => opponentSpecOf(room, id)) };
    const options: GuiServerOptions = {
      ...(config.saveReplays
        ? {
            replay: {
              label: `human-${config.mode}-${seed}`,
              dir: room.replayDir,
              onSaved: (path: string) => {
                lobby.onReplaySaved?.(path);
                pruneReplays(room.replayDir).catch(() => {});
              },
            },
          }
        : {}),
    };
    const started: StartedGameConfig = { ...config, opponents: [...config.opponents], seed };
    room.starting = true;
    let opened: { runner: EngineRunner; start: EngineStart };
    try {
      opened = lobby.engine ? await lobby.engine.openGame(spec) : InlineEngineRunner.open(gameFromSpec(spec));
    } finally {
      room.starting = false;
    }
    const table = openTable(room, opened.runner, opened.start, options, started);
    lobby.onGameStarted?.(started, room.userId);
    sendToRoom(room, `data: ${table.host.connectMessage()}\n\n`);
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
    const host = room.table?.host;
    if (!host) throw new Error("GuiServer: 진행 중인 대국이 없습니다");
    if (host.phase() === "game_end") throw new Error("GuiServer: 이미 끝난 대국입니다");
    leaveTable(room);
    room.lobbyScreen = "setup";
    sendToRoom(room, `data: ${setupMessage(room)}\n\n`);
  }

  /** 로비 안에서 화면을 옮긴다: 허브로 가거나, 모드를 골라 그 모드의 설정 화면으로 간다. 대국 중에는 할 수 없다. */
  function moveLobby(room: Room, input: unknown): void {
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    if (inActiveGame(room)) throw new Error("GuiServer: 진행 중인 게임이 있습니다");
    const raw = (typeof input === "object" && input !== null ? input : {}) as { screen?: unknown; mode?: unknown };
    room.notice = null;
    if (raw.screen === "hub") {
      room.lobbyScreen = "hub";
    } else if (raw.screen === "setup") {
      room.lastSetup = { ...room.lastSetup, mode: parseGuiMode(typeof raw.mode === "string" ? raw.mode : String(raw.mode)) };
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
      if (!room.table && !room.starting && room.sseClients.size === 0 && idle > limits.idleRoomMs) rooms.delete(room.userId);
    }
  }
  const sweepTimer = limits ? setInterval(sweepIdle, Math.min(60_000, Math.max(1_000, limits.idleGameMs / 2))) : null;
  sweepTimer?.unref();

  /** 서버 전체에서 열려 있는 대국 수 (끝났지만 아직 떠나지 않은 대국 포함, 만드는 중인 대국 포함) */
  function openGameCount(): number {
    let count = 0;
    for (const room of rooms.values()) if (room.table || room.starting) count++;
    return count;
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
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${connectMessage(room)}\n\n`);
      room.sseClients.add(res);
      req.on("close", () => room.sseClients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/respond") {
      readBody(req, res, (body) =>
        reply(res, () => respondAt(room, JSON.parse(body) as DecisionResponse))
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

  server.on("close", () => {
    if (sweepTimer) clearInterval(sweepTimer);
  });

  // 같은 스레드에서 도는 대국만 세션을 돌려준다 (worker 대국은 null)
  return { server, getSession: (userId = LOCAL_USER_ID) => rooms.get(userId)?.table?.host.session ?? null };
}
