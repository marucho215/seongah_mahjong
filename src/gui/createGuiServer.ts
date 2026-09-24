/* Factory extracted from server.ts so tests can start/stop a real instance on an ephemeral
 * port without spawning a subprocess - see tests/guiServer.test.ts. server.ts (the `npm run
 * play:gui` entry point) just calls this and listens; no behavior lives only in server.ts. */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameState } from "../core/GameState.js";
import { GuiSession, type WatchFrame } from "./guiSession.js";
import { AudioCueTracker, toPublicAction, type AudioCue, type PublicAction } from "./audioCues.js";
import type { DecisionResponse } from "../core/decisions.js";
import { buildGameReplayRecord, replaySeatsFromGame, writeGameReplay } from "../sim/replayRecorder.js";

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
const NO_STORE_FILES = new Set(["/index.html", "/app.js", "/audioManager.js", "/style.css"]);

export interface GuiServerHandle {
  server: Server;
  session: GuiSession;
}

export interface GuiServerOptions {
  /** 지정하면 게임이 끝날 때(game_end) 이 대국의 리플레이 JSON을 기존 AI 리플레이와 같은 형식/규칙으로 한 번 저장한다.
   *  파일: <dir>/<label>_game0.json (dir 기본 "replays" = 프로젝트 루트 기준). 서버가 게임 도중 종료되면 저장되지 않는다. */
  replay?: { label: string; dir?: string; onSaved?: (path: string) => void };
  /** 일반 타패 한 장면을 보여주는 기본 시간(ms). 울기/리치/화료는 이것의 배수만큼 더 오래 보여준다.
   *  0이면 장면 재생 없이 곧바로 다음 상태만 보낸다. */
  frameDelayMs?: number;
}

export const DEFAULT_FRAME_DELAY_MS = 400;

/** 장면 종류별 유지 시간 배수: 타패 x1 / 울기·북 x1.5 / 리치 x2.2 / 쯔모 x2.5 / 론 x3 (론은 결과창 전에 충분히 보여준다). */
function holdMultiplier(actions: PublicAction[]): number {
  const kinds = new Set(actions.map((a) => a.action));
  if (kinds.has("ron")) return 3;
  if (kinds.has("tsumo")) return 2.5;
  if (kinds.has("riichi")) return 2.2;
  if (kinds.has("chi") || kinds.has("pon") || kinds.has("kan") || kinds.has("kita")) return 1.5;
  return 1;
}

/** Builds (but does not start listening) an http.Server driving `game` via one GuiSession -
 *  one human seat, continuing across every hand of the game on the same GameState until
 *  GuiSession reaches "game_end" (see GuiSession's own doc comment for the phase model). */
export function createGuiServer(game: GameState, options: GuiServerOptions = {}): GuiServerHandle {
  const frameDelayMs = options.frameDelayMs ?? DEFAULT_FRAME_DELAY_MS;
  const session = new GuiSession(game);
  session.takeFrames(); // 접속 전의 AI 턴은 재생하지 않는다
  const sseClients = new Set<import("node:http").ServerResponse>();

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
      return JSON.stringify({ type: "game_end", event: session.getGameEndEvent(), handEvent: session.getHandEndEvent(), characterNames, ...extra });
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
    lastHold = frameDelayMs * holdMultiplier(actions);
    return message;
  }
  let lastHold = 0;

  /** 응답 처리 뒤 상태를 보낸다. 그 사이 AI 턴이 있었다면 한 수씩 간격을 두고 보여준 다음 최종 상태를 보낸다. */
  function broadcastAfterAction(): void {
    const frames = session.takeFrames();
    if (frameDelayMs <= 0 || frames.length === 0) {
      broadcastState();
      return;
    }
    playing = true;
    let i = 0;
    const step = (): void => {
      if (i < frames.length) {
        lastWatchMessage = watchMessage(frames[i++]!);
        const payload = `data: ${lastWatchMessage}\n\n`;
        for (const res of sseClients) res.write(payload);
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
    const payload = `data: ${currentStateMessage({ cues })}\n\n`;
    for (const res of sseClients) res.write(payload);
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
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const response = JSON.parse(body) as DecisionResponse;
          if (playing) throw new Error("GuiServer: 장면 재생 중에는 응답할 수 없습니다");
          session.respond(response);
          saveReplayIfFinished();
          broadcastAfterAction();
          res.writeHead(204).end();
        } catch (err) {
          res.writeHead(400, { "Content-Type": "text/plain" }).end(String(err instanceof Error ? err.message : err));
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/continue") {
      try {
        if (playing) throw new Error("GuiServer: 장면 재생 중에는 진행할 수 없습니다");
        session.continueToNextHand();
        broadcastAfterAction();
        res.writeHead(204).end();
      } catch (err) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(String(err instanceof Error ? err.message : err));
      }
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

  return { server, session };
}
