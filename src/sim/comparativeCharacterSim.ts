/* Comparative CharacterAI simulation / report script. Not part of the automated test
 * suite - run with `npx tsx src/sim/comparativeCharacterSim.ts`. Produces the metrics
 * requested for the CharacterAI report: aggression, defense/deal-in, riichi/dama, call
 * frequency, win speed, average value, entropy consistency, and special-mechanic checks. */
import { GameState } from "../core/GameState.js";
import { DEFAULT_SANMA_RULES } from "../rules/RuleConfig.js";
import { CHARACTER_PROFILES, getCharacterProfile, resolveCharacterId } from "../ai/characterProfiles.js";
import { CharacterAI, type CharacterDecisionContext } from "../ai/characterAI.js";
import { Hand } from "../core/Hand.js";
import type { Tile } from "../core/tiles.js";
import type { GameEvent } from "../core/GameLog.js";
import { buildGameReplayRecord, writeGameReplay, resolveReplayDir, type ReplaySeatInfo } from "./replayRecorder.js";

let nextId = 900000;
function t(kind: string, isRed = false): Tile {
  const suit = kind[0] as "m" | "p" | "s" | "z";
  const rank = Number(kind.slice(1));
  return { id: nextId++, kind, suit, rank, isRed };
}
function tiles(kinds: string[]): Tile[] {
  return kinds.map((k) => t(k));
}

function baseCtx(overrides: Partial<CharacterDecisionContext> = {}): CharacterDecisionContext {
  return {
    rules: DEFAULT_SANMA_RULES,
    riichiOpponentDiscardKinds: [],
    doraIndicatorKinds: [],
    visibleTileKinds: [],
    seatWind: 1,
    roundWind: 1,
    wallRemainingLive: 40,
    ownScore: 35000,
    opponentScores: [35000, 35000],
    isLastHandOfGame: false,
    isDealer: false,
    ...overrides,
  };
}

interface CharacterStats {
  games: number;
  hands: number;
  riichiCount: number;
  damaWinCount: number;
  callCount: number;
  winCount: number;
  dealInCount: number; // times seat 0's discard was ronned by someone else
  totalHanOnWin: number;
  totalFuOnWin: number;
  totalTurnsToWin: number; // approximated via count of seat-0 discards in the hand
  totalPlacement: number; // sum of seat 0's 1st/2nd/3rd placement across games
  firstPlaceCount: number;
}

function emptyStats(): CharacterStats {
  return {
    games: 0,
    hands: 0,
    riichiCount: 0,
    damaWinCount: 0,
    callCount: 0,
    winCount: 0,
    dealInCount: 0,
    totalHanOnWin: 0,
    totalFuOnWin: 0,
    totalTurnsToWin: 0,
    totalPlacement: 0,
    firstPlaceCount: 0,
  };
}

function handSlices(log: readonly GameEvent[]): { start: number; end: number }[] {
  const starts = log.map((e, i) => (e.type === "hand_start" ? i : -1)).filter((i) => i >= 0);
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? log.length }));
}

function runCharacterBattery(characterId: string, games: number, saveReplays = false): CharacterStats {
  const profile = getCharacterProfile(characterId);
  const stats = emptyStats();
  const replayDir = "replays";
  const seats: ReplaySeatInfo[] = [
    { seat: 0, kind: "characterAI", characterId },
    { seat: 1, kind: "simpleAI" },
    { seat: 2, kind: "simpleAI" },
  ];
  for (let seed = 0; seed < games; seed++) {
    const simulationLabel = `report-${characterId}-${seed}`;
    const gs = new GameState({
      rules: DEFAULT_SANMA_RULES,
      seed: simulationLabel,
      characterProfiles: [profile, null, null],
    });
    gs.playGame();
    if (saveReplays) {
      const record = buildGameReplayRecord(gs, simulationLabel, seed, seats);
      const writtenPath = writeGameReplay(record, replayDir);
      console.log(`  [replay saved] ${writtenPath}`);
    }
    stats.games++;
    const standing = gs.computeFinalStandings().find((s) => s.player === 0)!;
    stats.totalPlacement += standing.placement;
    if (standing.placement === 1) stats.firstPlaceCount++;
    for (const { start, end } of handSlices(gs.log)) {
      const slice = gs.log.slice(start, end);
      stats.hands++;
      let seatDiscards = 0;
      let seatRiichiThisHand = false;
      for (const evt of slice) {
        if (evt.type === "riichi" && evt.player === 0) {
          stats.riichiCount++;
          seatRiichiThisHand = true;
        }
        if (evt.type === "discard" && evt.player === 0) seatDiscards++;
        if (evt.type === "call" && evt.player === 0 && (evt.call === "pon" || evt.call === "kan_open")) stats.callCount++;
        if (evt.type === "win" && evt.ronFrom === 0 && evt.player !== 0) stats.dealInCount++;
        if (evt.type === "win" && evt.player === 0) {
          stats.winCount++;
          stats.totalHanOnWin += evt.han;
          stats.totalFuOnWin += evt.fu;
          stats.totalTurnsToWin += seatDiscards;
          if (!seatRiichiThisHand) stats.damaWinCount++; // won with a non-riichi yaku
        }
      }
    }
  }
  return stats;
}

