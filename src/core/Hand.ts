import type { Tile } from "./tiles.js";

export type MeldType = "chi" | "pon" | "kan_open" | "kan_closed" | "kan_added";

export interface Meld {
  type: MeldType;
  /** All tiles making up the meld (3 for pon, 4 for any kan). */
  tiles: Tile[];
  /** Seat index the tile was called from; undefined for a closed kan. */
  calledFrom?: number;
  /** The specific tile that was called (for pon/open-kan/added-kan). */
  calledTile?: Tile;
}

export interface DiscardEntry {
  tile: Tile;
  /** True if this discard was claimed by another player's chi/pon/kan call. This is bookkeeping
   *  for replay/debug and discard-history display only - a called-away tile still counts
   *  for this player's own-discard furiten (discarding your own winning tile makes you
   *  furiten regardless of whether someone later calls it). */
  calledAway: boolean;
  /** True if this was the discard immediately declaring riichi. */
  isRiichiDeclaration: boolean;
  /** True if this tile was drawn and discarded immediately (tsumogiri). */
  tsumogiri: boolean;
}

export interface PaoLiability {
  daisangen?: number;
  daisuushii?: number;
}

/**
 * One player's private hand state: concealed tiles, melds, river, and riichi/kita bookkeeping.
 * The hand never fabricates or duplicates tiles - every Tile here is a reference to a unique
 * physical tile instance issued by the Wall.
 */
export class Hand {
  concealed: Tile[] = [];
  melds: Meld[] = [];
  discards: DiscardEntry[] = [];
  kitaTiles: Tile[] = [];
  riichi = false;
  doubleRiichi = false;
  /** Per-hand responsibility created only by the decisive open honor call. */
  paoLiability: PaoLiability = {};

  dealIn(tiles: Tile[]): void {
    this.concealed.push(...tiles);
  }

  /** Adds a tile just drawn from the wall to the concealed hand. */
  addDrawn(tile: Tile): void {
    this.concealed.push(tile);
  }

  hasTileId(tileId: number): boolean {
    return this.concealed.some((t) => t.id === tileId);
  }

  countOfKind(kind: string): number {
    return this.concealed.filter((t) => t.kind === kind).length;
  }

  tilesOfKind(kind: string): Tile[] {
    return this.concealed.filter((t) => t.kind === kind);
  }

  /** Discards a tile from the concealed hand by its unique id. Throws if the tile is not in hand -
   *  a player can never discard a tile they don't physically hold. */
  discardById(tileId: number, opts: { tsumogiri: boolean; isRiichiDeclaration?: boolean }): Tile {
    const idx = this.concealed.findIndex((t) => t.id === tileId);
    if (idx === -1) {
      throw new Error(`Hand.discardById: tile id ${tileId} is not in concealed hand`);
    }
    const [tile] = this.concealed.splice(idx, 1);
    this.discards.push({
      tile: tile!,
      calledAway: false,
      isRiichiDeclaration: opts.isRiichiDeclaration ?? false,
      tsumogiri: opts.tsumogiri,
    });
    return tile!;
  }

  /** Marks the most recent (unclaimed) discard entry of this exact physical tile as
   *  claimed by a pon/kan call - bookkeeping for discard-history/replay display; it does
   *  not exempt this player from own-discard furiten (see DiscardEntry.calledAway). */
  markDiscardCalledAway(tileId: number): void {
    const entry = [...this.discards].reverse().find((d) => d.tile.id === tileId && !d.calledAway);
    if (!entry) {
      throw new Error(`Hand.markDiscardCalledAway: tile id ${tileId} is not an uncalled discard`);
    }
    entry.calledAway = true;
  }

  /** Removes specific concealed tiles by id (used when forming a meld from hand tiles). */
  removeConcealedByIds(tileIds: number[]): Tile[] {
    const removed: Tile[] = [];
    for (const id of tileIds) {
      const idx = this.concealed.findIndex((t) => t.id === id);
      if (idx === -1) {
        throw new Error(`Hand.removeConcealedByIds: tile id ${id} is not in concealed hand`);
      }
      removed.push(this.concealed.splice(idx, 1)[0]!);
    }
    return removed;
  }

  /** All tiles currently in hand: concealed + tiles locked in melds (kan tiles included). */
  allTileCount(): number {
    return this.concealed.length + this.melds.reduce((sum, m) => sum + m.tiles.length, 0) + this.kitaTiles.length;
  }

  isConcealed(): boolean {
    return this.melds.every((m) => m.type === "kan_closed");
  }
}
