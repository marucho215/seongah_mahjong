# Seongah Mahjong Engine — 인수인계

최종 갱신: 2026-09-22  
작업 디렉터리: `C:\Users\mango\Documents\seongah-majak`

## 1. 현재 기준점

Mahjong Soul 계열 sanma/yonma deterministic simulation engine의 주요 구현과 fidelity
감사가 완료된 상태다.

- Sanma와 Yonma 모두 `playHand()` / `playGame()` 완주 가능
- CharacterAI 4인 대응 완료
- scoring, calls, riichi, kan, exhaustive/abortive draw, round progression 구현
- deterministic replay 및 AI decision trace 지원
- Final Audit finding FF-01~FF-17 반영 완료
- 마지막 full regression: **55 files / 507 tests 전체 통과**
- 마지막 full regression 로그: `post-ff17-full-regression.log`
- FF-17 반영 후 `tsc -p . --noEmit` 통과

현재 상태를 v1 기능 기준점으로 볼 수 있다. 새로운 규칙이나 AI 튜닝을 시작하기 전에
아래 테스트 명령으로 기준점이 유지되는지 확인할 것.

## 2. 중요한 작업 원칙

- 한 번에 하나의 규칙/finding만 수정한다.
- Mahjong Soul 특화 동작은 일반 리치마작 상식으로 추정하지 않고 자료를 재확인한다.
- production 변경은 deterministic regression test로 고정한다.
- sanma 동작을 보존하면서 yonma를 수정하고, 반대 경우도 동일하게 확인한다.
- CharacterAI 파라미터 조정과 규칙 수정은 분리한다.
- RNG 호출 횟수·순서, replay event 순서, AI decision ordering을 불필요하게 바꾸지 않는다.
- seed-discovery 테스트보다 직접 fixture/pure helper 테스트를 선호한다.
- 기존 worktree는 대규모 미커밋 변경 상태다. 다른 작업자의 변경을 reset/checkout하지 말 것.
- commit/push는 사용자의 명시적 요청 전에는 하지 않는다.

## 3. 주요 구조

### Ruleset과 진행

- `src/rules/RuleConfig.ts`: 게임 정책과 기본 Mahjong Soul config
- `src/rules/RuleSet.ts`: sanma/yonma 구조 차이
- `src/core/seats.ts`: player-count 독립 seat/turn-order helper
- `src/core/roundProgression.ts`: 다음 dealer/round/honba/game-end 판단의 순수 경계
- `src/rules/settlement.ts`: multi-ron, exhaustive draw, Nagashi 등 settlement helper
- `src/core/GameState.ts`: 실제 hand/game orchestration 및 event 기록

### Calls와 kan

- `src/core/discardResponses.ts`: chi/pon/daiminkan/ron candidate 및 arbitration
- `src/core/applyDiscardResponse.ts`: 선택된 non-winning call 적용
- `src/actions/calls.ts`: meld mutation
- `src/actions/riichiAnkan.ts`: 리치 후 합법 안깡 판정
- `src/actions/kokushiAnkan.ts`: 국사 안깡 창깡 경계
- `src/core/Wall.ts`: live/dead wall, replacement, kan count와 공개 kandora 상태

### Scoring과 yaku

- `src/yaku/evaluate.ts`: standard/chiitoi/kokushi 평가와 FF-13 initial-14 해석
- `src/yaku/winContext.ts`: GameState에서 scorer로 전달하는 context 생성
- `src/yaku/score.ts`: sanma/yonma ron/tsumo payment
- `src/rules/pao.ts`: Daisangen/Daisuushii Pao trigger 및 payment redistribution

### CharacterAI와 관측성

- `src/ai/characterAI.ts`: CharacterAI 판단
- `src/ai/chiDecision.ts`: chi 평가
- `src/ai/decisionTraceFactory.ts`: JSON-safe AI trace factory
- `src/ai/visibleTiles.ts`: called-away river tile을 중복하지 않는 공개패 집계
- `src/core/GameLog.ts`: replay event와 auditable `hand_end.result` schema
- `src/sim/replayRecorder.ts`: `--save-replays` JSON 저장
- `tests/helpers/replayQa.ts`: production과 분리된 replay invariant checker

## 4. 완료된 개발 단계

- Phase 7C: yonma ruleset, 4 seats, 136 tiles, 14-tile dead wall
- Phase 7D: chi/call candidate/arbitration/multi-ron ordering
- Phase 7E-1: chi/pon/daiminkan state application
- Phase 7E-2: yonma scoring, exhaustive draw, progression, full game loop
- Phase 7F: CharacterAI yonma, chi/defense/opponent context
- Phase A: yonma yaku coverage audit
- Phase B: abortive draws
- Phase C: call observability
- Phase D: deterministic replay QA
- Phase E: stale documentation cleanup
- Phase F1: WinContext extraction
- Phase F2: AI decision trace factory extraction
- Phase F3: pure round-progression calculation

## 5. Fidelity Fix 요약