function fmt(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : "n/a";
}

// ---------------------------------------------------------------------------
// Direct 3-player CharacterAI battle: seats an arbitrary trio of characterIds at the
// same table (instead of solo seat 0 vs 2 neutral SimpleAI opponents) via --players.
// ---------------------------------------------------------------------------
interface SeatStats {
  games: number;
  hands: number;
  riichiCount: number;
  damaWinCount: number;
  callCount: number;
  winCount: number;
  dealInCount: number;
  totalHanOnWin: number;
  totalPlacement: number;
  firstPlaceCount: number;
  dealerHands: number;
  dealerWins: number;
  dealerRenchanCount: number;
}

function emptySeatStats(): SeatStats {
  return {
    games: 0,
    hands: 0,
    riichiCount: 0,
    damaWinCount: 0,
    callCount: 0,
    winCount: 0,
    dealInCount: 0,
    totalHanOnWin: 0,
    totalPlacement: 0,
    firstPlaceCount: 0,
    dealerHands: 0,
    dealerWins: 0,
    dealerRenchanCount: 0,
  };
}

function runDirectBattle(characterIds: [string, string, string], games: number, saveReplays = false): SeatStats[] {
  const profiles = characterIds.map((id) => getCharacterProfile(id));
  const stats: SeatStats[] = [emptySeatStats(), emptySeatStats(), emptySeatStats()];
  const replayDir = "replays";
  const label = characterIds.join("-vs-");
  const seats: ReplaySeatInfo[] = [0, 1, 2].map((seat) => ({ seat, kind: "characterAI", characterId: characterIds[seat]! }));

  for (let seed = 0; seed < games; seed++) {
    const simulationLabel = `direct-${label}-${seed}`;
    const gs = new GameState({
      rules: DEFAULT_SANMA_RULES,
      seed: simulationLabel,
      characterProfiles: profiles,
    });
    gs.playGame();
    if (saveReplays) {
      const record = buildGameReplayRecord(gs, simulationLabel, seed, seats);
      const writtenPath = writeGameReplay(record, replayDir);
      console.log(`  [replay saved] ${writtenPath}`);
    }

    const standings = gs.computeFinalStandings();
    for (const seat of [0, 1, 2]) {
      stats[seat]!.games++;
      const standing = standings.find((s) => s.player === seat)!;
      stats[seat]!.totalPlacement += standing.placement;
      if (standing.placement === 1) stats[seat]!.firstPlaceCount++;
    }

    for (const { start, end } of handSlices(gs.log)) {
      const slice = gs.log.slice(start, end);
      const handStartEvt = slice[0] as Extract<GameEvent, { type: "hand_start" }>;
      const handEndEvt = slice.find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end");
      for (const seat of [0, 1, 2]) {
        stats[seat]!.hands++;
        if (handStartEvt.dealer === seat) stats[seat]!.dealerHands++;
      }
      let dealerWonThisHand = false;
      const seatRiichiThisHand = [false, false, false];
      for (const evt of slice) {
        if (evt.type === "riichi") {
          stats[evt.player]!.riichiCount++;
          seatRiichiThisHand[evt.player] = true;
        }
        if (evt.type === "call" && (evt.call === "pon" || evt.call === "kan_open")) stats[evt.player]!.callCount++;
        if (evt.type === "win" && evt.ronFrom !== undefined) stats[evt.ronFrom]!.dealInCount++;
        if (evt.type === "win") {
          stats[evt.player]!.winCount++;
          stats[evt.player]!.totalHanOnWin += evt.han;
          if (!seatRiichiThisHand[evt.player]) stats[evt.player]!.damaWinCount++;
          if (evt.player === handStartEvt.dealer) dealerWonThisHand = true;
        }
      }
      if (dealerWonThisHand) {
        stats[handStartEvt.dealer]!.dealerWins++;
        if (handEndEvt && handEndEvt.nextDealer === handStartEvt.dealer) stats[handStartEvt.dealer]!.dealerRenchanCount++;
      }
    }
  }
  return stats;
}

