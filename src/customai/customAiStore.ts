/* custom-ai/ 폴더의 CustomAI 저장소. 파일 하나 = CustomAI 하나 (`${id}.json`). 파일 이름은 무작위 내부 id로만 만들며
 * 사용자 입력 이름을 경로에 쓰지 않는다. 쓰기/읽기 모두 customAiSchema의 같은 검증을 거친다. */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveReplayDir } from "../sim/replayRecorder.js";
import {
  CUSTOM_AI_FORMAT_VERSION,
  CUSTOM_AI_ID_PATTERN,
  CUSTOM_AI_NAME_MAX,
  CustomAiValidationError,
  parseCustomAiDefinition,
  validateCustomAiName,
  validateCustomAiStyle,
  type CustomAiDefinition,
} from "./customAiSchema.js";

export type CustomAiListEntry =
  | { ok: true; definition: CustomAiDefinition }
  | { ok: false; file: string; reason: string };

export class CustomAiStore {
  readonly dir: string;

  /** `dir`: 절대 경로이거나 프로젝트 루트 기준 상대 경로 (기본 "custom-ai"). */
  constructor(dir = "custom-ai") {
    this.dir = resolveReplayDir(dir);
  }

  private pathOf(id: string): string {
    if (!CUSTOM_AI_ID_PATTERN.test(id)) throw new CustomAiValidationError("id 형식이 올바르지 않습니다");
    return join(this.dir, `${id}.json`);
  }

  private newId(): string {
    for (;;) {
      const id = `c-${randomBytes(6).toString("hex")}`;
      if (!existsSync(join(this.dir, `${id}.json`))) return id;
    }
  }

  private write(def: CustomAiDefinition): CustomAiDefinition {
    const checked = parseCustomAiDefinition(def); // 저장 전에도 같은 검증
    mkdirSync(this.dir, { recursive: true });
    const target = this.pathOf(checked.id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(checked, null, 2), "utf-8");
    renameSync(tmp, target);
    return checked;
  }

  /** 폴더의 모든 CustomAI. 검증에 실패한 파일은 불러오지 않고 이유와 함께 알린다. 이름순. */
  list(): CustomAiListEntry[] {
    if (!existsSync(this.dir)) return [];
    const entries: CustomAiListEntry[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const def = parseCustomAiDefinition(JSON.parse(readFileSync(join(this.dir, file), "utf-8")));
        if (`${def.id}.json` !== file) throw new CustomAiValidationError("파일 이름과 id가 다릅니다");
        entries.push({ ok: true, definition: def });
      } catch (err) {
        entries.push({ ok: false, file, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return entries.sort((a, b) =>
      a.ok && b.ok ? a.definition.name.localeCompare(b.definition.name, "ko") : a.ok ? -1 : b.ok ? 1 : a.file.localeCompare(b.file)
    );
  }

  /** 검증을 통과한 CustomAI 하나. 없거나 검증에 실패하면 예외. */
  get(id: string): CustomAiDefinition {
    const path = this.pathOf(id);
    if (!existsSync(path)) throw new CustomAiValidationError("CustomAI를 찾을 수 없습니다");
    const def = parseCustomAiDefinition(JSON.parse(readFileSync(path, "utf-8")));
    if (def.id !== id) throw new CustomAiValidationError("파일 이름과 id가 다릅니다");
    return def;
  }

  create(input: { name: unknown; style: unknown }): CustomAiDefinition {
    return this.write({ formatVersion: CUSTOM_AI_FORMAT_VERSION, id: this.newId(), name: validateCustomAiName(input.name), style: validateCustomAiStyle(input.style) });
  }

  update(id: string, input: { name: unknown; style: unknown }): CustomAiDefinition {
    this.get(id); // 존재/유효성 확인
    return this.write({ formatVersion: CUSTOM_AI_FORMAT_VERSION, id, name: validateCustomAiName(input.name), style: validateCustomAiStyle(input.style) });
  }

  /** 같은 값으로 새 id를 만든다. 이름은 "원래 이름 복사본" (30자를 넘으면 원래 이름 쪽을 줄인다). */
  duplicate(id: string): CustomAiDefinition {
    const source = this.get(id);
    const suffix = " 복사본";
    const chars = [...source.name];
    const base = chars.length + suffix.length > CUSTOM_AI_NAME_MAX ? chars.slice(0, CUSTOM_AI_NAME_MAX - suffix.length).join("").trimEnd() : source.name;
    return this.write({ formatVersion: CUSTOM_AI_FORMAT_VERSION, id: this.newId(), name: `${base}${suffix}`, style: { ...source.style } });
  }

  delete(id: string): void {
    const path = this.pathOf(id);
    if (!existsSync(path)) throw new CustomAiValidationError("CustomAI를 찾을 수 없습니다");
    rmSync(path);
  }
}
