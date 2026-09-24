# Riichi Mahjong Simulation Engine

Deterministic riichi mahjong simulation engine with Mahjong Soul-inspired sanma and yonma
rulesets. Both formats support full games, including scoring, calls, riichi, kan, exhaustive
draws, round progression, CharacterAI play, and JSON replay output. The yonma ruleset also
includes the currently covered Mahjong Soul-style abortive draws.

Player-count, tile/wall layout, scoring totals, calls such as chi/kita, and round length are
selected through `RuleConfig`. The implementation targets the repository's covered Mahjong
Soul behavior; it does not claim complete parity with every live-service rule or option.

## Running

Requires [Node.js](https://nodejs.org/) (v20+).

```bash
npm install
npm test
npm run sim
```

`npm run sim` runs the sanma CharacterAI comparative simulation. By default it runs each
registered character solo (seat 0) against 2 neutral SimpleAI opponents. Options:

```bash
npm run sim -- --games 100          # override the games-per-character count (default: 50)
npm run sim -- --save-replays       # also save one JSON kifu per game to ./replays/
npm run sim -- --games 100 --save-replays
```

### Human play

Play a sanma game yourself (seat 0) against 2 CharacterAI opponents. You decide every
discard/riichi, pon, chi (yonma), daiminkan, ankan, kakan, kita, and each ron / pass (passing a valid ron
makes you furiten - temporary until your next draw, or for the rest of the hand in riichi).
Tsumo is offered too (declare or skip; AI seats still auto-declare).

**Browser GUI** (real mahjong tile art, click-to-discard):

```bash
npm run play:gui           # random seed
npm run play:gui my-seed   # fixed seed, for a reproducible hand
```

Then open the printed `http://localhost:3000` URL in a browser.

4-player (yonma) table: add `--mode yonma` (1 human + 3 CharacterAI, same GUI and session code):

```bash
npm run play:gui -- --mode yonma
npm run play:gui -- my-seed --mode yonma
```

In yonma you also get chi choices: the engine lists every legal sequence and the GUI/CLI show them to pick from (or pass).

**Terminal CLI** (text-based, same rules/decisions as the GUI):

```bash
npm run play                        # random seed, sanma
npm run play my-seed                # fixed seed
npm run play -- --mode yonma        # 4-player table (same engine/CLI, only the ruleset differs)
```

The GUI plays the whole game in one browser session ("다음 국 시작" between hands, final
standings at the end); the CLI plays one hand per run. Both share the same decision engine,
so anything legal in one is legal in the other.

### Saving replays of human games

Human+AI games can save the same replay JSON (schema v2) as the AI-only simulations - for the GUI, once the
game ends (the whole game), for the CLI, the single hand it plays:

```bash
npm run play:gui -- --save-replays                 # sanma
npm run play:gui -- my-seed --mode yonma --save-replays
npm run play -- --save-replays
```

Files go to `replays/<label>_game0.json` (label = `human-<mode>-<seed>`, or `human-cli-<mode>-<seed>` for the CLI).
Compared with an AI-only replay: `meta.seats[].kind` is `"human"` for the human seat (character identity stays separate),
and an optional `humanDecisions` array records each choice the human made (`type`, `choice`, `handIndex`, and
`atEventIndex`, the length of `events` when the decision was made). A browser refresh keeps recording; if the server
process dies mid-game the unfinished replay is not recovered. There is no replay viewer yet.

### Future work

- **CustomAI**: the `customAI` controller slot is reserved in `GameState` (`ControllerKind`) but not implemented -
  constructing a game with it throws. User-authored AI, its editor/settings UI, a replay viewer, extra presentation
  polish, and character voice/cut-ins are all future updates.

### 효과음

GUI 효과음은 타패, 북빼기, 퐁, 깡, 리치봉, 셔플 같은 물리음과 버튼/결과창 UI 소리만 쓴다. 사람이 말하는 선언 음성은 재생에 연결하지 않는다.

| 출처 | 라이선스 | 저장소 포함 |
|---|---|---|
| [T-STUDIO Mahjong Sound Pack](https://t-studio-tst.itch.io/free-sound-mahjong-sound-pack) | 상업 이용 가능, 2차 배포 금지 | **포함하지 않음** (`.gitignore`) |
| [OwlishMedia Sound Effects Pack (OpenGameArt)](https://opengameart.org/content/sound-effects-pack) | CC0 | 사용한 3개 파일만 포함 |

- T-STUDIO 파일은 직접 내려받아 `src/gui/public/assets/audio/tstudio/`에 배치해야 소리가 난다. 필요한 파일과 방법은 그 폴더의 `README.md`를 본다. 파일이 없어도 게임은 정상 동작한다.
- 출처 기록: `src/gui/public/assets/audio/README.md`, `.../ui/ATTRIBUTION.md`

### Direct 3-player CharacterAI battle

Seat any 3 characterIds at the same table against each other instead:

```bash
npm run sim -- --players seiyatosuke,kyletyler,seiyamouri --games 10
npm run sim -- --players jegalmina,jegalnahui,byeonari --games 20 --save-replays
```

Seat order follows input order (seat 0/1/2). An unregistered characterId prints an error
and exits. The same characterId may be listed more than once (each seat still gets its
own independently seeded CharacterAI instance) - duplicates are allowed rather than
rejected, since seat-level personality doesn't depend on the other seats' identities.

Registered characterIds: `jegalmina`, `jegalnahui`, `seiyamouri`, `seiyakouri`,
`kyletyler`, `seiyatosuke`, `toumesuashi`, `toumesuayo`, `byeonari`, `kangunsim`,
`kimwooju`, `ryumint`, `inan`, `effieminos`, `hwayoung`, `mageuna`, `magnum`,
`optima215`, `yuwen`, `josangmin`, `seiyahikudo`, `ryuheart` (legacy alias: `ryuhart`).

### Direct 4-player CharacterAI battle

Use the yonma ruleset by seating exactly 4 CharacterAI players. Seat order follows input
order (seat 0/1/2/3), and `--seed` makes the game and decision log reproducible.

```bash
npm run sim:yonma -- --players jegalmina,toumesuayo,byeonari,seiyakouri --seed yonma-qa-001
npm run sim:yonma -- --players jegalmina,toumesuayo,byeonari,seiyakouri --seed yonma-qa-001 --save-replays
```

Saved sanma and yonma replays include the rule configuration, game events, final result,
and CharacterAI decision diagnostics. Deterministic replay QA checks rule invariants without
requiring whole-action-array snapshots. Each completed `hand_end` also carries an additive
result snapshot containing the scoring interpretation actually used (including the selected
winning tile), applied point deltas, draw/tenpai details, and dealer/honba/kyotaku progression.
This makes seeded results auditable without rerunning the hand.
