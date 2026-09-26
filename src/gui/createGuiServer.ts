/* Factory extracted from server.ts so tests can start/stop a real instance on an ephemeral
 * port without spawning a subprocess - see tests/guiServer.test.ts. server.ts (the `npm run
 * play:gui` entry point) just calls this and listens; no behavior lives only in server.ts. */
import { createServer, type Server } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameState } from "../core/GameState.js";
import { GuiSession, type WatchFrame } from "./guiSession.js";
import { AudioCueTracker, toPublicAction, type AudioCue, type PublicAction } from "./audioCues.js";
import type { DecisionResponse } from "../core/decisions.js";
import { buildGameReplayRecord, replaySeatsFromGame, resolveReplayDir, writeGameReplay, type GameReplayRecord } from "../sim/replayRecorder.js";
import { reproduceReplay, type ReplayReproduction } from "../replay/replayReproduction.js";
import { getCharacterProfile } from "../ai/characterProfiles.js";
import { buildCharacterRoster } from "./characterRoster.js";
import { DEFAULT_PLAYBACK_SPEED, PLAYBACK_FRAME_DELAY_MS, parsePlaybackSpeed } from "./playbackSpeed.js";
import { DEFAULT_OPPONENTS, createGuiGameWithProfiles, parseGuiGameConfig, parseGuiMode, playerCountOf, type GuiGameConfig, type GuiGameMode } from "./gameSetup.js";
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

/** 한 게임(GameState 하나)을 GuiSession으로 진행하며 SSE 메시지를 만든다. HTTP 서버는 이것을 게임마다 새로 만든다. */
interface GameHost {
  session: GuiSession;
  connectMessage(): string;
  isPlaying(): boolean;
  respond(response: DecisionResponse): void;
  continueToNextHand(): void;
  /** 대국 그만두기: 이후 이 호스트는 아무 메시지도 보내지 않는다 (재생 중이던 장면 타이머 포함). 리플레이는 저장하지 않는다. */
  dispose(): void;
}

/** 시작 화면에서 시작한 대국의 구성 (실제로 쓰인 시드 포함). 종료 화면의 "다시 하기"가 이것을 그대로 /start에 보낸다. */
export type StartedGameConfig = GuiGameConfig & { seed: string };

