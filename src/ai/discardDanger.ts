/* 리치한 상대에 대한 타패 위험도 (현물/스지). CharacterAI의 타패 판단과 사람 플레이 화면의 "위험도 표시"가 같은 규칙을 쓴다.
 * 입력은 그 상대의 강(버림패 종류 전체, 남이 울어 간 패 포함)뿐이다 - 공개된 정보만으로 계산하는 순수 함수다.
 * characterAI.ts에서 동작을 바꾸지 않고 옮겨 왔다 (리플레이 바이트 고정 해시 tests/replayParity.test.ts가 지킨다). */
import type { TileKind } from "../core/tiles.js";
import { parseKind } from "../core/tiles.js";

/** rank distance used for suji: a same-suit discard at rank+-3 makes a ryanmen-based deal-in less likely. */
export function isSuji(kind: TileKind, discardedKinds: readonly TileKind[]): boolean {
  if (kind[0] === "z") return false;
  const { suit, rank } = parseKind(kind);
  const sujiPartner = rank <= 6 ? `${suit}${rank + 3}` : null;
  const sujiPartner2 = rank >= 4 ? `${suit}${rank - 3}` : null;
  return (sujiPartner !== null && discardedKinds.includes(sujiPartner)) || (sujiPartner2 !== null && discardedKinds.includes(sujiPartner2));
}

/** 리치한 상대 한 명의 강에 대한 위험도: 현물 0, 스지 0.35(useSuji일 때), 그 밖 1. */
export function dangerOf(kind: TileKind, riverKinds: readonly TileKind[], useSuji: boolean): number {
  if (riverKinds.includes(kind)) return 0; // genbutsu
  if (useSuji && isSuji(kind, riverKinds)) return 0.35;
  return 1;
}

/** 사람 플레이 화면 "위험도 표시"의 등급. 상대적인 표시일 뿐 "안전"을 뜻하지 않는다 (화면 문구: 낮음 / 주의 / 높음). */
export type DiscardRiskLevel = "low" | "caution" | "high";

/**
 * 손패 한 종류를 지금 버릴 때의 위험도 등급. `riichiRivers`는 리치한 상대마다의 강(버림패 종류 전체, 울어 간 패 포함)이며
 * 빈 배열로는 부르지 않는다(리치한 상대가 없으면 PlayerView가 등급 자체를 만들지 않는다).
 */
export function discardRiskLevel(kind: TileKind, riichiRivers: readonly (readonly TileKind[])[]): DiscardRiskLevel {
  // CharacterAI의 chooseDiscard와 같이 리치한 상대마다 dangerOf를 구해 가장 위험한 값을 쓴다 (사람 표시에서는 스지를 항상 본다).
  const danger = Math.max(...riichiRivers.map((river) => dangerOf(kind, river, true)));
  if (danger <= 0) return "low";
  if (danger < 1) return "caution";
  return "high";
}

/** 위험도 등급의 근거 한 줄: 리치한 상대 한 명의 강에 대해 이 패가 현물인지, 스지인지, 아무 근거가 없는지. */
export type DiscardRiskBasis = "genbutsu" | "suji" | "none";

/** `dangerOf(kind, river, true)`와 같은 판정을 근거 이름으로 돌려준다 (등급 계산과 항상 일치한다). */
export function discardRiskBasis(kind: TileKind, riverKinds: readonly TileKind[]): DiscardRiskBasis {
  if (riverKinds.includes(kind)) return "genbutsu";
  if (isSuji(kind, riverKinds)) return "suji";
  return "none";
}
