/* GUI 서버가 시작할 판을 만든다. 산마/4마는 RuleConfig와 좌석 구성만 다르고 나머지(GuiSession,
 * PlayerView, 작탁 DOM)는 완전히 같다. seat 0이 사람, 나머지는 캐릭터 AI. */
import { GameState } from "../core/GameState.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../rules/RuleConfig.js";
import { getCharacterProfile } from "../ai/characterProfiles.js";
import type { CharacterProfile } from "../ai/characterProfile.js";
import { isCustomAiCharacterId } from "../customai/customAiSchema.js";

export type GuiGameMode = "sanma" | "yonma";

export function parseGuiMode(value: string | undefined): GuiGameMode {
  if (value === undefined || value === "sanma") return "sanma";
  if (value === "yonma") return "yonma";
  throw new Error(`알 수 없는 모드 "${value}" (sanma 또는 yonma)`);
}

/** `[seed] [--mode sanma|yonma] [--save-replays]` 형태의 인자를 읽는다 (GUI 서버와 CLI가 공용). */
export function parseGameArgs(args: readonly string[]): { mode: GuiGameMode; seed: string | undefined; saveReplays: boolean } {
  const saveReplays = args.includes("--save-replays");
  args = args.filter((a) => a !== "--save-replays");
  const modeIndex = args.indexOf("--mode");
  if (modeIndex >= 0 && args[modeIndex + 1] === undefined) throw new Error("--mode 뒤에 sanma 또는 yonma를 적어 주세요");
  const mode = parseGuiMode(modeIndex >= 0 ? args[modeIndex + 1] : undefined);
  const positional = modeIndex < 0 ? [...args] : args.filter((_, i) => i !== modeIndex && i !== modeIndex + 1);
  return { mode, seed: positional[0], saveReplays };
}

/** 상대 좌석(seat 1..)의 기본 캐릭터. 시작 화면의 초기값이자 CLI/테스트가 상대를 지정하지 않을 때의 구성. */
export const DEFAULT_OPPONENTS: Record<GuiGameMode, readonly string[]> = {
  sanma: ["jegalmina", "jegalnahui"],
  yonma: ["jegalmina", "jegalnahui", "byeonari"],
};

export function playerCountOf(mode: GuiGameMode): number {
  return mode === "yonma" ? 4 : 3;
}

/** 시작 화면에서 고른 대국 구성. seed가 없으면 호출자가 새로 만든다. */
export interface GuiGameConfig {
  mode: GuiGameMode;
  opponents: string[];
  seed?: string;
  saveReplays: boolean;
}

const MAX_SEED_LENGTH = 100;

/** 클라이언트가 보낸 구성을 검증하고 정규화한다 (legacy characterId는 정식 id로 바꾼다).
 *  한 판에 같은 캐릭터가 두 번 앉을 수는 없다 - 이름표로 구분할 수 없기 때문이다. */
export function parseGuiGameConfig(input: unknown, resolveProfile: (id: string) => CharacterProfile = getCharacterProfile): GuiGameConfig {
  if (typeof input !== "object" || input === null) throw new Error("대국 설정이 비어 있습니다");
  const raw = input as Record<string, unknown>;
  const mode = parseGuiMode(typeof raw.mode === "string" ? raw.mode : String(raw.mode));
  if (!Array.isArray(raw.opponents)) throw new Error("상대 목록(opponents)이 필요합니다");
  const expected = playerCountOf(mode) - 1;
  if (raw.opponents.length !== expected) throw new Error(`상대는 ${expected}명이어야 합니다`);
  const opponents = raw.opponents.map((id) => {
    if (typeof id !== "string") throw new Error("상대 characterId는 문자열이어야 합니다");
    return resolveProfile(id).characterId;
  });
  if (new Set(opponents).size !== opponents.length) throw new Error("같은 캐릭터를 두 좌석에 앉힐 수 없습니다");
  let seed: string | undefined;
  if (raw.seed !== undefined && raw.seed !== null) {
    if (typeof raw.seed !== "string") throw new Error("시드는 문자열이어야 합니다");
    const trimmed = raw.seed.trim();
    if (trimmed.length > MAX_SEED_LENGTH) throw new Error(`시드는 ${MAX_SEED_LENGTH}자 이하여야 합니다`);
    if (trimmed !== "") seed = trimmed;
  }
  if (raw.saveReplays !== undefined && typeof raw.saveReplays !== "boolean") throw new Error("saveReplays는 true/false여야 합니다");
  return { mode, opponents, ...(seed !== undefined ? { seed } : {}), saveReplays: raw.saveReplays === true };
}

export function createGuiGame(mode: GuiGameMode, seed: string, opponents: readonly string[] = DEFAULT_OPPONENTS[mode]): GameState {
  return createGuiGameWithProfiles(mode, seed, opponents.map((id) => getCharacterProfile(id)));
}

/** 상대 프로필을 직접 받아 판을 만든다. CustomAI 프로필(characterId가 "custom:"으로 시작)은 customAI 좌석이 되고,
 *  판단은 기존 CharacterAI가 그 프로필로 한다. 등록 캐릭터는 지금까지처럼 characterAI 좌석이다. */
export function createGuiGameWithProfiles(mode: GuiGameMode, seed: string, profiles: readonly CharacterProfile[]): GameState {
  if (profiles.length !== playerCountOf(mode) - 1) throw new Error(`${mode}: 상대는 ${playerCountOf(mode) - 1}명이어야 합니다`);
  return new GameState({
    rules: mode === "yonma" ? MAJSOUL_YONMA_RULES : DEFAULT_SANMA_RULES,
    seed,
    characterProfiles: [null, ...profiles],
    controllers: ["human", ...profiles.map((p) => (isCustomAiCharacterId(p.characterId) ? ("customAI" as const) : undefined))],
  });
}
