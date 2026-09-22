import type { GameEvent } from "../core/GameLog.js";
import type { RuleConfig } from "../rules/RuleConfig.js";
import { allKindsForRules } from "../core/tiles.js";
import { collectReplayInvariantViolations } from "./replayInvariants.js";
import { checkReplaySchemaV2 } from "./replaySchemaV2.js";

export interface Violation {
  /** Which check family this came from - used for the failure-category breakdown in
   *  the final report, not for control flow. */
  category:
    | "replay_consistency"
    | "tile_kind_ceiling"
    | "hand_size"
    | "win_legality"
    | "furiten_own_discard"
    | "riichi_menzen"
    | "riichi_single_deduction"
    | "ippatsu_timing"
    | "kita_replacement"
    | "turn_sequencing"
    | "dora_breakdown"
    | "win_snapshot";
  message: string;
}

function handSlices(events: readonly GameEvent[]): { start: number; end: number }[] {
  const starts = events.map((e, i) => (e.type === "hand_start" ? i : -1)).filter((i) => i >= 0);
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? events.length }));
}

/**
 * Section 3B/3C (scoped to what a TileKind-based replay log can actually see - see
 * HANDOFF report for why true physical-tile-ID uniqueness isn't checkable this way).
 * Within one hand, counts every kind revealed via the deal, every draw (wall + rinshan),
 * and the initial dora indicator, and flags any kind whose cumulative revealed count
 * exceeds rules.tileCopiesPerKind. This is a one-directional ceiling check: it can't prove
 * every physical tile is accounted for, but it WILL catch wall generation or dealing bugs
 * that duplicate a kind beyond what physically exists.
 */
function checkTileKindCeiling(rules: RuleConfig, events: readonly GameEvent[]): Violation[] {
  const violations: Violation[] = [];
  const validKinds = new Set(allKindsForRules(rules));
  for (const { start, end } of handSlices(events)) {
    const seen = new Map<string, number>();
    const bump = (kind: string, at: string) => {
      if (!validKinds.has(kind)) {
        violations.push({ category: "tile_kind_ceiling", message: `${at}: kind "${kind}" is not valid under this ruleset` });
        return;
      }
      const next = (seen.get(kind) ?? 0) + 1;
      seen.set(kind, next);
      if (next > rules.tileCopiesPerKind) {
        violations.push({
          category: "tile_kind_ceiling",
          message: `${at}: kind "${kind}" revealed ${next} times, exceeding tileCopiesPerKind=${rules.tileCopiesPerKind}`,
        });
      }
    };
    for (let i = start; i < end; i++) {
      const e = events[i]!;
      if (e.type === "deal") {
        for (const hand of e.hands) for (const kind of hand) bump(kind, `events[${i}] (deal)`);
        bump(e.doraIndicator, `events[${i}] (initial dora indicator)`);
      } else if (e.type === "draw") {
        bump(e.tile, `events[${i}] (draw)`);
      } else if (e.type === "kita") {
        // the extracted north tile was already counted once via the deal or an earlier
        // draw event - kita re-exposes it (moves hand -> kitaTiles) without creating a
        // new physical tile, so it must NOT be bumped again here.
        if (!seen.has(e.tile)) {
          violations.push({ category: "tile_kind_ceiling", message: `events[${i}]: kita extracted "${e.tile}" that was never seen dealt or drawn` });
        }
      }
    }
  }
  return violations;
}

