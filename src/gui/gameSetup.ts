/* GUI 서버가 시작할 판을 만든다. 산마/4마는 RuleConfig와 좌석 구성만 다르고 나머지(GuiSession,
 * PlayerView, 작탁 DOM)는 완전히 같다. seat 0이 사람, 나머지는 캐릭터 AI. */
import { GameState } from "../core/GameState.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES, type GameLength, type RuleConfig } from "../rules/RuleConfig.js";
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

// --- 규칙 옵션: 로비에서 고르는 규칙. RuleConfig의 일부 항목만 노출하고, 기본값과 같은 항목은 담지 않는다(그래서 기본 대국은 이전과 같다).
//     리플레이는 meta.rules에 실제 규칙 전체를 저장하므로 어떤 규칙으로 둔 대국도 그대로 재현된다. ---

export type AkaDoraOption = "none" | "default" | "more";

export interface RuleOptions {
  /** 동풍전("east") / 동남전("east-south") */
  gameLength?: GameLength;
  /** 적도라: 없음 / 기본(산마 통·삭 1장씩, 4마 3수트 1장씩) / 많이(수트마다 한 장 더) */
  akaDora?: AkaDoraOption;
  /** 울어서 탕야오 인정(쿠이탕) */
  kuitan?: boolean;
  /** 쿠이카에 금지 (4마만: 산마는 치가 없다) */
  kuikae?: boolean;
  /** 더블 론: 모두 화료("all") / 머리박기(가장 가까운 한 명만, "atamahane") */
  doubleRon?: "all" | "atamahane";
  /** 13판 이상을 역만으로 (헤아림 역만) */
  kazoeYakuman?: boolean;
  /** 더블 역만(국사 13면대기, 사암각 단기, 순정 구련, 대사희)을 두 배로 */
  doubleYakuman?: boolean;
  /** 절상만관 (4판 30부, 3판 60부를 만관으로) */
  kiriageMangan?: boolean;
}

function baseRulesOf(mode: GuiGameMode): RuleConfig {
  return mode === "yonma" ? MAJSOUL_YONMA_RULES : DEFAULT_SANMA_RULES;
}

function akaFor(base: RuleConfig, level: AkaDoraOption): RuleConfig["akaDoraCount"] {
  if (level === "none") return { man: 0, pin: 0, sou: 0 };
  if (level === "default") return { ...base.akaDoraCount };
  // "많이": 이 모드에서 적도라가 있는 수트마다 한 장 더 (산마의 만수는 5가 없으므로 그대로 0)
  const more = (n: number) => (n > 0 ? n + 1 : 0);
  return { man: more(base.akaDoraCount.man), pin: more(base.akaDoraCount.pin), sou: more(base.akaDoraCount.sou) };
}

/** 기본 규칙 + 고른 옵션. 옵션이 없거나 모두 기본값이면 기본 규칙과 같은 값이다. */
export function rulesFor(mode: GuiGameMode, options?: RuleOptions): RuleConfig {
  const base = baseRulesOf(mode);
  if (!options) return base;
  return {
    ...base,
    ...(options.gameLength !== undefined ? { gameLength: options.gameLength } : {}),
    ...(options.akaDora !== undefined ? { akaDoraCount: akaFor(base, options.akaDora) } : {}),
    ...(options.kuitan !== undefined ? { kuitan: options.kuitan } : {}),
    ...(options.kuikae !== undefined ? { kuikae: options.kuikae } : {}),
    ...(options.doubleRon !== undefined ? { doubleRonMode: options.doubleRon } : {}),
    ...(options.kazoeYakuman !== undefined ? { kazoeYakumanEnabled: options.kazoeYakuman } : {}),
    ...(options.doubleYakuman !== undefined ? { doubleYakumanEnabled: options.doubleYakuman } : {}),
    ...(options.kiriageMangan !== undefined ? { kiriageMangan: options.kiriageMangan } : {}),
  };
}

