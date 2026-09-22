# Phase C — Partial Baseline (intentionally interrupted)

**Status: NOT a completed Phase C run.** This run was intentionally stopped before
reaching its planned game count to start Replay Schema v2 development. Do not treat
the numbers below as a final Phase C verdict.

## Run configuration
- Command: `npx tsx src/sim/validationHarness.ts --games 5000 --seed phaseC --save-failures`
- Format: `sanma`
- Master seed: `"phaseC"`
- Log: [phaseC-validation.log](phaseC-validation.log) (raw tee output, preserved as-is)
- Git HEAD at run start/interruption: `b58d543d762676ff9436dfd8cdf1abf3dff9fcbf` (2026-09-22 07:14:28 +0900)
- Working tree: same uncommitted changes as before this run (yonma CLI fixes +
  validation harness sources); no files were modified or deleted as part of this
  interruption.

## Result summary

| Field | Value |
|---|---|
| Planned games | 5000 |
| Completed games (confirmed via checkpoint log) | 2000 |
| Elapsed at last checkpoint | 14,720,148 ms (~4h 5m) |
| Validation failures | 0 |
| Runtime exceptions / crashes | 0 |
| Warnings / anomalies | none observed |
| Failure artifacts under `validation-failures/` | none (directory was never created — 0 failures to save) |

Checkpoints observed (progress line printed every 10% = every 500 games):

```
...500/5000 (3897849ms elapsed)
...1000/5000 (7629337ms elapsed)
...1500/5000 (11057324ms elapsed)
...2000/5000 (14720148ms elapsed)
```

The process was stopped between the 2000 and 2500 checkpoints, so 2000 is the last
*confirmed* completed-game count. Some additional games beyond 2000 were likely
in-flight/partially processed at kill time, but since only fully-completed games
increment the counter and no output confirms a count beyond 2000, this baseline
conservatively reports 2000 as `completed`.

Per-game rate stayed consistent with Phase B (~7.4s/game here vs. ~7.8s/game in
Phase B), so there is no indication of a slowdown or stall — the run was healthy
when stopped.

## Disposition
```
Phase C partial baseline
- planned: 5000 games
- completed: 2000 games (confirmed checkpoints only)
- validation failures: 0
- runtime errors: 0
- interrupted intentionally for Replay Schema v2 development
```

This run is **not** counted as Phase C's completion. A fresh Phase C (5000 games)
will be re-run after Replay Schema v2 lands, per the post-implementation verification
plan (full regression → typecheck → targeted DoraBreakdown tests → known-seed replay
regression → 100–500 game self-play → validation clean check → new Phase C 5000-game
run).

All previously generated replay/result files (`replays/*.json`, `phaseA-validation.log`,
`phaseB-validation.log`, `phaseC-validation.log`) are preserved untouched.