/**
 * Section 4: tracks each seat's concealed-tile count purely from the event stream (draw
 * +1, discard -1, kita -1, meld formation removes the caller's own contributed tiles from
 * concealed) alongside a running meld-tile count, and asserts concealed + meld equals 13
 * immediately after every one of that seat's own discards (the only point in a turn where
 * "effective hand size" has an invariant answer independent of meld count). Kita-extracted
 * tiles are deliberately NOT added back in: unlike a meld, an extracted North tile is
 * removed from the hand's structure entirely (pure bonus scoring, not a block toward the
 * 4-sets-plus-pair shape) and is immediately replaced by a rinshan draw, so concealed alone
 * already returns to its normal count - counting kitaTiles here as if it were meld material
 * would systematically overcount by 1 for every seat that ever extracted a North tile
 * (caught by this harness's own smoke test, not a real engine bug - see report).
 * Uses DealEvent's own per-seat dealt count as the starting point rather than hardcoding
 * 13, so it doesn't assume away FF-13's Tenhou initial-14 interpretation.
 */
function checkHandSize(rules: RuleConfig, events: readonly GameEvent[]): Violation[] {
  const violations: Violation[] = [];
  for (const { start, end } of handSlices(events)) {
    const dealEvent = events.slice(start, end).find((e): e is Extract<GameEvent, { type: "deal" }> => e.type === "deal");
    if (!dealEvent) continue;
    const concealed = dealEvent.hands.map((h) => h.length);
    const meldTiles = new Array(rules.playerCount).fill(0) as number[];
    const kitaTiles = new Array(rules.playerCount).fill(0) as number[];
    let wonOrAborted = false;

    for (let i = start; i < end; i++) {
      const e = events[i]!;
      if (e.type === "draw") {
        concealed[e.player]! += 1;
      } else if (e.type === "discard") {
        concealed[e.player]! -= 1;
        if (concealed[e.player]! < 0) {
          violations.push({ category: "hand_size", message: `events[${i}]: seat ${e.player}'s concealed count went negative on discard` });
        }
        if (!wonOrAborted) {
          const effective = concealed[e.player]! + meldTiles[e.player]!;
          if (effective !== 13) {
            violations.push({
              category: "hand_size",
              message: `events[${i}]: seat ${e.player}'s effective hand size (concealed+meld) is ${effective} after discard, expected 13`,
            });
          }
        }
      } else if (e.type === "kita") {
        concealed[e.player]! -= 1;
        kitaTiles[e.player]! += 1;
      } else if (e.type === "call") {
        // concealed contribution: how many PHYSICAL tiles this event removes from the
        // caller's own concealed hand (chi/pon take 2, daiminkan 3, ankan 4, shouminkan
        // just the 1 upgrade tile). meld-tile delta is intentionally NOT the physical tile
        // count: every meld - kan included - counts as exactly one 3-tile-equivalent block
        // toward the structural 13, same as a plain pon/chi. A kan's 4th tile is bonus
        // material (extra dora/fu potential) that the rinshan replacement draw exists
        // specifically to compensate for, so it must never be added to this running total -
        // shouminkan (kan_added) upgrades an EXISTING block rather than forming a new one,
        // so it contributes 0 additional blocks.
        const contributionFromCaller = e.call === "chi" || e.call === "pon" ? 2 : e.call === "kan_open" ? 3 : e.call === "kan_added" ? 1 : 4; // kan_closed
        const meldTileDelta = e.call === "kan_added" ? 0 : 3; // chi/pon/kan_open/kan_closed all form exactly one new block
        concealed[e.player]! -= contributionFromCaller;
        meldTiles[e.player]! += meldTileDelta;
        if (concealed[e.player]! < 0) {
          violations.push({ category: "hand_size", message: `events[${i}]: seat ${e.player}'s concealed count went negative on call "${e.call}"` });
        }
      } else if (e.type === "win" || e.type === "abortive_draw") {
        // no further post-discard invariant applies once the hand has a terminal event -
        // a winner's final tile (tsumo/ron) is never itself discarded.
        wonOrAborted = true;
      }
    }
  }
  return violations;
}

/**
 * Section 5 (win legality) + section 7 (own-discard furiten, the one furiten rule that's
 * unconditional and safely checkable from a replay log alone - see report for why temporary/
 * riichi furiten timing is intentionally NOT re-derived here). Uses hand_end.result's
 * AuditableWinResult (FF-13/FF-14's authoritative snapshot) rather than re-scoring anything.
 */
