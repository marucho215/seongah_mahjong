# Seongah Mahjong — 인수인계 (v1.0.0)

최종 갱신: v1.0.0 마감 시점. README는 사용자/실행 안내, 이 문서는 개발자와 다음 세션을 위한 구조·상태 설명이다.

## 1. 현재 상태 (1.0)

- 엔진: Mahjong Soul 계열 **산마/4마** deterministic 시뮬레이션. `playHand()` / `playGame()` 완주, scoring, 후로,
  리치, 깡, 유국(유국만관 포함), 국 진행, CharacterAI(산마/4마), 결정적 replay와 AI decision trace.
- Final Audit FF-01~FF-17 반영 완료 (§6).
- **사람 1명 + AI 플레이**: GUI(`npm run play:gui [-- --mode yonma]`)와 CLI(`npm run play [-- --mode yonma]`).
  사람이 고를 수 있는 모든 선택이 human decision 경로를 가진다: discard/riichi, pon, chi(4마), daiminkan, ankan, kakan,
  kita, ron/pass, tsumo/decline, 구종구패.
- **Replay**: AI-only와 사람+AI 모두 같은 schema v2 (`humanDecisions`는 선택 필드). GUI는 `--save-replays`로 게임
  종료 시 저장.
- 마지막 전체 회귀: 72 files / 694 tests 통과, `tsc -p . --noEmit` clean (숫자는 계속 변하므로 새 기준은 새 실행으로
  확인할 것). 전체 스위트는 약 15~17분 걸린다.
- 체크포인트 태그: `human-play-*` 중간 태그들과 `human-play-complete-v1`, 최종 `v1.0.0`.

## 2. 중요한 설계 결정

- **controller와 character identity 분리**: `GameState.controllers`(`simpleAI|characterAI|human|customAI`)가 "누가 결정하는가",
  `characterProfiles`가 "이 좌석이 누구인가(표시 이름/성향)". human 좌석도 프로필을 가질 수 있다.
- **human decision은 generator/session 경로**: `GameState.playHandInteractive()`가 사람 좌석에서만 `DecisionRequest`를
  `yield`하고 `DecisionResponse`를 받는다 (`src/core/decisions.ts`). 사람이 없는 게임은 절대 yield하지 않으며
  (`playHand()`가 사람이 있으면 throw), AI 경로의 RNG 호출 횟수·순서와 이벤트 순서는 바이트 단위로 보존된다.
  변경 시에는 AI-only 게임의 log/score/AI decision log를 이전 커밋과 JSON 비교하는 parity 확인을 한다.
- **generator는 예외가 나면 되살릴 수 없다**: 그래서 응답 검증은 generator에 넣기 전에 `GuiSession`(`validateResponse`)에서
  하고, 엔진 예외가 나면 세션을 중단 상태로 표시한다. 잘못된 GUI 응답이 진행 중인 국을 망가뜨리면 안 된다.
- **UI는 마작 legality를 계산하지 않는다**: 후보(치 조합, 리치 가능한 패, 대기패, 론/쯔모 점수 preview)는 모두 엔진이
  request/view에 담아 주고, CLI/GUI는 표시하고 선택만 한다.
- **PlayerView로 숨은 정보 차단** (`src/core/playerView.ts`): 요청에 실리는 view에는 그 좌석의 손패만 있고 상대는
  `concealedCount`(개수)만 있다. 대기패 장수(`WaitInfo.unseenCount`)는 view에 든 공개 정보만으로 `4 - 보이는 장수`를 센다
  (패산/상대 손패 미사용). view에 새 필드를 추가할 때는 상대 정보가 새지 않는지 테스트(`tests/riichiWaits.test.ts`,
  `tests/humanPlay.test.ts`)로 고정한다.
- **presentation은 엔진 결과와 분리**: `GameState.frameObserver`는 표시 전용 콜백(타패/울기/리치/화료 시점의 view)이고,
  게임 진행·로그·결과에 영향이 없다. 서버(`createGuiServer`)가 장면을 시간 간격으로 재생하고, 효과음은 `game.log`를 공개
  정보만 담은 `AudioCue`로 바꿔 보낸다(`src/gui/audioCues.ts`, 재접속 시 과거 소리를 재생하지 않는다).