function printDirectBattleReport(characterIds: [string, string, string], games: number, saveReplays: boolean) {
  console.log(`\n=== Direct battle: ${characterIds.join(", ")} (seats 0/1/2), ${games} games ===\n`);
  if (saveReplays) console.log(`(saving one replay JSON per game to ${resolveReplayDir("replays")})\n`);
  const stats = runDirectBattle(characterIds, games, saveReplays);
  const header = [
    "seat",
    "characterId",
    "avgPlacement",
    "1st%",
    "win/hand",
    "dealIn/hand",
    "riichi/hand",
    "dama-win/win",
    "call/hand",
    "avgHan",
    "dealerWin%",
    "dealerRenchanCount",
  ];
  console.log(header.join("\t"));
  for (const seat of [0, 1, 2]) {
    const s = stats[seat]!;
    console.log(
      [
        seat,
        characterIds[seat],
        fmt(s.totalPlacement / s.games, 2),
        fmt(s.firstPlaceCount / s.games),
        fmt(s.winCount / s.hands),
        fmt(s.dealInCount / s.hands),
        fmt(s.riichiCount / s.hands),
        fmt(s.damaWinCount / Math.max(1, s.winCount)),
        fmt(s.callCount / s.hands),
        fmt(s.totalHanOnWin / Math.max(1, s.winCount), 2),
        fmt(s.dealerWins / Math.max(1, s.dealerHands)),
        s.dealerRenchanCount,
      ].join("\t")
    );
  }
}

function parsePlayersArg(argv: string[]): [string, string, string] | null {
  const flagIdx = argv.indexOf("--players");
  if (flagIdx === -1) return null;
  const raw = argv[flagIdx + 1];
  if (!raw) {
    console.error("--players requires a value, e.g. --players seiyatosuke,kyletyler,seiyamouri");
    process.exit(1);
  }
  // resolve legacy aliases (e.g. "ryuhart" -> "ryuheart") immediately, before validation
  // or anything downstream (replay serialization) ever sees the id, so only the canonical
  // id is ever recorded going forward.
  const ids = raw.split(",").map((s) => resolveCharacterId(s.trim()));
  if (ids.length !== 3) {
    console.error(`--players requires exactly 3 characterIds (got ${ids.length}): ${raw}`);
    process.exit(1);
  }
  for (const id of ids) {
    if (!(id in CHARACTER_PROFILES)) {
      console.error(`Unknown characterId "${id}". Registered characterIds: ${Object.keys(CHARACTER_PROFILES).join(", ")}`);
      process.exit(1);
    }
  }
  return ids as [string, string, string];
}