/** 클라이언트가 보낸 규칙 옵션을 검증하고, 기본값과 같은 항목은 뺀다. 모르는 항목이나 잘못된 값은 거절한다. */
export function parseRuleOptions(input: unknown, mode: GuiGameMode): RuleOptions {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("규칙 옵션(rules)은 객체여야 합니다");
  const raw = input as Record<string, unknown>;
  const allowed = ["gameLength", "akaDora", "kuitan", "kuikae", "doubleRon", "kazoeYakuman", "doubleYakuman", "kiriageMangan"];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new Error(`알 수 없는 규칙 옵션입니다: ${key}`);
  const base = baseRulesOf(mode);
  const oneOf = <T extends string>(key: string, values: readonly T[]): T | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw new Error(`규칙 옵션 ${key}의 값이 올바르지 않습니다`);
    return v as T;
  };
  const flag = (key: string): boolean | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "boolean") throw new Error(`규칙 옵션 ${key}는 true/false여야 합니다`);
    return v;
  };
  const out: RuleOptions = {};
  const gameLength = oneOf("gameLength", ["east", "east-south"] as const);
  if (gameLength !== undefined && gameLength !== base.gameLength) out.gameLength = gameLength;
  const akaDora = oneOf("akaDora", ["none", "default", "more"] as const);
  if (akaDora !== undefined && akaDora !== "default") out.akaDora = akaDora;
  const kuitan = flag("kuitan");
  if (kuitan !== undefined && kuitan !== base.kuitan) out.kuitan = kuitan;
  const kuikae = flag("kuikae");
  if (kuikae !== undefined) {
    if (mode === "sanma") throw new Error("산마에는 치가 없어 쿠이카에 규칙이 없습니다");
    if (kuikae !== base.kuikae) out.kuikae = kuikae;
  }
  const doubleRon = oneOf("doubleRon", ["all", "atamahane"] as const);
  if (doubleRon !== undefined && doubleRon !== base.doubleRonMode) out.doubleRon = doubleRon;
  const kazoe = flag("kazoeYakuman");
  if (kazoe !== undefined && kazoe !== base.kazoeYakumanEnabled) out.kazoeYakuman = kazoe;
  const dbl = flag("doubleYakuman");
  if (dbl !== undefined && dbl !== base.doubleYakumanEnabled) out.doubleYakuman = dbl;
  const kiri = flag("kiriageMangan");
  if (kiri !== undefined && kiri !== base.kiriageMangan) out.kiriageMangan = kiri;
  return out;
}

/** 기본과 다른 규칙의 화면 표시용 한국어 이름들 (대국 화면에 작게 보여 준다). 기본 규칙이면 빈 배열. */
export function ruleOptionLabels(options: RuleOptions | undefined): string[] {
  if (!options) return [];
  const out: string[] = [];
  if (options.gameLength) out.push(options.gameLength === "east" ? "동풍전" : "동남전");
  if (options.akaDora) out.push(options.akaDora === "none" ? "적도라 없음" : options.akaDora === "more" ? "적도라 많이" : "적도라 기본");
  if (options.kuitan === false) out.push("쿠이탕 없음");
  if (options.kuikae === false) out.push("쿠이카에 허용");
  if (options.doubleRon === "atamahane") out.push("머리박기");
  if (options.kazoeYakuman === false) out.push("헤아림 역만 없음");
  if (options.doubleYakuman === false) out.push("더블 역만 없음");
  if (options.kiriageMangan === true) out.push("절상만관");
  return out;
}

/** 사람이 앉을 자리: 0 = 동(첫 친)부터 차례로, "random" = 시드로 정해지는 자리(같은 시드면 같은 자리). 생략하면 0. */
export type HumanSeatChoice = number | "random";

/** 시작 화면에서 고른 대국 구성. seed가 없으면 호출자가 새로 만든다. `humanSeat`를 생략하면 0(동가, 친)이다. */
export interface GuiGameConfig {
  mode: GuiGameMode;
  opponents: string[];
  seed?: string;
  saveReplays: boolean;
  humanSeat?: HumanSeatChoice;
  /** 기본과 다른 규칙 옵션 (생략하면 기본 규칙) */
  rules?: RuleOptions;
}

/** 시드 문자열에서 0..count-1의 자리를 정한다 (같은 시드는 항상 같은 자리). FNV-1a 해시를 쓴다. */
export function seatFromSeed(seed: string, count: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % count;
}