- **Replay는 기존 pipeline 재사용**: `src/sim/replayRecorder.ts`(`buildGameReplayRecord`, `writeGameReplay`,
  `replaySeatsFromGame`). 사람 결정은 `GameState.humanDecisionLog`(`src/core/humanDecisionLog.ts`)에 GuiSession/CLI 드라이버가
  기록하고, 사람이 있을 때만 `humanDecisions`로 나간다. AI-only replay는 바이트 그대로다.

## 3. 주요 구조

### Ruleset과 진행 (엔진)

- `src/rules/RuleConfig.ts`(정책, `DEFAULT_SANMA_RULES`, `MAJSOUL_YONMA_RULES`), `src/rules/RuleSet.ts`(산마/4마 구조 차이)
- `src/core/seats.ts`(player-count 독립 seat/순서), `src/core/roundProgression.ts`(친/국/본장/종료 판단의 순수 경계)
- `src/rules/settlement.ts`(멀티 론, 유국, 유국만관 정산), `src/rules/pao.ts`, `src/rules/kuikae.ts`
- `src/core/GameState.ts`: hand/game orchestration과 event 기록. human 결정은 `decideX` generator wrapper들.

### 후로와 깡

- `src/core/discardResponses.ts`(chi/pon/daiminkan/ron 후보와 우선순위 중재), `src/core/applyDiscardResponse.ts`,
  `src/actions/calls.ts`, `src/actions/riichiAnkan.ts`, `src/actions/kokushiAnkan.ts`, `src/core/Wall.ts`
- 4마 후로 경로는 `GameState.offerCallsForDiscard`의 4마 분기. 사람의 chi는 중재를 통과한 후보만
  `ChiDecisionRequest.options`로 제시한다.

### Scoring과 yaku

- `src/yaku/evaluate.ts`, `src/yaku/winContext.ts`, `src/yaku/score.ts`, `src/actions/winSearch.ts`(대기패 계산),
  `src/shanten/`

### CharacterAI와 관측성

- `src/ai/characterAI.ts`, `src/ai/chiDecision.ts`, `src/ai/decisionTraceFactory.ts`, `src/ai/visibleTiles.ts`
- `src/core/GameLog.ts`: replay event와 auditable `hand_end.result` schema
- `src/validation/`: replay/event invariant 검증(테스트와 `npm run validate`가 공유), `tests/helpers/replayQa.ts`는 재수출

### 사람 플레이 (CLI/GUI)

- `src/core/decisions.ts`: Request/Response 타입 전부 (`discard`, `call_pon|call_daiminkan|ankan|kakan|kita`, `ron`, `tsumo`,
  `chi`, `nine_terminals`)
- `src/gui/gameSetup.ts`: `--mode`/`--save-replays` 인자 해석과 게임 생성 (GUI 서버와 CLI 공용). 산마/4마는 여기서 규칙과
  좌석 구성만 다르다. 시작 화면이 보내는 구성(`parseGuiGameConfig`: 모드, 상대 characterId, 시드, 리플레이 저장)도 여기서 검증한다.
- `src/gui/characterRoster.ts`: 시작 화면용 캐릭터 목록. `CharacterProfile`에서는 이름만 읽고, 화면 전용 정보(플레이 경향 한 줄과
  태그 2~4개 `CHARACTER_PRESENTATION`, 선택 필드 `CHARACTER_PORTRAITS`)는 여기 둔다. 내부 튜닝 수치와 archetype 식별자는
  클라이언트로 보내지 않는다. 문구는 AI 로직과 AI끼리 둔 대국에서 관찰된 경향이 함께 뒷받침하는 내용만 적었으므로,
  CharacterAI 수치를 바꾸면 문구도 다시 확인한다. 초상화는 아직 없고, 시작 화면은 텍스트만으로 완성된
  형태다(임시 아바타나 빈 이미지 영역을 만들지 않는다). 초상화가 생기면 여기에 등록하고 그때 카드 레이아웃을 확장한다.
