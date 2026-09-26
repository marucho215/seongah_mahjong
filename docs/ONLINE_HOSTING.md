# 온라인 운영 안내 (Windows 노트북 + Tailscale Funnel)

노트북에서 게임 서버를 켜고, Tailscale Funnel로 인터넷에 https 주소를 열어 초대한 사람들이 브라우저로 접속하게 하는
방법이다. 비용은 들지 않는다. 노트북이 켜져 있고 서버와 Funnel이 실행 중일 때만 접속할 수 있다.

- 접속하는 사람은 아무것도 설치하지 않는다. 주소와 초대 코드만 있으면 된다.
- 한 대국에는 사람 1명과 AI들이 앉는다. 사람마다 자기 로비, 대국, CustomAI, 리플레이를 따로 가진다.
- Tailscale의 메뉴 이름과 절차는 바뀔 수 있다. 화면이 이 문서와 다르면 Tailscale 공식 문서(Funnel)를 따른다.

## 1. 처음 한 번 준비

1. **Node.js** 20 이상(LTS)을 설치한다: https://nodejs.org
2. **Git for Windows**를 설치한다: https://git-scm.com
3. 코드를 받는다 (PowerShell):
   ```powershell
   git clone https://github.com/marucho215/seongah_mahjong.git
   cd seongah_mahjong
   npm ci
   ```
4. **Tailscale**을 설치하고 로그인한다: https://tailscale.com/download (Windows). Google/Microsoft/GitHub 계정으로 가입할 수 있다.
5. **Funnel을 켤 수 있게 허용**한다. 처음 `tailscale funnel` 명령을 실행하면 허용이 필요하다는 안내와 링크가 나온다.
   링크를 열어 이 기기의 HTTPS 인증서와 Funnel을 허용한다(관리 콘솔에서 한 번만 하면 된다).

## 2. 서버 켜기

PowerShell 창을 하나 열고, 프로젝트 폴더에서:

```powershell
$env:SEONGAH_INVITE_CODE = "길고-맞히기-어려운-코드"
$env:HOST = "127.0.0.1"
npm run play:gui
```

- `SEONGAH_INVITE_CODE`: 초대 코드. 이것이 유일한 출입 통제이므로 길게 정하고, 주소와는 따로 알려 준다.
- `HOST = "127.0.0.1"`: 같은 와이파이의 다른 기기가 아니라 Funnel을 거쳐서만 들어오게 한다.
- 창에 `Seongah Majak GUI: http://localhost:3000 (127.0.0.1에서만 받음) (초대 코드 입장), 엔진 worker N개`가 나오면 된다.
- 이 창은 닫지 않는다. 끌 때는 이 창에서 `Ctrl + C`.

노트북 브라우저로 http://localhost:3000 을 열어 입장 화면이 나오는지 먼저 확인한다.

## 3. 인터넷에 열기 (Funnel)

PowerShell 창을 하나 더 열고:

```powershell
tailscale funnel 3000
```

- `https://<기기 이름>.<tailnet 이름>.ts.net` 형태의 주소가 나온다. 이 주소가 초대할 사람에게 줄 주소다.
  기기 이름을 바꾸지 않는 한 주소는 매번 같다.
- 처음 켤 때는 주소가 인터넷에서 열리기까지 몇 분 걸릴 수 있다.
- 이 창을 닫거나 `Ctrl + C`를 누르면 Funnel이 꺼진다. 창 없이 계속 켜 두려면 `tailscale funnel --bg 3000`,
  끄려면 `tailscale funnel reset`. 상태 확인은 `tailscale funnel status`.
- 들어오는 연결을 여는 방화벽/공유기 설정은 필요 없다(Funnel은 노트북에서 밖으로 나가는 연결을 쓴다).

휴대폰의 모바일 데이터(와이파이 끄기)로 그 주소를 열어 입장 화면이 나오면 성공이다.

## 4. 초대하기

- 주소(`https://….ts.net`)와 초대 코드를 따로 알려 준다.
- 들어온 사람은 닉네임만 정한다. 같은 브라우저로 다시 오면 입장한 상태가 유지된다.
- 초대 코드를 5번 틀린 접속지는 10분 동안 입장할 수 없다.

## 5. 켜 두는 동안

- **절전 끄기**: 설정 > 시스템 > 전원에서 화면 끄기/절전을 "안 함"으로 하고 전원을 연결해 둔다. 노트북이 잠들면 모두 끊긴다.
- **덮개를 닫아도 켜 두려면** 제어판 > 전원 옵션 > "덮개를 닫으면"을 "아무 것도 안 함"으로.
- 대국은 서버 메모리에 있다. 서버를 끄거나 노트북이 잠들면 **진행 중이던 대국은 사라진다**(입장 상태, CustomAI, 저장된
  리플레이는 남는다).

