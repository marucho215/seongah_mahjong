/* CustomAI 저장 형식과 CharacterAI 프로필 변환. CustomAI는 사용자가 정한 파라미터 세트를 기존 CharacterAI 엔진에 그대로
 * 넘기는 기능이며, 판단 로직을 새로 만들지 않는다. 등록 캐릭터(characterProfiles.ts)와는 파일/데이터를 섞지 않는다.
 *
 * - 공개 항목: CharacterAI 공통 파라미터 15개 전부 (플레이 성향 10개 + 판단 품질 5개). UI에는 모두 0~100 정수 슬라이더로
 *   보여주고, 내부값은 항목별 toInternal로 명시적으로 변환한다. 자동 보정/정규화나 다른 값에 맞춘 조정은 하지 않는다.
 * - 안전 범위는 현재 CharacterAI 코드 기준이다 (등록 캐릭터의 분포는 제한으로 쓰지 않는다):
 *   · 성향 10개와 접기 기준: 0.5를 중립으로 둔 선형 가중치, 설계 정의역 0~1 (밖으로 나가면 곱하는 항이 음수가 되어 의미가 뒤집힌다).
 *   · 실력: 평가 잡음 크기 (1-실력)*1.5 가 음수가 되지 않는 0~1.
 *   · 변동성: 비슷한 후보 사이 선택 온도 max(0.05, 값)*1.5 와 리치/울기 흔들림 폭. 선택은 늘 "비슷한 후보" 안이라 0~1 전체가 안전하다.
 *   · 실수율: 후보 범위를 3.5배로 넓힐 확률, 0~1.
 *   · 후보 허용 폭: 코드가 0.05 미만을 0.05로 올려 쓰므로 하한 0.05. 실수로 넓힌 범위(허용 폭*10*3.5)가 샹텐 한 단계(10)를
 *     넘지 않아야 "약간 못한 수"라는 전제가 지켜지므로(< 0.2857) 상한 0.25.
 * - 초기값: 성향 10개는 중립 50, 판단 품질/접기 기준 5개는 등록 캐릭터 중앙값에 가장 가까운 슬라이더 값 (초기값일 뿐 고정값이 아니다).
 * - 캐릭터 전용 메커니즘 필드(글리치/애착/힘 빼기 등)는 넣지 않으므로 그 메커니즘은 꺼져 있다 (향후 별도 확장). */
import type { CharacterProfile } from "../ai/characterProfile.js";

export const CUSTOM_AI_FORMAT_VERSION = 1;

/** 내부 파일 식별자. 파일 이름은 `${id}.json`이며, 사용자 입력 이름과는 무관하다. */
export const CUSTOM_AI_ID_PATTERN = /^c-[0-9a-f]{12}$/;
/** 등록 캐릭터 id와 겹치지 않도록 CustomAI 좌석의 characterId는 이 접두사를 붙인다. */
export const CUSTOM_AI_CHARACTER_PREFIX = "custom:";
export const CUSTOM_AI_NAME_MAX = 30;
export const SLIDER_MIN = 0;
export const SLIDER_MAX = 100;

type ExposedProfileKey =
  | "aggression"
  | "defense"
  | "callBias"
  | "riichiBias"
  | "damaBias"
  | "valueGreed"
  | "riskTolerance"
  | "honitsuBias"
  | "chiitoitsuBias"
  | "yakumanGreed"
  | "foldThreshold"
  | "skill"
  | "entropy"
  | "mistakeRate"
  | "candidateScoreTolerance";

export interface CustomAiField {
  /** 저장 파일의 style 키 (내부 파라미터 이름과 분리) */
  key: string;
  /** CharacterProfile의 필드 */
  profileKey: ExposedProfileKey;
  /** 편집 화면의 묶음 */
  group: "style" | "quality";
  /** 사용자에게 보이는 이름과 설명 */
  label: string;
  description: string;
  /** 새 CustomAI의 초기 슬라이더 값 */
  initial: number;
  /** 슬라이더 값(0~100 정수) -> CharacterProfile 내부값 */
  toInternal: (slider: number) => number;
}

const percent = (slider: number): number => slider / 100;
/** 후보 허용 폭: 슬라이더 0~100 -> 0.05~0.25 (0.002 단위) */
const tolerance = (slider: number): number => Math.round((0.05 + slider * 0.002) * 1000) / 1000;