- `src/gui/guiSession.ts`: 여러 국을 한 `GameState`로 잇는 세션(`decision|hand_end|game_end`), 응답 사전 검증
- `src/gui/createGuiServer.ts`, `src/gui/server.ts`: HTTP + SSE 서버. `/events`(상태 스트림), `POST /respond`, `POST /continue`.
  접속 시 현재 요청을 그대로 다시 보내므로 새로고침 복구가 된다. 장면 재생 중에는 응답을 받지 않는다.
  `createGuiServer(game)`은 게임 하나에 묶인 서버(테스트용), `createGuiLobbyServer()`는 `npm run play:gui`가 쓰는 시작 화면 서버다:
  `setup` 메시지 → `POST /start`(구성) → 게임 → game_end에서 `POST /setup`으로 시작 화면 복귀. 게임마다 GameHost를 새로 만든다.
- `src/gui/public/`: 바닐라 JS 클라이언트 (`app.js`, `audioManager.js`, `style.css`, `index.html`). 4-position 작탁 하나로
  산마/4마를 함께 그린다(좌석 번호 하드코딩 없이 내 좌석 기준 상대 위치). 개발 중 프런트 파일은 `Cache-Control: no-store`.
- `src/cli/humanPlayDriver.ts`(요청별 입력 처리), `src/cli/humanPlayCli.ts`(진입점, 한 국만 진행)

## 4. 테스트 체계

- 전체: `npm test`(vitest). 타입: `npx tsc -p . --noEmit`.
- 엔진 규칙: fidelity별 `tests/ff*.test.ts`, phase별 회귀, 정산/진행 테스트. 직접 fixture/pure helper를 seed 탐색보다 선호.
- 사람 결정: `tests/ronDecision.test.ts`, `humanChi.test.ts`, `tsumoDecision.test.ts`, `nineTerminals.test.ts`,
  `riichiWaits.test.ts`, `humanPlay.test.ts`. 고정 패 시나리오는 `tests/helpers/ronFixture.ts`(`RonFixture`: 손패, 일반 draw,
  영상패, 북 대체 패, 퐁 멜드 순서를 고정)와 `tests/helpers/yonmaHuman.ts`.
- GUI/세션: `guiSession.test.ts`, `guiServer.test.ts`(HTTP/SSE, 재접속, 장면 재생), `audioCues.test.ts`,
  `yonmaHumanGame.test.ts`(4마 한 게임 완주).
- Replay: `replaySchemaV2.test.ts`, `phaseD-yonma-replay-qa.test.ts`, `humanReplay.test.ts`(산마/4마 사람 대국 저장과 검증기 통과).
- 사람 대국 테스트는 CharacterAI 게임을 여러 번 돌려 느리다. 새 시나리오는 seed 탐색 대신 고정 시드/fixture를 쓸 것.

## 5. 작업 원칙

- 한 번에 하나의 규칙/finding/기능만 수정한다.
- Mahjong Soul 특화 동작은 일반 리치마작 상식으로 추정하지 않고 자료를 재확인한다.
- production 변경은 deterministic 테스트로 고정한다. 산마 동작을 보존하며 4마를 고치고, 반대도 확인한다.
- CharacterAI 파라미터 조정과 규칙 수정은 분리한다.
- RNG 호출 횟수·순서, replay event 순서, AI decision ordering을 불필요하게 바꾸지 않는다.
- commit/push는 사용자의 명시적 요청이 있을 때만 한다. 기존 중간 태그를 지우거나 옮기지 않는다.
- Windows/PowerShell 환경: 명령은 `npm.cmd`/`node_modules\.bin\*.cmd`를 쓸 수 있다.

## 6. Fidelity Fix 요약

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

## 7. 특히 주의할 경계

- **FF-13/FF-14**: `FullWinResult`는 scorer가 실제 사용한 `winningTile`과 `WinContext`를 보존한다. Tenhou initial-14만
  `evaluateInitialDealerWin()`이 후보를 비교한다. `hand_end.result`는 additive optional schema이므로 기존 필드를
  제거하거나 의미를 바꾸지 말 것. AI trace와 rules result log는 별도 계층이다.
