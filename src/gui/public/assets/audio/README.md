# 효과음 자산

GUI 효과음은 두 출처를 쓴다. 분류는 다음 세 가지이며, 이 저장소의 재생 시스템은 **physical + ui만** 연결한다.

| 분류 | 의미 | 재생 연결 |
|---|---|---|
| physical | 마작패 충돌, 리치봉, 셔플 같은 실제 물리음 | 연결함 (`sfx.*`) |
| ui | 버튼/결과창 같은 비언어 UI 소리 | 연결함 (`ui.*`) |
| voice | "론", "퐁" 같은 사람이 말하는 선언 음성 | **연결하지 않음** (`voice.*`는 자리만 예약) |

- `ui/` - OwlishMedia UI 효과음 (CC0, 저장소에 포함). `ui/ATTRIBUTION.md` 참고.
- `tstudio/` - T-STUDIO Mahjong Sound Pack (저장소에 **포함하지 않음**). `tstudio/README.md` 참고.

T-STUDIO 파일이 없어도 게임은 정상 동작한다. 해당 소리만 재생되지 않는다.
