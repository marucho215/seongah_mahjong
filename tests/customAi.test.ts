import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameState } from "../src/core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../src/rules/RuleConfig.js";
import { getCharacterProfile } from "../src/ai/characterProfiles.js";
import {
  CUSTOM_AI_FIELDS,
  customAiToProfile,
  initialCustomAiStyle,
  isUsableProfileSnapshot,
  parseCustomAiDefinition,
  type CustomAiDefinition,
} from "../src/customai/customAiSchema.js";
import { CustomAiStore } from "../src/customai/customAiStore.js";
import { buildGameReplayRecord, replaySeatsFromGame } from "../src/sim/replayRecorder.js";
import { reproduceReplay } from "../src/replay/replayReproduction.js";
import { createGuiGameWithProfiles } from "../src/gui/gameSetup.js";
import { GuiSession } from "../src/gui/guiSession.js";
import { defaultResponse } from "./helpers/yonmaHuman.js";

const PROFILE_FIELDS = [
  "skill", "aggression", "defense", "riichiBias", "damaBias", "callBias", "foldThreshold", "valueGreed",
  "honitsuBias", "chiitoitsuBias", "yakumanGreed", "riskTolerance", "entropy", "mistakeRate", "candidateScoreTolerance",
];

function def(style = initialCustomAiStyle(), name = "테스트 AI"): CustomAiDefinition {
  return { formatVersion: 1, id: "c-0123456789ab", name, style };
}

describe("CustomAI 스키마", () => {
  it("CharacterAI 공통 파라미터 15개를 모두 사용자 값으로 넘기고, 특수 메커니즘 필드는 넣지 않는다", () => {
    expect(CUSTOM_AI_FIELDS.map((f) => f.profileKey).sort()).toEqual([...PROFILE_FIELDS].sort());
    const style = Object.fromEntries(CUSTOM_AI_FIELDS.map((f, i) => [f.key, (i * 7) % 101]));
    const profile = customAiToProfile(def(style));
    for (const f of CUSTOM_AI_FIELDS) expect(profile[f.profileKey]).toBe(f.toInternal(style[f.key]!));
    expect(Object.keys(profile).sort()).toEqual(["archetype", "characterId", "displayName", ...PROFILE_FIELDS].sort());
    expect(profile.characterId).toBe("custom:c-0123456789ab");
    expect(isUsableProfileSnapshot(profile)).toBe(true);
  });

  it("슬라이더 끝값은 코드에서 확인한 안전 범위의 끝과 같다 (후보 허용 폭만 0.05~0.25, 나머지 0~1)", () => {
    for (const f of CUSTOM_AI_FIELDS) {
      const [lo, hi] = f.key === "tolerance" ? [0.05, 0.25] : [0, 1];
      expect(f.toInternal(0)).toBe(lo);
      expect(f.toInternal(100)).toBe(hi);
    }
  });

  it("초기값: 성향은 50, 판단 품질/접기 기준은 등록 캐릭터 중앙값에 가까운 값 (고정값이 아니라 초기값)", () => {
    const p = customAiToProfile(def());
    expect(p.skill).toBe(0.69);
    expect(p.foldThreshold).toBe(0.46);
    expect(p.entropy).toBe(0.37);
    expect(p.mistakeRate).toBe(0.02);
    expect(p.candidateScoreTolerance).toBe(0.06);
    expect(p.aggression).toBe(0.5);
  });

  it("충돌해 보이는 조합도 그대로 허용하고 값을 바꾸지 않는다", () => {
    const style = { ...initialCustomAiStyle(), attack: 100, defense: 100, riichi: 100, dama: 100, skill: 0, mistake: 100 };
    expect(parseCustomAiDefinition(def(style)).style).toEqual(style);
  });

  it("알 수 없는 필드/잘못된 타입/범위 밖/정수 아님/버전 불일치/잘못된 id/빈 이름은 거절한다", () => {
    const ok = def();
    expect(() => parseCustomAiDefinition({ ...ok, extra: 1 })).toThrow(/알 수 없는 필드/);
    expect(() => parseCustomAiDefinition({ ...ok, style: { ...ok.style, luck: 50 } })).toThrow(/알 수 없는 항목/);
    const { attack: _a, ...missing } = ok.style;
    expect(() => parseCustomAiDefinition({ ...ok, style: missing })).toThrow(/값이 없습니다/);
    expect(() => parseCustomAiDefinition({ ...ok, style: { ...ok.style, attack: "50" } })).toThrow(/정수/);
    expect(() => parseCustomAiDefinition({ ...ok, style: { ...ok.style, attack: 50.5 } })).toThrow(/정수/);
    expect(() => parseCustomAiDefinition({ ...ok, style: { ...ok.style, skill: 101 } })).toThrow(/0~100/);
    expect(() => parseCustomAiDefinition({ ...ok, style: { ...ok.style, tolerance: -1 } })).toThrow(/0~100/);
    expect(() => parseCustomAiDefinition({ ...ok, formatVersion: 2 })).toThrow(/형식 버전/);
    expect(() => parseCustomAiDefinition({ ...ok, id: "../evil" })).toThrow(/id/);
    expect(() => parseCustomAiDefinition({ ...ok, name: "   " })).toThrow(/이름/);
    expect(() => parseCustomAiDefinition({ ...ok, name: "가".repeat(31) })).toThrow(/30자/);
  });
});