function printBehaviorReport(games: number, saveReplays = false) {
  console.log(`\n=== Behavior battery: ${games} games per character, solo seat 0 vs 2 neutral SimpleAI opponents ===\n`);
  if (saveReplays) console.log(`(saving one replay JSON per game to ${resolveReplayDir("replays")})\n`);
  const header = [
    "character",
    "games",
    "hands",
    "riichi/hand",
    "dama-win/win",
    "call/hand",
    "win/hand",
    "dealIn/hand",
    "avgHan",
    "avgFu",
    "avgTurnsToWin",
    "avgPlacement",
    "gameWinRate(1st)",
  ];
  console.log(header.join("\t"));
  for (const id of Object.keys(CHARACTER_PROFILES)) {
    const s = runCharacterBattery(id, games, saveReplays);
    console.log(
      [
        id,
        s.games,
        s.hands,
        fmt(s.riichiCount / s.hands),
        fmt(s.damaWinCount / Math.max(1, s.winCount)),
        fmt(s.callCount / s.hands),
        fmt(s.winCount / s.hands),
        fmt(s.dealInCount / s.hands),
        fmt(s.totalHanOnWin / Math.max(1, s.winCount), 2),
        fmt(s.totalFuOnWin / Math.max(1, s.winCount), 1),
        fmt(s.totalTurnsToWin / Math.max(1, s.winCount), 2),
        fmt(s.totalPlacement / s.games, 2),
        fmt(s.firstPlaceCount / s.games),
      ].join("\t")
    );
  }
}

