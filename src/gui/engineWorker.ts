/* 엔진 worker 스레드 (1.2 3단계, engineWorkerPool.ts가 띄운다). 한 worker가 여러 대국을 들고, 들어온 순서대로 하나씩 처리한다.
 * 대국은 engineRunner.ts의 EngineCore로 진행하므로 같은 스레드에서 돌릴 때와 결과가 같다. 리플레이 재현도 여기서 한다. */
import { parentPort } from "node:worker_threads";
import { EngineCore, gameFromSpec } from "./engineRunner.js";
import { reproduceReplay } from "../replay/replayReproduction.js";
import type { EngineRequest, EngineReply } from "./engineWorkerPool.js";

if (!parentPort) throw new Error("engineWorker는 worker 스레드에서만 실행한다");
const port = parentPort;
const games = new Map<number, EngineCore>();

function gameOf(gameId: number): EngineCore {
  const core = games.get(gameId);
  if (!core) throw new Error("GuiServer: 대국이 없습니다 (이미 끝났거나 정리되었습니다)");
  return core;
}

function handle(message: EngineRequest): unknown {
  switch (message.op) {
    case "create": {
      const core = new EngineCore(gameFromSpec(message.spec));
      games.set(message.gameId, core);
      return core.start();
    }
    case "respond":
      return gameOf(message.gameId).respond(message.response);
    case "continue":
      return gameOf(message.gameId).continueToNextHand();
    case "replay":
      return gameOf(message.gameId).replayRecord(message.label);
    case "dispose":
      games.delete(message.gameId);
      return null;
    case "reproduce":
      return reproduceReplay(message.record);
  }
}

port.on("message", (message: EngineRequest) => {
  let reply: EngineReply;
  try {
    reply = { id: message.id, ok: true, result: handle(message) };
  } catch (err) {
    reply = { id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(reply);
});
