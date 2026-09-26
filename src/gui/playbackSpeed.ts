/* AI 턴 장면 재생 속도. 서버가 이미 계산된 장면(frame)을 보내는 간격만 정하며, AI 판단/RNG/게임 결과와는 무관하다
 * (AI 행동은 사람이 응답하는 순간 GuiSession 안에서 모두 동기적으로 계산되고, 장면은 그 결과의 스냅샷이다). */

export type PlaybackSpeed = "slow" | "normal" | "fast" | "instant";

/** 일반 타패 한 장면의 기본 유지 시간(ms). 울기/리치/화료는 createGuiServer의 배수만큼 더 오래 보여준다. 0이면 재생 없이 바로 다음 상태. */
export const PLAYBACK_FRAME_DELAY_MS: Record<PlaybackSpeed, number> = {
  slow: 700,
  normal: 400,
  fast: 150,
  instant: 0,
};

export const DEFAULT_PLAYBACK_SPEED: PlaybackSpeed = "normal";

export function parsePlaybackSpeed(value: unknown): PlaybackSpeed {
  if (typeof value === "string" && Object.hasOwn(PLAYBACK_FRAME_DELAY_MS, value)) return value as PlaybackSpeed;
  throw new Error(`알 수 없는 재생 속도 "${String(value)}" (slow, normal, fast, instant)`);
}
