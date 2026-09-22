import type { GameEvent } from "../core/GameLog.js";
import type { RuleConfig } from "../rules/RuleConfig.js";
import { nextDoraKind } from "../yaku/dora.js";
import type { Violation } from "./invariants.js";

function handSlices(events: readonly GameEvent[]): { start: number; end: number }[] {
  const starts = events.map((e, i) => (e.type === "hand_start" ? i : -1)).filter((i) => i >= 0);
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? events.length }));
}

const REPLAY_MELD_TILE_COUNT: Record<string, number> = {
  chi: 3,
  pon: 3,
  daiminkan: 4,
  ankan: 4,
  kakan: 4,
};

/**
 * Schema v2 checks: `AuditableWinResult.doraBreakdown`/`.snapshot` and the
 * "dora_indicator_revealed" event stream. Kept fully separate from `checkWinLegality`
 * (invariants.ts) rather than folded into it - v1 replays (schemaVersion < 2, or simply
 * missing the optional fields) skip these entirely instead of failing them, since v1 never
 * populated this detail in the first place.
 */
export function checkReplaySchemaV2(
  rules: RuleConfig,
  events: readonly GameEvent[],
  schemaVersion: number
): Violation[] {
  const violations: Violation[] = [];
  if (schemaVersion < 2) return violations;

  for (const { start, end } of handSlices(events)) {
    const slice = events.slice(start, end);
    const kanRevealCount = slice.filter(
      (e): e is Extract<GameEvent, { type: "dora_indicator_revealed" }> =>
        e.type === "dora_indicator_revealed" && e.source === "kan"
    ).length;

    const handEnd = slice.find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end");
    if (!handEnd?.result || handEnd.result.kind !== "agari") continue;

    for (const w of handEnd.result.winners) {
      const at = `hand_end.result winner seat ${w.winnerSeat}`;

      if (!w.doraBreakdown) {
        violations.push({ category: "dora_breakdown", message: `${at}: schema v${schemaVersion} but doraBreakdown is missing` });
      }
      if (!w.snapshot) {
        violations.push({ category: "win_snapshot", message: `${at}: schema v${schemaVersion} but snapshot is missing` });
      }
      if (!w.doraBreakdown || !w.snapshot) continue;

      const { doraBreakdown, snapshot } = w;
      const doraYakuHan = w.yaku.find((y) => y.name === "Dora")?.han ?? 0;

      const summed = doraBreakdown.sources.reduce((sum, s) => sum + s.matchedTileIds.length, 0);
      if (summed !== doraBreakdown.totalHan) {
        violations.push({ category: "dora_breakdown", message: `${at}: sum(matchedTileIds) ${summed} !== totalHan ${doraBreakdown.totalHan}` });
      }
      if (doraBreakdown.totalHan !== doraYakuHan) {
        violations.push({ category: "dora_breakdown", message: `${at}: doraBreakdown.totalHan ${doraBreakdown.totalHan} !== "Dora" yaku han ${doraYakuHan}` });
      }

      const omoteSources = doraBreakdown.sources.filter((s) => s.type === "omote");
      const kanSources = doraBreakdown.sources.filter((s) => s.type === "kan");
      const uraSources = doraBreakdown.sources.filter((s) => s.type === "ura");
      const akaSources = doraBreakdown.sources.filter((s) => s.type === "aka");
      const kitaSources = doraBreakdown.sources.filter((s) => s.type === "kita");

      if (omoteSources.length !== 1) {
        violations.push({ category: "dora_breakdown", message: `${at}: expected exactly 1 omote source, found ${omoteSources.length}` });
      }
      if (kanSources.length !== kanRevealCount) {
        violations.push({ category: "dora_breakdown", message: `${at}: ${kanSources.length} kan sources but only ${kanRevealCount} kan-reveal events occurred this hand` });
      }
      const isRiichiWin = w.scoringFlags.riichi || w.scoringFlags.doubleRiichi;
      if (uraSources.length > 0 && !isRiichiWin) {
        violations.push({ category: "dora_breakdown", message: `${at}: ura source present on a non-riichi win` });
      }

      for (const s of [...omoteSources, ...kanSources, ...uraSources]) {
        const expectedKind = nextDoraKind(s.indicator.kind, rules);
        if (s.doraKind !== expectedKind) {
          violations.push({ category: "dora_breakdown", message: `${at}: indicator "${s.indicator.kind}" should point to "${expectedKind}", recorded as "${s.doraKind}"` });
        }
      }

      const snapshotTiles = [...snapshot.concealedTiles, ...snapshot.melds.flatMap((m) => m.tiles), ...snapshot.kitaTiles];
      // For the red/kita lookups only (not the ownership-duplicate check below): includes
      // winningTile separately, since for a ron it is deliberately absent from
      // concealedTiles (see WinSnapshot's definition) yet still legitimately contributes to
      // dora matching, exactly as it did during real scoring. Safe to just concat - a Set
      // collapses the tsumo case where winningTile is already present in snapshotTiles.
      const matchableTiles = [...snapshotTiles, snapshot.winningTile];
      const snapshotRedIds = new Set(matchableTiles.filter((t) => t.red).map((t) => t.id));
      for (const s of akaSources) {
        for (const id of s.matchedTileIds) {
          if (!snapshotRedIds.has(id)) {
            violations.push({ category: "dora_breakdown", message: `${at}: aka source tile id ${id} is not a red tile in the snapshot` });
          }
        }
      }

      const snapshotKitaIds = new Set(snapshot.kitaTiles.map((t) => t.id));
      for (const s of kitaSources) {
        for (const id of s.matchedTileIds) {
          if (!snapshotKitaIds.has(id)) {
            violations.push({ category: "dora_breakdown", message: `${at}: kita source tile id ${id} is not in snapshot.kitaTiles` });
          }
        }
      }

      const idCounts = new Map<number, number>();
      for (const t of snapshotTiles) idCounts.set(t.id, (idCounts.get(t.id) ?? 0) + 1);
      for (const [id, count] of idCounts) {
        if (count > 1) {
          violations.push({ category: "win_snapshot", message: `${at}: tile id ${id} appears ${count} times across concealed/melds/kita (impossible ownership)` });
        }
      }

      if (snapshot.winningTile.kind !== w.winningTile.kind || snapshot.winningTile.id !== w.winningTile.id) {
        violations.push({ category: "win_snapshot", message: `${at}: snapshot.winningTile does not match the winner result's winningTile` });
      }
      const winningTileInConcealed = snapshot.concealedTiles.some((t) => t.id === snapshot.winningTile.id);
      if (w.method === "tsumo" && !winningTileInConcealed) {
        violations.push({ category: "win_snapshot", message: `${at}: tsumo winningTile is missing from snapshot.concealedTiles` });
      }
      if (w.method === "ron" && winningTileInConcealed) {
        violations.push({ category: "win_snapshot", message: `${at}: ron winningTile should not be duplicated into snapshot.concealedTiles` });
      }
      if (snapshot.winningTileSource !== w.method) {
        violations.push({ category: "win_snapshot", message: `${at}: snapshot.winningTileSource "${snapshot.winningTileSource}" !== result method "${w.method}"` });
      }

      for (const meld of snapshot.melds) {
        const expectedCount = REPLAY_MELD_TILE_COUNT[meld.type];
        if (expectedCount !== undefined && meld.tiles.length !== expectedCount) {
          violations.push({ category: "win_snapshot", message: `${at}: meld type "${meld.type}" has ${meld.tiles.length} tiles, expected ${expectedCount}` });
        }
      }
    }
  }
  return violations;
}