describe("CustomAI 저장소 (custom-ai/)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("생성/수정/복제/삭제, 파일 이름은 내부 id이고 사용자 이름을 경로에 쓰지 않는다", () => {
    dir = mkdtempSync(join(tmpdir(), "custom-ai-"));
    const store = new CustomAiStore(dir);
    const a = store.create({ name: "../../나의 AI", style: initialCustomAiStyle() });
    expect(readdirSync(dir)).toEqual([`${a.id}.json`]);
    expect(JSON.parse(readFileSync(join(dir, `${a.id}.json`), "utf-8"))).toEqual(a);

    const edited = store.update(a.id, { name: "수정한 AI", style: { ...a.style, attack: 90 } });
    expect(store.get(a.id)).toEqual(edited);

    const copy = store.duplicate(a.id);
    expect(copy.id).not.toBe(a.id);
    expect(copy.name).toBe("수정한 AI 복사본");
    expect(copy.style).toEqual(edited.style);

    store.delete(a.id);
    expect(store.list().map((e) => (e.ok ? e.definition.id : e.file))).toEqual([copy.id]);
    expect(() => store.update(a.id, { name: "x", style: initialCustomAiStyle() })).toThrow();
    expect(() => store.create({ name: "x", style: { ...initialCustomAiStyle(), skill: 200 } })).toThrow();
  });

  it("검증에 실패한 파일은 불러오지 않고 이유와 함께 알린다", () => {
    dir = mkdtempSync(join(tmpdir(), "custom-ai-"));
    const store = new CustomAiStore(dir);
    const good = store.create({ name: "정상", style: initialCustomAiStyle() });
    writeFileSync(join(dir, "c-aaaaaaaaaaaa.json"), JSON.stringify({ ...good, id: "c-aaaaaaaaaaaa", style: { ...good.style, skill: 500 } }));
    writeFileSync(join(dir, "c-bbbbbbbbbbbb.json"), "{ not json");
    const list = store.list();
    expect(list.filter((e) => e.ok).map((e) => e.ok && e.definition.id)).toEqual([good.id]);
    expect(list.filter((e) => !e.ok).length).toBe(2);
    expect(() => store.get("c-aaaaaaaaaaaa")).toThrow();
  });
});

describe("CustomAI 좌석 (기존 CharacterAI에 사용자 프로필 전달)", () => {
  it("같은 프로필이면 customAI 좌석과 characterAI 좌석의 대국 로그/AI 판단이 같다 (판단 로직 동일)", () => {
    const profile = { ...getCharacterProfile("hwayoung"), characterId: "custom:c-0123456789ab", displayName: "테스트" };
    const others = [getCharacterProfile("jegalmina"), getCharacterProfile("josangmin")];
    const run = (kind: "characterAI" | "customAI") => {
      const g = new GameState({ rules: DEFAULT_SANMA_RULES, seed: "custom-ai-parity", characterProfiles: [profile, ...others], controllers: [kind, undefined, undefined] });
      g.playGame();
      return g;
    };
    const a = run("characterAI");
    const b = run("customAI");
    expect(JSON.stringify(b.log)).toBe(JSON.stringify(a.log));
    expect(JSON.stringify(b.aiDecisionLog)).toBe(JSON.stringify(a.aiDecisionLog));
    expect(b.controllers[0]).toBe("customAI");
  }, 60_000);

  it("CustomAI 대국 리플레이는 그 좌석에만 프로필 스냅샷을 담고, CustomAI를 고치거나 지워도 스냅샷으로 같게 재현된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "custom-ai-"));
    try {
      const store = new CustomAiStore(dir);
      const custom = store.create({ name: "리플레이 AI", style: { ...initialCustomAiStyle(), attack: 85, riichi: 90, skill: 40 } });
      const game = createGuiGameWithProfiles("sanma", "custom-ai-replay", [customAiToProfile(store.get(custom.id)), getCharacterProfile("inan")]);
      const session = new GuiSession(game);
      for (let steps = 0; session.getPhase() !== "game_end"; steps++) {
        if (steps > 200000) throw new Error("game did not finish");
        if (session.getPhase() === "hand_end") session.continueToNextHand();
        else session.respond(defaultResponse(session.getCurrentRequest()!));
      }
      const record = JSON.parse(JSON.stringify(buildGameReplayRecord(game, "custom", 0, replaySeatsFromGame(game))));
      expect(record.meta.replaySchemaVersion).toBe(2);
      expect(record.meta.seats.map((s: { kind: string }) => s.kind)).toEqual(["human", "customAI", "characterAI"]);
      expect(record.meta.seats[1].customProfile).toEqual(customAiToProfile(custom));
      expect(record.meta.seats[0]).not.toHaveProperty("customProfile");
      expect(record.meta.seats[2]).not.toHaveProperty("customProfile");

      store.update(custom.id, { name: "바뀐 이름", style: { ...custom.style, attack: 5 } });
      expect(reproduceReplay(record).ok).toBe(true);
      store.delete(custom.id);
      expect(reproduceReplay(record).ok).toBe(true);

      const broken = JSON.parse(JSON.stringify(record));
      delete broken.meta.seats[1].customProfile;
      expect(reproduceReplay(broken).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
