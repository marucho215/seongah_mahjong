# Seongah Mahjong — 인수인계 (v1.1.0)

최종 갱신: v1.1.0 마감 시점. README는 사용자/실행 안내, 이 문서는 개발자와 다음 세션을 위한 구조·상태 설명이다.

## 1. 현재 상태 (1.1)

- 엔진: Mahjong Soul 계열 **산마/4마** deterministic 시뮬레이션. `playHand()` / `playGame()` 완주, scoring, 후로,
  리치, 깡, 유국(유국만관 포함), 국 진행, CharacterAI(산마/4마), 결정적 replay와 AI decision trace.
- Final Audit FF-01~FF-17 반영 완료 (§6).
- **사람 1명 + AI 플레이**: GUI(`npm run play:gui [-- --mode yonma]`)와 CLI(`npm run play [-- --mode yonma]`).
  사람이 고를 수 있는 모든 선택이 human decision 경로를 가진다: discard/riichi, pon, chi(4마), daiminkan, ankan, kakan,
  kita, ron/pass, tsumo/decline, 구종구패.
- **Replay**: AI-only와 사람+AI 모두 같은 schema v2 (`humanDecisions`, CustomAI 좌석의 `customProfile`은 선택 필드).
  GUI는 설정 화면의 "리플레이 저장"(또는 `--save-replays`)으로 게임 종료 시 저장하며, 중단한 대국은 저장하지 않는다.
- **GUI 흐름 (1.1)**: 로비(대국 방식 선택 → 같은 화면의 좌석/CustomAI/시드/리플레이 설정) → 대국(AI 진행 속도, 자동 쯔모기리/
  울기 패스/자동 화료, 샹텐·텐파이 대기 표시, 대국 그만두기) → 국 결과(손패/도라 내역/판·부·등급/점수 이동) → 최종 결과(엔진 순위,
  같은 설정/같은 시드로 다시, 설정 바꾸기). 리플레이 뷰어(`/replay.html`), CustomAI 편집기. 변경 내역은 `RELEASE_NOTES.md`.
- 마지막 전체 회귀: 81 files / 737 tests 통과, `tsc -p . --noEmit` clean (숫자는 계속 변하므로 새 기준은 새 실행으로
  확인할 것). 전체 스위트는 약 8분 걸린다. GUI 스모크(`npm run test:e2e`) 2 tests 통과.
- 체크포인트 태그: `human-play-*` 중간 태그들과 `human-play-complete-v1`, `v1.0.0`, 최종 `v1.1.0`.

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
  `tests/humanPlay.test.ts`)로 고정한다. `view.waits`는 "리치 중 대기"이고, 리치 여부와 무관한 현재 손 상태는 별도 필드
  `view.handStatus`(`shanten`: 엔진 minShanten, `tenpaiWaits`: 엔진 대기 캐시 + 같은 공개 정보 기준 장수)에 담는다
  (`tests/handStatus.test.ts`). GUI는 이 값을 표시만 하며, 유효패/추천 타패/위험패는 아직 없다.
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

### CustomAI

- 사용자가 정한 파라미터 세트를 기존 CharacterAI에 넘기는 기능이다. 판단 로직은 characterAI와 같고, 좌석 종류만 `customAI`로
  구분한다(`GameState`는 customAI 좌석에도 프로필을 요구하고 같은 CharacterAI 인스턴스를 만든다 - `tests/customAi.test.ts`가
  같은 프로필이면 두 좌석 종류의 로그/AI 판단이 같음을 고정).
- `src/customai/customAiSchema.ts`: 저장 형식(`formatVersion: 1`, 내부 id `c-<12 hex>`, 표시 이름, `style` 15개 0~100 정수)과
  항목별 한국어 이름/설명/초기값/내부값 변환(`toInternal`). 안전 범위는 CharacterAI 코드 기준: 성향·접기 기준·실력·변동성·실수율
  0~1, 후보 허용 폭 0.05~0.25(코드의 0.05 하한, 실수로 넓힌 범위가 샹텐 한 단계를 넘지 않는 상한). 초기값은 성향 50, 품질 계열은
  등록 캐릭터 중앙값에 가까운 값이며 고정값이 아니다. 보정/정규화 없음, 충돌 조합은 안내(`customAiNotices`)만.
