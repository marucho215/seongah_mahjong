# Seong-ah Mahjong Simulator

Deterministic riichi mahjong engine with Mahjong Soul-inspired **sanma (3-player)** and **yonma (4-player)**
rulesets, CharacterAI opponents, and a playable browser GUI / terminal CLI for one human seat.

The implementation targets the behavior covered by this repository's tests; it does not claim complete parity
with every live-service rule or option. Player count, tile/wall layout, scoring totals, calls (chi/kita) and
round length are selected through `RuleConfig`.

Version 1.0.0. Developer-facing structure and status: [HANDOFF.md](HANDOFF.md).

## What is supported

| | Sanma | Yonma |
|---|---|---|
| AI-only full games (CharacterAI / simple AI) | yes | yes |
| Human (1 seat) + AI in the browser GUI | yes | yes |
| Human + AI in the terminal CLI (one hand per run) | yes | yes |
| Replay JSON (schema v2) for AI-only games | yes | yes |
| Replay JSON for human + AI games | yes | yes |

Every choice a human can face has a decision path (GUI and CLI):
discard and riichi, pon, chi (yonma only - you pick among the engine's legal sequences, or pass), daiminkan,
ankan, kakan, kita (sanma), ron / pass (passing makes you furiten, as in the real rules), tsumo / decline, and
nine-terminals abortive draw. AI seats always act automatically (including automatic tsumo/ron).

## Running

Requires [Node.js](https://nodejs.org/) 20 or newer.

```bash
npm install
```

### Play in the browser (GUI)

```bash
npm run play:gui                           # opens the start screen
npm run play:gui -- my-seed --mode yonma --save-replays   # same, with these values pre-filled
```

Open the printed `http://localhost:3000` (set `PORT` to change it). The browser opens on a start screen: pick sanma
or yonma, choose a character for each opponent seat (every registered character is listed with a one-line playstyle
description and a few short tags), optionally set a seed and replay saving, then start. Command-line arguments only pre-fill that
screen. You sit at seat 0. A game runs all hands; after the last hand's result, "최종 결과 보기" shows the final
standings (placement, score and pt from the engine, end reason, and the seed actually used). From there you can replay
with the same opponents and a new seed, replay the exact same game with the same seed, or return to the start screen
with the last choices pre-filled - no server restart needed.

GUI features: one shared 4-position table for sanma and yonma, click-to-discard with riichi confirmation, action bar
for every decision (chi options are drawn as tiles), the AI's discards/calls/riichi/wins replayed one at a time,
a short "recent actions" list, an AI playback speed setting (slow / normal / fast / instant - it only changes how
fast the already-decided AI turns are shown, never the game itself), riichi wait display with the number of copies you have not seen yet (public
information only, never the real wall), furiten indicator, sound effects, result overlay, and session recovery on
browser refresh/reconnect. Tile art: `src/gui/public/assets/mahjong/ATTRIBUTION.md`.

### Play in the terminal (CLI)

```bash
npm run play                        # sanma, random seed
npm run play my-seed                # fixed seed
npm run play -- --mode yonma        # yonma
npm run play -- --save-replays
```

The CLI plays a single hand per run (no next-hand continuation); the GUI plays the whole game. Both use the same
decision engine, so anything legal in one is legal in the other.

### Sound effects

The GUI plays physical (tile, riichi stick, shuffle) and UI sounds only - no spoken declarations. OwlishMedia UI
sounds (CC0) are included; T-STUDIO's sound pack cannot be redistributed, so download it yourself and place the files
as described in `src/gui/public/assets/audio/tstudio/README.md`. The game works without them (those sounds are just
silent). Sources and licenses: `src/gui/public/assets/audio/README.md`.

### AI-only simulations

```bash
npm run sim                                     # sanma: each registered character solo vs 2 simple AIs
npm run sim -- --games 100 --save-replays
npm run sim -- --players seiyatosuke,kyletyler,seiyamouri --games 10   # any 3 characterIds at one table
npm run sim:yonma -- --players jegalmina,toumesuayo,byeonari,seiyakouri --seed yonma-qa-001 --save-replays
npm run validate -- --games 100 [--seed S] [--format sanma|yonma] [--save-failures]   # mass self-play invariant checks
```

Seat order follows the order of `--players`; the same characterId may appear more than once. Registered
characterIds are listed in `src/ai/characterProfiles.ts`.

## Replays

`--save-replays` writes one JSON file per game to `replays/` (relative paths resolve against the project root, not the
current directory): `<label>_game<index>.json`. Human games are named `human-<mode>-<seed>_game0.json`
(`human-cli-<mode>-<seed>_game0.json` for the CLI).

A record contains `meta` (`replaySchemaVersion: 2`, rules, game seed, per-seat `kind` and `characterId`), the engine's
own `events` log (deals, draws, discards, calls, riichi, wins with auditable scoring and dora breakdown, draws,
`game_end`), `aiDecisions` (CharacterAI debug entries), and `finalStandings`. Games with a human seat additionally get
`meta.seats[].kind: "human"` and an optional `humanDecisions` array (what was asked, what was chosen, and where in
`events` it happened). Schema v2 is additive over v1; readers should treat a missing version as 1.

Replays are checked by the same invariant validators the tests use (`src/validation/`, `tests/helpers/replayQa.ts`).
GUI games save once, when the game ends; if the server process dies mid-game the unfinished replay is not recovered
(a browser refresh does not interrupt recording). There is no replay viewer yet.

## Tests

```bash
npx tsc -p . --noEmit            # typecheck
npm test                         # full suite (vitest run) - takes about 15 minutes
npx vitest run tests/humanChi.test.ts     # a single file
```

Coverage areas: scoring and yaku, calls and kan, riichi/furiten, abortive and exhaustive draws, round progression,
Mahjong Soul fidelity fixes (`tests/ff*.test.ts`), CharacterAI determinism, replay schema and invariants, human
decision paths (ron, chi, tsumo, nine-terminals, riichi waits), the GUI session/server (including refresh recovery),
and full human + AI games in both modes.

## Known limitations and future work

- **CustomAI** is not implemented. The `customAI` controller kind is only a reserved slot: creating a game with it
  throws. User-authored AI and any editor/settings UI are future work.
- No replay viewer / timeline / seek, no character voices or win cut-ins, no additional presentation options.
- The GUI always seats the human at seat 0 (opponents are chosen on the start screen; the human's seat is not).
- Character portraits are not included yet. The start screen is text-only by design; `CHARACTER_PORTRAITS` in
  `src/gui/characterRoster.ts` is the optional slot for them.
- The CLI plays one hand per run.
- Rank/room/account progression scoring is out of scope.
