import type { Hand } from "./Hand.js";
import type { Tile, TileKind } from "./tiles.js";
import type { MeldSnapshot, TileRef } from "./GameLog.js";
import { tileToRef } from "../yaku/doraBreakdown.js";
import { meldToSnapshot } from "../yaku/winSnapshot.js";
import { NO_FURITEN, type FuritenSnapshot } from "../actions/furiten.js";
import { seatDistance } from "./seats.js";
import { tilesToCounts } from "./tileIndex.js";
import { minShanten } from "../shanten/shanten.js";
import { discardRiskLevel, type DiscardRiskLevel } from "../ai/discardDanger.js";

/** Position, within the visible river (`discards`, called-away tiles excluded), of the tile
 *  to draw sideways because it declared riichi - null when no riichi declaration. If the
 *  declaration tile itself was called away, the next visible discard takes over (the usual
 *  table convention). Display data only; derived from DiscardEntry.isRiichiDeclaration. */
export function riichiDiscardIndexOf(hand: Hand): number | null {
  const declaredAt = hand.discards.findIndex((d) => d.isRiichiDeclaration);
  if (declaredAt === -1) return null;
  const visibleBefore = hand.discards.slice(0, declaredAt).filter((d) => !d.calledAway).length;
  const visibleTotal = hand.discards.filter((d) => !d.calledAway).length;
  return visibleBefore < visibleTotal ? visibleBefore : null;
}

/** 대기패 한 종류와, 이 플레이어에게 아직 보이지 않은 장수. */
export interface WaitInfo {
  kind: TileKind;
  /** 4 - (이 플레이어가 지금 알고 있는 같은 종류의 장수). 실제 패산 잔여 수가 아니라 "공개 정보 기준 추정치"다:
   *  자기 손패/멘츠/북, 모든 버림패, 모든 공개 멘츠/북, 도라 표시패만 센다. 상대 손패나 패산의 실제 내용은 쓰지 않는다. */
  unseenCount: number;
}

/** 대기패로 화료할 때 역이 없는 경우 (HandStatus.tenpaiWaits에만 붙는다, 역이 있으면 필드가 없다).
 *  "none": 론도 쯔모도 역이 없다 (울어서 멘젠쯔모도 없는 손). "tsumo_only": 론은 역이 없고 쯔모만 멘젠쯔모로 화료할 수 있다.
 *  해저/하저/영상/창깡처럼 그 순간에만 붙는 역은 셈하지 않는다. */
export type WaitYaku = "none" | "tsumo_only";

/** HandStatus의 대기패 하나: WaitInfo + 역 유무 */
export interface TenpaiWaitInfo extends WaitInfo {
  yaku?: WaitYaku;
}

/**
 * view 안에 이미 담긴 공개 정보만으로 `kind`의 미확인 장수를 센다 (4 - 보이는 장수, 0 미만은 0).
 * 이 함수는 PlayerView의 필드만 읽으므로, view에 없는 정보(상대 손패, 패산)는 구조적으로 쓸 수 없다.
 */
export function unseenCountOf(
  view: Pick<PlayerView, "concealedTiles" | "melds" | "kitaTiles" | "discards" | "opponents" | "doraIndicators">,
  kind: TileKind
): number {
  let visible = 0;
  const count = (k: TileKind): void => {
    if (k === kind) visible++;
  };
  for (const t of view.concealedTiles) count(t.kind);
  for (const m of view.melds) for (const t of m.tiles) count(t.kind);
  for (const t of view.kitaTiles) count(t.kind);
  for (const k of view.discards) count(k);
  for (const o of view.opponents) {
    for (const k of o.discards) count(k);
    for (const m of o.melds) for (const t of m.tiles) count(t.kind);
    if (kind === "z4") visible += o.kitaCount; // 북빼기 패는 모두 북(z4)이며 공개돼 있다
  }
  for (const t of view.doraIndicators) count(t.kind);
  return Math.max(0, 4 - visible);
}

export function withUnseenCounts(
  view: Parameters<typeof unseenCountOf>[0],
  kinds: readonly TileKind[]
): WaitInfo[] {
  return kinds.map((kind) => ({ kind, unseenCount: unseenCountOf(view, kind) }));
}