/** 공개 항목과 표시 이름. 순서가 곧 편집 화면의 순서다. */
export const CUSTOM_AI_FIELDS: readonly CustomAiField[] = [
  { key: "attack", profileKey: "aggression", group: "style", label: "공격 성향", description: "높을수록 속도를 중시하고 위험한 패도 밀어붙입니다.", initial: 50, toInternal: percent },
  { key: "defense", profileKey: "defense", group: "style", label: "수비 성향", description: "높을수록 위험한 패를 피하고, 상대 리치에 접기 쉬워집니다.", initial: 50, toInternal: percent },
  { key: "calls", profileKey: "callBias", group: "style", label: "울기 선호", description: "높을수록 치·퐁을 적극적으로 고려합니다.", initial: 50, toInternal: percent },
  { key: "riichi", profileKey: "riichiBias", group: "style", label: "리치 선호", description: "텐파이에서 리치를 고를 때의 선호입니다. 다마 선호와 비교해 정합니다.", initial: 50, toInternal: percent },
  { key: "dama", profileKey: "damaBias", group: "style", label: "다마 선호", description: "텐파이에서 리치하지 않고 기다릴 때의 선호입니다. 리치 선호와 비교해 정합니다.", initial: 50, toInternal: percent },
  { key: "value", profileKey: "valueGreed", group: "style", label: "타점 욕심", description: "높을수록 빠른 화료보다 점수가 높은 손을 노립니다.", initial: 50, toInternal: percent },
  { key: "risk", profileKey: "riskTolerance", group: "style", label: "위험 감수", description: "높을수록 방총 위험을 덜 무겁게 봅니다.", initial: 50, toInternal: percent },
  { key: "fold", profileKey: "foldThreshold", group: "style", label: "접기 기준", description: "높을수록 상대가 리치했을 때 공격을 멈추고 수비로 돌아서기 쉽습니다.", initial: 46, toInternal: percent },
  { key: "honitsu", profileKey: "honitsuBias", group: "style", label: "혼일색 선호", description: "혼일색으로 갈 수 있는 손에서 그 루트를 더 선호합니다.", initial: 50, toInternal: percent },
  { key: "chiitoitsu", profileKey: "chiitoitsuBias", group: "style", label: "칠대자 선호", description: "칠대자로 갈 수 있는 손에서 그 루트를 더 선호합니다.", initial: 50, toInternal: percent },
  { key: "yakuman", profileKey: "yakumanGreed", group: "style", label: "역만 지향", description: "역만을 노릴 수 있는 손에서 그 루트를 더 선호합니다.", initial: 50, toInternal: percent },
  { key: "skill", profileKey: "skill", group: "quality", label: "실력 (판단 정확도)", description: "낮을수록 패 평가에 잡음이 커집니다. 절반 미만이면 스지를 안전패로 보지 않습니다.", initial: 69, toInternal: percent },
  { key: "variance", profileKey: "entropy", group: "quality", label: "변동성", description: "점수가 비슷한 후보들 사이에서 얼마나 고르게 섞어 고르는지입니다. 리치·울기 판단의 흔들림에도 쓰입니다.", initial: 37, toInternal: percent },
  { key: "mistake", profileKey: "mistakeRate", group: "quality", label: "실수율", description: "가끔 선택 범위를 넓혀 조금 못한 패를 고를 확률(%)입니다. 합법이 아니거나 크게 나쁜 수는 고르지 않습니다.", initial: 2, toInternal: percent },
  { key: "tolerance", profileKey: "candidateScoreTolerance", group: "quality", label: "후보 허용 폭", description: "최선의 수와 얼마나 가까운 후보까지 '비슷한 수'로 볼지입니다. 넓을수록 변동성이 작용할 후보가 늘어납니다.", initial: 5, toInternal: tolerance },
];

export function initialCustomAiStyle(): CustomAiStyle {
  return Object.fromEntries(CUSTOM_AI_FIELDS.map((f) => [f.key, f.initial]));
}

export type CustomAiStyle = Record<string, number>;

export interface CustomAiDefinition {
  formatVersion: typeof CUSTOM_AI_FORMAT_VERSION;
  id: string;
  name: string;
  style: CustomAiStyle;
}

export class CustomAiValidationError extends Error {}

function fail(message: string): never {
  throw new CustomAiValidationError(message);
}

/** 표시 이름: 앞뒤 공백을 뺀 1~30자, 제어 문자 없음. */
export function validateCustomAiName(value: unknown): string {
  if (typeof value !== "string") fail("이름은 문자열이어야 합니다");
  const name = value.trim();
  if (name.length === 0) fail("이름을 입력해 주세요");
  if ([...name].length > CUSTOM_AI_NAME_MAX) fail(`이름은 ${CUSTOM_AI_NAME_MAX}자 이하여야 합니다`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) fail("이름에 제어 문자를 쓸 수 없습니다");
  return name;
}