## 6. 제한 (기본값)

초대 코드로 켠 서버에만 적용된다.

| 항목 | 기본값 | 바꾸는 방법 |
| --- | --- | --- |
| 서버 전체 동시 대국 수 | 8판 | `$env:SEONGAH_MAX_GAMES = "4"` |
| 요청 없는 대국 정리 | 30분 (리플레이 저장 안 함, 로비에 안내) | - |
| 한 사람당 CustomAI | 20개 | - |
| 한 사람당 리플레이 | 최근 50개 | - |
| 한 사람당 동시에 여는 탭 | 5개 | - |
| 엔진 worker 수 | CPU 수 - 1 (1~4개) | `$env:SEONGAH_ENGINE_WORKERS = "2"` |

노트북이 느려지면 `SEONGAH_MAX_GAMES`와 `SEONGAH_ENGINE_WORKERS`를 줄인다.

## 7. 데이터

모두 프로젝트 폴더의 `server-data/`에 있다 (git에 올라가지 않는다).

- `server-data/sessions.json`: 입장한 브라우저 목록(토큰은 해시로만 저장).
- `server-data/users/<사용자 id>/custom-ai/`, `.../replays/`: 사람별 CustomAI와 리플레이.
- 백업은 서버를 끈 상태에서 `server-data` 폴더를 통째로 복사한다.
- 로컬 모드(초대 코드 없이 켠 서버)의 `custom-ai/`, `replays/`는 온라인 서버에서 보이지 않는다. 내 CustomAI를 온라인에서도
  쓰려면, 온라인으로 한 번 입장한 뒤 `custom-ai/`의 JSON 파일을 내 사용자 폴더의 `custom-ai/`로 복사한다
  (내 사용자 id는 `sessions.json`에서 내 닉네임 옆의 `userId`).

**초대 코드를 바꾸면**: 서버를 끄고 새 코드로 다시 켠다. 이미 입장한 브라우저는 계속 들어올 수 있다. 모두 다시 입장하게
하려면 서버를 끈 상태에서 `server-data/sessions.json`을 지운다. 이때 모두 새 사용자가 되어 예전 CustomAI/리플레이 폴더와
이어지지 않는다(폴더는 남아 있다).

## 8. 업데이트

아무도 두고 있지 않을 때:

```powershell
# 서버 창에서 Ctrl + C 로 끈 뒤
git pull
npm ci
npm run play:gui
```

Funnel은 켜 둔 채로 두어도 된다(서버가 다시 켜지면 같은 주소로 이어진다).

## 9. 버그 제보 받기

제보하는 사람에게 리플레이 뷰어(로비의 "저장된 리플레이 보기")에서 그 대국을 고르고 **"파일 내려받기"**로 받은 JSON 파일을
보내 달라고 한다. 대국 설정에서 "리플레이 저장"을 켜 둔 대국만 저장된다. 이 파일로 같은 대국을 그대로 재현할 수 있다.

## 10. 문제가 생기면

- **주소가 열리지 않는다**: `tailscale funnel status`로 Funnel이 켜져 있는지, 서버 창이 살아 있는지 확인한다.
  처음 켠 직후라면 몇 분 기다린다.
- **입장 화면으로 계속 돌아간다**: 브라우저가 쿠키를 막고 있는지 확인한다(시크릿 창은 닫으면 입장 상태가 사라진다).
- **화면이 멈춘 채 갱신되지 않는다**: 새로고침한다. 새로고침하면 현재 결정/국 종료 화면으로 돌아온다.
- **"진행 중인 대국이 많습니다"**: 동시 대국 수 제한이다. 다른 사람이 끝내기를 기다리거나 `SEONGAH_MAX_GAMES`를 늘린다.
- **"요청이 너무 잦습니다"**: 잠시 뒤 다시 시도한다.

## 참고: 다른 방법

- **Cloudflare 이름 있는 터널**: 본인 도메인이 있으면(유료) 가장 표준적인 방법이다. SSE가 되고 주소가 고정된다.
- **Cloudflare Quick Tunnel**(trycloudflare.com): 가입 없이 쓸 수 있지만, SSE를 지원하지 않는다는 제한이 있는 것으로 알려져
  있어 이 게임(화면 갱신에 SSE 사용)에는 권하지 않는다. 또 켤 때마다 주소가 바뀌고 가동 보장이 없다.
