// AI 관전 여러 판 연속 실행: 판마다 요약(순위/점수/화료/방총/리치)만 남기고, 좌석별 통계를 보여 준다. 취소는 지금 판이 끝난 뒤 멈춘다.
// 엔진은 한 판 관전(runAiWatchGame)과 같은 경로라, 같은 시드면 같은 대국이다.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createGuiLobbyServer } from "../src/gui/createGuiServer.js";
import { EngineWorkerPool } from "../src/gui/engineWorkerPool.js";
import { runAiWatchGame } from "../src/gui/engineRunner.js";
import { MAX_WATCH_BATCH_GAMES, parseAiWatchBatchConfig } from "../src/gui/gameSetup.js";
import { aggregateWatchStats, summarizeWatchGame } from "../src/sim/watchStats.js";
import type { GameReplayRecord } from "../src/sim/replayRecorder.js";
import { initialCustomAiStyle } from "../src/customai/customAiSchema.js";

/** 이벤트와 최종 순위만 채운 최소 기록 (요약은 이 두 가지와 좌석 정보만 읽는다) */
function fakeRecord(events: unknown[], standings: [number, number, number][]): GameReplayRecord {
  return {
    meta: {
      replaySchemaVersion: 2,
      simulationLabel: "fake",
      gameIndex: 0,
      gameSeed: "fake-seed",
      rules: { playerCount: 3 } as GameReplayRecord["meta"]["rules"],
      seats: [0, 1, 2].map((seat) => ({ seat, kind: "characterAI" as const, characterId: ["a", "b", "c"][seat]! })),
    },
    events: events as GameReplayRecord["events"],
    aiDecisions: [],
    finalStandings: standings.map(([player, placement, rawScore]) => ({ player, placement, rawScore, uma: 0, points: (rawScore - 40000) / 1000 })),
  };
}

describe("관전 통계 (watchStats)", () => {
  it("한 판 요약: 국 수, 화료(더블 론은 화료자마다), 방총(더블 론이어도 국당 한 번), 리치, 최종 순위", () => {
    const record = fakeRecord(
      [
        { type: "hand_start" },
        { type: "riichi", player: 1 },
        { type: "win", player: 1, ronFrom: 0, isTsumo: false },
        { type: "win", player: 2, ronFrom: 0, isTsumo: false }, // 더블 론
        { type: "hand_start" },
        { type: "riichi", player: 0 },
        { type: "riichi", player: 2 },
        { type: "win", player: 0, isTsumo: true },
        { type: "hand_start" },
        { type: "exhaustive_draw", tenpaiPlayers: [], deltas: {} },
      ],
      [
        [0, 3, 20000],
        [1, 1, 50000],
        [2, 2, 35000],
      ]
    );
    const summary = summarizeWatchGame(record, 4, "file.json");
    expect(summary).toMatchObject({ index: 4, seed: "fake-seed", hands: 3, replayFile: "file.json" });
    expect(summary.seats.map((s) => [s.characterId, s.placement, s.wins, s.dealIns, s.riichi])).toEqual([
      ["a", 3, 1, 1, 1],
      ["b", 1, 1, 0, 1],
      ["c", 2, 1, 0, 1],
    ]);
  });

  it("좌석별 합계: 순위 분포, 평균 순위/1위율/점수/pt, 국당 화료·방총·리치 비율", () => {
    const g1 = summarizeWatchGame(fakeRecord([{ type: "hand_start" }, { type: "win", player: 0, ronFrom: 1, isTsumo: false }], [[0, 1, 50000], [1, 3, 25000], [2, 2, 30000]]), 0);
    const g2 = summarizeWatchGame(fakeRecord([{ type: "hand_start" }, { type: "hand_start" }, { type: "riichi", player: 0 }], [[0, 2, 40000], [1, 1, 45000], [2, 3, 20000]]), 1);
    const [s0, s1] = aggregateWatchStats([g1, g2], 3);
    expect(s0).toMatchObject({ seat: 0, characterId: "a", games: 2, placementCounts: [1, 1, 0], averagePlacement: 1.5, firstRate: 0.5, averageRawScore: 45000, hands: 3 });
    expect(s0!.averagePoints).toBeCloseTo(5);
    expect(s0!.winRate).toBeCloseTo(1 / 3);
    expect(s0!.riichiRate).toBeCloseTo(1 / 3);
    expect(s1!.dealInRate).toBeCloseTo(1 / 3);
    expect(s1!.placementCounts).toEqual([1, 0, 1]);
    // 판이 없으면 비율은 0 (0으로 나누지 않는다)
    expect(aggregateWatchStats([], 3)[0]).toMatchObject({ games: 0, averagePlacement: 0, winRate: 0 });
  });

  it("실제 AI 대국 한 판의 요약은 기록의 최종 순위와 같다", () => {
    const record = runAiWatchGame({ mode: "sanma", seed: "watch-stats-real", seats: ["jegalmina", "jegalnahui", "byeonari"].map((characterId) => ({ characterId })) }, "x");
    const summary = summarizeWatchGame(record, 0);
    expect(summary.seats.map((s) => s.placement).sort()).toEqual([1, 2, 3]);
    for (const s of summary.seats) expect(s.rawScore).toBe(record.finalStandings.find((f) => f.player === s.seat)!.rawScore);
    expect(summary.hands).toBe(record.events.filter((e) => e.type === "hand_start").length);
  }, 120_000);
});

