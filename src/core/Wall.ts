import type { RuleConfig } from "../rules/RuleConfig.js";
import { SeededRng, type Seed } from "./rng.js";
import { buildTileSet, type Tile } from "./tiles.js";

const DEAD_WALL_SIZE = 14;
/** R1..R8: the initial dead wall's own designated replacement-tile sequence, fixed at
 *  shuffle time. Matches replacementDrawCapacity exactly under default rules, so every
 *  replacement draw in a normal hand comes from here, never from a live-tail borrow. */
const INITIAL_RINSHAN_SLOTS = 8;
/** D0,U0,K1,U1,K2,U2: the 3 indicator pairs already present in the initial dead wall
 *  (8 + 6 = 14). K3/U3 and K4/U4 (needed once kansDrawn reaches 3/4) are NOT part of the
 *  initial reserve - they're formed from tiles absorbed off the live wall's tail during
 *  replacement draws (see absorbedTiles). */
const INITIAL_INDICATOR_PAIRS = 3;
const DORA_INDICATOR_SLOTS = 5; // 1 initial + up to maxKans(4) more, Mahjong Soul sanma default
/** Every tile kind has exactly 4 physical copies (see tiles.ts's buildTileSet), including
 *  North - so across a whole hand, kita extraction can never be drawn more than 4 times in
 *  total no matter how many players hold Norths, since only 4 North tiles exist. */
const NORTH_TILE_COPIES = 4;
// dead wall layout (fixed indices, at rest):
// [0..7]   R1..R8 - replacement draws 1-8, in this order
// [8]  D0  [9]  U0   - initial dora/ura indicator
// [10] K1  [11] U1   - after real kan #1
// [12] K2  [13] U2   - after real kan #2
// (K3/U3, K4/U4 come from absorbedTiles, not from this block)

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
   *  exist at all). Not an independent magic number - derived from what can actually happen
   *  in a hand under the current rules. */
  private readonly replacementDrawCapacity: number;
  /** Next unused index into the R1..R8 designated sequence. */
  private nextRinshanSlot = 0;
  /** Tiles absorbed off the live wall's tail, one per replacement draw (every replacement,
   *  not just the first 8), in absorption order. Sources U3/K3/U4/K4 (bottom-then-top per
   *  absorbed stack slot, matching D0/U0's own bottom=ura/top=dora convention) once real
   *  kan count reaches 3/4 - see doraIndicators/uraDoraIndicators: absorbed[0]->U3,
   *  absorbed[1]->K3, absorbed[2]->U4, absorbed[3]->K4. */
  private readonly absorbedTiles: Tile[] = [];
  private readonly initialDoraSlots: readonly Tile[];
  private readonly initialUraSlots: readonly Tile[];

  constructor(rules: RuleConfig, seed: Seed) {
    const rng = new SeededRng(seed);
    this.seed = rng.seed;
    const built = buildTileSet(rules);
    this.allTiles = rng.shuffle(built);
    this.deadWall = this.allTiles.slice(this.allTiles.length - DEAD_WALL_SIZE);
    this.liveEnd = this.allTiles.length - DEAD_WALL_SIZE;
    this.replacementDrawCapacity = rules.maxKans + NORTH_TILE_COPIES;
    // D0,K1,K2 at offsets 8,10,12; U0,U1,U2 at offsets 9,11,13
    this.initialDoraSlots = [this.deadWall[8]!, this.deadWall[10]!, this.deadWall[12]!];
    this.initialUraSlots = [this.deadWall[9]!, this.deadWall[11]!, this.deadWall[13]!];
    void INITIAL_INDICATOR_PAIRS;
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

  /** A replacement draw after calling a kan: takes the next tile from the R1..R8 designated
   *  sequence (or, beyond that, the live wall's tail - see takeReplacementTile) and absorbs
   *  a live-wall-tail tile. Reveals the next kan-dora indicator. */
  drawRinshan(): Tile {
    const tile = this.takeReplacementTile();
    this.kansDrawn++;
    return tile;
  }

  /** Whether a kita replacement draw can currently succeed. */
  canDrawKitaReplacement(): boolean {
    return this.canTakeReplacementTile();
  }

  /** A replacement draw after pulling a north (kita) tile: shares the same replacement
   *  sequence kan uses. Never reveals a new dora indicator by itself - nukidora scoring is a
   *  direct dora attribution computed from the extracted tiles, not an indicator reveal (see
   *  src/yaku/dora.ts). */
  drawKitaReplacement(): Tile {
    const tile = this.takeReplacementTile();
    this.kitaRinshanDrawn++;
    return tile;
  }

  private canTakeReplacementTile(): boolean {
    if (this.rinshanPoolUsed() >= this.replacementDrawCapacity) return false;
    // every replacement draw - including the first 8, which come from the designated R1..R8
    // sequence - also absorbs a live-wall-tail tile, so it always needs one available
    return this.liveEnd > this.liveIndex;
  }

  /** Pulls the next kan/kita replacement tile, shared by both call sites above: the
   *  returned tile comes from the initial R1..R8 sequence (fixed identity from shuffle
   *  time) as long as any remain; only a replacementDrawCapacity beyond 8 (i.e. maxKans>4)
   *  ever reaches past R8, at which point it borrows directly from the live wall's tail.
   *  Every call also absorbs one live-wall-tail tile (shrinking the live wall by one),
   *  independent of which branch supplied the returned tile - that absorbed pool is what
   *  later supplies K3/U3/K4/U4 (see doraIndicators/uraDoraIndicators). */
  private takeReplacementTile(): Tile {
    if (this.rinshanPoolUsed() >= this.replacementDrawCapacity) {
      throw new Error("Wall: no rinshan tiles left (shared kan/kita pool exhausted)");
    }
    if (this.liveEnd <= this.liveIndex) {
      throw new Error("Wall: no live tiles left to absorb for a replacement draw");
    }
    let tile: Tile;
    if (this.nextRinshanSlot < INITIAL_RINSHAN_SLOTS) {
      tile = this.deadWall[this.nextRinshanSlot]!;
      this.nextRinshanSlot++;
      this.liveEnd--;
      this.absorbedTiles.push(this.allTiles[this.liveEnd]!);
    } else {
      this.liveEnd--;
      tile = this.allTiles[this.liveEnd]!;
    }
    return tile;
  }

  /** Currently revealed dora indicators (index 0 = initial, further ones added per real
   *  kan). The first 3 (D0,K1,K2) are fixed in the initial dead wall; the 4th/5th (K3,K4)
   *  are sourced from absorbedTiles once kansDrawn reaches 3/4 - always available by then,
   *  since kansDrawn <= total replacements drawn <= absorbedTiles.length. */
  doraIndicators(): Tile[] {
    const count = Math.min(1 + this.kansDrawn, DORA_INDICATOR_SLOTS);
    const result = this.initialDoraSlots.slice(0, Math.min(count, this.initialDoraSlots.length));
    if (count >= 4) result.push(this.absorbedTiles[1]!);
    if (count >= 5) result.push(this.absorbedTiles[3]!);
    return result;
  }

  /** Ura dora indicators, same count/cadence as doraIndicators, for riichi hands at resolution time. */
  uraDoraIndicators(): Tile[] {
    const count = Math.min(1 + this.kansDrawn, DORA_INDICATOR_SLOTS);
    const result = this.initialUraSlots.slice(0, Math.min(count, this.initialUraSlots.length));
    if (count >= 4) result.push(this.absorbedTiles[0]!);
    if (count >= 5) result.push(this.absorbedTiles[2]!);
    return result;
  }

  kanCount(): number {
    return this.kansDrawn;
  }
}
