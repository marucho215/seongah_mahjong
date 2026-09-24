import type { GameEvent } from "../core/GameLog.js";

/**
 * 브라우저로 보내는 "공개 효과음 신호". game.log의 raw 이벤트를 그대로 보내지 않고, 소리 재생에
 * 필요한 공개 정보(누가 어떤 행동을 했는가)만 담아 서버에서 변환한다.
 *
 * 일부러 담지 않는 것: 패의 종류/id(상대가 뽑은 패 포함), 패 이름, 점수, AI 결정 로그 등.
 * 엔진의 GameEvent 타입이나 채점 로직은 이 변환 때문에 바뀌지 않는다.
 */
export type AudioCue =
  | { seq: number; type: "draw"; seat: number }
  | { seq: number; type: "discard"; seat: number }
  | { seq: number; type: "chi" | "pon" | "kan" | "kita" | "riichi" | "ron" | "tsumo"; seat: number }
  | { seq: number; type: "hand_start"; first: boolean }
  | { seq: number; type: "hand_end"; riichiSticksCollected: boolean };

/** 유니언의 각 멤버에서 키를 뺀다 (기본 Omit은 유니언을 합쳐 버려 멤버별 필드가 사라진다). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** GameEvent 하나를 공개 신호로 바꾼다. 소리와 무관한 이벤트는 null. seq는 호출자가 붙인다. */
export function toAudioCue(event: GameEvent): DistributiveOmit<AudioCue, "seq"> | null {
  switch (event.type) {
    case "draw":
      return { type: "draw", seat: event.player };
    case "discard":
      return { type: "discard", seat: event.player };
    case "call":
      return { type: event.call === "chi" ? "chi" : event.call === "pon" ? "pon" : "kan", seat: event.player };
    case "kita":
      return { type: "kita", seat: event.player };
    case "riichi":
      return { type: "riichi", seat: event.player };
    case "win":
      return { type: event.isTsumo ? "tsumo" : "ron", seat: event.player };
    case "hand_start":
      return { type: "hand_start", first: event.handIndex === 0 };
    case "hand_end":
      return {
        type: "hand_end",
        riichiSticksCollected: event.result?.kind === "agari" && event.result.kyotakuAwarded > 0,
      };
    default:
      return null; // deal, dora 공개, 유국 이벤트, game_end 등은 소리를 내지 않는다
  }
}

/** 최근 행동 목록(화면 표시용)에 쓰는 공개 행동. 버림패/울림/화료처럼 모두에게 보이는 것만 담는다. */
export interface PublicAction {
  seat: number;
  action: "discard" | "chi" | "pon" | "kan" | "kita" | "riichi" | "ron" | "tsumo";
  /** 버림패/울린 패의 종류 (공개 정보) */
  tile?: string;
}

export function toPublicAction(event: GameEvent): PublicAction | null {
  switch (event.type) {
    case "discard":
      return { seat: event.player, action: "discard", tile: event.tile };
    case "call":
      return { seat: event.player, action: event.call === "chi" ? "chi" : event.call === "pon" ? "pon" : "kan", tile: event.kind };
    case "kita":
      return { seat: event.player, action: "kita" };
    case "riichi":
      return { seat: event.player, action: "riichi" };
    case "win":
      return { seat: event.player, action: event.isTsumo ? "tsumo" : "ron" };
    default:
      return null;
  }
}

/**
 * game.log를 앞에서부터 한 번씩만 읽어 순서를 보존한 AudioCue 목록을 만든다. 각 cue에는 세션 내내
 * 증가하는 seq가 붙는다. 서버는 "마지막으로 보낸 seq"를 기억해 그 이후 cue만 보내고, 새로 접속한
 * 클라이언트에는 현재 seq를 기준점(cueBase)으로 알려 과거 소리를 다시 재생하지 않게 한다.
 */
export class AudioCueTracker {
  private nextLogIndex = 0;
  private lastSeq = 0;
  private pending: AudioCue[] = [];
  /** seq → 그 cue를 만든 로그 인덱스 */
  private readonly logIndexOfSeq = new Map<number, number>();

  constructor(private readonly log: readonly GameEvent[]) {}

  /** 아직 읽지 않은 로그 이벤트를 cue로 변환해 쌓는다. */
  sync(): void {
    for (; this.nextLogIndex < this.log.length; this.nextLogIndex++) {
      const cue = toAudioCue(this.log[this.nextLogIndex]!);
      if (cue) {
        this.pending.push({ ...cue, seq: ++this.lastSeq } as AudioCue);
        this.logIndexOfSeq.set(this.lastSeq, this.nextLogIndex);
      }
    }
  }

  /** 지금까지 만들어진 마지막 seq (아직 없으면 0). */
  latestSeq(): number {
    return this.lastSeq;
  }

  /** 로그의 앞 logLength개 이벤트까지에서 만들어진 마지막 seq. */
  seqThroughLogLength(logLength: number): number {
    let best = 0;
    for (const [seq, idx] of this.logIndexOfSeq) if (idx < logLength && seq > best) best = seq;
    return best;
  }

  /** seq보다 뒤에 만들어진 cue를 순서대로 돌려준다. */
  cuesAfter(seq: number): AudioCue[] {
    return this.pending.filter((c) => c.seq > seq);
  }

  /** seq 이하 cue는 더 필요하지 않으므로 버린다 (메모리 정리). */
  discardThrough(seq: number): void {
    this.pending = this.pending.filter((c) => c.seq > seq);
    for (const s of this.logIndexOfSeq.keys()) if (s <= seq) this.logIndexOfSeq.delete(s);
  }
}
