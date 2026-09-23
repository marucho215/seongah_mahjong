import { describe, expect, it, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import { collectAllInvariantViolations } from "../src/validation/invariants.js";
import { createGuiServer } from "../src/gui/createGuiServer.js";

function newHumanGame(seed: string): GameState {
  return new GameState({
    rules: DEFAULT_SANMA_RULES,
    seed,
    characterProfiles: [null, getCharacterProfile("jegalmina"), getCharacterProfile("jegalnahui")],
    controllers: ["human", undefined, undefined],
  });
}

/** Reads exactly one SSE "data: ..." message from an open fetch stream's reader and parses
 *  it as JSON - good enough for this test's single-client, one-message-at-a-time usage. */
async function readOneSseMessage(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { text: string }): Promise<unknown> {
  while (true) {
    const lineMatch = /data: (.*)\n\n/.exec(buffer.text);
    if (lineMatch) {
      buffer.text = buffer.text.slice(lineMatch.index + lineMatch[0].length);
      return JSON.parse(lineMatch[1]!);
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE stream ended before a full message arrived");
    buffer.text += Buffer.from(value).toString("utf-8");
  }
}

async function startServer(game: GameState): Promise<{ baseUrl: string; close: () => Promise<void>; getSession: () => ReturnType<typeof createGuiServer>["session"] }> {
  const { server, session } = createGuiServer(game);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://localhost:${port}`,
    getSession: () => session,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections(); // defense-in-depth: a leaked SSE connection would otherwise hang close() forever
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("GUI HTTP/SSE server (createGuiServer)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  it("serves the static client shell and tile assets", async () => {
    const { baseUrl, close } = await startServer(newHumanGame("gui-http-static"));
    cleanup = close;

    const index = await fetch(`${baseUrl}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");

    const tile = await fetch(`${baseUrl}/assets/mahjong/regular/Man1.svg`);
    expect(tile.status).toBe(200);
    expect(tile.headers.get("content-type")).toContain("image/svg+xml");
    const svgText = await tile.text();
    expect(svgText).toContain("<svg");
  });

  it("marks the frequently edited frontend files no-store, but not the tile assets", async () => {
    const { baseUrl, close } = await startServer(newHumanGame("gui-http-cache"));
    cleanup = close;
    for (const path of ["/", "/index.html", "/app.js", "/style.css"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      await res.arrayBuffer();
    }
    const tile = await fetch(`${baseUrl}/assets/mahjong/regular/Man1.svg`);
    expect(tile.headers.get("cache-control")).toBeNull();
    await tile.arrayBuffer();
  });

  it("rejects path traversal outside the public directory", async () => {
    const { baseUrl, close } = await startServer(newHumanGame("gui-http-traversal"));
    cleanup = close;
    const res = await fetch(`${baseUrl}/../../package.json`);
    expect([403, 404]).toContain(res.status);
  });

  it("plays a full hand end-to-end over real HTTP + SSE, with zero invariant violations and no opponent concealed leak", async () => {
    const game = newHumanGame("gui-http-full-hand");
    const { baseUrl, close, getSession } = await startServer(game);
    cleanup = close;

    const sseRes = await fetch(`${baseUrl}/events`);
    const reader = sseRes.body!.getReader();
    const buffer = { text: "" };

    let steps = 0;
    while (true) {
      const msg = await readOneSseMessage(reader, buffer) as { type: string; request?: any; event?: unknown };
      if (msg.type === "hand_end" || msg.type === "game_end") break;
      expect(msg.type).toBe("decision");
      const request = msg.request;
      // The wire payload is exactly PlayerView/DecisionRequest - confirm no opponent
      // concealed tile field ever crosses the HTTP boundary.
      for (const opponent of request.view.opponents) {
        expect(opponent).not.toHaveProperty("concealedTiles");
      }
      const response = request.type === "discard"
        ? { type: "discard", tileId: request.legalTileIds[0], declareRiichi: false }
        : { type: request.type, declare: false };
      const postRes = await fetch(`${baseUrl}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response),
      });
      expect(postRes.status).toBe(204);
      steps++;
      if (steps > 2000) throw new Error("runaway loop guard triggered");
    }

    await reader.cancel(); // otherwise the still-open SSE connection keeps server.close() (in afterEach) pending forever
    expect(getSession().getPhase()).not.toBe("decision");
    expect(game.log.some((e) => e.type === "hand_end")).toBe(true);
    const violations = collectAllInvariantViolations({ rules: DEFAULT_SANMA_RULES, events: game.log });
    expect(violations).toEqual([]);
  }, 120000);

  it("continues to a second hand over HTTP via POST /continue, on the same GameState", async () => {
    const game = newHumanGame("gui-http-continue");
    const { baseUrl, close, getSession } = await startServer(game);
    cleanup = close;

    const sseRes = await fetch(`${baseUrl}/events`);
    const reader = sseRes.body!.getReader();
    const buffer = { text: "" };

    async function driveOneHandOverHttp(): Promise<string> {
      let steps = 0;
      for (;;) {
        const msg = (await readOneSseMessage(reader, buffer)) as { type: string; request?: any };
        if (msg.type === "hand_end" || msg.type === "game_end") return msg.type;
        const request = msg.request;
        const response = request.type === "discard"
          ? { type: "discard", tileId: request.legalTileIds[0], declareRiichi: false }
          : { type: request.type, declare: false };
        const postRes = await fetch(`${baseUrl}/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(response),
        });
        expect(postRes.status).toBe(204);
        steps++;
        if (steps > 2000) throw new Error("runaway loop guard triggered");
      }
    }

    const firstOutcome = await driveOneHandOverHttp();
    expect(firstOutcome).toBe("hand_end"); // this seed doesn't end the game on hand 1
    const handIndexAfterFirst = game.handIndex;

    const continueRes = await fetch(`${baseUrl}/continue`, { method: "POST" });
    expect(continueRes.status).toBe(204);
    expect(getSession().getPhase()).toBe("decision");

    await driveOneHandOverHttp();

    // Same GameState the whole time - handIndex advanced, no fresh game was ever constructed.
    expect(game.handIndex).toBe(handIndexAfterFirst + 1);
    expect(game.log.filter((e) => e.type === "hand_start").length).toBeGreaterThanOrEqual(2);

    await reader.cancel();
    const violations = collectAllInvariantViolations({ rules: DEFAULT_SANMA_RULES, events: game.log });
    expect(violations).toEqual([]);
  }, 120000);

  it("rejects a premature POST /continue (a decision is still pending) with a 400", async () => {
    const { baseUrl, close } = await startServer(newHumanGame("gui-http-continue-too-early"));
    cleanup = close;

    const res = await fetch(`${baseUrl}/continue`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("rejects an illegal discard response over HTTP with a 400, instead of silently corrupting the hand", async () => {
    const { baseUrl, close } = await startServer(newHumanGame("gui-http-illegal"));
    cleanup = close;

    const sseRes = await fetch(`${baseUrl}/events`);
    const reader = sseRes.body!.getReader();
    const buffer = { text: "" };

    // The first decision point isn't guaranteed to be a discard (could be a kita offer for
    // a dealer holding North) - pass through anything else with a harmless "decline" answer
    // until a real discard request appears, exactly like the CLI's own illegal-input tests do.
    let request: any;
    for (let i = 0; i < 20; i++) {
      const msg = await readOneSseMessage(reader, buffer) as { type: string; request?: any };
      if (msg.type === "hand_end") throw new Error("hand ended before a discard request ever appeared");
      request = msg.request;
      if (request.type === "discard") break;
      await fetch(`${baseUrl}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: request.type, declare: false }),
      });
    }
    expect(request.type).toBe("discard");

    const res = await fetch(`${baseUrl}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "discard", tileId: -999999, declareRiichi: false }),
    });
    expect(res.status).toBe(400);
    await reader.cancel();
  }, 30000);
});
