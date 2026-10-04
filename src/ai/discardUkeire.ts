/* 타패 후보별 "버린 뒤의 샹텐 + 유효패" (사람 플레이 보조 "유효패 표시", 표시 전용).
 * 입력은 자기 손패/멘츠 수와 view 안의 공개 정보뿐이다: 상대 손패와 패산은 읽지 않는다. CharacterAI의 판단에는 쓰이지 않는다. */
import type { RuleConfig } from "../rules/RuleConfig.js";
import { allKindsForRules, type Tile, type TileKind } from "../core/tiles.js";
import { kindToSlot, tilesToCounts } from "../core/tileIndex.js";
import { chiitoitsuShanten, kokushiShanten, standardShanten } from "../shanten/shanten.js";
import { unseenCountOf, type PlayerView, type WaitInfo } from "../core/playerView.js";

/** 손패의 한 종류를 버린 뒤의 상태 */
export interface DiscardUkeire {
  /** 버릴 패 종류 (손패에 있는 종류마다 하나) */
  kind: TileKind;
  /** 그 패를 버린 뒤의 샹텐 (엔진 minShanten, 0 = 텐파이, -1은 이미 화료형인 손에서만) */
  shanten: number;
  /** 버린 뒤 한 장 더 가져오면 샹텐이 줄어드는 패 종류와 미확인 장수 (공개 정보 기준 추정치, 미확인 0장인 종류는 뺀다).
   *  계산 시간을 아끼려고 샹텐이 가장 낮은 타패(= `best`)에만 계산하며, 그 밖의 타패는 `best: false`에 빈 배열이다. */
  ukeire: WaitInfo[];
  /** ukeire의 미확인 장수 합계 */
  total: number;
  /** 이 타패가 후보 중 가장 낮은 샹텐을 유지하는가 (ukeire를 계산한 타패) */
  best: boolean;
}

/**
 * 타패 요청의 손패(쯔모 포함 3n+2장)에서 종류별로 한 장을 버린 경우마다 샹텐과 유효패를 센다.
 * 같은 종류는 한 번만 계산한다. 샹텐이 낮고 유효패가 많은 순으로 정렬해 돌려준다.
 * 칠대자/국사는 멘츠가 없을 때만 minShanten이 함께 본다 (기존 샹텐 계산 그대로).
 */
export function computeDiscardUkeire(
  concealed: readonly Tile[],
  meldCount: number,
  rules: RuleConfig,
  view: Pick<PlayerView, "concealedTiles" | "melds" | "kitaTiles" | "discards" | "opponents" | "doraIndicators">
): DiscardUkeire[] {
  const counts = tilesToCounts(concealed);
  const drawable = allKindsForRules(rules).filter((k) => !(rules.kitaEnabled && k === "z4"));
  const kinds = [...new Set(concealed.map((t) => t.kind))];
  const shantenOf = (c: number[], std = standardShanten(c, meldCount)) =>
    meldCount === 0 ? Math.min(std, chiitoitsuShanten(c), kokushiShanten(c)) : std;

  // 1) 종류별로 버린 뒤의 샹텐
  const rows = kinds.map((kind) => {
    const slot = kindToSlot(kind);
    counts[slot]!--;
    const shanten = shantenOf(counts);
    counts[slot]!++;
    return { kind, slot, shanten };
  });
  const bestShanten = Math.min(...rows.map((r) => r.shanten));

  // 2) 샹텐이 가장 낮은 타패에만 유효패를 센다. 일반형은 손에 있거나 같은 수트의 ±2 안에 이웃이 있는 패만 의미가 있고
  //    (그 밖의 패는 떠 있는 패일 뿐이다), 칠대자/국사는 계산이 가벼워 모든 패를 본다.
  const out: DiscardUkeire[] = rows.map(({ kind, slot, shanten }) => {
    if (shanten !== bestShanten) return { kind, shanten, ukeire: [], total: 0, best: false };
    counts[slot]!--;
    const ukeire: WaitInfo[] = [];
    for (const draw of drawable) {
      const drawSlot = kindToSlot(draw);
      if (counts[drawSlot]! >= 4) continue;
      counts[drawSlot]!++;
      let improved = false;
      if (meldCount === 0) improved = chiitoitsuShanten(counts) < shanten || kokushiShanten(counts) < shanten;
      if (!improved && hasNeighbor(counts, drawSlot)) improved = standardShanten(counts, meldCount) < shanten;
      counts[drawSlot]!--;
      if (!improved) continue;
      // 버릴 패는 곧 강으로 옮겨 가 보이는 장수는 그대로다 (view의 손패 포함 계산과 같다)
      const unseenCount = unseenCountOf(view, draw);
      if (unseenCount > 0) ukeire.push({ kind: draw, unseenCount });
    }
    counts[slot]!++;
    return { kind, shanten, ukeire, total: ukeire.reduce((n, w) => n + w.unseenCount, 0), best: true };
  });
  return out.sort((a, b) => a.shanten - b.shanten || b.total - a.total);
}

/** `slot`의 패를 이미 가지고 있거나(`counts`에는 방금 가져온 그 패가 포함돼 있다 → 2장 이상) 같은 수트의 ±2 안에 패가 있는가 */
function hasNeighbor(counts: readonly number[], slot: number): boolean {
  if (counts[slot]! >= 2) return true;
  if (slot >= 27) return false; // 자패는 같은 종류가 이미 있을 때만 의미가 있다
  const base = Math.floor(slot / 9) * 9;
  for (let d = -2; d <= 2; d++) {
    if (d === 0) continue;
    const s = slot + d;
    if (s >= base && s < base + 9 && counts[s]! > 0) return true;
  }
  return false;
}
