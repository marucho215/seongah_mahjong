import { describe, expect, it } from "vitest";
import { aiOnlyRecord, humanRecord, replayBytes, sha256 } from "./helpers/replayParityGames.js";
import { reproduceReplay } from "../src/replay/replayReproduction.js";

/* 리플레이 뷰어용 표시 전용 관찰 기능(GameState.observeCurrentHands, src/replay/)을 넣기 전의 코드로 만든 리플레이 JSON
 * 해시. 관찰 기능이 게임 진행/RNG/AI 판단/로그에 영향을 주지 않는다는 것을 바이트 단위로 고정한다.
 * 엔진 규칙이나 AI를 의도적으로 바꿔 값이 달라지면, 그 변경을 검토한 뒤에만 갱신할 것. */
const GOLDEN = {
  aiSanma: "e6d192bd45b637a68ce252df0c43c65309c3b214bb50b53e84c94b8e1f61c0d9",
  aiYonma: "4902fce911a6854a602febbeb2e1df6018e1f585175a8aefd8637e67f4363603",
  humanSanma: "16e1c386ea619c1e813eee6d92a9143cf4705839ab87e61f25ddb869b10b531f",
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