export interface PlayerViewOpponent {
  seat: number;
  /** Own discards only, excluding any that were called away (those tiles now live in the
   *  caller's meld, not the river) - matches collectVisibleTileKinds' own convention. */
  discards: TileKind[];
  /** See riichiDiscardIndexOf. */
  riichiDiscardIndex: number | null;
  /** How many tiles this seat holds concealed - public information (a table sees the size of
   *  every hand), so a UI can draw the right number of face-down tiles. Count only: never
   *  which tiles. */
  concealedCount: number;
  melds: MeldSnapshot[];
  riichi: boolean;
  kitaCount: number;
}

/**
 * Everything a UI/HumanController may show one specific seat - and nothing else. No
 * opponent concealed tile ever appears here, by construction: `hands` supplies the full
 * per-seat state, but only `hands[seat]` is ever read for concealed/kita tiles below.
 */
export interface PlayerView {
  seat: number;
  concealedTiles: TileRef[];
  melds: MeldSnapshot[];
  kitaTiles: TileRef[];
  /** Own discards only, excluding any that were called away - same convention as
   *  PlayerViewOpponent.discards. Additive field (GUI river rendering needs this;
   *  the CLI driver does not use it). */
  discards: TileKind[];
  /** See riichiDiscardIndexOf. */
  riichiDiscardIndex: number | null;
  riichi: boolean;
  /** Seat wind of every seat this hand, indexed by seat: 1 East, 2 South, 3 West, 4 North -
   *  the same relation to the dealer the scorer uses. */
  seatWinds: number[];
  /** This seat's own furiten state by cause (see FuritenSnapshot). Never another seat's. */
  furiten: FuritenSnapshot;
  /** 리치 중인 이 좌석의 현재 대기패 (종류만). 엔진의 기존 대기 계산(computeWinningTiles)을 그대로 쓰며, 자기 손패에서만
   *  나온다 - 남은 장수처럼 상대 손패/벽에 의존하는 정보는 담지 않는다. 리치가 아니면 빈 배열. */
  waits: WaitInfo[];
  /** 이 좌석 손의 현재 상태. 모두 자기 손패/멘츠에서만 계산하며, 미확인 장수는 `waits`와 같은 공개 정보 기준이다. */
  handStatus: HandStatus;
  /** 자기 손패 종류별, 리치한 상대에 대한 타패 위험도 (GUI "위험도 표시"용, 표시 전용). CharacterAI와 같은 현물/스지 규칙
   *  (src/ai/discardDanger.ts)을 쓰고, 입력은 리치한 상대들의 강(울어 간 패 포함, 모두 공개 정보)과 자기 손패 종류뿐이다.
   *  리치한 상대가 없으면 빈 배열. */
  discardRisk: DiscardRisk[];
  opponents: PlayerViewOpponent[];
  doraIndicators: TileRef[];
  /** 지금 공개된 도라 표시패마다 그 표시패가 가리키는 실제 도라 종류 (doraIndicators와 같은 순서, 엔진 nextDoraKind - 산마 1만<->9만
   *  같은 규칙 포함). 화면이 규칙을 다시 구현하지 않게 엔진이 계산해 준다. 적5/북 같은 다른 도라는 들어 있지 않다. */
  doraKinds: TileKind[];
  scores: number[];
  dealerSeat: number;
  roundWind: number;
  roundHandNumber: number;
  honba: number;
  kyotaku: number;
  wallRemainingLive: number;
}

/** 리치 여부와 무관한 현재 손 상태 (GUI 표시용, 엔진 계산 결과). `waits`(리치 중 대기)의 의미는 바꾸지 않는다. */
export interface HandStatus {
  /** 엔진 minShanten(일반형/칠대자/국사 중 최소). 쯔모 직후처럼 손이 3n+2장이면 표준 정의대로 "한 장 버린 뒤의 최소 샹텐"이며,
   *  -1은 화료형이다. */
  shanten: number;
  /** 마지막 타패/울기 뒤(3n+1장 상태)의 대기패. 텐파이가 아니면 빈 배열. 쯔모 직후에도 그 직전의 대기를 유지한다
   *  (리치 중 `waits`, 후리텐 판정과 같은 엔진 대기 캐시). */
  tenpaiWaits: TenpaiWaitInfo[];
}