- `src/customai/customAiStore.ts`: `custom-ai/<id>.json` 저장소(생성/수정/복제/삭제, 쓰기/읽기 모두 같은 검증, 잘못된 파일은
  목록에 이유만). 서버 API `/api/custom-ai`(GET 목록+스키마, POST 생성, PUT 수정, POST `<id>/duplicate`, DELETE). 대국 상대 id는
  `custom:<id>`이며 게임 시작 순간의 프로필이 그 대국의 스냅샷이다.
- 리플레이: customAI 좌석의 `meta.seats[].customProfile`에만 실제 사용한 프로필 전체를 저장하고(Schema v2의 선택 필드), 재현은 이
  스냅샷만 쓴다(`custom-ai/`를 읽지 않음). CustomAI가 없는 리플레이의 바이트는 그대로다(`tests/replayParity.test.ts`).

### 리플레이 뷰어

- `src/replay/replayReproduction.ts`: 리플레이의 시드/규칙/좌석/사람 결정으로 현재 엔진에서 대국을 다시 진행하며(재시뮬레이션),
  이벤트가 로그에 추가될 때마다 원본의 같은 위치와 비교하고 표시용 상태(모든 좌석 손패/멘츠/강/북, 도라 표시패, 점수)를
  복사한다. 한 곳이라도 다르거나 끝의 이벤트 수/AI 판단/사람 결정 기록이 다르면 `ok:false`(재현 불가)이며 상태를 만들지 않는다.
  관찰은 재현용 인스턴스의 `log.push`와 엔진의 표시 전용 접근자 `GameState.observeCurrentHands()`만 쓴다. AI 판단은 "이 이벤트
  직전에 새로 기록된 판단"만 붙인다. 원본 파일은 읽기만 한다. 관찰 기능 추가 전후 리플레이 바이트 동일성은
  `tests/replayParity.test.ts`(고정 해시)가 지킨다.
- 서버: `GET /api/replays`(목록), `GET /api/replays/<파일>`(재현 결과, 파일별 캐시). 화면: `src/gui/public/replay.html`, `replay.js`.
- 향후 replay schema 개선 후보 (이번에는 확장하지 않음): 치 이벤트의 멘츠 구성 패(지금은 울은 패 종류만 있음), 배패/쯔모의 적5
  정보(지금은 종류만 있음), AI 판단 기록과 이벤트의 직접 연결 필드(지금은 handIndex/player만 있음). 이것들이 있으면 재시뮬레이션
  없이도(또는 엔진이 바뀐 뒤의 옛 기록도) 복원할 수 있다.

### 사람 플레이 (CLI/GUI)

- `src/core/decisions.ts`: Request/Response 타입 전부 (`discard`, `call_pon|call_daiminkan|ankan|kakan|kita`, `ron`, `tsumo`,
  `chi`, `nine_terminals`)
- `src/gui/gameSetup.ts`: `--mode`/`--save-replays` 인자 해석과 게임 생성 (GUI 서버와 CLI 공용). 산마/4마는 여기서 규칙과
  좌석 구성만 다르다. 시작 화면이 보내는 구성(`parseGuiGameConfig`: 모드, 상대 characterId, 시드, 리플레이 저장)도 여기서 검증한다.
- `src/gui/characterRoster.ts`: 시작 화면용 캐릭터 목록. `CharacterProfile`에서는 이름만 읽고, 화면 전용 정보(확정된 한 줄 설명과
  태그 0~4개 `CHARACTER_PRESENTATION`, 선택 필드 `CHARACTER_PORTRAITS`)는 여기 둔다. 한 줄 설명은 확정 문구로 이 파일이 source of
  truth다. 태그는 CharacterAI에 구현된 행동 로직을 근거로 하고, 평가/서열 표현은 쓰지 않는다. 내부 튜닝 수치와 archetype
  식별자는 클라이언트로 보내지 않는다. 초상화는 아직 없고, 시작 화면은 텍스트만으로 완성된 형태다(임시 아바타나 빈 이미지
  영역을 만들지 않는다). 초상화가 생기면 여기에 등록하고 그때 카드 레이아웃을 확장한다. 캐릭터 이름/소개가 필요한 다른
  화면(리플레이 뷰어, CustomAI 등)도 이 파일을 재사용해 표현을 한곳에서 관리한다.
