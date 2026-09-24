/* GUI 서버가 시작할 판을 만든다. 산마/4마는 RuleConfig와 좌석 구성만 다르고 나머지(GuiSession,
 * PlayerView, 작탁 DOM)는 완전히 같다. seat 0이 사람, 나머지는 캐릭터 AI. */
import { GameState } from "../core/GameState.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES } from "../rules/RuleConfig.js";
import { getCharacterProfile } from "../ai/characterProfiles.js";

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

export function createGuiGame(mode: GuiGameMode, seed: string): GameState {
  if (mode === "yonma") {
    return new GameState({
      rules: MAJSOUL_YONMA_RULES,
      seed,
      characterProfiles: [null, getCharacterProfile("jegalmina"), getCharacterProfile("jegalnahui"), getCharacterProfile("byeonari")],
      controllers: ["human", undefined, undefined, undefined],
    });
  }
  return new GameState({
    rules: DEFAULT_SANMA_RULES,
    seed,
    characterProfiles: [null, getCharacterProfile("jegalmina"), getCharacterProfile("jegalnahui")],
    controllers: ["human", undefined, undefined],
  });
}