/** 타패 후보 한 종류의 위험도 (상대적 표시용 등급이며 "안전하다"는 판정이 아니다). */
export interface DiscardRisk {
  kind: TileKind;
  level: DiscardRiskLevel;
}

export interface BuildPlayerViewOptions {
  seat: number;
  /** Defaults to "not furiten" when omitted. */
  furiten?: FuritenSnapshot;
  /** 리치 중인 이 좌석의 대기패. 생략하면 빈 배열. */
  waits?: readonly TileKind[];
  /** 리치 여부와 무관한 이 좌석의 현재 대기패 (HandStatus.tenpaiWaits). 생략하면 빈 배열. */
  tenpaiWaits?: readonly TileKind[];
  /** tenpaiWaits 중 역이 없는 대기 (엔진 계산, 표시 전용). 생략하면 모두 역이 있는 것으로 둔다. */
  tenpaiWaitYaku?: ReadonlyMap<TileKind, WaitYaku>;
  hands: readonly Hand[];
  doraIndicators: readonly Tile[];
  /** doraIndicators마다 가리키는 도라 종류 (PlayerView.doraKinds). 생략하면 빈 배열. */
  doraKinds?: readonly TileKind[];
  scores: readonly number[];
  dealerSeat: number;
  roundWind: number;
  roundHandNumber: number;
  honba: number;
  kyotaku: number;
  wallRemainingLive: number;
}

export function buildPlayerView(options: BuildPlayerViewOptions): PlayerView {
  const { seat, hands, doraIndicators, doraKinds, scores, furiten, waits, tenpaiWaits, tenpaiWaitYaku, ...rest } = options;
  const own = hands[seat]!;
  const opponents: PlayerViewOpponent[] = hands
    .map((hand, i) => ({ hand, seat: i }))
    .filter(({ seat: i }) => i !== seat)
    .map(({ hand, seat: i }) => ({
      seat: i,
      discards: hand.discards.filter((d) => !d.calledAway).map((d) => d.tile.kind),
      riichiDiscardIndex: riichiDiscardIndexOf(hand),
      concealedCount: hand.concealed.length,
      melds: hand.melds.map(meldToSnapshot),
      riichi: hand.riichi,
      kitaCount: hand.kitaTiles.length,
    }));
  const base = {
    seat,
    concealedTiles: own.concealed.map(tileToRef),
    melds: own.melds.map(meldToSnapshot),
    kitaTiles: own.kitaTiles.map(tileToRef),
    discards: own.discards.filter((d) => !d.calledAway).map((d) => d.tile.kind),
    riichiDiscardIndex: riichiDiscardIndexOf(own),
    riichi: own.riichi,
    seatWinds: hands.map((_, s) => seatDistance(options.dealerSeat, s, hands.length) + 1),
    furiten: furiten ?? NO_FURITEN,
    opponents,
    doraIndicators: doraIndicators.map(tileToRef),
    doraKinds: [...(doraKinds ?? [])],
    scores: [...scores],
    ...rest,
  };
  // 대기패의 미확인 장수는 방금 만든 view의 공개 정보만으로 센다
  const handStatus: HandStatus = {
    shanten: minShanten(tilesToCounts(own.concealed), own.melds.length),
    tenpaiWaits: withUnseenCounts(base, tenpaiWaits ?? []).map((w) => {
      const yaku = tenpaiWaitYaku?.get(w.kind);
      return yaku ? { ...w, yaku } : w;
    }),
  };
  return { ...base, waits: withUnseenCounts(base, waits ?? []), handStatus, discardRisk: discardRiskFor(seat, hands) };
}

/** 리치한 상대들의 강(버림패 종류 전체 - 울어 간 패도 그 상대가 버린 공개 패다)만으로 자기 손패 종류별 위험도를 매긴다.
 *  상대 손패나 패산은 읽지 않는다. */
function discardRiskFor(seat: number, hands: readonly Hand[]): DiscardRisk[] {
  const riichiRivers = hands
    .filter((hand, i) => i !== seat && hand.riichi)
    .map((hand) => hand.discards.map((d) => d.tile.kind));
  if (riichiRivers.length === 0) return [];
  const kinds = [...new Set(hands[seat]!.concealed.map((t) => t.kind))];
  return kinds.map((kind) => ({ kind, level: discardRiskLevel(kind, riichiRivers) }));
}