- `src/gui/guiSession.ts`: 여러 국을 한 `GameState`로 잇는 세션(`decision|hand_end|game_end`), 응답 사전 검증
- `src/gui/createGuiServer.ts`, `src/gui/server.ts`: HTTP + SSE 서버. `/events`(상태 스트림), `POST /respond`, `POST /continue`.
  접속 시 현재 요청을 그대로 다시 보내므로 새로고침 복구가 된다. 장면 재생 중에는 응답을 받지 않는다.
  `createGuiServer(game)`은 게임 하나에 묶인 서버(테스트용), `createGuiLobbyServer()`는 `npm run play:gui`가 쓰는 시작 화면 서버다:
  로비 화면 상태(`screen: "hub" | "setup"`, `mode`)는 서버가 들고 있다: 최초는 허브, `POST /lobby`로 허브 ↔ 모드별 설정 화면을
  오가며(대국 중에는 거절), 설정 화면은 두 모드가 공유하고 좌석 수/모드별 상대 구성만 데이터로 다르다(허브 카드의 모드 차이도
  RuleConfig에서 보낸다). `setup` 메시지 → `POST /start`(구성) → 게임 → game_end. game_end 메시지에는 엔진 `computeFinalStandings()` 결과(`standings`)와
  이번 대국 구성(`gameConfig`, 실제 시드 포함)이 실린다. 종료 화면의 "같은 설정으로 다시"(시드 생략)와 "같은 시드로 다시"는
  그 구성으로 다시 `POST /start`, "설정 바꾸기"는 `POST /setup`으로 마지막 모드의 설정 화면에 돌아간다(거기서 허브로 갈 수 있다). 진행 중인 대국에 다시
  접속하면 새로고침 복구로 그 대국 화면이 나온다. 게임마다 GameHost를 새로 만든다.
  AI 진행 속도는 `POST /speed`(`src/gui/playbackSpeed.ts`: slow 700 / normal 400 / fast 150 / instant 0ms)로 서버 단위 장면 간격만
  바꾼다. AI 판단은 사람 응답 때 이미 끝나 있고 장면은 그 스냅샷이므로 결과/RNG와 무관하다(테스트로 로그 동일성 확인).
  자동 플레이 옵션(자동 쯔모기리/울기 패스/자동 화료, 기본 꺼짐)은 클라이언트(`app.js`의 `autoResponseFor`)가 해당 결정에 정해진
  응답을 기존 `/respond`로 보내는 것뿐이라 사람 결정 기록과 리플레이 재현에 그대로 포함된다. 자동 쯔모기리는 엔진이 쯔모 뒤 타패
  요청에만 넣는 `DiscardDecisionRequest.drawnTileId`만 쓴다(울기 직후 타패에는 없음, 리치 후 쯔모기리는 원래 엔진이 요청 없이 처리).
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
- Replay: `replaySchemaV2.test.ts`, `phaseD-yonma-replay-qa.test.ts`, `humanReplay.test.ts`(산마/4마 사람 대국 저장과 검증기 통과),
  `replayParity.test.ts`(리플레이 바이트 고정 해시), `replayReproduction.test.ts`, `replayViewerServer.test.ts`.
- 1.1 GUI: `guiLobby.test.ts`(로비/허브/시작/종료/다시 하기/그만두기), `handStatus.test.ts`, `discardDrawnTile.test.ts`,
  `doubleRonResult.test.ts`, `customAi.test.ts`, `customAiServer.test.ts`.
- GUI 스모크: `npm run test:e2e`(`e2e/guiSmoke.e2e.ts`, Playwright, `npm test`와 분리). 화면 흐름만 보며, 처음 한 번
  `npx playwright install chromium`이 필요하다.
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

- **CustomAI는 1차 범위만**: 공통 파라미터 15개만 편집한다. 캐릭터 전용 특수 메커니즘(글리치/애착/힘 빼기 등)은 없고(향후 특수
  기믹 시스템으로 별도 확장), 가져오기/내보내기도 없다.
- 리플레이 뷰어는 현재 엔진으로 정확히 재현되는 기록만 보여준다 (엔진 규칙/AI가 바뀌기 전의 옛 기록은 대개 재현 불가로 표시).
  GUI는 게임이 끝날 때 한 번만 replay를 저장하며(그만둔 대국은 저장하지 않음), 서버가 게임 도중 죽으면 복구하지 않는다.
