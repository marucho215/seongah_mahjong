import type { RuleConfig } from "../rules/RuleConfig.js";
import type { Tile, TileKind } from "../core/tiles.js";
import { tilesToCounts, kindToSlot } from "../core/tileIndex.js";
import { chiitoitsuShanten, kokushiShanten } from "../shanten/shanten.js";
import { decomposeWinningHand } from "./decompose.js";
import { calcFu } from "./fu.js";
import { evaluateStandardYaku } from "./yakuStandard.js";
import { isTanyaoHand, isHonitsuHand, isChinitsuHand, isHonroutouHand } from "./tileFacts.js";
import { standardYakuman, kokushiYakuman } from "./yakuman.js";
import { computeScore, type ScoreResult } from "./score.js";
import type { EvaluatedWin, Group, WaitType, WinContext, YakuHit } from "./types.js";
import { groupToKinds } from "./types.js";

export interface EvaluateWinInput {
  concealedTiles: Tile[]; // includes the winning tile
  melds: Group[];
  winTile: Tile;
  context: WinContext;
  rules: RuleConfig;
  winner: number;
  dealer: number;
  ronFrom?: number;
  honba?: number;
}

export interface FullWinResult extends EvaluatedWin {
  yakumanUnits: number;
  score: ScoreResult;
  /** Exact tile interpretation committed by the scorer. */
  winningTile: Tile;
  context: WinContext;
}

/**
 * Mahjong Soul treats the dealer's initial 14-tile Tenhou as having no uniquely fixed
 * agari tile. Evaluate each distinct kind as the final tile and keep the highest-valued
 * legal interpretation. Ordinary ron/tsumo must continue to call evaluateWin directly.
 */
export function evaluateInitialDealerWin(
  input: Omit<EvaluateWinInput, "winTile">
): FullWinResult | null {
  const candidates = [...input.concealedTiles]
    .sort((a, b) => kindToSlot(a.kind) - kindToSlot(b.kind) || a.id - b.id)
    .filter((tile, index, tiles) => index === 0 || tiles[index - 1]!.kind !== tile.kind);
  let best: FullWinResult | null = null;
  for (const candidate of candidates) {
    const preWinTiles = input.concealedTiles.filter((tile) => tile.id !== candidate.id);
    const result = evaluateWin({
      ...input,
      concealedTiles: [...preWinTiles, candidate],
      winTile: candidate,
    });
    if (result && (!best || result.score.totalPoints > best.score.totalPoints)) best = result;
  }
  return best;
}

function applyRonConcealment(groups: Group[], winGroupIndex: number, isTsumo: boolean): Group[] {
  if (isTsumo) return groups;
  const cloned = groups.map((g) => ({ ...g }));
  const g = cloned[winGroupIndex]!;
  if (g.type === "triplet" || g.type === "quad") g.concealed = false;
  return cloned;
}

function evaluateChiitoiYaku(allKinds: TileKind[], isMenzen: boolean, ctx: WinContext): YakuHit[] {
  const hits: YakuHit[] = [{ name: "Chiitoitsu", han: 2 }];
  if (ctx.isDoubleRiichi) hits.push({ name: "Double Riichi", han: 2 });
  else if (ctx.isRiichi) hits.push({ name: "Riichi", han: 1 });
  if (ctx.isRiichi && ctx.isIppatsu) hits.push({ name: "Ippatsu", han: 1 });
  if (ctx.isTsumo && isMenzen) hits.push({ name: "Menzen Tsumo", han: 1 });
  if (ctx.isHaitei) hits.push({ name: "Haitei Raoyue", han: 1 });
  if (ctx.isHoutei) hits.push({ name: "Houtei Raoyui", han: 1 });
  if (ctx.isRinshan) hits.push({ name: "Rinshan Kaihou", han: 1 });
  if (isTanyaoHand(allKinds)) hits.push({ name: "Tanyao", han: 1 });
  if (isHonitsuHand(allKinds)) hits.push({ name: "Honitsu", han: 3 });
  if (isChinitsuHand(allKinds)) hits.push({ name: "Chinitsu", han: 6 });
  if (isHonroutouHand(allKinds)) hits.push({ name: "Honroutou", han: 2 });
  return hits;
}