function checkWinLegality(events: readonly GameEvent[]): Violation[] {
  const violations: Violation[] = [];
  for (const { start, end } of handSlices(events)) {
    const slice = events.slice(start, end);
    const handEnd = slice.find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end");
    if (!handEnd?.result || handEnd.result.kind !== "agari") continue;
    const ownDiscardKinds = new Map<number, string[]>();
    for (const e of slice) {
      if (e.type === "discard") {
        const list = ownDiscardKinds.get(e.player) ?? [];
        list.push(e.tile);
        ownDiscardKinds.set(e.player, list);
      }
    }
    for (const w of handEnd.result.winners) {
      const at = `hand_end.result winner seat ${w.winnerSeat}`;
      if (w.yaku.length === 0 && w.yakumanUnits === 0) {
        violations.push({ category: "win_legality", message: `${at}: win recorded with zero yaku/yakuman` });
      }
      if (w.method === "tsumo") {
        const lastDraw = [...slice].reverse().find((e): e is Extract<GameEvent, { type: "draw" }> => e.type === "draw" && e.player === w.winnerSeat);
        if (!lastDraw || lastDraw.tile !== w.winningTile.kind) {
          violations.push({ category: "win_legality", message: `${at}: tsumo winningTile "${w.winningTile.kind}" does not match that seat's most recent draw` });
        }
      } else {
        const priorDiscard = [...slice].reverse().find((e): e is Extract<GameEvent, { type: "discard" }> => e.type === "discard" && e.tile === w.winningTile.kind);
        const priorKanTile = [...slice].reverse().find(
          (e): e is Extract<GameEvent, { type: "call" }> => e.type === "call" && (e.call === "kan_open" || e.call === "kan_added") && e.kind === w.winningTile.kind
        );
        // sanma kita: an extracted North tile can itself be ronned ("robbing the kita"),
        // the same way chankan robs an added kan - see GameState's offerRon call right
        // after logging the kita event, before any rinshan replacement is drawn.
        const priorKitaTile = [...slice].reverse().find((e): e is Extract<GameEvent, { type: "kita" }> => e.type === "kita" && e.tile === w.winningTile.kind);
        if (!priorDiscard && !priorKanTile && !priorKitaTile) {
          violations.push({ category: "win_legality", message: `${at}: ron winningTile "${w.winningTile.kind}" matches no preceding discard, robbable kan tile, or robbable kita tile` });
        }
        // own-discard furiten: a ron can never legally be declared on a kind this seat has
        // themselves already discarded earlier in this same hand (unconditional rule).
        const ownKinds = ownDiscardKinds.get(w.winnerSeat) ?? [];
        if (ownKinds.includes(w.winningTile.kind)) {
          violations.push({ category: "furiten_own_discard", message: `${at}: ron on "${w.winningTile.kind}" which this seat had already discarded (own-discard furiten)` });
        }
      }
    }
  }
  return violations;
}

/**
 * Section 6 (riichi menzen-at-declaration, single 1000-point deduction, ippatsu timing)
 * and section 9's kita-replacement-follows check (mirrors the kan pattern already
 * verified by collectReplayInvariantViolations, which only covers kan).
 */