- 리플레이 뷰어의 재현은 한 판에 수 초 걸린다. `npm run play:gui`는 대국과 재현을 엔진 worker에서 돌리므로 서버는 멈추지 않는다
  (1.2 3단계). worker를 쓰지 않는 서버(테스트, `createGuiServer`)에서는 여전히 같은 스레드에서 돈다.
- 새로고침은 현재 결정/국 종료/게임 종료 화면을 복구한다(종료 화면은 마지막 장면의 view로 작탁을 다시 그림). 재생 중이던 AI 턴
  장면은 다시 재생하지 않는다.
- GUI는 사람을 seat 0에 앉힌다. 상대는 시작 화면에서 고르며 기본값은 산마: 제갈 미나·제갈 나희, 4마: +변아리. 사람 좌석 선택은 없다.
- CLI는 한 국만 진행한다.
- 전체 회귀가 약 8분이라, 작업 중에는 관련 파일만 돌리고 묶음 작업이 끝난 뒤 push 직전에만 전체를 돌린다.
- 루트의 `*-full-regression.log`, `validation-phaseC-partial-baseline.md`는 과거 검증 기록이다. 새 기준 로그는 덮어쓰지 말고
  새 이름으로 남길 것.

## 10. 1.2 목표와 이후 후보

### 1.2 목표: 온라인 플레이 (사람 1명 + AI)

최종 목표는 사람끼리 두는 온라인 대전이다. 1.2는 그 서버 구조를 먼저 세우되, 한 대국에는 사람 1명과 AI들만 앉는다.
엔진, RNG, 점수 계산, 국 진행, CharacterAI, 리플레이 schema는 바꾸지 않고 서버 계층만 바꾼다.

결정 사항:
- 접근: 초대 코드(공유 비밀번호)를 아는 사람만 입장한다.
- 계정: 닉네임만 정하는 최소 방식. 서버가 세션 토큰(쿠키)을 발급하고 닉네임은 표시용이다. 데이터는 그 브라우저의 쿠키에 묶인다.
- 호스팅: 운영자의 Windows 노트북에서 서버를 켜고 Cloudflare Tunnel로 외부 주소를 받는다(무료, 노트북이 켜져 있을 때만 접속 가능).
- CustomAI: 온라인에서도 쓴다(사용자별 저장, 기존 검증 그대로, 사용자당 개수 상한).

단계:
1. 입장: 초대 코드 + 닉네임, 세션 토큰 쿠키, 미입장 요청 차단. **완료** - `src/gui/accessGate.ts`, `join.html`/`join.js`,
   `--invite-code`, 세션은 `server-data/sessions.json`(토큰 해시만), `tests/guiAccess.test.ts`.
2. 세션 분리: 로비/대국/SSE를 사용자별로. 대국 구조는 "좌석마다 연결된 사용자"로 잡는다(사람끼리 대전 대비). **완료** -
   `createGuiServer.ts`의 `Room`(사용자별 로비 화면, 마지막 설정, SSE 연결, AI 속도, 앉은 대국)과 `Table`(GameHost +
   `seatUsers`). 대국 메시지는 사람 좌석 사용자에게만 가고, 응답은 요청받은 좌석의 사용자만 보낼 수 있다. 로컬 모드는
   사용자 `local` 하나. 로비 상태는 메모리에만 있다(서버 재시작 시 허브부터). `tests/guiRooms.test.ts`.
   (CustomAI/리플레이 공용 문제는 5단계에서 사용자별 폴더로 해결. 같은 사용자가 같은 시드로 다시 저장하면 파일을 덮어쓰는 것은 로컬 모드와 같다.)
3. AI 계산 worker 풀: 대국 진행과 리플레이 재현을 메인 스레드에서 분리. **완료** - `engineRunner.ts`(공통 EngineCore와
   스냅샷, 같은 스레드용 InlineEngineRunner), `engineWorkerPool.ts`/`engineWorker.ts`(대국은 시작할 때 가장 한가한 worker에
   배정되어 끝까지 그 worker에 있다). GameHost는 스냅샷만 보고 메시지를 만든다(로그는 받은 이벤트를 이어 붙인 사본).
   `npm run play:gui`는 worker 풀, `createGuiLobbyServer`는 `engine` 옵션이 없으면 같은 스레드(기존 테스트/e2e).
   개발 중에는 worker 안에서 tsx를 먼저 등록해 .ts를 띄운다. worker가 죽으면 그 worker의 대국은 사라지고(요청이 오류로 끝남)
   새 worker로 바뀐다. 측정: 사람 응답 1회당 AI 계산 20~50ms(최대 약 350ms), 리플레이 재현 약 4.6초.
   `tests/guiEngineWorker.test.ts`(worker와 같은 스레드의 메시지가 끝까지 같음, 재현 중에도 다른 사용자 즉시 응답).
