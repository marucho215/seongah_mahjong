import { GameState, type PhysicalHandBootstrap } from "../../src/core/GameState.js";
import { Hand } from "../../src/core/Hand.js";
import { Wall } from "../../src/core/Wall.js";
import { parseKind, type Tile, type TileKind } from "../../src/core/tiles.js";
import { DEFAULT_SANMA_RULES, type RuleConfig } from "../../src/rules/RuleConfig.js";

let nextId = 900000;
export function tile(kind: TileKind): Tile {
  const parsed = parseKind(kind);
  return { id: nextId++, kind, suit: parsed.suit, rank: parsed.rank, isRed: false };
}

// Closed, all-simples tenpai on p5/p8 (ryanmen p6-p7): a ron on either is Tanyao + Pinfu.
export const W: TileKind[] = ["p2", "p3", "p4", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s8", "p6", "p7"];
// Isolated, non-tenpai, few terminals/honors (so no nine-terminals abort, no accidental waits).
export const J0: TileKind[] = ["p1", "p3", "p6", "p9", "s1", "s4", "s6", "s8", "z1", "z3", "z5", "m1", "s2"];
export const J2: TileKind[] = ["p1", "p3", "p9", "s1", "s4", "s6", "s9", "z1", "z3", "z5", "m1", "s2", "p2"];
export const J2_PON: TileKind[] = ["p8", "p8", "p1", "p3", "s1", "s4", "s6", "z1", "z3", "z5", "m1", "s2", "p5"];

/** Deterministic hands + a forced sequence of wall draws (in call order, whichever seat draws). */
export class RonFixture extends GameState {
  constructor(
    options: ConstructorParameters<typeof GameState>[0],
    private readonly setup: { hands: TileKind[][]; draws: TileKind[]; ownDiscards?: TileKind[][]; rinshan?: TileKind[]; kitaDraws?: TileKind[]; ponMelds?: (TileKind | undefined)[] }
  ) {
    super(options);
  }

  override bootstrapPhysicalHand(): PhysicalHandBootstrap {
    const wall = new Wall(this.rules, "ron-fixture-wall");
    wall.dealInitial(this.rules.playerCount, 13);
    const ordinaryDraw = wall.drawTile.bind(wall);
    const queue = [...this.setup.draws];
    wall.drawTile = () => (queue.length > 0 ? tile(queue.shift()!) : ordinaryDraw());
    // 영상패/북 대체패도 순서를 고정한다 (원래 wall의 상태 갱신은 그대로 거치고 패만 바꿔치기).
    const rinshanQueue = [...(this.setup.rinshan ?? [])];
    const ordinaryRinshan = wall.drawCommittedRinshan.bind(wall);
    wall.drawCommittedRinshan = () => {
      const original = ordinaryRinshan();
      return rinshanQueue.length > 0 ? tile(rinshanQueue.shift()!) : original;
    };
    const kitaQueue = [...(this.setup.kitaDraws ?? [])];
    const ordinaryKita = wall.drawKitaReplacement.bind(wall);
    wall.drawKitaReplacement = () => {
      const original = ordinaryKita();
      return kitaQueue.length > 0 ? tile(kitaQueue.shift()!) : original;
    };
    const hands = this.setup.hands.map((kinds, seat) => {
      const hand = new Hand();
      hand.dealIn(kinds.map(tile));
      // 좌석별로 미리 만들어 둔 퐁 멜드 (종류 하나 = 그 패 3장). 가깡 시나리오용.
      const ponKind = this.setup.ponMelds?.[seat];
      if (ponKind) {
        const tiles = [tile(ponKind), tile(ponKind), tile(ponKind)];
        hand.melds.push({ type: "pon", tiles, calledFrom: (seat + 2) % this.rules.playerCount, calledTile: tiles[2]! });
      }
      for (const kind of this.setup.ownDiscards?.[seat] ?? []) {
        hand.discards.push({ tile: tile(kind), calledAway: false, isRiichiDeclaration: false, tsumogiri: false });
      }
      return hand;
    });
    return { wall, hands };
  }
}


export const ALL_HUMAN: ConstructorParameters<typeof GameState>[0]["controllers"] = ["human", "human", "human"];
export const ATAMAHANE: RuleConfig = { ...DEFAULT_SANMA_RULES, doubleRonMode: "atamahane" };

export function ronGame(rules: RuleConfig, controllers = ALL_HUMAN, hands = [J0, W, W], draws: TileKind[] = ["p8"]) {
  return new RonFixture({ rules, seed: "ron-decision", controllers }, { hands, draws });
}