/** 고른 자리를 실제 좌석 번호로 바꾼다. */
export function resolveHumanSeat(choice: HumanSeatChoice | undefined, seed: string, mode: GuiGameMode): number {
  if (choice === undefined) return 0;
  return choice === "random" ? seatFromSeed(seed, playerCountOf(mode)) : choice;
}

/** 사람 좌석을 정한 좌석 배치: 상대는 사람 다음 차례부터 순서대로 앉는다(하가가 다음 차례, 상가가 이전 차례라는 관계는 그대로). */
export function seatsAroundHuman<T>(opponents: readonly T[], humanSeat: number): (T | null)[] {
  const n = opponents.length + 1;
  const seats: (T | null)[] = new Array(n).fill(null);
  opponents.forEach((o, i) => {
    seats[(humanSeat + 1 + i) % n] = o;
  });
  return seats;
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
  let humanSeat: HumanSeatChoice | undefined;
  if (raw.humanSeat !== undefined && raw.humanSeat !== null) {
    if (raw.humanSeat === "random") humanSeat = "random";
    else if (typeof raw.humanSeat === "number" && Number.isInteger(raw.humanSeat) && raw.humanSeat >= 0 && raw.humanSeat < playerCountOf(mode)) humanSeat = raw.humanSeat;
    else throw new Error(`내 자리(humanSeat)는 0~${playerCountOf(mode) - 1} 또는 "random"이어야 합니다`);
  }
  const rules = parseRuleOptions(raw.rules, mode);
  return {
    mode,
    opponents,
    ...(seed !== undefined ? { seed } : {}),
    saveReplays: raw.saveReplays === true,
    ...(humanSeat !== undefined ? { humanSeat } : {}),
    ...(Object.keys(rules).length > 0 ? { rules } : {}),
  };
}

/** AI 관전 대국의 기본 좌석 (seat 0부터 전부 AI). 로비 관전 설정 화면의 초기값. */
export const DEFAULT_WATCH_SEATS: Record<GuiGameMode, readonly string[]> = {
  sanma: ["jegalmina", "jegalnahui", "byeonari"],
  yonma: ["jegalmina", "jegalnahui", "byeonari", "seiyamouri"],
};

/** 로비 "AI끼리 관전"에서 고른 구성. 모든 좌석이 AI다. seed가 없으면 호출자가 새로 만든다. */
export interface AiWatchConfig {
  mode: GuiGameMode;
  seats: string[];
  seed?: string;
}

function parseSeed(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("시드는 문자열이어야 합니다");
  const trimmed = value.trim();
  if (trimmed.length > MAX_SEED_LENGTH) throw new Error(`시드는 ${MAX_SEED_LENGTH}자 이하여야 합니다`);
  return trimmed === "" ? undefined : trimmed;
}

/** 관전 구성 검증: 좌석 수는 모드 인원과 같고, 대국과 같은 이유로 같은 캐릭터를 두 좌석에 앉힐 수 없다. */
export function parseAiWatchConfig(input: unknown, resolveProfile: (id: string) => CharacterProfile = getCharacterProfile): AiWatchConfig {
  if (typeof input !== "object" || input === null) throw new Error("관전 설정이 비어 있습니다");
  const raw = input as Record<string, unknown>;
  const mode = parseGuiMode(typeof raw.mode === "string" ? raw.mode : String(raw.mode));
  if (!Array.isArray(raw.seats)) throw new Error("좌석 목록(seats)이 필요합니다");
  const expected = playerCountOf(mode);
  if (raw.seats.length !== expected) throw new Error(`좌석은 ${expected}개여야 합니다`);
  const seats = raw.seats.map((id) => {
    if (typeof id !== "string") throw new Error("좌석 characterId는 문자열이어야 합니다");
    return resolveProfile(id).characterId;
  });
  if (new Set(seats).size !== seats.length) throw new Error("같은 캐릭터를 두 좌석에 앉힐 수 없습니다");
  const seed = parseSeed(raw.seed);
  return { mode, seats, ...(seed !== undefined ? { seed } : {}) };
}

