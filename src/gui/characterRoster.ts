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

/** 캐릭터 선택 카드의 문구.
 *  - summary: 확정된 캐릭터 한 줄 설명. 이 파일이 source of truth이며, 측정 결과로 고치지 않는다.
 *  - tags: 선택 도움용 짧은 태그 0~4개. CharacterAI에 명시적으로 구현된 행동 로직(성향 가중치, 캐릭터 고유 메커니즘)을
 *    근거로 붙이고, AI끼리 둔 대국 측정은 명백한 모순이 없는지 확인하는 용도로만 쓴다. 희귀 역/루트는 짧은 측정
 *    빈도로 넣거나 빼지 않는다. 평가나 서열처럼 읽히는 표현(강함, 약함, 숙련 등)은 쓰지 않는다.
 *  CharacterAI 수치를 바꾸면 태그를 다시 확인할 것. */
export interface CharacterPresentation {
  summary: string;
  tags: string[];
}

export const CHARACTER_PRESENTATION: Record<string, CharacterPresentation> = {
  jegalmina: {
    summary: "정답 하나에 좀처럼 고정되지 않는 생성형 사서. 높은 계산력으로 다마·칠대자·타점을 챙기면서도 좋은 후보들 사이에서 예측하기 어려운 패를 고른다.",
    tags: ["읽기 어려움", "타점 중시", "칠대자 선호"],
  },
  jegalnahui: {
    summary: "뭐든 1.5배속으로 처리하는 초고속 방송실 교사. 평소에는 리치까지 빠르고 안정적으로 판단하다가 판이 복잡해지면 위험 계산을 건너뛰는 글리치가 난다.",
    tags: ["안정적인 선택", "복잡한 국면에서 실수"],
  },
  seiyamouri: {
    summary: "먹을 것이 보이면 달려드는 소란스러운 DJ. 작탁에서도 울 수 있으면 적극적으로 먹고 리치까지 이어 붙이며 판을 빠르게 돌린다.",
    tags: ["울기 많음", "공격적", "빠른 템포"],
  },
  seiyakouri: {
    summary: "말보다 행동으로 상황을 제어하는 과묵한 미술 교사. 멘젠을 오래 지키고 다마와 수비를 활용해 조용히 판을 잠근다.",
    tags: ["다마텐 선호", "리치 적음", "신중함"],
  },
  kyletyler: {
    summary: "뻔한 정답보다 실험을 택하는 과학자. 칠대자·혼일색·역만 냄새가 나는 변칙 루트를 시험하고, 한번 고른 실험은 쉽게 포기하지 않는다.",
    tags: ["특이한 수순", "고집 있는 운영", "위험 감수"],
  },
  seiyatosuke: {
    summary: "모든 수를 읽고도 한발 물러설 줄 아는 백전노장. 작탁에서는 일부러 한 수 낮춰 두다가 판이 급해지면 숨겨 둔 최선수를 꺼낸다.",
    tags: ["수비 중시", "다마텐 선호", "울기 적음", "여유 있을 땐 힘을 뺌"],
  },
  toumesuashi: {
    summary: "환자의 고통을 줄이기 위해 수없이 계산하는 천재 외과의. 작탁에서도 위험을 세밀하게 피하며 멘젠과 다마로 안전한 답을 오래 찾는다.",
    tags: ["수비 중시", "다마텐 선호", "일관된 선택"],
  },
  toumesuayo: {
    summary: "남의 고통까지 덥석 받아내는 해맑은 간호사. 마작에서는 리치와 울기를 곧장 선택하며 어느 정도의 위험도 감수하는 직선적인 승부파.",
    tags: ["직선적인 공격", "리치 적극적", "울기도 사용"],
  },
  byeonari: {
    summary: "오염을 용납하지 않는 급식실 관리자. 고립패를 깨끗이 치우고 위험한 밀기를 꺼리며 흐트러진 패형을 차근차근 정돈한다.",
    tags: ["좋은 모양 선호", "위험 회피"],
  },
  kangunsim: {
    summary: "화제가 생기면 즉시 달려드는 정보통. 울기와 리치를 적극적으로 써서 판의 템포부터 빠르게 끌어올린다.",
    tags: ["빠른 템포", "울기 많음", "속도 우선"],
  },
  kimwooju: {
    summary: "살아남을 길부터 계산하는 후방 오퍼레이터. 상대의 위협을 읽고 빠르게 접으며, 멘젠과 다마를 선호하는 철저한 생존형.",
    tags: ["위협에 민감", "멘젠 중시", "다마텐 선호"],
  },
  ryumint: {
    summary: "선의로 장애물을 통째로 박살내는 근육형 사고뭉치. 작탁에서도 울고 밀고 리치하며 위험패 앞에서도 좀처럼 후퇴하지 않는다.",
    tags: ["울기 많음", "위험 감수"],
  },
  inan: {
    summary: "과열된 상황을 식히는 특별 생활 지도부장. 무리한 승부보다 다마와 수비를 택해 작탁의 열기를 가라앉힌다.",
    tags: ["수비 중시", "무리하지 않음", "다마텐 선호"],
  },
  effieminos: {
    summary: "손에 들어온 것은 놓기 싫은 수집가. 가치 있는 패를 오래 품고 혼일색·칠대자 같은 비싼 루트를 집요하게 모은다.",
    tags: ["타점 재료 수집", "모은 패에 애착"],
  },
  hwayoung: {
    summary: "무슨 승부든 지기 싫어하는 행동대장. 작탁에서도 리치를 걸고 위험을 감수하며 끝까지 밀어붙이는 정면승부파.",
    tags: ["리치 적극적", "끈질긴 승부", "공격적"],
  },
  mageuna: {
    summary: "계획에서 벗어나는 것을 견디지 못하는 완벽주의자. 한 번 잡힌 패의 방향을 꾸준히 밀고, 변수가 연달아 터지면 잠시 판단이 흔들린다.",
    tags: ["계획형", "일관된 선택", "변수가 겹치면 흔들림"],
  },
  magnum: {
    summary: "자극 없이는 못 사는 도파민 중독 카피캣. 울기·리치·고타점·역만을 닥치는 대로 쫓으며, 선택지가 비슷할수록 가장 예측하기 어렵게 움직인다.",
    tags: ["변칙적인 선택", "울기 많음", "공격적"],
  },
  optima215: {
    summary: "세상을 O와 X로 이해하는 휴머노이드. 패의 우열이 분명하면 망설임 없이 고르고, 답이 애매할수록 가까운 후보 사이에서 크게 흔들린다.",
    tags: ["명확하면 단호함", "애매하면 흔들림"],
  },
  yuwen: {
    summary: "계산보다 직감이 먼저 움직이는 배식 도우미. 높은 타점에 큰 욕심을 두지 않고 눈앞의 손을 편하게 완성해 가는 느긋한 대응형.",
    tags: ["속도 우선"],
  },
  josangmin: {
    summary: "꼭 필요한 일에만 힘을 쓰는 극단적 효율주의자. 확실한 이득이 없으면 울기·리치·깡도 아끼고, 다마와 수비로 최소한의 행동만 고른다.",
    tags: ["꼭 필요한 행동만", "울기 적음", "수비 중시"],
  },
  seiyahikudo: {
    summary: "주목받기 위해 천재가 된 타고난 쇼맨. 값싼 화료에는 쉽게 만족하지 않고 큰 손을 노리며, 완성되면 누구보다 적극적으로 리치를 건다.",
    tags: ["큰 손 지향", "역만 욕심", "혼일색 선호"],
  },
  ryuheart: {
    summary: "베푸는 건 잘해도 평범한 요리는 망치는 어린 요리사. 패 모양이 조금 거칠어도 적극적으로 울어 빠르게 완성하며 큰 손에는 별 욕심을 내지 않는다.",
    tags: ["울기 많음", "저타점 속공"],
  },
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
