import { describe, expect, it } from "vitest";
import { aiOnlyRecord, humanRecord, replayBytes, sha256 } from "./helpers/replayParityGames.js";
import { reproduceReplay } from "../src/replay/replayReproduction.js";

/* 리플레이 뷰어용 표시 전용 관찰 기능(GameState.observeCurrentHands, src/replay/)을 넣기 전의 코드로 만든 리플레이 JSON
 * 해시. 관찰 기능이 게임 진행/RNG/AI 판단/로그에 영향을 주지 않는다는 것을 바이트 단위로 고정한다.
 * 엔진 규칙이나 AI를 의도적으로 바꿔 값이 달라지면, 그 변경을 검토한 뒤에만 갱신할 것.
 * (갱신 기록: pt 제거 - meta.rules의 returnScore/uma와 finalStandings의 uma/points만 빠지고 나머지 바이트는 같음을 확인) */
const GOLDEN = {
  aiSanma: "c00b7f4754c44d9fb70d8f9cc7196af3a3c28aa576ff6b1a651a15de2f3b56e9",
  aiYonma: "e177cb6c9e975d91d8c159932b01c1a62c1dd1591be1ae23e42e50b002f6d649",
  humanSanma: "d41df1a3ab9c3312f26e82ab5212bb7cb099c6d1dfb7c898690a27e6976a8a90",
};

describe("리플레이 바이트 동일성 (표시 전용 관찰 기능 추가 전후)", () => {
  it("AI 대국 리플레이(산마/4마)의 바이트가 관찰 기능 추가 전과 같다", () => {
    expect(sha256(replayBytes(aiOnlyRecord("sanma", "replay-parity-sanma")))).toBe(GOLDEN.aiSanma);
    expect(sha256(replayBytes(aiOnlyRecord("yonma", "replay-parity-yonma")))).toBe(GOLDEN.aiYonma);
  }, 120_000);

  it("사람 대국 리플레이의 바이트가 관찰 기능 추가 전과 같다", () => {
    expect(sha256(replayBytes(humanRecord("sanma", "replay-parity-human-sanma")))).toBe(GOLDEN.humanSanma);
  }, 120_000);

  it("재시뮬레이션은 원본 리플레이를 바꾸지 않는다", () => {
    const record = humanRecord("sanma", "replay-parity-human-sanma");
    const before = replayBytes(record);
    expect(reproduceReplay(record).ok).toBe(true);
    expect(replayBytes(record)).toBe(before);
  }, 120_000);
});
