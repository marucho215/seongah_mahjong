import type { TileKind } from "../core/tiles.js";

export type GroupType = "sequence" | "triplet" | "quad" | "pair";

export interface Group {
  type: GroupType;
  /** Base kind: for sequences the lowest tile's kind, otherwise the repeated kind. */
  kind: TileKind;
  concealed: boolean;
  /** True if this quad/triplet was completed via an open call (pon/open-kan/added-kan). */
  calledFrom?: number;
  hasRedFive?: boolean;
}

export type WaitType = "ryanmen" | "kanchan" | "penchan" | "shanpon" | "tanki";

export interface StandardDecomposition {
  groups: Group[];
  waitType: WaitType;
  winGroupIndex: number;
}

export interface WinContext {
  seatWind: number; // 1 East, 2 South, 3 West (North seat never occurs in sanma)
  roundWind: number;
  isTsumo: boolean;
  isRiichi: boolean;
  isDoubleRiichi: boolean;
  isIppatsu: boolean;
  isHaitei: boolean;
  isHoutei: boolean;
  isRinshan: boolean;
  isChankan: boolean;
  isTenhou: boolean;
  isChiihou: boolean;
  doraCount: number;
  uraDoraCount: number;
  akaDoraCount: number;
  kanCount: number;
}

export interface YakuHit {
  name: string;
  han: number;
}

export function groupToKinds(g: Group): TileKind[] {
  if (g.type === "sequence") {
    const suit = g.kind[0]!;
    const rank = Number(g.kind.slice(1));
    return [g.kind, `${suit}${rank + 1}`, `${suit}${rank + 2}`];
  }
  if (g.type === "pair") return [g.kind, g.kind];
  if (g.type === "triplet") return [g.kind, g.kind, g.kind];
  return [g.kind, g.kind, g.kind, g.kind];
}

export interface EvaluatedWin {
  yaku: YakuHit[];
  yakumanMultiplier: number; // 0 = not a yakuman hand
  han: number;
  fu: number;
  groups: Group[];
  waitType: WaitType;
  isMenzen: boolean;
}