export function evaluateWin(input: EvaluateWinInput): FullWinResult | null {
  const { concealedTiles, melds, winTile, context: ctx, rules } = input;
  const isMenzen = melds.every((g) => g.concealed);
  const counts = tilesToCounts(concealedTiles);
  const winSlot = kindToSlot(winTile.kind);
  const meldKinds = melds.flatMap(groupToKinds);

  const candidates: { groups: Group[]; waitType: WaitType; fu: number; yaku: YakuHit[]; yakumanUnits: number }[] = [];
  const unitsOf = (units: number) => (rules.doubleYakumanEnabled ? units : Math.min(units, 1));

  // --- standard form ---
  const decomps = decomposeWinningHand(counts, melds, winSlot);
  for (const d of decomps) {
    const groups = applyRonConcealment(d.groups, d.winGroupIndex, ctx.isTsumo);
    const allKinds = [...concealedTiles.map((t) => t.kind), ...meldKinds];
    const yakumanHits = standardYakuman(groups, d.waitType, allKinds, winTile.kind, isMenzen, ctx);
    const yakumanUnits = yakumanHits.reduce((s, h) => s + unitsOf(h.units), 0);

    if (yakumanUnits > 0) {
      candidates.push({
        groups,
        waitType: d.waitType,
        fu: 0,
        yaku: yakumanHits.map((h) => ({ name: h.name, han: 13 * unitsOf(h.units) })),
        yakumanUnits,
      });
      continue;
    }

    const isPinfuHand = evaluateStandardYaku(groups, d.waitType, isMenzen, allKinds, ctx, rules.kuitan).some(
      (h) => h.name === "Pinfu"
    );
    const fu = calcFu(groups, d.winGroupIndex, d.waitType, {
      isTsumo: ctx.isTsumo,
      isMenzen,
      seatWind: ctx.seatWind,
      roundWind: ctx.roundWind,
      isPinfu: isPinfuHand,
      isChiitoitsu: false,
      doubleWindFuStacks: rules.doubleWindFuStacks,
    });
    const yaku = evaluateStandardYaku(groups, d.waitType, isMenzen, allKinds, ctx, rules.kuitan, rules.northIsYakuhai);
    candidates.push({ groups, waitType: d.waitType, fu, yaku, yakumanUnits: 0 });
  }

  // --- chiitoitsu (closed hand only) ---
  if (isMenzen && melds.length === 0 && chiitoitsuShanten(counts) <= -1) {
    const allKinds = concealedTiles.map((t) => t.kind);
    const pairGroups: Group[] = [];
    const seen = new Set<string>();
    for (const t of concealedTiles) {
      if (seen.has(t.kind)) continue;
      seen.add(t.kind);
      pairGroups.push({ type: "pair", kind: t.kind, concealed: true });
    }
    const yakumanHits = standardYakuman(pairGroups, "tanki", allKinds, winTile.kind, isMenzen, ctx);
    const yakumanUnits = yakumanHits.reduce((s, h) => s + unitsOf(h.units), 0);
    if (yakumanUnits > 0) {
      candidates.push({
        groups: pairGroups,
        waitType: "tanki",
        fu: 0,
        yaku: yakumanHits.map((h) => ({ name: h.name, han: 13 * unitsOf(h.units) })),
        yakumanUnits,
      });
    } else {
      candidates.push({
        groups: pairGroups,
        waitType: "tanki",
        fu: 25,
        yaku: evaluateChiitoiYaku(allKinds, isMenzen, ctx),
        yakumanUnits: 0,
      });
    }
  }

  // --- kokushi musou (closed hand only) ---
  if (isMenzen && melds.length === 0 && kokushiShanten(counts) <= -1) {
    const allKinds = concealedTiles.map((t) => t.kind);
    const hit = kokushiYakuman(allKinds, winTile.kind);
    if (hit) {
      const contextualHits = standardYakuman([], "tanki", allKinds, winTile.kind, isMenzen, ctx)
        .filter((candidate) => candidate.name === "Tenhou" || candidate.name === "Chiihou");
      const yakumanHits = [hit, ...contextualHits];
      const units = yakumanHits.reduce((sum, candidate) => sum + unitsOf(candidate.units), 0);
      candidates.push({
        groups: [],
        waitType: "tanki",
        fu: 0,
        yaku: yakumanHits.map((candidate) => ({ name: candidate.name, han: 13 * unitsOf(candidate.units) })),
        yakumanUnits: units,
      });
    }
  }

  if (candidates.length === 0) return null;

  let best: { c: (typeof candidates)[number]; han: number; score: ScoreResult; effectiveYakumanUnits: number } | null =
    null;
  for (const c of candidates) {
    if (c.yaku.length === 0) continue; // no yaku -> not a valid win under this interpretation
    const yakuHan = c.yaku.reduce((s, h) => s + h.han, 0);
    const doraHan = c.yakumanUnits > 0 ? 0 : ctx.doraCount + ctx.uraDoraCount + ctx.akaDoraCount;
    const han = yakuHan + doraHan;
    // "kazoe yakuman": 13+ han reached through ordinary yaku+dora stacking (no actual
    // yakuman shape present) scores as a single yakuman when the rule allows it.
    const effectiveYakumanUnits =
      c.yakumanUnits === 0 && han >= 13 && rules.kazoeYakumanEnabled ? 1 : c.yakumanUnits;
    const score = computeScore({
      han,
      fu: c.fu,
      yakumanUnits: effectiveYakumanUnits,
      winner: input.winner,
      dealer: input.dealer,
      isTsumo: ctx.isTsumo,
      ronFrom: input.ronFrom,
      honba: input.honba,
      playerCount: input.rules.playerCount,
      rules,
    });
    if (!best || score.totalPoints > best.score.totalPoints) {
      best = { c, han, score, effectiveYakumanUnits };
    }
  }

  if (!best) return null;
  const doraHan = best.c.yakumanUnits > 0 ? 0 : ctx.doraCount + ctx.uraDoraCount + ctx.akaDoraCount;
  const finalYaku =
    doraHan > 0 ? [...best.c.yaku, { name: "Dora", han: doraHan }] : best.c.yaku;

  return {
    yaku: finalYaku,
    yakumanMultiplier: best.effectiveYakumanUnits,
    han: best.han,
    fu: best.c.fu,
    groups: best.c.groups,
    waitType: best.c.waitType,
    isMenzen,
    yakumanUnits: best.effectiveYakumanUnits,
    score: best.score,
    winningTile: winTile,
    context: { ...ctx },
  };
}
