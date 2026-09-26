# Seong-ah Mahjong Simulator

Deterministic riichi mahjong engine with Mahjong Soul-inspired **sanma (3-player)** and **yonma (4-player)**
rulesets, CharacterAI opponents, and a playable browser GUI / terminal CLI for one human seat.

The implementation targets the behavior covered by this repository's tests; it does not claim complete parity
with every live-service rule or option. Player count, tile/wall layout, scoring totals, calls (chi/kita) and
round length are selected through `RuleConfig`.

Version 1.1.0 ([release notes](RELEASE_NOTES.md)). Developer-facing structure and status: [HANDOFF.md](HANDOFF.md).

## What is supported

| | Sanma | Yonma |
|---|---|---|
| AI-only full games (CharacterAI / simple AI) | yes | yes |
| Human (1 seat) + AI in the browser GUI | yes | yes |
| Human + AI in the terminal CLI (one hand per run) | yes | yes |
| Replay JSON (schema v2) for AI-only games | yes | yes |
| Replay JSON for human + AI games | yes | yes |
| GUI lobby (mode choice, opponents, CustomAI, seed, replay saving) | yes | yes |
| Replay viewer (re-plays a saved game with the current engine) | yes | yes |
| CustomAI opponents (user-set CharacterAI parameters) | yes | yes |

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
npm run play:gui                                   # start the GUI server, then open the lobby in a browser
npm run play:gui -- my-seed --save-replays         # same, with the seed / replay-saving options pre-filled
```

#### Entering the lobby and starting a game

1. Run `npm run play:gui` and open the printed `http://localhost:3000` (set `PORT` to change the port).
2. The page opens on the game lobby. Under **"대국 방식"**, click **산마** (3 players) or **4마** (4 players). Each row
   shows the player count, starting score and whether chi / kita exist. Picking a mode never starts a game by itself.
   The character list on the right can be browsed but not assigned until a mode is picked.
3. The same screen then shows the settings for that mode (the settings screen is shared by both modes; only the number
   of seats differs):
   - **좌석**: click a seat (하가 / 대면 / 상가), then click a character card to seat it. The same character can sit in
     only one seat. "무작위로 채우기" fills the seats randomly.
   - **CustomAI**: create, edit, duplicate or delete your own AIs; saved CustomAIs appear at the end of the character
     list and can be seated like any other character.
   - **옵션**: seed (leave empty for a random one) and "게임이 끝나면 리플레이 저장".
   - **"대국 방식 바꾸기"** goes back to step 2 to pick the other mode.
4. Click **"대국 시작"**. You sit at seat 0 and the game runs all hands. During a game, **"대국 그만두기"** (top right)
   ends it after a confirmation and returns to the settings of that mode; an abandoned game is not saved as a replay.
5. After the last hand, **"최종 결과 보기"** shows the final standings (placement, score and pt from the engine, end
   reason, and the seed actually used). From there:
   - **"같은 설정으로 다시"**: same mode and opponents, new seed.
   - **"같은 시드로 다시"**: the exact same game again.
   - **"설정 바꾸기"**: back to the settings of the mode you last played, with the last choices pre-filled; "대국 방식
     바꾸기" from there returns to the mode choice.
   No server restart is needed between games.

The lobby screen state lives on the server, so a refresh or a second tab shows the same screen. If a game is already in
progress on the server, opening the page (or refreshing) resumes that game instead of showing the lobby; the lobby comes
back once that game ends and you choose "설정 바꾸기". Command-line arguments only pre-fill the settings screen (seed,
`--save-replays`); the mode is always chosen in the lobby (`--mode` is still accepted but does not skip that choice).
The lobby also links to the replay viewer ("저장된 리플레이 보기").

GUI features: one shared 4-position table for sanma and yonma, click-to-discard with riichi confirmation, action bar
for every decision (chi options are drawn as tiles), the AI's discards/calls/riichi/wins replayed one at a time,
a short "recent actions" list, an AI playback speed setting (slow / normal / fast / instant - it only changes how
fast the already-decided AI turns are shown, never the game itself),
optional auto-play toggles (all off by default): auto tsumogiri (discard the tile just drawn, no riichi), auto-pass on
chi/pon/open kan offers, and auto-win on ron/tsumo - each only answers that exact decision through the normal response
path, so it is recorded in the replay like any other human choice, your current shanten, your waits whenever you are tenpai (riichi or not) with the number of copies you have not
seen yet (public information only, never the real wall), furiten indicator, sound effects, result overlay, and session recovery on
browser refresh/reconnect. Tile art: `src/gui/public/assets/mahjong/ATTRIBUTION.md`.