/** style 객체: 정확히 공개 항목 10개, 각각 0~100 정수. 모르는 키나 빠진 키가 있으면 거절한다. */
export function validateCustomAiStyle(value: unknown): CustomAiStyle {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("style은 객체여야 합니다");
  const raw = value as Record<string, unknown>;
  const expected = new Set(CUSTOM_AI_FIELDS.map((f) => f.key));
  for (const key of Object.keys(raw)) if (!expected.has(key)) fail(`알 수 없는 항목입니다: ${key}`);
  const style: CustomAiStyle = {};
  for (const field of CUSTOM_AI_FIELDS) {
    const v = raw[field.key];
    if (v === undefined) fail(`${field.label} 값이 없습니다`);
    if (typeof v !== "number" || !Number.isInteger(v)) fail(`${field.label} 값은 정수여야 합니다`);
    if (v < SLIDER_MIN || v > SLIDER_MAX) fail(`${field.label} 값은 ${SLIDER_MIN}~${SLIDER_MAX} 사이여야 합니다`);
    style[field.key] = v;
  }
  return style;
}

/** 저장 파일 전체 검증 (저장할 때와 불러올 때 같은 함수). 모르는 필드/잘못된 타입/범위 밖 값은 거절한다. */
export function parseCustomAiDefinition(value: unknown): CustomAiDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("CustomAI 정의는 객체여야 합니다");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["formatVersion", "id", "name", "style"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) fail(`알 수 없는 필드입니다: ${key}`);
  if (raw.formatVersion !== CUSTOM_AI_FORMAT_VERSION) fail(`지원하지 않는 형식 버전입니다: ${String(raw.formatVersion)}`);
  if (typeof raw.id !== "string" || !CUSTOM_AI_ID_PATTERN.test(raw.id)) fail("id 형식이 올바르지 않습니다");
  return { formatVersion: CUSTOM_AI_FORMAT_VERSION, id: raw.id, name: validateCustomAiName(raw.name), style: validateCustomAiStyle(raw.style) };
}

export function customAiCharacterId(id: string): string {
  return `${CUSTOM_AI_CHARACTER_PREFIX}${id}`;
}

export function isCustomAiCharacterId(characterId: string): boolean {
  return characterId.startsWith(CUSTOM_AI_CHARACTER_PREFIX);
}

/** CustomAI 정의 -> CharacterAI에 넘길 프로필. 15개 공통 파라미터 모두 사용자 값(항목별 toInternal). 특수 메커니즘 필드는 없다. */
export function customAiToProfile(def: CustomAiDefinition): CharacterProfile {
  const values = Object.fromEntries(CUSTOM_AI_FIELDS.map((f) => [f.profileKey, f.toInternal(def.style[f.key]!)])) as Record<ExposedProfileKey, number>;
  return {
    characterId: customAiCharacterId(def.id),
    displayName: def.name,
    archetype: "custom",
    ...values,
  };
}

/** 충돌처럼 보이는 조합에 대한 안내 (막거나 고치지 않는다). 엔진은 두 값을 함께 반영해 상대적으로 판단한다. */
export function customAiNotices(style: CustomAiStyle): string[] {
  const notices: string[] = [];
  if ((style.riichi ?? 0) >= 70 && (style.dama ?? 0) >= 70) {
    notices.push("리치 선호와 다마 선호가 모두 높습니다. 텐파이에서는 두 값을 비교해 정하므로, 차이가 작으면 상황에 따라 갈립니다.");
  }
  if ((style.attack ?? 0) >= 70 && (style.defense ?? 0) >= 70) {
    notices.push("공격과 수비가 모두 높습니다. 두 성향이 함께 반영되어 서로를 일부 상쇄합니다.");
  }
  return notices;
}

/** 리플레이 좌석에 저장된 프로필 스냅샷의 최소 검증 (재현 전). 엔진이 읽는 공통 필드가 모두 유한한 수인지 확인한다. */
const PROFILE_NUMBER_FIELDS = [
  "skill", "aggression", "defense", "riichiBias", "damaBias", "callBias", "foldThreshold", "valueGreed",
  "honitsuBias", "chiitoitsuBias", "yakumanGreed", "riskTolerance", "entropy", "mistakeRate", "candidateScoreTolerance",
] as const;

export function isUsableProfileSnapshot(value: unknown): value is CharacterProfile {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  if (typeof p.characterId !== "string" || typeof p.displayName !== "string" || typeof p.archetype !== "string") return false;
  return PROFILE_NUMBER_FIELDS.every((k) => typeof p[k] === "number" && Number.isFinite(p[k]));
}
