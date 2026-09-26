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
import { DEFAULT_OPPONENTS, createGuiGame, parseGuiGameConfig, playerCountOf, type GuiGameConfig, type GuiGameMode } from "./gameSetup.js";

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
const NO_STORE_FILES = new Set(["/index.html", "/app.js", "/audioManager.js", "/style.css", "/replay.html", "/replay.js"]);

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
  session.takeFrames(); // 접속 전의 AI 턴은 재생하지 않는다

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
    if (phase === "game_end") {
      // 순위/우마는 엔진의 computeFinalStandings() 결과를 그대로 보낸다 (GUI가 따로 정렬하지 않는다).
      return JSON.stringify({
        type: "game_end",
        event: session.getGameEndEvent(),
        handEvent: session.getHandEndEvent(),
        standings: game.computeFinalStandings(),
        characterNames,
        canStartNewGame: startedConfig !== null,
        ...(startedConfig ? { gameConfig: startedConfig } : {}),
        ...extra,
      });
    }
    if (phase === "hand_end") {
      return JSON.stringify({ type: "hand_end", event: session.getHandEndEvent(), characterNames, ...extra });
    }
    return JSON.stringify({ type: "decision", request: session.getCurrentRequest(), characterNames, ...extra });
  }

  /** 새로 접속한 클라이언트: 과거 신호는 보내지 않고, 현재 seq만 기준점(cueBase)으로 알려준다. */
  function connectMessage(): string {
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
    const message = JSON.stringify({ type: "watch", view: frame.view, actor: frame.actor, latestDiscardSeat, actions, characterNames, cues });
    lastHold = frameDelayMs() * holdMultiplier(actions);
    return message;
  }
  let lastHold = 0;

  /** 응답 처리 뒤 상태를 보낸다. 그 사이 AI 턴이 있었다면 한 수씩 간격을 두고 보여준 다음 최종 상태를 보낸다. */
  function broadcastAfterAction(): void {
    const frames = session.takeFrames();
    if (frameDelayMs() <= 0 || frames.length === 0) {
      broadcastState();
      return;
    }
    playing = true;
    let i = 0;
    const step = (): void => {
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
  };
}

/** 시작 화면(대국 설정)부터 여는 서버의 옵션. 설정 화면의 초기값과, 게임마다 쓸 리플레이 저장 위치를 받는다. */
export interface GuiLobbyOptions {
  frameDelayMs?: number;
  /** 시작 화면 초기값 (CLI 인자에서 온다). opponents를 생략하면 모드별 기본 상대. */
  defaults?: { mode?: GuiGameMode; seed?: string; saveReplays?: boolean; opponents?: Partial<Record<GuiGameMode, string[]>> };
  replayDir?: string;
  onReplaySaved?: (path: string) => void;
  onGameStarted?: (config: StartedGameConfig) => void;
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

  const roster = lobby ? buildCharacterRoster() : [];
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

  function setupMessage(): string {
    return JSON.stringify({
      type: "setup",
      roster,
      playerCounts: { sanma: playerCountOf("sanma"), yonma: playerCountOf("yonma") },
      defaults: lastSetup,
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
    const game = createGuiGame(config.mode, seed, config.opponents);
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
    broadcast(`data: ${setupMessage()}\n\n`);
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


  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

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
      readBody(req, (body) => reply(res, () => startGame(parseGuiGameConfig(JSON.parse(body)))));
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

    if (req.method === "POST" && url.pathname === "/speed") {
      readBody(req, (body) =>
        reply(res, () => {
          const { speed } = JSON.parse(body) as { speed?: unknown };
          frameDelayMs = PLAYBACK_FRAME_DELAY_MS[parsePlaybackSpeed(speed)];
        })
      );
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
