import type { RuleConfig } from "../rules/RuleConfig.js";
import { SeededRng, type Seed } from "./rng.js";
import { buildTileSet, type Tile } from "./tiles.js";

const DEAD_WALL_SIZE = 14;
// The dead wall itself is the standard 14 tiles at rest: 4 physical rinshan slots + 5 dora
// + 5 ura indicator slots. The *combined* kan+kita replacement budget for a hand is larger
// than those 4 physical slots (see rinshanSlots below) - draws beyond the first 4 borrow
// directly from the live wall's own tail instead of a second static reserve, exactly like a
// real dead wall being replenished from the live wall after each kan.
const STATIC_RINSHAN_SLOTS = 4;
const DORA_INDICATOR_SLOTS = 5;
/** Every tile kind has exactly 4 physical copies (see tiles.ts's buildTileSet), including
 *  North - so across a whole hand, kita extraction can never be drawn more than 4 times in
 *  total no matter how many players hold Norths, since only 4 North tiles exist. */
const NORTH_TILE_COPIES = 4;
// dead wall layout (fixed indices):
// [0..3]    rinshan pool tier 1 - the dead wall's own physical replacement slots
// [4..8]    dora indicators, revealed one at a time on each real kan (kita never reveals one)
// [9..13]   ura dora indicators, same reveal cadence, only shown for riichi hands

export class Wall {
  readonly seed: number;
  private readonly allTiles: readonly Tile[];
  private readonly deadWall: readonly Tile[];
  private liveIndex = 0;
  private liveEnd: number;
  private kansDrawn = 0;
  /** Rinshan-pool draws attributable to kita, tracked separately from real kans so
   *  maxKans enforcement (a rule about kan specifically) is unaffected by kita traffic. */
  private kitaRinshanDrawn = 0;
  /** Combined kan+kita replacement-draw budget for one hand: rules.maxKans (real kans are
   *  rule-capped) plus NORTH_TILE_COPIES (kita is physically capped by how many North tiles
   *  exist at all) - not an independent magic number, derived from what can actually happen
   *  in a hand under the current rules. */
  private readonly rinshanSlots: number;

  constructor(rules: RuleConfig, seed: Seed) {
    const rng = new SeededRng(seed);
    this.seed = rng.seed;
    const built = buildTileSet(rules);
    this.allTiles = rng.shuffle(built);
    this.deadWall = this.allTiles.slice(this.allTiles.length - DEAD_WALL_SIZE);
    this.liveEnd = this.allTiles.length - DEAD_WALL_SIZE;
    this.rinshanSlots = rules.maxKans + NORTH_TILE_COPIES;
  }

  get totalTiles(): number {
    return this.allTiles.length;
  }

  /** Tiles left that can still be drawn as a normal turn draw. */
  remainingLiveCount(): number {
    return Math.max(0, this.liveEnd - this.liveIndex);
  }

  isExhausted(): boolean {
    return this.remainingLiveCount() <= 0;
  }

  /** Deals `count` tiles to each of `playerCount` players, round by round (standard deal order). */
  dealInitial(playerCount: number, count: number): Tile[][] {
    const hands: Tile[][] = Array.from({ length: playerCount }, () => []);
    for (let round = 0; round < count; round++) {
      for (let p = 0; p < playerCount; p++) {
        hands[p]!.push(this.drawFromLive());
      }
    }
    return hands;
  }

  private drawFromLive(): Tile {
    if (this.liveIndex >= this.liveEnd) {
      throw new Error("Wall: attempted to draw from an empty live wall");
    }
    return this.allTiles[this.liveIndex++]!;
  }

  /** A normal turn draw (tsumo candidate). */
  drawTile(): Tile {
    return this.drawFromLive();
  }

  private rinshanPoolUsed(): number {
    return this.kansDrawn + this.kitaRinshanDrawn;
  }

  /** Whether a kan replacement draw can currently succeed. Checked by callers before
   *  offering kan as an action, rather than relying on drawRinshan to throw. */
  canDrawRinshan(maxKans: number): boolean {
    return this.kansDrawn < maxKans && this.canTakeReplacementTile();
  }

  /** A replacement draw after calling a kan: pulls from the shared rinshan pool and
   *  shrinks the live wall boundary by one tile to keep the dead wall replenished.
   *  Reveals the next kan-dora indicator. */
  drawRinshan(): Tile {
    const tile = this.takeReplacementTile();
    this.kansDrawn++;
    return tile;
  }

  /** Whether a kita replacement draw can currently succeed. */
  canDrawKitaReplacement(): boolean {
    return this.canTakeReplacementTile();
  }

  /** A replacement draw after pulling a north (kita) tile: shares the same rinshan pool
   *  kan uses. Never reveals a new dora indicator by itself - nukidora scoring is a direct
   *  dora attribution computed from the extracted tiles, not an indicator reveal (see
   *  src/yaku/dora.ts). */
  drawKitaReplacement(): Tile {
    const tile = this.takeReplacementTile();
    this.kitaRinshanDrawn++;
    return tile;
  }

  private canTakeReplacementTile(): boolean {
    const used = this.rinshanPoolUsed();
    if (used >= this.rinshanSlots) return false;
    if (used < STATIC_RINSHAN_SLOTS) return true;
    // replacements 5-8 borrow the next tile directly off the live wall's tail, so once the
    // live wall itself is empty no further replacement draw is possible
    return this.liveEnd > this.liveIndex;
  }

  /** Pulls the next kan/kita replacement tile, shared by both call sites above. The dead
   *  wall's own rinshan section only physically holds 4 tiles (STATIC_RINSHAN_SLOTS); the
   *  5th-8th replacement in a hand borrows straight from the live wall's tail instead,
   *  which is also what keeps `remainingLiveCount()` correctly shrinking either way and
   *  makes an impossible replacement draw fail naturally rather than needing a separate
   *  live-wall-empty special case. */
  private takeReplacementTile(): Tile {
    const used = this.rinshanPoolUsed();
    if (used >= this.rinshanSlots) {
      throw new Error("Wall: no rinshan tiles left (shared kan/kita pool exhausted)");
    }
    if (used < STATIC_RINSHAN_SLOTS) {
      const tile = this.deadWall[used]!;
      if (this.liveEnd > this.liveIndex) this.liveEnd--;
      return tile;
    }
    if (this.liveEnd <= this.liveIndex) {
      throw new Error("Wall: no live tiles left for a replacement draw");
    }
    this.liveEnd--;
    return this.allTiles[this.liveEnd]!;
  }

  /** Currently revealed dora indicators (index 0 = initial, further ones added per real kan). */
  doraIndicators(): Tile[] {
    const count = 1 + this.kansDrawn;
    return this.deadWall.slice(STATIC_RINSHAN_SLOTS, STATIC_RINSHAN_SLOTS + Math.min(count, DORA_INDICATOR_SLOTS));
  }

  /** Ura dora indicators, same count/cadence as doraIndicators, for riichi hands at resolution time. */
  uraDoraIndicators(): Tile[] {
    const count = 1 + this.kansDrawn;
    const start = STATIC_RINSHAN_SLOTS + DORA_INDICATOR_SLOTS;
    return this.deadWall.slice(start, start + Math.min(count, DORA_INDICATOR_SLOTS));
  }

  kanCount(): number {
    return this.kansDrawn;
  }
}