function checkRiichiIppatsuKita(events: readonly GameEvent[]): Violation[] {
  const violations: Violation[] = [];
  for (const { start, end } of handSlices(events)) {
    const openCallSeats = new Set<number>(); // seats that have made a non-ankan open call so far
    const riichiDeclaredCount = new Map<number, number>();
    const ippatsuAlive = new Map<number, boolean>();
    for (let i = start; i < end; i++) {
      const e = events[i]!;
      if (e.type === "call" && e.call !== "kan_closed") {
        openCallSeats.add(e.player);
        for (const seat of ippatsuAlive.keys()) ippatsuAlive.set(seat, false); // any call breaks every live ippatsu window
      } else if (e.type === "riichi") {
        const count = (riichiDeclaredCount.get(e.player) ?? 0) + 1;
        riichiDeclaredCount.set(e.player, count);
        if (count > 1) {
          violations.push({ category: "riichi_single_deduction", message: `events[${i}]: seat ${e.player} declared riichi more than once in the same hand` });
        }
        if (openCallSeats.has(e.player)) {
          violations.push({ category: "riichi_menzen", message: `events[${i}]: seat ${e.player} declared riichi with a prior open call this hand` });
        }
        ippatsuAlive.set(e.player, true);
      } else if (e.type === "discard" && ippatsuAlive.get(e.player)) {
        // the declarer's own next discard (a tsumogiri draw-discard that isn't itself a
        // win) closes their own ippatsu window - riichi's own declaration discard is
        // excluded implicitly since this only fires on a LATER discard by that seat.
        if (!e.riichiDeclaration) ippatsuAlive.set(e.player, false);
      } else if (e.type === "win" && e.yaku.some((y) => y.name === "Ippatsu") && !ippatsuAlive.get(e.player)) {
        violations.push({ category: "ippatsu_timing", message: `events[${i}]: seat ${e.player} won with Ippatsu outside its live window` });
      } else if (e.type === "kita") {
        const next = events[i + 1];
        const robbed = next?.type === "win" && next.ronFrom === e.player;
        const replaced = next?.type === "draw" && next.player === e.player && next.source === "rinshan";
        if (!robbed && !replaced) {
          violations.push({ category: "kita_replacement", message: `events[${i}]: kita by seat ${e.player} was not followed by a rinshan draw or legal robbing ron` });
        }
      }
    }
  }
  return violations;
}

/**
 * Section 13 (turn/phase sanity): the one structural check safely derivable from the
 * event stream alone - a seat can never make two discards in a row with no intervening
 * draw/call/kita/win/draw-game event for them, since every legal discard is preceded by
 * either a wall/rinshan draw or a call that formed a meld.
 */
function checkTurnSequencing(events: readonly GameEvent[]): Violation[] {
  const violations: Violation[] = [];
  for (const { start, end } of handSlices(events)) {
    let lastActorGotTileSince: Set<number> = new Set();
    for (let i = start; i < end; i++) {
      const e = events[i]!;
      if (e.type === "draw" || e.type === "kita") {
        lastActorGotTileSince.add(e.player);
      } else if (e.type === "call") {
        lastActorGotTileSince.add(e.player); // meld formation stands in for "received a tile to act on"
      } else if (e.type === "discard") {
        if (!lastActorGotTileSince.has(e.player)) {
          violations.push({ category: "turn_sequencing", message: `events[${i}]: seat ${e.player} discarded without an intervening draw/call/kita` });
        }
        lastActorGotTileSince.delete(e.player);
      }
    }
  }
  return violations;
}

/** `schemaVersion` defaults to 2: any caller passing a live `GameState.log` (the harness,
 *  tests) always has current-schema data. A caller reading an on-disk replay file should
 *  pass `replay.meta.replaySchemaVersion ?? 1` explicitly so a v1 file's absent
 *  doraBreakdown/snapshot fields aren't flagged as violations. */
export function collectAllInvariantViolations(input: {
  rules: RuleConfig;
  events: readonly GameEvent[];
  schemaVersion?: number;
}): Violation[] {
  const { rules, events, schemaVersion = 2 } = input;
  const violations: Violation[] = [];
  for (const message of collectReplayInvariantViolations({ rules, events })) {
    violations.push({ category: "replay_consistency", message });
  }
  violations.push(...checkTileKindCeiling(rules, events));
  violations.push(...checkHandSize(rules, events));
  violations.push(...checkWinLegality(events));
  violations.push(...checkRiichiIppatsuKita(events));
  violations.push(...checkTurnSequencing(events));
  violations.push(...checkReplaySchemaV2(rules, events, schemaVersion));
  return violations;
}
