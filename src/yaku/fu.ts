import { isTerminalOrHonor, isHonor } from "../core/tiles.js";
import type { Group, WaitType } from "./types.js";

export interface FuContext {
  isTsumo: boolean;
  isMenzen: boolean;
  seatWind: number; // 1 East, 2 South, 3 West
  roundWind: number;
  isPinfu: boolean;
  isChiitoitsu: boolean;
  doubleWindFuStacks: boolean;
}

function groupFu(g: Group): number {
  if (g.type === "sequence" || g.type === "pair") return 0; // pair fu handled separately
  const terminalOrHonor = isTerminalOrHonor(g.kind);
  if (g.type === "triplet") return g.concealed ? (terminalOrHonor ? 8 : 4) : terminalOrHonor ? 4 : 2;
  // quad
  return g.concealed ? (terminalOrHonor ? 32 : 16) : terminalOrHonor ? 16 : 8;
}

export function pairFu(kind: string, seatWind: number, roundWind: number, doubleWindFuStacks = true): number {
  if (!isHonor(kind)) return 0;
  const rank = Number(kind.slice(1));
  if (rank === 5 || rank === 6 || rank === 7) return 2; // dragons
  const isSeatWind = rank === seatWind;
  const isRoundWind = rank === roundWind;
  if (!isSeatWind && !isRoundWind) return 0;
  if (isSeatWind && isRoundWind) return doubleWindFuStacks ? 4 : 2;
  return 2;
}

function waitFu(waitType: WaitType): number {
  return waitType === "kanchan" || waitType === "penchan" || waitType === "tanki" ? 2 : 0;
}

export function calcFu(groups: Group[], winGroupIndex: number, waitType: WaitType, ctx: FuContext): number {
  if (ctx.isChiitoitsu) return 25;
  if (ctx.isPinfu) return ctx.isTsumo ? 20 : 30;

  let fu = 20;
  for (const g of groups) fu += groupFu(g);
  const pair = groups.find((g) => g.type === "pair");
  if (pair) fu += pairFu(pair.kind, ctx.seatWind, ctx.roundWind, ctx.doubleWindFuStacks);
  fu += waitFu(waitType);
  if (ctx.isTsumo) fu += 2;
  else if (ctx.isMenzen) fu += 10; // menzen ron bonus

  // "open pinfu shape" floor: an open hand that is otherwise all-sequences, a non-value
  // pair, and a ryanmen wait contributes zero fu from every source above (no meld fu, no
  // pair fu, no wait fu, and no menzen-ron bonus since it's open) and would sit at exactly
  // 20fu on ron - real scoring floors this at 30fu even though the hand doesn't qualify for
  // the Pinfu yaku itself (that requires a closed hand). Tsumo doesn't need this: the +2
  // tsumo fu already pushes 20->22, which rounds up to 30 on its own.
  if (fu === 20 && !ctx.isTsumo) fu = 30;

  return Math.ceil(fu / 10) * 10;
}
