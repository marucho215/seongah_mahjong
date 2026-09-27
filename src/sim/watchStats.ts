/* AI 관전 여러 판 통계. 리플레이 기록(엔진 이벤트 로그와 최종 순위)만 읽는 순수 함수이며, 규칙/점수를 다시 계산하지 않는다.
 * 한 판마다 summarizeWatchGame으로 작은 요약을 만들고(리플레이 전체를 들고 있지 않도록), 좌석별로 aggregateWatchStats로 합친다.
 * 관전 한 묶음 안에서는 좌석과 캐릭터가 고정이므로 좌석 기준으로 집계한다. */
import type { GameReplayRecord } from "./replayRecorder.js";

/** 한 판에서 한 좌석의 결과. */
export interface WatchSeatGameResult {
  seat: number;
  characterId: string | null;
  /** 1부터 인원 수까지 (엔진 computeFinalStandings) */
  placement: number;
  rawScore: number;
  /** 우마 포함 pt (엔진 FinalStanding.points) */
  points: number;
  /** 화료 횟수 (더블 론이면 화료자마다 한 번) */
  wins: number;
  /** 이 좌석의 버림패로 론 당한 국 수 (더블 론도 한 국은 한 번) */
  dealIns: number;
  /** 리치 성립 횟수 */
  riichi: number;
}

export interface WatchGameSummary {
  /** 묶음 안의 순서 (0부터) */
  index: number;
  seed: string;
  /** 이 판의 국 수 */
  hands: number;
  seats: WatchSeatGameResult[];
  /** 리플레이를 저장했으면 그 파일 이름 */
  replayFile?: string;
}

export function summarizeWatchGame(record: GameReplayRecord, index: number, replayFile?: string): WatchGameSummary {
  const playerCount = record.meta.rules.playerCount;
  const wins = new Array<number>(playerCount).fill(0);
  const dealIns = new Array<number>(playerCount).fill(0);
  const riichi = new Array<number>(playerCount).fill(0);
  let hands = 0;
  let dealtInThisHand = new Set<number>();
  for (const event of record.events) {
    if (event.type === "hand_start") {
      hands++;
      dealtInThisHand = new Set();
    } else if (event.type === "riichi") {
      riichi[event.player]!++;
    } else if (event.type === "win") {
      wins[event.player]!++;
      if (event.ronFrom !== undefined && !dealtInThisHand.has(event.ronFrom)) {
        dealtInThisHand.add(event.ronFrom);
        dealIns[event.ronFrom]!++;
      }
    }
  }
  const seats = record.meta.seats.map((seat): WatchSeatGameResult => {
    const standing = record.finalStandings.find((s) => s.player === seat.seat);
    if (!standing) throw new Error(`summarizeWatchGame: 좌석 ${seat.seat}의 최종 순위가 없습니다`);
    return {
      seat: seat.seat,
      characterId: seat.characterId ?? null,
      placement: standing.placement,
      rawScore: standing.rawScore,
      points: standing.points,
      wins: wins[seat.seat]!,
      dealIns: dealIns[seat.seat]!,
      riichi: riichi[seat.seat]!,
    };
  });
  return { index, seed: record.meta.gameSeed, hands, seats, ...(replayFile ? { replayFile } : {}) };
}

/** 한 좌석(= 한 캐릭터)의 묶음 전체 통계. 판이 없으면 비율은 0이다. */
export interface WatchSeatStats {
  seat: number;
  characterId: string | null;
  games: number;
  /** placementCounts[k] = (k+1)위 횟수 */
  placementCounts: number[];
  averagePlacement: number;
  /** 1위 비율 (0~1) */
  firstRate: number;
  averageRawScore: number;
  averagePoints: number;
  totalPoints: number;
  hands: number;
  /** 국당 화료 비율 (0~1) */
  winRate: number;
  /** 국당 방총 비율 (0~1) */
  dealInRate: number;
  /** 국당 리치 비율 (0~1) */
  riichiRate: number;
}

export function aggregateWatchStats(games: readonly WatchGameSummary[], playerCount: number): WatchSeatStats[] {
  const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);
  return Array.from({ length: playerCount }, (_, seat) => {
    const rows = games.map((g) => g.seats.find((s) => s.seat === seat)!);
    const placementCounts = new Array<number>(playerCount).fill(0);
    for (const r of rows) placementCounts[r.placement - 1]!++;
    const hands = games.reduce((sum, g) => sum + g.hands, 0);
    const sum = (pick: (r: WatchSeatGameResult) => number) => rows.reduce((acc, r) => acc + pick(r), 0);
    const totalPoints = sum((r) => r.points);
    return {
      seat,
      characterId: rows[0]?.characterId ?? null,
      games: rows.length,
      placementCounts,
      averagePlacement: ratio(sum((r) => r.placement), rows.length),
      firstRate: ratio(placementCounts[0]!, rows.length),
      averageRawScore: ratio(sum((r) => r.rawScore), rows.length),
      averagePoints: ratio(totalPoints, rows.length),
      totalPoints,
      hands,
      winRate: ratio(sum((r) => r.wins), hands),
      dealInRate: ratio(sum((r) => r.dealIns), hands),
      riichiRate: ratio(sum((r) => r.riichi), hands),
    };
  });
}
