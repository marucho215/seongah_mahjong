/* 엔진 worker 풀 (1.2 3단계). 대국은 시작할 때 가장 한가한 worker 하나에 배정되어 끝날 때까지 그 worker에서만 진행된다
 * (대국 상태는 worker 안에만 있다). 리플레이 재현 같은 단발 작업도 한가한 worker로 보낸다. 메인 스레드는 요청을 보내고
 * 결과를 기다릴 뿐이라, 한 사용자의 AI 계산이나 재현이 다른 사용자의 이벤트 스트림/로비를 멈추지 않는다.
 * worker가 죽으면 그 worker의 대기 중 요청은 실패하고 대국은 사라지며(이후 요청도 실패), 새 worker로 바꾼다. */
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { createRequire } from "node:module";
import type { DecisionResponse } from "../core/decisions.js";
import type { GameReplayRecord } from "../sim/replayRecorder.js";
import type { ReplayReproduction } from "../replay/replayReproduction.js";
import type { EngineRunner, EngineSnapshot, EngineStart, GameSpec } from "./engineRunner.js";

export type EngineRequest =
  | { id: number; op: "create"; gameId: number; spec: GameSpec }
  | { id: number; op: "respond"; gameId: number; response: DecisionResponse }
  | { id: number; op: "continue"; gameId: number }
  | { id: number; op: "replay"; gameId: number; label: string }
  | { id: number; op: "dispose"; gameId: number }
  | { id: number; op: "reproduce"; record: GameReplayRecord };

export type EngineReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

type RequestBody = EngineRequest extends infer R ? (R extends EngineRequest ? Omit<R, "id"> : never) : never;

/** 기본 worker 수: CPU 수 - 1 (메인 스레드 몫), 1~4개. */
export function defaultEngineWorkerCount(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

/** 개발 중(tsx로 .ts 실행, vitest)에는 worker도 tsx를 거쳐 띄우고, 빌드된 .js에서는 그대로 띄운다. */
const WORKER_IS_TS = import.meta.url.endsWith(".ts");
const WORKER_URL = new URL(WORKER_IS_TS ? "./engineWorker.ts" : "./engineWorker.js", import.meta.url);

class EngineWorker {
  private worker: Worker;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  /** 이 worker에 있는 대국 수 + 진행 중 단발 작업 수 (배정 기준) */
  load = 0;
  /** worker가 바뀔 때마다 늘어난다: 죽은 worker에 있던 대국을 알아보는 데 쓴다. */
  generation = 0;
  private closed = false;

  constructor() {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const worker = WORKER_IS_TS
      ? // tsx의 모듈 해석(.js 경로 -> .ts 파일)은 worker에 자동으로 이어지지 않으므로, worker 안에서 먼저 등록하고 불러온다.
        new Worker(`require(${JSON.stringify(createRequire(import.meta.url).resolve("tsx/esm/api"))}).register(); import(${JSON.stringify(WORKER_URL.href)});`, { eval: true })
      : new Worker(WORKER_URL);
    worker.on("message", (reply: EngineReply) => {
      const entry = this.pending.get(reply.id);
      if (!entry) return;
      this.pending.delete(reply.id);
      if (reply.ok) entry.resolve(reply.result);
      else entry.reject(new Error(reply.error));
    });
    const fail = (reason: string) => {
      if (this.worker !== worker) return;
      for (const entry of this.pending.values()) entry.reject(new Error(`GuiServer: 엔진 worker가 중단되었습니다 (${reason})`));
      this.pending.clear();
      this.generation++;
      this.load = 0;
      if (!this.closed) this.worker = this.spawn();
    };
    worker.on("error", (err) => fail(err.message));
    worker.on("exit", (code) => fail(`종료 코드 ${code}`));
    return worker;
  }

  call<T>(body: RequestBody): Promise<T> {
    if (this.closed) return Promise.reject(new Error("GuiServer: 엔진 풀이 닫혔습니다"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...body, id });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.worker.terminate();
  }
}

class WorkerEngineRunner implements EngineRunner {
  readonly session = null;
  private disposed = false;

  constructor(
    private readonly host: EngineWorker,
    private readonly generation: number,
    private readonly gameId: number
  ) {}

  private call<T>(body: RequestBody): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("GuiServer: 이미 정리된 대국입니다"));
    if (this.host.generation !== this.generation) return Promise.reject(new Error("GuiServer: 엔진 worker가 중단되어 대국이 사라졌습니다"));
    return this.host.call<T>(body);
  }

  pollSync(): null {
    return null;
  }

  respond(response: DecisionResponse): Promise<EngineSnapshot> {
    return this.call({ op: "respond", gameId: this.gameId, response });
  }

  continueToNextHand(): Promise<EngineSnapshot> {
    return this.call({ op: "continue", gameId: this.gameId });
  }

  replayRecord(label: string): Promise<GameReplayRecord> {
    return this.call({ op: "replay", gameId: this.gameId, label });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.host.generation !== this.generation) return;
    this.host.load = Math.max(0, this.host.load - 1);
    this.host.call({ op: "dispose", gameId: this.gameId }).catch(() => {});
  }
}

export class EngineWorkerPool {
  private readonly workers: EngineWorker[];
  private nextGameId = 1;

  constructor(size = defaultEngineWorkerCount()) {
    if (!Number.isInteger(size) || size < 1) throw new Error("엔진 worker 수는 1 이상의 정수여야 합니다");
    this.workers = Array.from({ length: size }, () => new EngineWorker());
  }

  get size(): number {
    return this.workers.length;
  }

  /** 모든 worker에 배정된 대국 수 + 진행 중 단발 작업 수 (운영 확인/테스트용) */
  get load(): number {
    return this.workers.reduce((sum, w) => sum + w.load, 0);
  }

  private leastLoaded(): EngineWorker {
    return this.workers.reduce((best, w) => (w.load < best.load ? w : best));
  }

  /** 대국을 만들어 한 worker에 배정한다. */
  async openGame(spec: GameSpec): Promise<{ runner: EngineRunner; start: EngineStart }> {
    const worker = this.leastLoaded();
    const gameId = this.nextGameId++;
    const generation = worker.generation;
    worker.load++;
    try {
      const start = await worker.call<EngineStart>({ op: "create", gameId, spec });
      return { runner: new WorkerEngineRunner(worker, generation, gameId), start };
    } catch (err) {
      if (worker.generation === generation) worker.load = Math.max(0, worker.load - 1);
      throw err;
    }
  }

  /** 리플레이를 현재 엔진으로 재현한다 (replayReproduction.ts, worker에서). */
  async reproduce(record: GameReplayRecord): Promise<ReplayReproduction> {
    const worker = this.leastLoaded();
    const generation = worker.generation;
    worker.load++;
    try {
      return await worker.call<ReplayReproduction>({ op: "reproduce", record });
    } finally {
      if (worker.generation === generation) worker.load = Math.max(0, worker.load - 1);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