| Fix | 내용 | 대표 테스트 |
|---|---|---|
| FF-01 | Yonma chi 직후 kuikae legality | `tests/ff01-kuikae.test.ts` |
| FF-02 | Kita replacement Chiitoitsu Rinshan | `tests/ff02-chiitoitsu-rinshan.test.ts` |
| FF-03 | Mahjong Soul식 리치 후 안깡 | `tests/ff03-riichi-ankan.test.ts` |
| FF-04 | Kokushi의 ankan rob | `tests/ff04-kokushi-ankan-rob.test.ts` |
| FF-05 | kan 종류별 kandora/kan-ura 공개 시점 | `tests/ff05-kandora-timing.test.ts` |
| FF-06 | 비리치 Kita/pass 선택권 | `tests/ff06-kita-choice.test.ts` |
| FF-07 | just-drawn North의 post-riichi Kita | `tests/ff07-riichi-kita.test.ts` |
| FF-08 | Sanma Kyuushu Kyuuhai/Suukaikan | `tests/ff08-sanma-abortive-draw.test.ts` |
| FF-09 | Sanma agari-yame/tenpai-yame | `tests/ff09-sanma-dealer-yame.test.ts` |
| FF-10 | Nagashi Mangan | `tests/ff10-nagashi-mangan.test.ts` |
| FF-11 | Daisangen/Daisuushii Pao | `tests/ff11-pao.test.ts` |
| FF-12 | target/return 분리 및 최종 uma standings | `tests/ff12-final-standings.test.ts` |
| FF-13 | Tenhou initial-14 최상 scoring interpretation | `tests/ff13-tenhou-initial-interpretation.test.ts` |
| FF-14 | auditable hand-result replay logging | `tests/ff14-replay-observability.test.ts` |
| FF-15 | Kokushi + Chiihou 복합 역만 | `tests/ff15-kokushi-chiihou.test.ts` |
| FF-16 | Daiminkan rinshan 이후 정상 자기 행동 window | `tests/ff16-daiminkan-post-rinshan.test.ts` |
| FF-17 | called-away visible tile 중복 제거 | `tests/ff17-visible-tile-dedup.test.ts` |

## 6. 최근 변경에서 특히 주의할 경계

### FF-13 / FF-14

`FullWinResult`는 scorer가 실제 사용한 `winningTile`과 `WinContext`를 보존한다.
Tenhou initial-14만 `evaluateInitialDealerWin()`이 가능한 화료패 후보를 비교한다. 일반
ron/tsumo는 실제 화료패가 고정되며 재해석하면 안 된다.

`hand_end.result`는 additive optional schema다. 기존 `hand_end` 필드를 제거하거나 의미를
바꾸지 말 것. AI trace와 rules result log는 별도 계층이다.

### FF-16

Daiminkan replacement tile은 이미 caller hand에 들어간 상태로 기존 post-draw action loop에
합류한다. 다시 `addDrawn()`하면 tile duplication이 생긴다. 가능한 후속 행동은 현재
engine이 지원하는 tsumo/Kita/shouminkan/ankan/discard다.

Open/added-kan rinshan에서 Kita로 이어질 경우 이전 pending kandora는 Kita replacement
scoring 전에 공개된다.

### FF-17

Called-away discard는 강에서 삭제하지 않는다. 후리텐과 replay history에 필요하다.
오직 `collectVisibleTileKinds()`가 `calledAway` river entry를 제외하며, 해당 physical tile은
caller meld에서 계산한다.

## 7. 의도적으로 분리하거나 보존한 사항

- Chiitoitsu + Chankan은 물리적으로 양립하지 않으므로 추가하지 않았다.
- Multi-ron honba/kyotaku closest-winner 정책은 Mahjong Soul 동작에 맞춰 유지했다.
- Kita는 kan이 아니므로 kan count/pending kandora를 새로 만들지 않는다.
- Nagashi는 정상 exhaustive draw에서만 판정하며 ordinary noten payment를 대체한다.
- Pao는 Daisangen/Daisuushii의 해당 yakuman portion에만 적용한다.
- Rank/room/account progression 점수는 구현 범위가 아니다.
- CharacterAI 캐릭터별 수치는 fidelity fix 과정에서 조정하지 않았다.

## 8. 실행 명령

### 전체 회귀 및 로그 저장

```powershell
& ".\node_modules\.bin\vitest.cmd" run 2>&1 | Tee-Object -FilePath ".\full-regression.log"
$vitestExitCode = $LASTEXITCODE
Write-Host "Vitest exit code: $vitestExitCode"
exit $vitestExitCode
```

### 타입 검사

```powershell
& ".\node_modules\.bin\tsc.cmd" -p . --noEmit
```

### Yonma CharacterAI CLI와 replay 저장

```powershell
npm.cmd run sim:yonma -- --players jegalmina,toumesuayo,byeonari,seiyakouri --seed yonma-qa-001 --save-replays
```

### Sanma replay 저장

```powershell
npm.cmd run sim -- --players seiyatosuke,kyletyler,seiyamouri --games 1 --save-replays
```

## 9. 마지막 검증 결과

`post-ff17-full-regression.log` 기준:

```text
Test Files  55 passed (55)
Tests       507 passed (507)
Duration    879.63s
```

사용자가 직접 ALL GREEN을 확인했다. 이후 새 변경이 들어가면 이 결과를 새 기준 로그로
덮어쓰지 말고 별도 이름의 로그를 남기는 편이 좋다.

## 10. 다음 작업자 체크리스트

1. 이 문서와 `README.md`, 관련 finding 전용 테스트를 먼저 읽는다.
2. `git status`에서 기존 대규모 변경을 사용자 소유 상태로 취급한다.
3. 새 요청의 범위를 한 finding/기능으로 제한한다.
4. Mahjong Soul 특화 규칙은 구현 전에 source를 재검증한다.
5. pure fixture를 먼저 추가하고 관련 targeted regression을 실행한다.
6. `tsc --noEmit`을 실행한다.
7. 안정적인 checkpoint에서만 full regression을 실행하고 로그를 보존한다.
8. 사용자의 명시적 요청 전에는 commit/push하지 않는다.

