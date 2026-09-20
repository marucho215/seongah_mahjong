# sanma-riichi-engine

3-player (sanma) riichi mahjong simulation engine, targeting Mahjong Soul ranked sanma rules.

## Running

Requires [Node.js](https://nodejs.org/) (v20+).

```bash
npm install
npm test
npm run sim
```

`npm run sim` runs the CharacterAI comparative simulation. By default it runs each of
the 9 characters solo (seat 0) against 2 neutral SimpleAI opponents. Options:

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
`kyletyler`, `seiyatosuke`, `toumesuashi`, `toumesuayo`, `byeonari`.
