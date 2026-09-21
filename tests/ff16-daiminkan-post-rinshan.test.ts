import { describe, expect, it } from "vitest";
import { GameState, type PhysicalHandBootstrap } from "../src/core/GameState.js";
import { Hand } from "../src/core/Hand.js";
import { Wall } from "../src/core/Wall.js";
import { parseKind, type Tile, type TileKind } from "../src/core/tiles.js";
import { DEFAULT_SANMA_RULES, MAJSOUL_YONMA_RULES, type RuleConfig } from "../src/rules/RuleConfig.js";

let nextId = 160000;
function tile(kind: TileKind): Tile {
  const parsed = parseKind(kind);
  return { id: nextId++, kind, suit: parsed.suit, rank: parsed.rank, isRed: false };
}

class DaiminkanFollowUpFixture extends GameState {
  readonly followUp: "ankan" | "kita" | "shouminkan";
  pendingDoraWasRevealedBeforeKitaReplacement = false;

  constructor(options: ConstructorParameters<typeof GameState>[0], followUp: "ankan" | "kita" | "shouminkan" = "ankan") {
    super(options);
    this.followUp = followUp;
  }

  override bootstrapPhysicalHand(): PhysicalHandBootstrap {
    const wall = new Wall(this.rules, `ff16-wall-${this.rules.playerCount}`);
    wall.dealInitial(this.rules.playerCount, 13);

    // Force the dealer's first known draw to be the yakuhai discarded under the locked
    // riichi-hand path. The physical Wall still supplies/consumes every replacement tile.
    const ordinaryDraw = wall.drawTile.bind(wall);
    let firstDraw = true;
    wall.drawTile = () => {
      if (firstDraw) {
        firstDraw = false;
        return tile("z5");
      }
      return ordinaryDraw();
    };

    // Select a deterministic first replacement that exposes the requested post-draw action
    // while preserving Wall's real committed-kan/replacement accounting.
    const physicalRinshan = wall.drawCommittedRinshan.bind(wall);
    let firstRinshan = true;
    wall.drawCommittedRinshan = () => {
      const drawn = physicalRinshan();
      if (firstRinshan) {
        firstRinshan = false;
        return tile(this.followUp === "kita" ? "z4" : this.followUp === "shouminkan" ? "p8" : "p9");
      }
      return drawn;
    };
    const physicalKitaReplacement = wall.drawKitaReplacement.bind(wall);
    wall.drawKitaReplacement = () => {
      this.pendingDoraWasRevealedBeforeKitaReplacement = wall.pendingKanDora() === 0;
      return physicalKitaReplacement();
    };

    const hands = Array.from({ length: this.rules.playerCount }, () => new Hand());
    hands[0]!.dealIn(Array.from({ length: 13 }, () => tile("p2")));
    hands[0]!.riichi = true; // forces the known z5 draw to be discarded as tsumogiri
    if (this.followUp === "ankan") {
      hands[1]!.dealIn([
        tile("z5"), tile("z5"), tile("z5"), tile("p9"), tile("p9"), tile("p9"),
        tile("m1"), tile("m2"), tile("m3"), tile("s1"), tile("s2"), tile("s3"), tile("z1"),
      ]);
    } else {
      hands[1]!.dealIn([
        tile("z5"), tile("z5"), tile("z5"), tile("p1"),
        tile("m1"), tile("m2"), tile("m3"), tile("s1"), tile("s2"), tile("s3"), tile("z1"),
      ]);
      if (this.followUp === "shouminkan") {
        const ponTiles = [tile("p1"), tile("p1"), tile("p1")];
        hands[1]!.melds.push({ type: "pon", tiles: ponTiles, calledFrom: 2, calledTile: ponTiles[2] });
      }
    }
    for (let seat = 2; seat < this.rules.playerCount; seat++) {
      hands[seat]!.dealIn(Array.from({ length: 13 }, (_, index) => tile(index % 2 === 0 ? "m1" : "s9")));
    }
    return { wall, hands };
  }
}

function verifyDaiminkanCanChainAnkan(rules: RuleConfig) {
  const game = new DaiminkanFollowUpFixture({ rules, seed: `ff16-${rules.playerCount}` });
  game.playHand();

  const openKan = game.log.findIndex(
    (event) => event.type === "call" && event.call === "kan_open" && event.player === 1
  );
  const rinshanDraw = game.log.findIndex(
    (event, index) => index > openKan && event.type === "draw" && event.player === 1 && event.source === "rinshan"
  );
  const chainedAnkan = game.log.findIndex(
    (event, index) => index > rinshanDraw && event.type === "call" && event.call === "kan_closed" && event.player === 1
  );
  const firstPostRinshanDiscard = game.log.findIndex(
    (event, index) => index > rinshanDraw && event.type === "discard" && event.player === 1
  );

  expect(openKan).toBeGreaterThan(-1);
  expect(rinshanDraw).toBeGreaterThan(openKan);
  expect(chainedAnkan).toBeGreaterThan(rinshanDraw);
  expect(firstPostRinshanDiscard).toBeGreaterThan(chainedAnkan);
}

describe("FF-16 daiminkan post-rinshan self-action window", () => {
  it("allows a yonma caller to declare ankan before its required discard", () => {
    verifyDaiminkanCanChainAnkan(MAJSOUL_YONMA_RULES);
  });

  it("allows a sanma caller to declare ankan before its required discard", () => {
    verifyDaiminkanCanChainAnkan(DEFAULT_SANMA_RULES);
  });

  it("allows sanma Kita and reveals the pending open-kan indicator before its replacement", () => {
    const game = new DaiminkanFollowUpFixture({
      rules: DEFAULT_SANMA_RULES,
      seed: "ff16-kita",
      kitaDecisionPolicy: () => true,
    }, "kita");
    game.playHand();
    const openKan = game.log.findIndex((event) => event.type === "call" && event.call === "kan_open");
    const rinshan = game.log.findIndex(
      (event, index) => index > openKan && event.type === "draw" && event.player === 1 && event.source === "rinshan"
    );
    const kita = game.log.findIndex((event, index) => index > rinshan && event.type === "kita" && event.player === 1);
    const discard = game.log.findIndex((event, index) => index > rinshan && event.type === "discard" && event.player === 1);

    expect(kita).toBeGreaterThan(rinshan);
    expect(discard).toBeGreaterThan(kita);
    expect(game.pendingDoraWasRevealedBeforeKitaReplacement).toBe(true);
  });

  it("allows shouminkan after a daiminkan rinshan draw before discarding", () => {
    const game = new DaiminkanFollowUpFixture({ rules: MAJSOUL_YONMA_RULES, seed: "ff16-shouminkan" }, "shouminkan");
    game.playHand();
    const openKan = game.log.findIndex((event) => event.type === "call" && event.call === "kan_open");
    const rinshan = game.log.findIndex(
      (event, index) => index > openKan && event.type === "draw" && event.player === 1 && event.source === "rinshan"
    );
    const addedKan = game.log.findIndex(
      (event, index) => index > rinshan && event.type === "call" && event.call === "kan_added" && event.player === 1
    );
    const discard = game.log.findIndex((event, index) => index > rinshan && event.type === "discard" && event.player === 1);

    expect(addedKan).toBeGreaterThan(rinshan);
    expect(discard).toBeGreaterThan(addedKan);
  });
});
