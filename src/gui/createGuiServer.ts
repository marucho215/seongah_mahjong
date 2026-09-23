/* Factory extracted from server.ts so tests can start/stop a real instance on an ephemeral
 * port without spawning a subprocess - see tests/guiServer.test.ts. server.ts (the `npm run
 * play:gui` entry point) just calls this and listens; no behavior lives only in server.ts. */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameState } from "../core/GameState.js";
import { GuiSession } from "./guiSession.js";
import type { DecisionResponse } from "../core/decisions.js";

export const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/plain; charset=utf-8",
};

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

  function currentStateMessage(): string {
    const phase = session.getPhase();
    if (phase === "game_end") {
      return JSON.stringify({ type: "game_end", event: session.getGameEndEvent(), handEvent: session.getHandEndEvent(), characterNames });
    }
    if (phase === "hand_end") {
      return JSON.stringify({ type: "hand_end", event: session.getHandEndEvent(), characterNames });
    }
    return JSON.stringify({ type: "decision", request: session.getCurrentRequest(), characterNames });
  }

  function broadcastState(): void {
    const payload = `data: ${currentStateMessage()}\n\n`;
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
      res.write(`data: ${currentStateMessage()}\n\n`);
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
          res.writeHead(200, { "Content-Type": contentType }).end(data);
        })
        .catch(() => res.writeHead(404).end("Not found"));
      return;
    }

    res.writeHead(405).end("Method not allowed");
  });

  return { server, session };
}