/** `startedConfig`: 시작 화면이 있는 서버에서 시작한 대국이면 그 구성. 있으면 종료 화면에 새 대국/다시 하기 버튼이 나온다. */
/** `frameDelayMs`: 재생 속도 설정. 서버 단위 값이라 장면마다 새로 읽는다 (재생 중에 바꾸면 다음 장면부터 적용). */
function createGameHost(
  game: GameState,
  options: GuiServerOptions,
  broadcast: (payload: string) => void,
  startedConfig: StartedGameConfig | null,
  frameDelayMs: () => number
): GameHost {
  const session = new GuiSession(game);
  /** 가장 최근 장면(화료/유국 포함)의 사람 좌석 view. 국/게임 종료 상태를 새로고침으로 다시 받을 때 작탁을 그 상태로 다시 그리는 데 쓴다. */
  let lastFrameView: WatchFrame["view"] | null = session.takeFrames().at(-1)?.view ?? null; // 접속 전의 AI 턴은 재생하지 않는다
  /** 시작 화면이 있는 서버에서 시작한 대국만 도중에 그만두고 로비로 돌아갈 수 있다. */
  const canAbandon = startedConfig !== null;
  let disposed = false;
  let lastRequestView: WatchFrame["view"] | null = null;

  let replaySaved = false;
  function saveReplayIfFinished(): void {
    if (!options.replay || replaySaved || session.getPhase() !== "game_end") return;
    replaySaved = true;
    const record = buildGameReplayRecord(game, options.replay.label, 0, replaySeatsFromGame(game));
    const path = writeGameReplay(record, options.replay.dir ?? "replays");
    options.replay.onSaved?.(path);
  }

  // Identity-only, presentation-layer detail: `game.characterProfiles` is already public
  // (see GameState's controller/identity separation) - this just forwards each seat's
  // display name (or null when that seat has no character profile) so the client never
  // hardcodes a name and never confuses "who this seat is" with "who controls it".
  const characterNames: (string | null)[] = game.characterProfiles.map((p) => p?.displayName ?? null);

  // 효과음 신호: game.log를 서버에서 공개 정보만 담은 AudioCue로 바꿔 보낸다 (audioCues.ts).
  // 접속 전에 이미 쌓인 신호는 "과거"이므로 다시 재생하지 않는다.
  const cueTracker = new AudioCueTracker(game.log);
  cueTracker.sync();
  let lastBroadcastSeq = cueTracker.latestSeq();

  /** 장면 재생 중에는 사람이 응답할 수 없다 (클라이언트는 아직 요청을 받지 못했다). */
  let playing = false;
  let lastWatchMessage: string | null = null;
  /** 최근 행동 목록을 만들 때 어디까지 읽었는지 (game.log 인덱스) */
  let actionLogIndex = game.log.length;

  function currentStateMessage(extra: { cues: AudioCue[]; cueBase?: number }): string {
    const phase = session.getPhase();
    // 종료 화면 뒤에 그릴 작탁: 마지막 장면, 없으면 마지막 결정 요청의 view (사람 좌석 view라 숨은 정보가 없다)
    const view = lastFrameView ?? lastRequestView;
    if (phase === "game_end") {
      // 순위/우마는 엔진의 computeFinalStandings() 결과를 그대로 보낸다 (GUI가 따로 정렬하지 않는다).
      return JSON.stringify({
        type: "game_end",
        event: session.getGameEndEvent(),
        handEvent: session.getHandEndEvent(),
        standings: game.computeFinalStandings(),
        characterNames,
        ...(view ? { view } : {}),
        canStartNewGame: startedConfig !== null,
        ...(startedConfig ? { gameConfig: startedConfig } : {}),
        ...extra,
      });
    }
    if (phase === "hand_end") {
      return JSON.stringify({ type: "hand_end", event: session.getHandEndEvent(), ...(view ? { view } : {}), characterNames, canAbandon, ...extra });
    }
    const request = session.getCurrentRequest();
    if (request) lastRequestView = request.view;
    return JSON.stringify({ type: "decision", request, characterNames, canAbandon, ...extra });
  }

  /** 새로 접속한 클라이언트: 과거 신호는 보내지 않고, 현재 seq만 기준점(cueBase)으로 알려준다. */
  function connectMessage(): string {
    // 아직 꺼내지 않은 장면이 있으면(응답 처리 밖에서 세션이 진행된 경우) 새 접속에는 재생하지 않되 마지막 상태로는 반영한다
    if (!playing) {
      const pending = session.takeFrames();
      if (pending.length > 0) lastFrameView = pending.at(-1)!.view;
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
      const a = toPublicAction(game.log[actionLogIndex]!);
      if (a) actions.push(a);
    }
    // 방금 버려진 패의 주인 (론이면 방총자): 그 패를 강조하는 데 쓴다
    let latestDiscardSeat: number | null = null;
    for (let i = frame.logLength - 1; i >= 0; i--) {
      const e = game.log[i]!;
      if (e.type === "discard") { latestDiscardSeat = e.player; break; }
      if (e.type === "hand_start") break;
    }
    const message = JSON.stringify({ type: "watch", view: frame.view, actor: frame.actor, latestDiscardSeat, actions, characterNames, canAbandon, cues });
    lastHold = frameDelayMs() * holdMultiplier(actions);
    return message;
  }
  let lastHold = 0;

  /** 응답 처리 뒤 상태를 보낸다. 그 사이 AI 턴이 있었다면 한 수씩 간격을 두고 보여준 다음 최종 상태를 보낸다. */
  function broadcastAfterAction(): void {
    const frames = session.takeFrames();
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

  return {
    session,
    connectMessage,
    isPlaying: () => playing,
    respond(response) {
      if (playing) throw new Error("GuiServer: 장면 재생 중에는 응답할 수 없습니다");
      session.respond(response);
      saveReplayIfFinished();
      broadcastAfterAction();
    },
    continueToNextHand() {
      if (playing) throw new Error("GuiServer: 장면 재생 중에는 진행할 수 없습니다");
      session.continueToNextHand();
      broadcastAfterAction();
    },
    dispose() {
      disposed = true;
      playing = false;
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
  onGameStarted?: (config: StartedGameConfig) => void;
  /** 온라인 입장 게이트. 지정하면 초대 코드와 닉네임으로 입장한 브라우저만 로비/대국/API를 쓸 수 있다 (accessGate.ts).
   *  생략하면 지금까지처럼 누구나 쓰는 로컬 모드다. */
  access?: AccessGate;
}

export interface GuiLobbyServerHandle {
  server: Server;
  /** 진행 중인 게임의 세션 (시작 화면에서는 null) */
  getSession(): GuiSession | null;
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

function buildServer(initial: { game: GameState; options: GuiServerOptions } | null, lobby: GuiLobbyOptions | null): GuiLobbyServerHandle {
  const sseClients = new Set<import("node:http").ServerResponse>();
  const broadcast = (payload: string): void => {
    for (const res of sseClients) res.write(payload);
  };
  let frameDelayMs = (initial ? initial.options.frameDelayMs : lobby?.frameDelayMs) ?? DEFAULT_FRAME_DELAY_MS;
  const currentFrameDelayMs = (): number => frameDelayMs;
  let host: GameHost | null = initial ? createGameHost(initial.game, initial.options, broadcast, null, currentFrameDelayMs) : null;

  // 리플레이 뷰어: 이 서버가 리플레이를 저장하는 폴더를 그대로 읽는다 (기본 "replays", 프로젝트 루트 기준).
  const replayDir = resolveReplayDir((initial ? initial.options.replay?.dir : lobby?.replayDir) ?? "replays");
  /** 재현은 한 판에 수 초 걸리므로 파일(이름+수정 시각)별로 결과를 캐시한다. */
  const reproductionCache = new Map<string, { mtimeMs: number; body: string }>();

  async function listReplays(): Promise<{ name: string; size: number; modified: number }[]> {
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

  async function replayBody(name: string): Promise<string> {
    if (!REPLAY_FILE_NAME.test(name)) throw new Error("리플레이 파일 이름이 올바르지 않습니다");
    const filePath = join(replayDir, name);
    const st = await stat(filePath);
    const cached = reproductionCache.get(name);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.body;
    const record = JSON.parse(await readFile(filePath, "utf-8")) as GameReplayRecord;
    const reproduction: ReplayReproduction = reproduceReplay(record);
    const seats = Array.isArray(record.meta?.seats) ? record.meta.seats : [];
    const body = JSON.stringify({
      name,
      meta: record.meta ? { gameSeed: record.meta.gameSeed, rules: { playerCount: record.meta.rules?.playerCount }, replaySchemaVersion: record.meta.replaySchemaVersion ?? 1 } : null,
      seatNames: seats.map(replaySeatName),
      seatKinds: seats.map((s) => s.kind),
      reproduction,
    });
    reproductionCache.set(name, { mtimeMs: st.mtimeMs, body });
    return body;
  }

  const officialRoster = lobby ? buildCharacterRoster() : [];
  const customAiStore = lobby ? new CustomAiStore(lobby.customAiDir ?? "custom-ai") : null;

  /** 시작 화면 목록: 등록 캐릭터 + 검증을 통과한 CustomAI (CustomAI에는 설명/태그를 자동으로 만들지 않는다). */
  function currentRoster() {
    const customs = (customAiStore?.list() ?? []).flatMap((e) =>
      e.ok ? [{ characterId: customAiCharacterId(e.definition.id), displayName: e.definition.name, summary: "", tags: [] as string[], custom: true }] : []
    );
    return [...officialRoster, ...customs];
  }

  /** 대국 상대 id -> 프로필. CustomAI는 게임을 시작하는 순간 파일에서 읽어 검증한 값이 그 대국의 스냅샷이 된다. */
  function resolveOpponentProfile(id: string): CharacterProfile {
    if (isCustomAiCharacterId(id)) {
      if (!customAiStore) throw new Error("이 서버에서는 CustomAI를 쓸 수 없습니다");
      return customAiToProfile(customAiStore.get(id.slice(CUSTOM_AI_CHARACTER_PREFIX.length)));
    }
    return getCharacterProfile(id);
  }
  const defaults = lobby?.defaults ?? {};
  /** 시작 화면에 채워 둘 값: 처음에는 CLI 기본값, 한 판을 한 뒤에는 마지막으로 고른 구성 */
  let lastSetup = {
    mode: defaults.mode ?? "sanma",
    opponents: {
      sanma: [...(defaults.opponents?.sanma ?? DEFAULT_OPPONENTS.sanma)],
      yonma: [...(defaults.opponents?.yonma ?? DEFAULT_OPPONENTS.yonma)],
    } as Record<GuiGameMode, string[]>,
    seed: defaults.seed ?? "",
    saveReplays: defaults.saveReplays ?? false,
  };

  /** 로비 화면: 처음에는 모드를 고르는 허브, 모드를 고르면 그 모드의 대국 설정. 새로고침/다른 탭도 같은 화면을 보도록 서버가 들고 있다.
   *  설정 화면은 모드와 무관하게 하나이며, 어떤 모드인지는 lastSetup.mode(데이터)로만 다르다. */
  let lobbyScreen: "hub" | "setup" = "hub";

  function setupMessage(): string {
    const roster = currentRoster();
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

  function connectMessage(): string {
    return host ? host.connectMessage() : setupMessage();
  }

  function startGame(config: GuiGameConfig): void {
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    if (host && (host.isPlaying() || host.session.getPhase() !== "game_end")) throw new Error("GuiServer: 진행 중인 게임이 있습니다");
    const seed = config.seed ?? `gui-${Date.now()}`;
    lastSetup = {
      mode: config.mode,
      opponents: { ...lastSetup.opponents, [config.mode]: [...config.opponents] },
      seed: config.seed ?? "",
      saveReplays: config.saveReplays,
    };
    const game = createGuiGameWithProfiles(config.mode, seed, config.opponents.map(resolveOpponentProfile));
    const options: GuiServerOptions = {
      ...(config.saveReplays
        ? {
            replay: {
              label: `human-${config.mode}-${seed}`,
              ...(lobby.replayDir !== undefined ? { dir: lobby.replayDir } : {}),
              ...(lobby.onReplaySaved ? { onSaved: lobby.onReplaySaved } : {}),
            },
          }
        : {}),
    };
    const started: StartedGameConfig = { ...config, opponents: [...config.opponents], seed };
    host = createGameHost(game, options, broadcast, started, currentFrameDelayMs);
    lobby.onGameStarted?.(started);
    broadcast(`data: ${host.connectMessage()}\n\n`);
  }

  function returnToSetup(): void {
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    if (host && (host.isPlaying() || host.session.getPhase() !== "game_end")) throw new Error("GuiServer: 게임이 끝난 뒤에만 시작 화면으로 돌아갈 수 있습니다");
    host = null;
    lobbyScreen = "setup"; // 마지막으로 사용한 모드(lastSetup.mode)의 설정 화면으로 돌아간다
    broadcast(`data: ${setupMessage()}\n\n`);
  }

  /** 진행 중인 대국을 그만두고 그 모드의 설정 화면(로비)으로 돌아간다. 리플레이는 저장하지 않는다(저장은 게임 종료 때만 한다).
   *  게임이 이미 끝났다면 "설정 바꾸기"(/setup)를 쓴다. */
  function abandonGame(): void {
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    if (!host) throw new Error("GuiServer: 진행 중인 대국이 없습니다");
    if (host.session.getPhase() === "game_end") throw new Error("GuiServer: 이미 끝난 대국입니다");
    host.dispose();
    host = null;
    lobbyScreen = "setup";
    broadcast(`data: ${setupMessage()}\n\n`);
  }

  /** 로비 안에서 화면을 옮긴다: 허브로 가거나, 모드를 골라 그 모드의 설정 화면으로 간다. 대국 중에는 할 수 없다. */
  function moveLobby(input: unknown): void {
    if (!lobby) throw new Error("GuiServer: 이 서버는 시작 화면을 쓰지 않습니다");
    if (host && (host.isPlaying() || host.session.getPhase() !== "game_end")) throw new Error("GuiServer: 진행 중인 게임이 있습니다");
    const raw = (typeof input === "object" && input !== null ? input : {}) as { screen?: unknown; mode?: unknown };
    if (raw.screen === "hub") {
      lobbyScreen = "hub";
    } else if (raw.screen === "setup") {
      lastSetup = { ...lastSetup, mode: parseGuiMode(typeof raw.mode === "string" ? raw.mode : String(raw.mode)) };
      lobbyScreen = "setup";
    } else {
      throw new Error('screen은 "hub" 또는 "setup"이어야 합니다');
    }
    host = null;
    broadcast(`data: ${setupMessage()}\n\n`);
  }

  /** CustomAI 편집 화면용 목록: 스키마(표시 이름/설명/범위)와 저장된 CustomAI(검증 실패 파일은 이유만). */
  function customAiListBody(): string {
    return JSON.stringify({
      schema: {
        nameMax: CUSTOM_AI_NAME_MAX,
        min: SLIDER_MIN,
        max: SLIDER_MAX,
        fields: CUSTOM_AI_FIELDS.map((f) => ({ key: f.key, group: f.group, label: f.label, description: f.description, initial: f.initial })),
      },
      entries: (customAiStore?.list() ?? []).map((e) =>
        e.ok
          ? { ok: true, id: e.definition.id, characterId: customAiCharacterId(e.definition.id), name: e.definition.name, style: e.definition.style, notices: customAiNotices(e.definition.style) }
          : { ok: false, file: e.file, reason: e.reason }
      ),
    });
  }

  /** CustomAI가 바뀌면 시작 화면이 떠 있는 클라이언트에 새 목록을 보낸다. */
  function refreshSetupRoster(): void {
    if (!host) broadcast(`data: ${setupMessage()}\n\n`);
  }

  function handleCustomAi(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, pathname: string): void {
    const json = (status: number, body: string) => res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(body);
    const error = (err: unknown) => res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(String(err instanceof Error ? err.message : err));
    if (!customAiStore) {
      res.writeHead(404).end("Not found");
      return;
    }
    const store = customAiStore;
    const rest = pathname.slice("/api/custom-ai".length).split("/").filter(Boolean); // [] | [id] | [id, "duplicate"]
    if (req.method === "GET" && rest.length === 0) {
      json(200, customAiListBody());
      return;
    }
    readBody(req, (body) => {
      try {
        let result: unknown;
        if (req.method === "POST" && rest.length === 0) result = store.create(JSON.parse(body));
        else if (req.method === "PUT" && rest.length === 1) result = store.update(rest[0]!, JSON.parse(body));
        else if (req.method === "POST" && rest.length === 2 && rest[1] === "duplicate") result = store.duplicate(rest[0]!);
        else if (req.method === "DELETE" && rest.length === 1) {
          store.delete(rest[0]!);
          result = { deleted: rest[0] };
        } else {
          res.writeHead(405).end("Method not allowed");
          return;
        }
        refreshSetupRoster();
        json(200, JSON.stringify(result));
      } catch (err) {
        error(err);
      }
    });
  }

  function readBody(req: import("node:http").IncomingMessage, onBody: (body: string) => void): void {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => onBody(body));
  }

  function reply(res: import("node:http").ServerResponse, action: () => void): void {
    try {
      action();
      res.writeHead(204).end();
    } catch (err) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end(String(err instanceof Error ? err.message : err));
    }
  }


  const access = lobby?.access ?? null;

  /** 입장 게이트: 입장 화면/입장 요청은 통과시키고, 입장하지 않은 요청은 페이지면 입장 화면으로 보내고 나머지는 401로 막는다.
   *  요청을 여기서 끝냈으면 true. */
  function handleAccess(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, pathname: string): boolean {
    if (!access) return false;
    if (req.method === "POST" && pathname === "/join") {
      readBody(req, (body) => {
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

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (handleAccess(req, res, url.pathname)) return;

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${connectMessage()}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/respond") {
      readBody(req, (body) =>
        reply(res, () => {
          if (!host) throw new Error("GuiServer: 진행 중인 게임이 없습니다");
          host.respond(JSON.parse(body) as DecisionResponse);
        })
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/continue") {
      reply(res, () => {
        if (!host) throw new Error("GuiServer: 진행 중인 게임이 없습니다");
        host.continueToNextHand();
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/start") {
      readBody(req, (body) => reply(res, () => startGame(parseGuiGameConfig(JSON.parse(body), resolveOpponentProfile))));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/replays") {
      listReplays()
        .then((files) => res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(files)))
        .catch((err) => res.writeHead(500, { "Content-Type": "text/plain" }).end(String(err instanceof Error ? err.message : err)));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/replays/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/replays/".length));
      replayBody(name)
        .then((body) => res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(body))
        .catch((err) => res.writeHead(REPLAY_FILE_NAME.test(name) ? 404 : 400, { "Content-Type": "text/plain" }).end(String(err instanceof Error ? err.message : err)));
      return;
    }

    if (url.pathname === "/api/custom-ai" || url.pathname.startsWith("/api/custom-ai/")) {
      handleCustomAi(req, res, url.pathname);
      return;
    }

    if (req.method === "POST" && url.pathname === "/speed") {
      readBody(req, (body) =>
        reply(res, () => {
          const { speed } = JSON.parse(body) as { speed?: unknown };
          frameDelayMs = PLAYBACK_FRAME_DELAY_MS[parsePlaybackSpeed(speed)];
        })
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/abandon") {
      reply(res, abandonGame);
      return;
    }

    if (req.method === "POST" && url.pathname === "/lobby") {
      readBody(req, (body) => reply(res, () => moveLobby(JSON.parse(body || "{}"))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/setup") {
      reply(res, returnToSetup);
      return;
    }

    if (req.method === "GET") {
      const relative = url.pathname === "/" ? "/index.html" : url.pathname;
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
      return;
    }

    res.writeHead(405).end("Method not allowed");
  });

  return { server, getSession: () => host?.session ?? null };
}
