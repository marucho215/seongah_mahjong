/* 시작 화면에 보내는 캐릭터 목록. CharacterProfile(AI 수치, 스펙상 임의 수정 금지)에서는 이름만 읽고,
 * 화면에 쓰는 정보(플레이 경향 설명, 태그, 초상화)는 이 파일에 따로 둔다. 엔진/리플레이와 무관하며,
 * 내부 튜닝 수치나 archetype 식별자는 클라이언트로 보내지 않는다. */
import { CHARACTER_PROFILES } from "../ai/characterProfiles.js";
import type { CharacterProfile } from "../ai/characterProfile.js";

/** 캐릭터 초상화. 아직 어떤 캐릭터에도 없다 - 제공되면 CHARACTER_PORTRAITS에 등록하고,
 *  클라이언트는 이 필드가 있을 때만 레이아웃을 확장한다 (없는 상태가 기본이자 완성형). */
export interface CharacterPortrait {
  /** PUBLIC_DIR 기준 경로, 예: "/assets/characters/jegalmina.webp" */
  src: string;
  width: number;
  height: number;
}

export const CHARACTER_PORTRAITS: Partial<Record<string, CharacterPortrait>> = {};

/** 캐릭터 선택 카드의 문구: 플레이 경향 한 줄과 짧은 태그 2~4개.
 *  AI 로직(성향 가중치와 캐릭터 고유 메커니즘)과 AI끼리 둔 4마 대국에서 실제로 관찰된 경향(리치/울기/방총
 *  빈도, 다마텐 화료 비중 등)이 함께 뒷받침하는 내용만 적는다. 두 근거가 어긋나는 경향은 쓰지 않는다.
 *  AI 수치를 조정했다면 이 문구도 다시 확인할 것. */
export interface CharacterPresentation {
  summary: string;
  tags: string[];
}

export const CHARACTER_PRESENTATION: Record<string, CharacterPresentation> = {
  jegalmina: { summary: "수를 섞어 두어 속을 읽기 어렵고, 타점을 챙기며 칠대자도 곧잘 노린다.", tags: ["읽기 어려움", "타점 중시", "칠대자 선호"] },
  jegalnahui: { summary: "판을 빠르게 읽고 속도로 승부한다. 판단할 것이 많아지면 가끔 실수가 나온다.", tags: ["빠른 템포", "안정적인 선택", "복잡한 국면에 약함"] },
  seiyamouri: { summary: "적극적으로 울어 속도를 올리고, 상대가 앞서도 쉽게 물러서지 않는다.", tags: ["울기 많음", "공격적", "빠른 템포"] },
  seiyakouri: { summary: "손을 닫은 채 조용히 운영하며, 리치보다 다마텐을 고르는 일이 많다.", tags: ["다마텐 선호", "리치 적음", "신중함"] },
  kyletyler: { summary: "흔치 않은 루트를 시험하길 좋아하고, 한 번 정한 길을 쉽게 바꾸지 않는다.", tags: ["특이한 수순", "고집 있는 운영", "방총이 잦음"] },
  seiyatosuke: { summary: "평소에는 힘을 빼고 두지만, 승부처나 위험한 순간에는 최선의 수를 고른다.", tags: ["수비 탄탄", "다마텐 선호", "울기 적음", "여유 있을 땐 힘을 뺌"] },
  toumesuashi: { summary: "멀리 내다보고 손을 만들며, 위험한 패는 좀처럼 내주지 않는다.", tags: ["수비 중시", "다마텐 선호", "일관된 선택"] },
  toumesuayo: { summary: "망설임 없이 앞으로 나아가는 정면 승부형. 리치도 울기도 주저하지 않는다.", tags: ["직선적인 공격", "리치 적극적", "울기도 사용"] },
  byeonari: { summary: "깔끔한 모양과 안정된 대기를 선호하고, 애매하게 위험한 밀기는 피한다.", tags: ["좋은 모양 선호", "위험 회피", "리치 적음"] },
  kangunsim: { summary: "빠르게 울어 흐름을 잡고, 큰 손보다 먼저 화료하는 쪽을 택한다.", tags: ["빠른 템포", "울기 많음", "속도 우선"] },
  kimwooju: { summary: "상대의 위협을 먼저 살피고, 닫힌 손으로 조용히 화료를 노린다.", tags: ["위협에 민감", "멘젠 중시", "다마텐 선호"] },
  ryumint: { summary: "위험을 가리지 않고 울며 정면으로 밀어붙인다.", tags: ["울기 매우 많음", "무모한 전진", "방총이 잦음"] },
  inan: { summary: "판을 안정시키는 온건한 스타일로, 무리한 승부는 피한다.", tags: ["수비 중시", "무리하지 않음", "다마텐 선호"] },
  effieminos: { summary: "도라나 역 재료처럼 가치 있는 패를 모아 두고, 쉽게 놓아주지 않는다.", tags: ["타점 재료 수집", "모은 패에 애착"] },
  hwayoung: { summary: "리치를 자주 걸고, 불리해도 끝까지 승부를 이어 간다.", tags: ["리치 적극적", "끈질긴 승부", "공격적"] },
  mageuna: { summary: "처음 정한 방향대로 손을 진행한다. 여러 변수가 한꺼번에 겹치면 흔들린다.", tags: ["계획형", "일관된 선택", "돌발 상황에 약함"] },
  magnum: { summary: "새로운 수를 즐기고, 기회가 보이면 울어서라도 바로 달려든다.", tags: ["변칙적인 선택", "울기 많음", "공격적"] },
  optima215: { summary: "차이가 분명하면 망설임 없이 고르고, 애매한 상황에서는 선택이 흔들린다.", tags: ["명확하면 단호함", "애매하면 흔들림", "울기 많음"] },
  yuwen: { summary: "크게 욕심내지 않고 흐름을 따라 편하게 친다.", tags: ["속도 우선", "직감적인 선택", "느긋한 운영"] },
  josangmin: { summary: "득이 분명하지 않으면 울지도, 리치하지도 않는다.", tags: ["꼭 필요한 행동만", "울기 적음", "수비 탄탄"] },
  seiyahikudo: { summary: "화려한 큰 손을 좋아해 혼일색이나 역만 루트를 노린다.", tags: ["큰 손 지향", "역만 욕심", "혼일색 선호"] },
  ryuheart: { summary: "모양이 거칠어도 빨리 완성하는 쪽을 택한다.", tags: ["모양보다 속도", "울기 많음", "저타점 속공"] },
};

export interface RosterEntry {
  characterId: string;
  displayName: string;
  summary: string;
  tags: string[];
  portrait?: CharacterPortrait;
}

export function rosterEntryOf(profile: CharacterProfile): RosterEntry {
  const presentation = CHARACTER_PRESENTATION[profile.characterId];
  const portrait = CHARACTER_PORTRAITS[profile.characterId];
  return {
    characterId: profile.characterId,
    displayName: profile.displayName,
    summary: presentation?.summary ?? "",
    tags: presentation ? [...presentation.tags] : [],
    ...(portrait ? { portrait } : {}),
  };
}

/** 등록된 모든 캐릭터 (CHARACTER_PROFILES 순서). */
export function buildCharacterRoster(): RosterEntry[] {
  return Object.values(CHARACTER_PROFILES).map(rosterEntryOf);
}
