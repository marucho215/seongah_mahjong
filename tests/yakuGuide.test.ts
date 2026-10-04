// 마작 배우기(역 도감) 데이터의 정확성: 모든 역에 설명이 있고, 예시 패가 실제로 그 역으로 평가되며 판수가 엔진 값과 같다.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MAJSOUL_YONMA_RULES } from "../src/rules/RuleConfig.js";
import { evaluateWin } from "../src/yaku/evaluate.js";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";
import type { WinContext } from "../src/yaku/types.js";

type Entry = { id: string; name: string; han: string; menzen: string; tag: string; summary: string; tips?: string; example?: { groups: string[][]; note?: string } };
// 브라우저용 스크립트(전역 const)를 module.exports가 있는 함수 안에서 실행해 읽는다
const guideModule = { exports: {} as unknown };
new Function("module", readFileSync("src/gui/public/yakuGuide.js", "utf8"))(guideModule);
const { YAKU_GUIDE, GUIDE_BASICS, GUIDE_TAGS, DORA_GUIDE } = guideModule.exports as {
  YAKU_GUIDE: Entry[];
  GUIDE_BASICS: { id: string; title: string; body: string[]; example?: { groups: string[][] } }[];
  GUIDE_TAGS: [string, string][];
  DORA_GUIDE: Entry;
};

let nextId = 1;
const tile = (kind: string): Tile => ({ id: nextId++, kind: kind as TileKind, suit: parseKind(kind as TileKind).suit, rank: parseKind(kind as TileKind).rank, isRed: false });

function ctx(overrides: Partial<WinContext>): WinContext {
  return { seatWind: 1, roundWind: 1, isTsumo: true, isRiichi: false, isDoubleRiichi: false, isIppatsu: false, isHaitei: false, isHoutei: false, isRinshan: false, isChankan: false, isTenhou: false, isChiihou: false, doraCount: 0, uraDoraCount: 0, akaDoraCount: 0, kanCount: 0, ...overrides };
}

/** 예시 패(13장이면 모든 종류를 마지막 패로 시도, 14장이면 각 패를 마지막 패로)로 쯔모/론 모두 평가해 id가 나오는 결과들 */
function hitsFor(entry: Entry): { han: number; units: number }[] {
  const kinds = entry.example!.groups.flat();
  const found: { han: number; units: number }[] = [];
  const winKinds = kinds.length === 14 ? [...new Set(kinds)] : ([...new Set(kinds)].length ? Array.from({ length: 34 }, (_, i) => (i < 9 ? `m${i + 1}` : i < 18 ? `p${i - 8}` : i < 27 ? `s${i - 17}` : `z${i - 26}`)) : []);
  for (const win of winKinds) {
    const pre = kinds.length === 14 ? (() => { const copy = [...kinds]; copy.splice(copy.indexOf(win), 1); return copy; })() : kinds;
    for (const isTsumo of [true, false]) {
      const winTile = tile(win);
      const result = evaluateWin({
        concealedTiles: [...pre.map(tile), winTile],
        melds: [],
        winTile,
        context: ctx({ isTsumo, isRiichi: entry.id === "Riichi" }),
        rules: MAJSOUL_YONMA_RULES,
        winner: 0,
        dealer: 1,
        ...(isTsumo ? {} : { ronFrom: 2 }),
      });
      const hit = result?.yaku.find((y) => y.name === entry.id);
      if (hit) found.push({ han: hit.han, units: result!.yakumanUnits });
    }
  }
  return found;
}

describe("역 도감 데이터", () => {
  it("엔진이 결과에 적는 모든 역 이름(app.js의 YAKU_KO)에 설명이 있다 (도라는 별도)", () => {
    const app = readFileSync("src/gui/public/app.js", "utf8");
    const block = app.slice(app.indexOf("const YAKU_KO = {"), app.indexOf("};", app.indexOf("const YAKU_KO = {")));
    const ids = [...block.matchAll(/^\s+(?:"([^"]+)"|([A-Za-z]+)):\s*"/gm)].map((m) => m[1] ?? m[2]!);
    expect(ids.length).toBeGreaterThan(40);
    const guideIds = new Set(YAKU_GUIDE.map((e) => e.id));
    for (const id of ids) if (id !== "Dora") expect(guideIds.has(id), `${id}`).toBe(true);
    // 삼원패 역패는 이름이 동적이라(Yakuhai (z5)) 따로 확인
    for (const id of ["Yakuhai (z5)", "Yakuhai (z6)", "Yakuhai (z7)"]) expect(guideIds.has(id)).toBe(true);
    expect(DORA_GUIDE.id).toBe("Dora");
  });

  it("항목 형식: id가 겹치지 않고 모든 항목에 이름/판수/설명/분류가 있다", () => {
    const tags = new Set(GUIDE_TAGS.map(([t]) => t));
    const seen = new Set<string>();
    for (const e of YAKU_GUIDE) {
      expect(seen.has(e.id), e.id).toBe(false);
      seen.add(e.id);
      for (const field of [e.name, e.han, e.menzen, e.summary]) expect(field.length).toBeGreaterThan(0);
      expect(tags.has(e.tag), e.id).toBe(true);
    }
    for (const b of GUIDE_BASICS) expect(b.body.length).toBeGreaterThan(0);
  });

  const withExample = YAKU_GUIDE.filter((e) => e.example);
  it("예시가 있는 역이 충분히 많다", () => expect(withExample.length).toBeGreaterThan(20));
  for (const entry of withExample) {
    it(`예시 패가 실제로 ${entry.name}(${entry.id})로 평가되고 판수가 도감과 같다`, () => {
      const hits = hitsFor(entry);
      expect(hits.length, `${entry.name} 예시가 화료로 평가되지 않거나 그 역이 나오지 않음`).toBeGreaterThan(0);
      const head = Number(/^(\d+)판/.exec(entry.han)?.[1] ?? NaN);
      if (entry.tag === "yakuman") {
        const units = entry.han.includes("더블") ? 2 : 1;
        expect(hits.some((h) => h.units >= units)).toBe(true);
      } else if (!Number.isNaN(head)) {
        // 멘젠으로 만든 예시의 판수 (울면 줄어드는 역은 도감에 멘젠 판수를 앞에 적는다)
        expect(hits.some((h) => h.han === head), `${entry.name}: 도감 ${head}판, 엔진 ${hits.map((h) => h.han)}`).toBe(true);
      }
    });
  }
});