#### Invite-code entry (in development for 1.2)

`npm run play:gui -- --invite-code <code>` (or the `SEONGAH_INVITE_CODE` environment variable) turns on an entry
gate: every page first asks for the invite code and a nickname (12 characters max), and only browsers that entered
can use the lobby, games, replays and CustomAI. There are no accounts or passwords; the server keeps a session cookie
per browser (stored as a hash in `server-data/sessions.json`, so entries survive a restart), and entering again from
the same browser only changes the nickname. Wrong invite codes are rate-limited per client. Without an invite code the
server works exactly as before (local mode).

Each entered user has their own lobby, game, event stream and AI speed setting (several tabs of the same browser share
them). Online play is still in development (see `HANDOFF.md` §10): CustomAI and saved replays are still shared by all
users, and a long AI computation or replay reproduction for one user can briefly pause the others.

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
(a browser refresh does not interrupt recording). The GUI server also serves a replay viewer at `http://localhost:3000/replay.html` (linked from the start screen). It lists
the files in `replays/` and re-plays the chosen game with the current engine from the recorded seed, rules, seats and human
decisions, checking every event against the file in order. If anything differs, the viewer says the replay cannot be
reproduced exactly by this engine version and shows nothing further. Otherwise you can move by hand or by move, jump to
wins/draws, see every seat's hand, melds, kita and river at that moment, and see the CharacterAI decision entries that were
logged right before each move. Replay files are only read, never modified.

## Tests

```bash
npx tsc -p . --noEmit            # typecheck
npm test                         # full suite (vitest run) - takes about 8 minutes
npx vitest run tests/humanChi.test.ts     # a single file
npm run test:e2e                 # GUI smoke test in a headless browser (not part of npm test)
```

The GUI smoke test (`e2e/guiSmoke.e2e.ts`) only checks the core screen flow: lobby → mode → settings → start →
abandon, and game end (including a refresh) → "설정 바꾸기" → back to the mode choice. It needs a Chromium build for
Playwright once: `npx playwright install chromium`.

Coverage areas: scoring and yaku, calls and kan, riichi/furiten, abortive and exhaustive draws, round progression,
Mahjong Soul fidelity fixes (`tests/ff*.test.ts`), CharacterAI determinism, replay schema and invariants, human
decision paths (ron, chi, tsumo, nine-terminals, riichi waits), the GUI session/server (including refresh recovery),
and full human + AI games in both modes.

## Known limitations and future work

- **CustomAI** (1st version): the start screen can create, edit, duplicate and delete CustomAIs and seat them as
  opponents. A CustomAI is only a user-chosen set of the 15 common CharacterAI parameters (Korean-labelled 0-100 sliders)
  run by the existing CharacterAI; character-specific mechanics and import/export are not included. Files live in
  `custom-ai/` (one JSON per AI, named by an internal id). Games with a CustomAI store the exact profile used in that
  seat's replay metadata, so later edits or deletions never change how an old replay reproduces.
- No character voices or win cut-ins, no additional presentation options. Replays recorded by an older engine version
  usually cannot be reproduced by the viewer (it reports this instead of guessing).
- Opening a long replay in the viewer re-plays the whole game on the GUI server, which pauses that server (including a
  game in progress) for a few seconds.
- A refresh restores the current decision, hand-end and game-end screens; an AI-turn animation that was playing is not
  replayed.
- The GUI always seats the human at seat 0 (opponents are chosen on the start screen; the human's seat is not).
- Character portraits are not included yet. The start screen is text-only by design; `CHARACTER_PORTRAITS` in
  `src/gui/characterRoster.ts` is the optional slot for them.
- The CLI plays one hand per run.
- Rank/room/account progression scoring is out of scope.