4. 자원 관리: 동시 대국 수 제한, 방치된 대국 정리, 요청 빈도 제한. **완료** - `createGuiServer.ts`의 `ResourceLimits`/
   `ONLINE_LIMITS`(초대 코드 서버에만, `server.ts`가 넘긴다): 서버 전체 대국 8판(`SEONGAH_MAX_GAMES`, 끝났지만 떠나지 않은
   대국 포함), 요청 없는 대국 30분 뒤 정리(리플레이 저장 안 함, 로비 `notice`), 접속·대국 없는 로비 1시간 뒤 메모리에서 삭제,
   사용자별 토큰 버킷(초당 20, 최대 40 - 정적 파일 제외), 사용자별 이벤트 연결 5개. 요청 본문 64KB 제한은 모든 서버(413).
5. 사용자별 저장: 리플레이/CustomAI, 버그 제보용 리플레이 다운로드. **완료** - 초대 코드 서버는
   `server-data/users/<사용자 id>/custom-ai`, `.../replays`(`userDataDir` 옵션). 사용자당 CustomAI 20개, 리플레이 최근 50개
   (저장 직후 오래된 것부터 삭제). 다른 사용자의 CustomAI는 목록/대국 시작 모두 불가. 리플레이 뷰어 "파일 내려받기"
   (`/api/replays/<이름>?download=1`, 로컬 모드 포함). 재현 캐시 키는 파일 경로. 로컬 모드의 `custom-ai/`, `replays/`는
   온라인 서버에서 보이지 않는다(옮기는 기능 없음). `tests/guiOnline.test.ts`.
6. 배포: Windows + Cloudflare Tunnel 운영 문서, SSE heartbeat.
7. 두 사용자 동시 접속 스모크 테스트.

1.2 이후: 사람끼리 대전(매칭, 재접속, 시간 제한), 다른 기기에서 이어 하기(복구 코드 등), 상시 호스팅(Oracle Cloud Always Free 등).

### 그 밖의 후보 (우선순위 없음)

- 게임 종료 화면에서 저장된 리플레이로 바로 가는 링크.
- 리치 입력 UX(확인창 대신 리치 버튼), 대국 통계(화료/방총/리치 횟수).
- 유효패(현재 손/타패 후보별), 울은 손의 타패별 텐파이 미리보기, 위험패 조언(현물 등) - 각각 별도 기능으로 설계.
- CustomAI 특수 기믹 시스템과 가져오기/내보내기. 리플레이 형식 개선(치 구성 패, 적5, AI 판단과 이벤트의 직접 연결 - §3 리플레이 뷰어).
- 캐릭터 보이스와 화료 컷인, 캐릭터 초상화, 사람 좌석 선택, CLI의 상대/CustomAI 선택과 여러 국 진행.
- 추가 presentation 옵션과 UI polish, 추가 효과음, 새로운 마작 룰, 5000판급 장기 자체 대국 검증(Phase C 기준선 참고).
- 캐릭터 성향을 실측으로 확인할 때는 전체 국 대비 비율 대신 조건부 지표(예: 리치 가능 상태가 된 횟수 중 실제 리치 비율)를 쓸 것 -
  울기가 많은 캐릭터는 멘젠 상태가 일찍 깨져 단순 리치 비율이 의향을 반영하지 않는다.

## 11. 다음 작업자 체크리스트

1. 이 문서, `README.md`, 관련 finding/기능 전용 테스트를 먼저 읽는다.
2. `git status`/`git log`로 현재 상태를 확인한다 (릴리즈 시점에 추적 파일은 clean).
3. 요청 범위를 한 기능으로 제한하고, 사람이 없는 게임의 동작이 바뀌지 않는지(parity) 확인한다.
4. pure fixture를 먼저 추가하고 관련 테스트 → `tsc --noEmit` → 안정된 시점에 전체 회귀 순으로 진행한다.
5. 사용자의 명시적 요청 전에는 commit/push하지 않는다.