describe("여러 판 관전 구성 검증 (parseAiWatchBatchConfig)", () => {
  it("판 수는 1~20 정수, 리플레이 저장은 기본 꺼짐", () => {
    const seats = ["jegalmina", "jegalnahui", "byeonari"];
    expect(parseAiWatchBatchConfig({ mode: "sanma", seats, games: 3 })).toEqual({ mode: "sanma", seats, games: 3, saveReplays: false });
    expect(parseAiWatchBatchConfig({ mode: "sanma", seats, games: MAX_WATCH_BATCH_GAMES, saveReplays: true }).saveReplays).toBe(true);
    for (const games of [0, 21, 2.5, "3", undefined]) expect(() => parseAiWatchBatchConfig({ mode: "sanma", seats, games })).toThrow("판 수");
    expect(() => parseAiWatchBatchConfig({ mode: "sanma", seats, games: 2, saveReplays: "yes" })).toThrow("saveReplays");
    expect(() => parseAiWatchBatchConfig({ mode: "sanma", seats: ["inan", "inan", "byeonari"], games: 2 })).toThrow("같은 캐릭터");
  });
});

describe("로비 여러 판 관전 (/watch/batch)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  /** `worker`: 실제 서버처럼 엔진 worker 풀에서 판을 돌린다 (판이 도는 동안에도 요청을 받는다) */
  async function startServer({ worker = false } = {}) {
    const engine = worker ? new EngineWorkerPool(1) : undefined;
    const root = mkdtempSync(join(tmpdir(), "watch-batch-"));
    const replayDir = join(root, "replays");
    const { server } = createGuiLobbyServer({ frameDelayMs: 0, replayDir, customAiDir: join(root, "custom-ai"), ...(engine ? { engine } : {}) });
    server.keepAliveTimeout = 0; // 판마다 수 초 걸리므로 guiLobby.test.ts와 같은 이유로 유휴 제한을 끈다
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const stream = await fetch(`${base}/events`);
    const reader = stream.body!.getReader();
    let text = "";
    const next = async (): Promise<any> => {
      while (true) {
        const m = /data: (.*)\n\n/.exec(text);
        if (m) {
          text = text.slice(m.index + m[0].length);
          return JSON.parse(m[1]!);
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE ended");
        text += Buffer.from(value).toString("utf-8");
      }
    };
    /** 여러 판 관전 메시지만 골라, 조건을 만족할 때까지 읽는다 */
    const untilBatch = async (pred: (b: any) => boolean) => {
      for (;;) {
        const m = await next();
        if (m.type === "watch_batch" && m.batch && pred(m.batch)) return m.batch;
      }
    };
    cleanup = async () => {
      await reader.cancel();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await engine?.close();
      rmSync(root, { recursive: true, force: true });
    };
    const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    await next(); // 첫 로비 상태
    return { base, replayDir, post, next, untilBatch };
  }

  it("판마다 진행 상황을 보내고, 끝나면 좌석별 통계를 준다 (worker 풀, CustomAI 이름, 판 i의 시드는 <시드>-i, 리플레이 저장 옵션)", async () => {
    const { base, replayDir, post, next, untilBatch } = await startServer({ worker: true });
    const custom = (await (await post("/api/custom-ai", { name: "연속 관전용", style: initialCustomAiStyle() })).json()) as { id: string };
    const seats = ["jegalmina", `custom:${custom.id}`, "byeonari"];
    expect((await post("/watch/batch", { mode: "sanma", seats, seed: "batch", games: 2, saveReplays: true })).status).toBe(204);

    const first = await untilBatch((b) => b.status === "running" && b.done === 0);
    expect(first).toMatchObject({ total: 2, mode: "sanma", seed: "batch", saveReplays: true, seatNames: ["제갈 미나", "연속 관전용", "변아리"] });
    // 도는 동안에는 새 대국/관전을 시작하거나 결과를 지울 수 없다
    expect((await post("/start", { mode: "sanma", opponents: ["jegalmina", "jegalnahui"] })).status).toBe(400);
    expect((await post("/watch", { mode: "sanma", seats })).status).toBe(400);
    expect((await post("/watch/batch", { mode: "sanma", seats, games: 1 })).status).toBe(400);
    expect((await post("/watch/batch/clear")).status).toBe(400);

    const progress = await untilBatch((b) => b.done === 1);
    expect(progress.status).toBe("running");
    const done = await untilBatch((b) => b.status !== "running");
    expect(done.status).toBe("done");
    expect(done.games.map((g: any) => g.seed)).toEqual(["batch-1", "batch-2"]);
    expect(done.stats.map((s: any) => s.games)).toEqual([2, 2, 2]);
    for (const g of done.games) expect([...g.placements].sort()).toEqual([1, 2, 3]);
    // 판마다 저장한 리플레이가 목록에 있고, 뷰어는 CustomAI 좌석을 프로필 이름으로 보여 준다
    expect(readdirSync(replayDir).sort()).toEqual(done.games.map((g: any) => g.replayFile).sort());
    const viewer = (await (await fetch(`${base}/api/replays/${encodeURIComponent(done.games[0].replayFile)}`)).json()) as any;
    expect(viewer.reproduction.ok).toBe(true);
    expect(viewer.seatNames).toEqual(["제갈 미나", "연속 관전용", "변아리"]);

    // 같은 시드와 좌석(저장된 CustomAI 스냅샷)으로 한 판만 돌린 대국과 같은 결과다 (엔진 경로가 같다)
    const saved = (await (await fetch(`${base}/api/replays/${encodeURIComponent(done.games[0].replayFile)}?download=1`)).json()) as GameReplayRecord;
    const customProfile = saved.meta.seats[1]!.customProfile!;
    const single = summarizeWatchGame(
      runAiWatchGame({ mode: "sanma", seed: "batch-1", seats: [{ characterId: "jegalmina" }, { profile: customProfile }, { characterId: "byeonari" }] }, "x"),
      0
    );
    expect(done.games[0].placements).toEqual(single.seats.map((s) => s.placement));
    expect(done.games[0].points).toEqual(single.seats.map((s) => s.points));

    // 결과를 지우면 로비에서 사라진다 (리플레이 파일은 남는다)
    expect((await post("/watch/batch/clear")).status).toBe(204);
    for (;;) {
      const m = await next();
      if (m.type === "watch_batch") {
        expect(m.batch).toBeNull();
        break;
      }
    }
    expect(readdirSync(replayDir)).toHaveLength(2);
  }, 300_000);

  it("리플레이 저장을 끄면 파일 없이 통계만 남는다", async () => {
    const { replayDir, post, untilBatch } = await startServer();
    expect((await post("/watch/batch", { mode: "sanma", seats: ["jegalmina", "jegalnahui", "byeonari"], seed: "nosave", games: 1 })).status).toBe(204);
    const done = await untilBatch((b) => b.status !== "running");
    expect(done.status).toBe("done");
    expect(done.games[0]).not.toHaveProperty("replayFile");
    expect(() => readdirSync(replayDir)).toThrow(); // 폴더도 만들지 않았다
  }, 300_000);

  it("취소하면 지금 도는 판이 끝난 뒤 멈추고, 끝난 판까지의 결과는 남는다 (worker 풀: 실제 서버 경로)", async () => {
    const { post, untilBatch } = await startServer({ worker: true });
    expect((await post("/watch/batch", { mode: "sanma", seats: ["jegalmina", "jegalnahui", "byeonari"], seed: "cancel", games: 5 })).status).toBe(204);
    await untilBatch((b) => b.status === "running");
    expect((await post("/watch/batch/cancel")).status).toBe(204);
    const cancelling = await untilBatch((b) => b.cancelRequested);
    expect(cancelling.status).toBe("running"); // 도는 판은 끝까지 간다
    const end = await untilBatch((b) => b.status !== "running");
    expect(end.status).toBe("cancelled");
    // 첫 판이 도는 중에 취소했으므로 그 판만 끝나고 멈춘다
    expect(end.done).toBe(1);
    expect(end.stats[0].games).toBe(end.done);
    expect((await post("/watch/batch/cancel")).status).toBe(400); // 이미 끝났다
    // 끝났으니 다시 시작할 수 있다
    expect((await post("/watch/batch/clear")).status).toBe(204);
  }, 300_000);

  it("마지막 판 수와 저장 옵션은 로비 설정에 기억된다 (새로고침해도 유지)", async () => {
    const { base, post, untilBatch } = await startServer({ worker: true });
    expect((await post("/watch/batch", { mode: "sanma", seats: ["jegalmina", "jegalnahui", "byeonari"], seed: "remember", games: 1, saveReplays: false })).status).toBe(204);
    await untilBatch((b) => b.status !== "running");
    const res = await fetch(`${base}/events`);
    const reader = res.body!.getReader();
    let text = "";
    while (!/data: (.*)\n\n/.test(text)) text += Buffer.from((await reader.read()).value!).toString("utf-8");
    await reader.cancel();
    const setup = JSON.parse(/data: (.*)\n\n/.exec(text)![1]!);
    expect(setup.defaults).toMatchObject({ watchGames: 1, watchSaveReplays: false, seed: "remember" });
    expect(setup.watchBatch).toMatchObject({ status: "done", done: 1 }); // 다시 접속해도 결과가 보인다
  }, 300_000);
});