- **FF-16**: Daiminkan replacement tile은 이미 caller hand에 들어간 상태로 기존 post-draw loop에 합류한다. 다시
  `addDrawn()`하면 tile duplication이 생긴다.
- **FF-17**: called-away discard는 강에서 삭제하지 않는다(후리텐/replay에 필요). `collectVisibleTileKinds()`와 대기 장수
  계산(`unseenCountOf`, view의 `discards`는 called-away 제외)이 각자 중복 없이 센다.
- **쯔모/론 넘기기와 후리텐**: 론을 놓친 것만 `FuritenTracker.onMissedRonChance()`로 후리텐을 만든다. 사람이 쯔모를 넘기는
  것은 후리텐과 무관하다(테스트로 고정).
- 4마 human 경로: 사람의 pon/daiminkan/chi와 후로 뒤 버림은 `offerCallsForDiscard` 4마 분기에서 human일 때만 yield하고,
  AI 좌석은 기존 호출(예: `chooseDiscardFor` 한 번, 리치 판단 없음)을 그대로 유지한다.

## 8. 의도적으로 분리하거나 보존한 사항

- Chiitoitsu + Chankan은 물리적으로 양립하지 않으므로 추가하지 않았다.
- Multi-ron honba/kyotaku closest-winner 정책은 Mahjong Soul 동작에 맞춰 유지했다.
- Kita는 kan이 아니므로 kan count/pending kandora를 새로 만들지 않는다.
- Nagashi는 정상 exhaustive draw에서만 판정하며 ordinary noten payment를 대체한다.
- Pao는 Daisangen/Daisuushii의 해당 yakuman portion에만 적용한다.
- Rank/room/account progression 점수는 구현 범위가 아니다.
- CharacterAI 캐릭터별 수치는 fidelity fix 과정에서 조정하지 않았다.

## 9. 알려진 제한

- **CustomAI는 미구현**: `ControllerKind`의 `"customAI"`는 예약 슬롯일 뿐이고, 이 값으로 `GameState`를 만들면 생성자가
  throw한다 (`GameState: controller kind "customAI" is not implemented yet`).
- replay viewer/timeline 없음. GUI는 게임이 끝날 때 한 번만 replay를 저장하며, 서버가 게임 도중 죽으면 복구하지 않는다.
- GUI는 사람을 seat 0에 앉힌다. 상대는 시작 화면에서 고르며 기본값은 산마: 제갈 미나·제갈 나희, 4마: +변아리. 사람 좌석 선택은 없다.
- CLI는 한 국만 진행한다.
- 전체 회귀가 약 15~17분이라, 작업 중에는 관련 파일만 돌리고 안정된 시점에만 전체를 돌린다.
- 루트의 `*-full-regression.log`, `validation-phaseC-partial-baseline.md`는 과거 검증 기록이다. 새 기준 로그는 덮어쓰지 말고
  새 이름으로 남길 것.

## 10. 1.0 이후 후보 (우선순위 없음)

CustomAI 구현과 설정/편집 UI, replay viewer(재생/timeline/seek), 캐릭터 보이스와 화료 컷인, 캐릭터 초상화, 사람 좌석
선택, 추가 presentation 옵션과 UI polish, 추가 효과음, 새로운 마작 룰, 5000판급 장기 자체 대국 검증(Phase C 기준선 참고).

## 11. 다음 작업자 체크리스트

1. 이 문서, `README.md`, 관련 finding/기능 전용 테스트를 먼저 읽는다.
2. `git status`/`git log`로 현재 상태를 확인한다 (1.0 시점에 추적 파일은 clean).
3. 요청 범위를 한 기능으로 제한하고, 사람이 없는 게임의 동작이 바뀌지 않는지(parity) 확인한다.
4. pure fixture를 먼저 추가하고 관련 테스트 → `tsc --noEmit` → 안정된 시점에 전체 회귀 순으로 진행한다.
5. 사용자의 명시적 요청 전에는 commit/push하지 않는다.
