# T-STUDIO Mahjong Sound Pack (원본 미포함)

이 폴더의 `*.mp3`, `*.ogg`는 `.gitignore`로 제외된다. **공개 저장소에 원본을 커밋하지 않는다.**

## 이유 (약관 요약)

- 게임을 포함한 상업적 사용은 가능하다.
- 가능하면 `みんなの創作支援サイトＴスタ` 크레딧을 표기해 달라는 요청이 있다.
- 저작권을 포기한 것이 아니다.
- 무료 음악/효과음의 2차 판매 및 2차 배포는 금지다. (원본 파일을 그대로 다시 배포하면 이에 해당할 수 있다.)
- 게임 패키지/웹 배포 형태가 약관상 허용되는지는 배포 방식이 정해질 때 다시 확인한다.

## 출처

- 출처(다운로드) 및 이용 약관: https://t-studio-tst.itch.io/free-sound-mahjong-sound-pack
  - 위 "약관 요약"은 이 페이지에 적힌 조건을 옮긴 것이다. 별도의 약관 페이지가 따로 있다면 여기에 추가한다.
  - 제작: みんなの創作支援サイトＴスタ (T-STUDIO)

## 필요한 파일 (mp3)

| 파일 | 역할 |
|---|---|
| `mahjong_tile_1.mp3` | `sfx.discard` 타패 |
| `mahjong_tile_2.mp3` | `sfx.kita` 북빼기 |
| `mahjong_tile_3.mp3` | `sfx.pon` 퐁 |
| `mahjong_tile_4.mp3` | `sfx.kan` 깡 |
| `riich_bets_1.mp3` | `sfx.riichiStick` 리치봉 |
| `take_the_riich_bets_2.mp3` | `sfx.riichiCollect` 공탁 회수 |
| `shuffle_the_mahjong_tiles.mp3` | `sfx.shuffle` 국 시작 셔플 |

이 팩의 선언 음성(`ron`, `draw`, `pung`, `kong`, `chow`, `riichi`, `double_riichi`, 역 이름 파일 등)은 **voice**로 분류되어 재생에 연결하지 않으며, 이 폴더에 둘 필요도 없다.

## 직접 배치하는 방법

1. 팩(`Mahjong_Sound_Pack_*`)을 내려받아 압축을 푼다.
2. 위 표의 7개 mp3를 이 폴더(`src/gui/public/assets/audio/tstudio/`)에 그대로 복사한다.
3. GUI 서버를 다시 시작할 필요는 없다. 페이지를 새로고침하면 된다.
