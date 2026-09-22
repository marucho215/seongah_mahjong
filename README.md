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
