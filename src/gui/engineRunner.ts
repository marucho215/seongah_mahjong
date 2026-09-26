/* 대국 엔진 실행기 (1.2 3단계). GUI 서버(GameHost)는 대국 엔진(GameState + GuiSession)을 직접 부르지 않고 이 인터페이스로
 * 비동기로만 부른다. 구현은 둘이다.
 * - InlineEngineRunner: 같은 스레드에서 돌린다. 직접 만든 게임을 여는 createGuiServer와, 세션을 직접 조작하는 테스트용.
 * - WorkerEngineRunner (engineWorkerPool.ts): worker 스레드에서 돌린다. 온라인 서버에서 한 사용자의 AI 계산이 다른 사용자의
 *   화면을 멈추지 않게 한다.
 * 두 구현 모두 같은 EngineCore로 스냅샷을 만든다. 서버는 스냅샷만 보고 화면 메시지를 만들므로, 어느 쪽이든 같은 메시지가 나간다.
 * 엔진 자체(규칙, RNG, AI 판단)는 바꾸지 않는다: 대국은 같은 GameState 생성자로 만들고 같은 GuiSession으로 진행한다. */
import type { GameState } from "../core/GameState.js";
import type { GameEvent } from "../core/GameLog.js";
import type { DecisionRequest, DecisionResponse } from "../core/decisions.js";
import type { CharacterProfile } from "../ai/characterProfile.js";
import { getCharacterProfile } from "../ai/characterProfiles.js";
import { buildGameReplayRecord, replaySeatsFromGame, type GameReplayRecord } from "../sim/replayRecorder.js";
import { GuiSession, type GuiSessionPhase, type WatchFrame } from "./guiSession.js";
import { createGuiGameWithProfiles, type GuiGameMode } from "./gameSetup.js";

/** 상대 좌석: 등록 캐릭터는 id만 넘기고(실행하는 쪽이 같은 프로필 표에서 찾는다), CustomAI는 대국 시작 시점의 프로필 스냅샷을 넘긴다. */
export type OpponentSpec = { characterId: string } | { profile: CharacterProfile };

/** worker로도 넘길 수 있는(순수 데이터) 대국 구성. */
export interface GameSpec {
  mode: GuiGameMode;
  seed: string;
  opponents: OpponentSpec[];
}

export function gameFromSpec(spec: GameSpec): GameState {
  const profiles = spec.opponents.map((o) => ("profile" in o ? o.profile : getCharacterProfile(o.characterId)));
  return createGuiGameWithProfiles(spec.mode, spec.seed, profiles);
}

type HandEndEvent = Extract<GameEvent, { type: "hand_end" }>;
type GameEndEvent = Extract<GameEvent, { type: "game_end" }>;

/** 한 번의 진행(응답/다음 국) 뒤의 엔진 상태. newEvents는 앞 스냅샷 이후 game.log에 추가된 이벤트다. */
export interface EngineSnapshot {
  phase: GuiSessionPhase;
  request: DecisionRequest | null;
  frames: WatchFrame[];
  newEvents: GameEvent[];
  handEndEvent?: HandEndEvent;
  gameEndEvent?: GameEndEvent;
  /** game_end일 때만: 엔진의 computeFinalStandings() */
  standings?: ReturnType<GameState["computeFinalStandings"]>;
}

/** 대국을 처음 열 때 한 번 받는 정보. */
export interface EngineStart {
  /** 좌석별 표시 이름 (프로필이 없는 좌석은 null) */
  characterNames: (string | null)[];
  controllers: GameState["controllers"];
  initial: EngineSnapshot;
}

/** 실행 위치와 무관한 엔진 한 판. 스냅샷을 만들 때 로그를 어디까지 보냈는지 기억한다. */
export class EngineCore {
  readonly session: GuiSession;
  private logIndex = 0;

  constructor(readonly game: GameState) {
    this.session = new GuiSession(game);
  }

  start(): EngineStart {
    return {
      characterNames: this.game.characterProfiles.map((p) => p?.displayName ?? null),
      controllers: [...this.game.controllers],
      initial: this.snapshot(),
    };
  }

  snapshot(): EngineSnapshot {
    const phase = this.session.getPhase();
    const newEvents = this.game.log.slice(this.logIndex);
    this.logIndex = this.game.log.length;
    const handEndEvent = this.session.getHandEndEvent();
    const gameEndEvent = this.session.getGameEndEvent();
    return {
      phase,
      request: this.session.getCurrentRequest(),
      frames: this.session.takeFrames(),
      newEvents,
      ...(handEndEvent ? { handEndEvent } : {}),
      ...(gameEndEvent ? { gameEndEvent } : {}),
      ...(phase === "game_end" ? { standings: this.game.computeFinalStandings() } : {}),
    };
  }

  respond(response: DecisionResponse): EngineSnapshot {
    this.session.respond(response);
    return this.snapshot();
  }

  continueToNextHand(): EngineSnapshot {
    this.session.continueToNextHand();
    return this.snapshot();
  }

  replayRecord(label: string): GameReplayRecord {
    return buildGameReplayRecord(this.game, label, 0, replaySeatsFromGame(this.game));
  }
}

export interface EngineRunner {
  /** 같은 스레드에서 도는 경우에만 세션 (테스트/직접 게임용). worker면 null. */
  readonly session: GuiSession | null;
  /** 같은 스레드에서 도는 경우, 서버 밖에서 세션이 진행됐을 수 있으므로 지금 상태를 바로 읽는다. worker면 null (바깥에서 바뀌지 않는다). */
  pollSync(): EngineSnapshot | null;
  respond(response: DecisionResponse): Promise<EngineSnapshot>;
  continueToNextHand(): Promise<EngineSnapshot>;
  replayRecord(label: string): Promise<GameReplayRecord>;
  /** 대국을 버린다 (그만두기, 방치 정리). 이후 호출은 실패한다. */
  dispose(): void;
}

export class InlineEngineRunner implements EngineRunner {
  private readonly core: EngineCore;

  private constructor(game: GameState) {
    this.core = new EngineCore(game);
  }

  static open(game: GameState): { runner: InlineEngineRunner; start: EngineStart } {
    const runner = new InlineEngineRunner(game);
    return { runner, start: runner.core.start() };
  }

  get session(): GuiSession {
    return this.core.session;
  }

  pollSync(): EngineSnapshot {
    return this.core.snapshot();
  }

  async respond(response: DecisionResponse): Promise<EngineSnapshot> {
    return this.core.respond(response);
  }

  async continueToNextHand(): Promise<EngineSnapshot> {
    return this.core.continueToNextHand();
  }

  async replayRecord(label: string): Promise<GameReplayRecord> {
    return this.core.replayRecord(label);
  }

  dispose(): void {}
}
