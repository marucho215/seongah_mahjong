/* Factory extracted from server.ts so tests can start/stop a real instance on an ephemeral
 * port without spawning a subprocess - see tests/guiServer.test.ts. server.ts (the `npm run
 * play:gui` entry point) just calls this and listens; no behavior lives only in server.ts. */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameState } from "../core/GameState.js";
import { GuiSession } from "./guiSession.js";
import { AudioCueTracker, type AudioCue } from "./audioCues.js";
import type { DecisionResponse } from "../core/decisions.js";

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

/** Builds (but does not start listening) an http.Server driving `game` via one GuiSession -
 *  one human seat, continuing across every hand of the game on the same GameState until
 *  GuiSession reaches "game_end" (see GuiSession's own doc comment for the phase model). */
export function createGuiServer(game: GameState): GuiServerHandle {
  const session = new GuiSession(game);
  const sseClients = new Set<import("node:http").ServerResponse>();

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
    return currentStateMessage({ cues: [], cueBase: cueTracker.latestSeq() });
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
          session.respond(response);
          broadcastState();
          res.writeHead(204).end();
        } catch (err) {
          res.writeHead(400, { "Content-Type": "text/plain" }).end(String(err instanceof Error ? err.message : err));
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/continue") {
      try {
        session.continueToNextHand();
        broadcastState();
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