// ---------------------------------------------------------------------------
// Entropy consistency: fixed tied-candidate scenario, sampled many times per character
// with different RNG seeds, measuring how concentrated the choice distribution is.
// ---------------------------------------------------------------------------
function entropyConsistencyExperiment(samples: number) {
  console.log(`\n=== Entropy consistency: ${samples} samples/character on a fixed 3-way-tied discard scenario, skill-noise HELD FIXED per character (varying only the selection stream) ===\n`);
  // 3 complete melds + pair + 3 isolated, mutually-tied floaters (z5, z6, z7) - discarding
  // any of them keeps identical shanten, so nothing but noise/entropy/mistakeRate can drive
  // the pick. Holding the skill-noise seed fixed per character (and varying only the
  // selection-stream seed across samples) isolates entropy's own softmax-sampling effect:
  // with a single shared seed, a fresh skill-noise draw each sample would itself decide
  // which of the 3 tied candidates looks best BEFORE entropy's temperature ever engages,
  // washing out entropy's signature regardless of how cleanly the streams are separated.
  const hand = new Hand();
  hand.dealIn(tiles(["m1", "m1", "m1", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z1", "z5", "z6", "z7"]));

  console.log(["character", "entropy", "uniqueChoices", "topChoiceShare"].join("\t"));
  for (const id of Object.keys(CHARACTER_PROFILES)) {
    const profile = getCharacterProfile(id);
    const counts = new Map<string, number>();
    for (let i = 0; i < samples; i++) {
      const ai = new CharacterAI(profile, `entropy-${id}`, {
        independentStreamSeeds: { skillSeed: `entropy-${id}::fixed-skill`, selectionSeed: `entropy-${id}::selection-${i}` },
      });
      const h = new Hand();
      h.dealIn(hand.concealed.map((tile) => ({ ...tile })));
      const discardedId = ai.chooseDiscard(h, baseCtx());
      const kind = h.concealed.find((c) => c.id === discardedId)!.kind;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const topShare = Math.max(...counts.values()) / samples;
    console.log([id, profile.entropy, counts.size, fmt(topShare)].join("\t"));
  }
}

// ---------------------------------------------------------------------------
// Special mechanic checks
// ---------------------------------------------------------------------------
function checkNahuiOverload(samples: number) {
  console.log(`\n=== Nahui overload glitch: deviation rate at low vs high decision complexity (${samples} samples each) ===\n`);
  const profile = getCharacterProfile("jegalnahui");
  const hand = new Hand();
  hand.dealIn(tiles(["m1", "m1", "m1", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z1", "p9", "s9"]));

  function trueBestKind(ctx: CharacterDecisionContext): string {
    // deterministic best pick with entropy/mistake disabled, for comparison
    const zeroNoise = { ...profile, entropy: 0.001, mistakeRate: 0, overloadSensitivity: 0 };
    const ai = new CharacterAI(zeroNoise, "reference");
    const h = new Hand();
    h.dealIn(hand.concealed.map((tile) => ({ ...tile })));
    const id = ai.chooseDiscard(h, ctx);
    return h.concealed.find((c) => c.id === id)!.kind;
  }

  for (const [label, ctx] of [
    ["low complexity", baseCtx({ riichiOpponentDiscardKinds: [], wallRemainingLive: 40 })],
    ["high complexity", baseCtx({ riichiOpponentDiscardKinds: [["p9"], ["s9"]], wallRemainingLive: 8 })],
  ] as const) {
    const reference = trueBestKind(ctx);
    let deviations = 0;
    for (let i = 0; i < samples; i++) {
      const ai = new CharacterAI(profile, `nahui-${label}-${i}`);
      const h = new Hand();
      h.dealIn(hand.concealed.map((tile) => ({ ...tile })));
      const id = ai.chooseDiscard(h, ctx);
      const kind = h.concealed.find((c) => c.id === id)!.kind;
      if (kind !== reference) deviations++;
    }
    console.log(`${label}: reference=${reference}, deviation rate=${fmt(deviations / samples)}`);
  }
}

function checkKylePersistence() {
  console.log(`\n=== Kyle route persistence: simulated multi-turn chiitoi-leaning hand, no kokushi possibility ===\n`);
  const profile = getCharacterProfile("kyletyler");
  const ai = new CharacterAI(profile, "kyle-persistence-test-2");
  ai.onHandStart();
  const hand = new Hand();
  // 4 pairs of MIDDLE ranks (p2,p6,s4,p8 - none terminal, none honor, so kokushi shanten
  // stays locked around 11 the whole time) + scattered non-kokushi singles. Only m9/z3
  // are kokushi-relevant at all, so kokushi can never compete with chiitoi's shanten here.
  hand.dealIn(tiles(["p2", "p2", "p6", "p6", "s4", "s4", "p8", "p8", "s2", "s3", "m9", "z3", "p4", "s7"]));
  const kept: string[] = [];
  const pairKinds = new Set(["p2", "p6", "s4", "p8"]);
  let brokeAPair = false;
  for (let turn = 0; turn < 4; turn++) {
    const id = ai.chooseDiscard(hand, baseCtx());
    const kind = hand.concealed.find((c) => c.id === id)!.kind;
    const remainingOfKind = hand.concealed.filter((t) => t.kind === kind).length;
    if (pairKinds.has(kind) && remainingOfKind === 2) brokeAPair = true; // discarding from a still-intact pair
    kept.push(`discarded ${kind}`);
    hand.discardById(id, { tsumogiri: false });
    hand.addDrawn(t(["s6", "p7", "z5", "s8"][turn]!));
  }
  console.log(kept.join(" -> "));
  console.log(`broke an existing pair at any point: ${brokeAPair}`);
}

function checkTosukeSandbagging(samples: number) {
  console.log(`\n=== Tosuke sandbagging (paired per-seed comparison on separated RNG): deviation rate, low vs high intervention pressure (${samples} samples each) ===\n`);
  // Paired design: for each sample seed, build TWO instances sharing that EXACT seed - one
  // with sandbagging on (the real profile) and one with sandbagging forced to 0. Because
  // skill-noise now lives on its own RNG stream keyed by the same seed, both instances
  // compute an IDENTICAL scored candidate list; the only thing that can differ is whether
  // applySandbagging (which draws from the separate selection stream) settles for a
  // second-tier pick. This isolates sandbagging's own effect from sample-to-sample
  // skill-noise variance, which the single-fixed-reference version conflated.
  const profile = getCharacterProfile("seiyatosuke");
  const hand = new Hand();
  hand.dealIn(tiles(["m1", "m1", "m1", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z1", "p9", "s9"]));

  for (const [label, ctx] of [
    ["low pressure", baseCtx({ ownScore: 35000, opponentScores: [35000, 35000], isLastHandOfGame: false })],
    ["high pressure (large deficit + last hand)", baseCtx({ ownScore: 8000, opponentScores: [45000, 40000], isLastHandOfGame: true })],
  ] as const) {
    let deviations = 0;
    const traceExamples: string[] = [];
    for (let i = 0; i < samples; i++) {
      const seed = `tosuke-paired-${label}-${i}`;
      const refAi = new CharacterAI({ ...profile, sandbagging: 0 }, seed);
      const testAi = new CharacterAI(profile, seed);

      const refHand = new Hand();
      refHand.dealIn(hand.concealed.map((tile) => ({ ...tile })));
      const refId = refAi.chooseDiscard(refHand, ctx);
      const refKind = refHand.concealed.find((c) => c.id === refId)!.kind;

      const testHand = new Hand();
      testHand.dealIn(hand.concealed.map((tile) => ({ ...tile })));
      const testId = testAi.chooseDiscard(testHand, ctx);
      const testKind = testHand.concealed.find((c) => c.id === testId)!.kind;

      if (testKind !== refKind) deviations++;

      const trace = testAi.lastSandbaggingTrace;
      if (trace && traceExamples.length < 3) {
        traceExamples.push(
          `  trueBest=${trace.trueChoice} final=${trace.finalChoice} sandbagged=${trace.sandbagged} ` +
            `pressure=${trace.interventionPressure.toFixed(3)} threshold=${trace.interventionThreshold} interventionActive=${trace.interventionActive}`
        );
      }
    }
    console.log(`${label}: deviation rate (sandbagging on vs off, same seed) = ${fmt(deviations / samples)}`);
    console.log(`  example decision traces:\n${traceExamples.join("\n")}`);
  }
}

function checkAriShapeCleanliness(samples: number) {
  console.log(`\n=== Ari shape cleanliness: preference for discarding an isolated tile over a connected one, when shanten-tied (${samples} samples) ===\n`);
  // 3 complete melds + pair + one isolated honor (z7) + one loosely-connected tile (s5,
  // adjacent to the s4 already in a run) - both discardable at equal shanten in this shape.
  const hand = new Hand();
  hand.dealIn(tiles(["m1", "m1", "m1", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z1", "z7", "s5"]));
  const profile = getCharacterProfile("byeonari");
  const counts = new Map<string, number>();
  for (let i = 0; i < samples; i++) {
    const ai = new CharacterAI(profile, `ari-${i}`);
    const h = new Hand();
    h.dealIn(hand.concealed.map((tile) => ({ ...tile })));
    const id = ai.chooseDiscard(h, baseCtx());
    const kind = h.concealed.find((c) => c.id === id)!.kind;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  console.log([...counts.entries()].map(([k, v]) => `${k}: ${v}/${samples}`).join(", "));
}

// NOTE: entropyConsistencyExperiment below is the REAL-HAND-based entropy experiment
// (fixed tied-candidate real hand, varying only the selection-stream seed). It is reported
// SEPARATELY from the fully synthetic entropy test (fixed scores, zero shanten/hand
// involvement at all) added to tests/characterAI.test.ts under
// "entropy isolation (synthetic: fixed candidate scores, zero skill-noise)".
function parseGamesArg(argv: string[], defaultGames: number): number {
  const flagIdx = argv.indexOf("--games");
  if (flagIdx !== -1 && argv[flagIdx + 1] !== undefined) return Number(argv[flagIdx + 1]);
  // Only treat a bare positional as the games count if it's actually numeric - otherwise
  // e.g. `--players a,b,c` (with no --games) would have its own value misread as this.
  const positional = argv.find((a) => !a.startsWith("--") && /^\d+$/.test(a));
  return positional !== undefined ? Number(positional) : defaultGames;
}

const CLI_ARGS = process.argv.slice(2);
const GAMES = parseGamesArg(CLI_ARGS, 50); // default unchanged: raised from the previous 12 games/character
const SAVE_REPLAYS = CLI_ARGS.includes("--save-replays");
const PLAYERS = parsePlayersArg(CLI_ARGS);

if (PLAYERS) {
  // Direct 3-player CharacterAI battle mode: only this report runs (the solo-vs-SimpleAI
  // comparison battery and special-mechanic checks below are a different diagnostic and
  // stay untouched/unaffected when --players isn't passed).
  printDirectBattleReport(PLAYERS, GAMES, SAVE_REPLAYS);
} else {
  printBehaviorReport(GAMES, SAVE_REPLAYS);
  entropyConsistencyExperiment(300);
  checkNahuiOverload(200);
  checkKylePersistence();
  checkTosukeSandbagging(200);
  checkAriShapeCleanliness(200);
}