/** 친선전 대국: 좌석마다 사람(null) 또는 AI 프로필. 사람이 2명 이상이면 사람끼리 대국 모드(동시 묻기, 사람별 장면)로 만든다. */
export function createFriendGame(mode: GuiGameMode, seed: string, seats: readonly (CharacterProfile | null)[], rules: RuleConfig = baseRulesOf(mode)): GameState {
  if (seats.length !== playerCountOf(mode)) throw new Error(`${mode}: 좌석은 ${playerCountOf(mode)}개여야 합니다`);
  const humans = seats.filter((p) => p === null).length;
  if (humans === 0) throw new Error("친선전 대국에는 사람이 한 명 이상 있어야 합니다");
  return new GameState({
    rules,
    seed,
    characterProfiles: [...seats],
    controllers: seats.map((p) => (p === null ? ("human" as const) : isCustomAiCharacterId(p.characterId) ? ("customAI" as const) : ("characterAI" as const))),
    ...(humans >= 2 ? { multiplayer: true } : {}),
  });
}

/** AI 관전 여러 판 연속 실행의 판 수 상한 (한 판 10~30초라 20판이면 최대 10분 정도). */
export const MAX_WATCH_BATCH_GAMES = 20;

/** 여러 판 연속 관전 구성: 한 판 관전 구성 + 판 수 + 판마다 리플레이 저장 여부(기본 저장 안 함, 통계만). */
export interface AiWatchBatchConfig extends AiWatchConfig {
  games: number;
  saveReplays: boolean;
}

export function parseAiWatchBatchConfig(input: unknown, resolveProfile: (id: string) => CharacterProfile = getCharacterProfile): AiWatchBatchConfig {
  const base = parseAiWatchConfig(input, resolveProfile);
  const raw = input as Record<string, unknown>;
  const games = raw.games;
  if (typeof games !== "number" || !Number.isInteger(games) || games < 1 || games > MAX_WATCH_BATCH_GAMES) {
    throw new Error(`판 수는 1~${MAX_WATCH_BATCH_GAMES} 사이의 정수여야 합니다`);
  }
  if (raw.saveReplays !== undefined && typeof raw.saveReplays !== "boolean") throw new Error("saveReplays는 true/false여야 합니다");
  return { ...base, games, saveReplays: raw.saveReplays === true };
}

/** 사람 없이 모든 좌석이 AI인 판. 등록 캐릭터 좌석은 시뮬레이션(`npm run sim`)과 같은 characterAI, CustomAI 좌석은 customAI다. */
export function createAiWatchGame(mode: GuiGameMode, seed: string, profiles: readonly CharacterProfile[]): GameState {
  if (profiles.length !== playerCountOf(mode)) throw new Error(`${mode}: 좌석은 ${playerCountOf(mode)}개여야 합니다`);
  return new GameState({
    rules: mode === "yonma" ? MAJSOUL_YONMA_RULES : DEFAULT_SANMA_RULES,
    seed,
    characterProfiles: [...profiles],
    controllers: profiles.map((p) => (isCustomAiCharacterId(p.characterId) ? ("customAI" as const) : ("characterAI" as const))),
  });
}

export function createGuiGame(mode: GuiGameMode, seed: string, opponents: readonly string[] = DEFAULT_OPPONENTS[mode]): GameState {
  return createGuiGameWithProfiles(mode, seed, opponents.map((id) => getCharacterProfile(id)));
}

/** 상대 프로필을 직접 받아 판을 만든다. CustomAI 프로필(characterId가 "custom:"으로 시작)은 customAI 좌석이 되고,
 *  판단은 기존 CharacterAI가 그 프로필로 한다. 등록 캐릭터는 지금까지처럼 characterAI 좌석이다. */
export function createGuiGameWithProfiles(mode: GuiGameMode, seed: string, profiles: readonly CharacterProfile[], rules: RuleConfig = baseRulesOf(mode)): GameState {
  if (profiles.length !== playerCountOf(mode) - 1) throw new Error(`${mode}: 상대는 ${playerCountOf(mode) - 1}명이어야 합니다`);
  return new GameState({
    rules,
    seed,
    characterProfiles: [null, ...profiles],
    controllers: ["human", ...profiles.map((p) => (isCustomAiCharacterId(p.characterId) ? ("customAI" as const) : undefined))],
  });
}
