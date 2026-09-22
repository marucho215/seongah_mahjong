import type { Tile } from "../core/tiles.js";
import type { RuleConfig } from "../rules/RuleConfig.js";
import type { DoraBreakdown, DoraSource, TileRef } from "../core/GameLog.js";
import { matchDoraTileIds, nextDoraKind } from "./dora.js";

export function tileToRef(tile: Tile): TileRef {
  return tile.isRed ? { kind: tile.kind, id: tile.id, red: true } : { kind: tile.kind, id: tile.id };
}

export interface BuildDoraBreakdownOptions {
  /** Winning hand's concealed + meld tiles (the same set `countDora`/`countAkaDora` are
   *  evaluated against for scoring) - excludes kita tiles, passed separately below. */
  scoringTiles: readonly Tile[];
  kitaTiles: readonly Tile[];
  /** `Wall.doraIndicators()` verbatim - index 0 is always the initial indicator, any
   *  further entries are kan-revealed, matching Wall.ts's own indexing convention. */
  doraIndicators: readonly Tile[];
  /** `Wall.uraDoraIndicators()`, or `[]` when the hand isn't riichi/double-riichi - the
   *  caller decides eligibility, same as the existing `buildWinContext` call site does. */
  uraDoraIndicators: readonly Tile[];
  rules: RuleConfig;
}

/**
 * Reconstructs exactly which physical tiles produced this hand's dora han, from the same
 * indicator/hand state the scorer itself used - no replay-log reverse-engineering. The
 * same tile id may legitimately appear in more than one source (e.g. a red five that is
 * also the indicated dora kind, or two kan indicators pointing at the same kind), so
 * `matchedTileIds` is never deduplicated across sources; summing every source's length
 * always equals `totalHan`, which always equals the "Dora" yaku's han.
 */
export function buildDoraBreakdown(options: BuildDoraBreakdownOptions): DoraBreakdown {
  const { scoringTiles, kitaTiles, doraIndicators, uraDoraIndicators, rules } = options;
  const pool = [...scoringTiles, ...kitaTiles];
  const sources: DoraSource[] = [];

  doraIndicators.forEach((indicator, index) => {
    sources.push({
      type: index === 0 ? "omote" : "kan",
      indicator: tileToRef(indicator),
      doraKind: nextDoraKind(indicator.kind, rules),
      matchedTileIds: matchDoraTileIds(pool, indicator.kind, rules),
    });
  });

  for (const indicator of uraDoraIndicators) {
    sources.push({
      type: "ura",
      indicator: tileToRef(indicator),
      doraKind: nextDoraKind(indicator.kind, rules),
      matchedTileIds: matchDoraTileIds(pool, indicator.kind, rules),
    });
  }

  const akaTileIds = scoringTiles.filter((t) => t.isRed).map((t) => t.id);
  if (akaTileIds.length > 0) sources.push({ type: "aka", matchedTileIds: akaTileIds });

  // Every kita tile is worth 1 dora unconditionally (see countNukidora) - independent of,
  // and additional to, any omote/kan/ura source it may also have matched above via `pool`.
  const kitaTileIds = kitaTiles.map((t) => t.id);
  if (kitaTileIds.length > 0) sources.push({ type: "kita", matchedTileIds: kitaTileIds });

  const totalHan = sources.reduce((sum, s) => sum + s.matchedTileIds.length, 0);
  return { totalHan, sources };
}
