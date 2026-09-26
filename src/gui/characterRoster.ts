/* 시작 화면에 보내는 캐릭터 목록. CharacterProfile(AI 수치, 스펙상 임의 수정 금지)은 그대로 읽기만 하고,
 * 화면에만 쓰는 정보(성향 한국어 표기, 초상화)는 이 파일에 따로 둔다. 엔진/리플레이와 무관하다. */
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

/** archetype 식별자의 화면 표기. 없는 archetype은 식별자를 그대로 보여준다. */
export const ARCHETYPE_LABELS: Record<string, string> = {
  high_skill_stochastic: "고숙련 변칙형",
  high_speed_table_reader: "고속 판독형",
  aggressive_tempo_feeder: "공격적 템포형",
  control_oriented_closed_player: "통제형 멘젠 운영",
  novice_experimentalist: "초보 실험가",
  expert_sandbagger: "실력을 숨기는 고수",
  cautious_deep_planner: "신중한 장기 설계형",
  straightforward_risk_taker: "직선적 승부사",
  clean_control_player: "깔끔한 통제형",
  fast_tempo_information_chaser: "빠른 템포 정보 추적형",
  threat_aware_operator: "위협 감지형 운영자",
  reckless_direct_brawler: "무모한 정면 승부형",
  temperate_table_stabilizer: "온건한 판 안정형",
  value_hoarding_collector: "고타점 수집형",
  competitive_endurance_pusher: "끈질긴 밀어붙이기형",
  rule_bound_planner: "원칙 고수 설계형",
  novelty_seeking_opportunist: "새로움을 좇는 기회주의자",
  literal_threshold_reasoner: "기준치 판단형",
  easygoing_intuitive_responder: "느긋한 직감형",
  minimal_action_optimizer: "최소 행동 최적화형",
  high_value_showman: "고타점 쇼맨",
  rough_shape_fast_completer: "거친 형태 속공형",
};

/** 숙련도 구간 (skill 기준). 카드에는 이 구간 이름만 보여준다. */
export type SkillLevel = "high" | "mid" | "low";

export function skillLevelOf(profile: CharacterProfile): SkillLevel {
  if (profile.skill >= 0.8) return "high";
  if (profile.skill >= 0.6) return "mid";
  return "low";
}

/** 상대를 고를 때 참고할 성향 문구. 내부 파라미터를 그대로 공개하지 않고, 눈에 띄게 높거나 낮은 몇 가지만
 *  문장으로 바꾼다. 문턱값은 표시용 기준일 뿐 AI 동작과 무관하다 (수치 자체는 클라이언트로 보내지 않는다). */
interface TendencyRule {
  key: "aggression" | "defense" | "callBias" | "riichiBias" | "damaBias" | "valueGreed" | "entropy";
  when: "high" | "low";
  threshold: number;
  text: string;
}

export const TENDENCY_RULES: readonly TendencyRule[] = [
  { key: "aggression", when: "high", threshold: 0.64, text: "공격적인 편" },
  { key: "defense", when: "high", threshold: 0.7, text: "수비를 중시함" },
  { key: "defense", when: "low", threshold: 0.35, text: "수비보다 전진" },
  { key: "callBias", when: "high", threshold: 0.55, text: "울기를 자주 사용함" },
  { key: "callBias", when: "low", threshold: 0.22, text: "울기를 거의 하지 않음" },
  { key: "riichiBias", when: "high", threshold: 0.64, text: "리치를 적극적으로 사용함" },
  { key: "damaBias", when: "high", threshold: 0.66, text: "다마텐을 선호함" },
  { key: "valueGreed", when: "high", threshold: 0.7, text: "고타점을 노림" },
  { key: "valueGreed", when: "low", threshold: 0.31, text: "속도를 우선함" },
  { key: "entropy", when: "high", threshold: 0.55, text: "변칙적인 선택이 잦음" },
  { key: "entropy", when: "low", threshold: 0.13, text: "선택이 일관됨" },
];

export const MAX_TENDENCIES = 3;
export const BALANCED_TENDENCY = "치우침 없는 균형형";

/** 문턱값을 가장 크게 넘는 순으로 최대 MAX_TENDENCIES개. 해당이 없으면 균형형. */
export function tendenciesOf(profile: CharacterProfile): string[] {
  const matched = TENDENCY_RULES.map((r) => ({
    margin: r.when === "high" ? profile[r.key] - r.threshold : r.threshold - profile[r.key],
    text: r.text,
  }))
    .filter((m) => m.margin >= 0)
    .sort((a, b) => b.margin - a.margin)
    .slice(0, MAX_TENDENCIES)
    .map((m) => m.text);
  return matched.length > 0 ? matched : [BALANCED_TENDENCY];
}

export interface RosterEntry {
  characterId: string;
  displayName: string;
  archetype: string;
  archetypeLabel: string;
  skillLevel: SkillLevel;
  tendencies: string[];
  portrait?: CharacterPortrait;
}

export function rosterEntryOf(profile: CharacterProfile): RosterEntry {
  const portrait = CHARACTER_PORTRAITS[profile.characterId];
  return {
    characterId: profile.characterId,
    displayName: profile.displayName,
    archetype: profile.archetype,
    archetypeLabel: ARCHETYPE_LABELS[profile.archetype] ?? profile.archetype,
    skillLevel: skillLevelOf(profile),
    tendencies: tendenciesOf(profile),
    ...(portrait ? { portrait } : {}),
  };
}

/** 등록된 모든 캐릭터 (CHARACTER_PROFILES 순서). */
export function buildCharacterRoster(): RosterEntry[] {
  return Object.values(CHARACTER_PROFILES).map(rosterEntryOf);
}
