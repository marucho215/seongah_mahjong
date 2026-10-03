// README의 캐릭터 목록(터미널 명령의 characterId 표)이 코드의 등록 캐릭터, 이름, 로비 카드 태그와 같은지 확인한다.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CHARACTER_PROFILES } from "../src/ai/characterProfiles.js";
import { CHARACTER_PRESENTATION } from "../src/gui/characterRoster.js";

describe("README 캐릭터 목록", () => {
  it("표의 characterId/이름/태그가 등록 순서 그대로 코드와 같다", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const rows = [...readme.matchAll(/^\| `([a-z0-9]+)` \| ([^|]+) \| ([^|]*) \|$/gm)].map((m) => ({
      id: m[1]!,
      name: m[2]!.trim(),
      tags: m[3]!.trim(),
    }));
    const expected = Object.values(CHARACTER_PROFILES).map((p) => ({
      id: p.characterId,
      name: p.displayName,
      tags: (CHARACTER_PRESENTATION[p.characterId]?.tags ?? []).join(", "),
    }));
    expect(rows).toEqual(expected);
  });
});
