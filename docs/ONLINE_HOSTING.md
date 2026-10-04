# 온라인 운영 안내 (Windows 노트북 + Tailscale Funnel)

노트북에서 게임 서버를 켜고, Tailscale Funnel로 인터넷에 https 주소를 열어 누구나 브라우저로 들어와 AI와 대국하게 하는
방법이다. 비용은 들지 않는다. 노트북이 켜져 있고 서버와 Funnel이 실행 중일 때만 접속할 수 있다.

- 접속하는 사람은 아무것도 설치하지 않는다. 주소만 알면 닉네임을 정하고 들어온다(공개 모드).
- 아는 사람만 들어오게 하려면 초대 코드를 건다(비공개 모드, 2절 끝).
- 로비 대국은 사람 1명과 AI들이 앉는다. 사람끼리 두려면 로비의 "친선전"에서 방을 만들고 코드를 알려 준다.
  사람마다 자기 로비, 대국, CustomAI, 리플레이를 따로 가진다.
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
$env:SEONGAH_PUBLIC = "1"
$env:HOST = "127.0.0.1"
npm run play:gui
```

- `SEONGAH_PUBLIC = "1"`: 공개 모드. 누구나 닉네임만 정하면 들어와서 AI와 대국하거나 친선전 방에서 사람끼리 둔다. 사람마다
  로비·CustomAI·리플레이가 따로다.
- `HOST = "127.0.0.1"`: 같은 와이파이의 다른 기기가 아니라 Funnel을 거쳐서만 들어오게 한다.
- 창에 `Seongah Majak GUI: http://localhost:3000 (127.0.0.1에서만 받음) (공개: 닉네임만 정해 입장), 엔진 worker N개`가 나오면 된다.
- 이 창은 닫지 않는다. 끌 때는 이 창에서 `Ctrl + C`.

노트북 브라우저로 http://localhost:3000 을 열어 닉네임 입장 화면이 나오는지 먼저 확인한다.

**비공개로 열려면** `SEONGAH_PUBLIC` 대신 초대 코드를 준다. 그러면 초대 코드를 아는 사람만 들어온다(입장 화면에 초대 코드 칸이
생긴다). 초대 코드가 유일한 출입 통제이므로 길게 정하고, 주소와는 따로 알려 준다.

```powershell
$env:SEONGAH_INVITE_CODE = "길고-맞히기-어려운-코드"
$env:HOST = "127.0.0.1"
npm run play:gui
```

같은 PowerShell 창에서 공개 모드를 켠 적이 있으면 `$env:SEONGAH_PUBLIC`이 남아 있어도 초대 코드가 우선한다. 공개와 비공개를
바꿔 켜도 입장 세션은 같은 파일(`server-data/sessions.json`)을 쓰므로, 이미 입장한 사람은 그대로 들어온다.

## 3. 인터넷에 열기 (Funnel)

PowerShell 창을 하나 더 열고:

```powershell
tailscale funnel 3000
```

- `https://<기기 이름>.<tailnet 이름>.ts.net` 형태의 주소가 나온다. 이 주소를 들어올 사람에게 알려 준다.
  기기 이름을 바꾸지 않는 한 주소는 매번 같다.
- 처음 켤 때는 주소가 인터넷에서 열리기까지 몇 분 걸릴 수 있다.
- 이 창을 닫거나 `Ctrl + C`를 누르면 Funnel이 꺼진다. 창 없이 계속 켜 두려면 `tailscale funnel --bg 3000`,
  끄려면 `tailscale funnel reset`. 상태 확인은 `tailscale funnel status`.
- 들어오는 연결을 여는 방화벽/공유기 설정은 필요 없다(Funnel은 노트북에서 밖으로 나가는 연결을 쓴다).

휴대폰의 모바일 데이터(와이파이 끄기)로 그 주소를 열어 입장 화면이 나오면 성공이다.

## 4. 알리기

- 공개 모드: 주소(`https://….ts.net`)만 알려 준다. 들어온 사람은 닉네임만 정한다.
- 비공개 모드: 주소와 초대 코드를 따로 알려 준다. 초대 코드를 5번 틀린 접속지는 10분 동안 입장할 수 없다.
- 같은 브라우저로 다시 오면 입장한 상태가 유지된다(닉네임은 로비의 "바꾸기"로 바꾼다).

## 5. 켜 두는 동안

- **절전 끄기**: 설정 > 시스템 > 전원에서 화면 끄기/절전을 "안 함"으로 하고 전원을 연결해 둔다. 노트북이 잠들면 모두 끊긴다.
- **덮개를 닫아도 켜 두려면** 제어판 > 전원 옵션 > "덮개를 닫으면"을 "아무 것도 안 함"으로.
- 대국은 서버 메모리에 있다. 서버를 끄거나 노트북이 잠들면 **진행 중이던 대국은 사라진다**(입장 상태, CustomAI, 저장된
  리플레이는 남는다).

## 6. 제한 (기본값)

공개/비공개 모드로 켠 서버에만 적용된다(로컬 모드는 제한 없음).

| 항목 | 기본값 | 바꾸는 방법 |
| --- | --- | --- |
| 서버 전체 동시 대국 수 | 8판 | `$env:SEONGAH_MAX_GAMES = "4"` |
| 요청 없는 대국 정리 | 30분 (리플레이 저장 안 함, 로비에 안내) | - |
| 한 사람당 CustomAI | 20개 | - |
| 한 사람당 리플레이 | 최근 50개 | - |
| 한 사람당 동시에 여는 탭 | 5개 | - |
| 엔진 worker 수 | CPU 수 - 1 (1~4개) | `$env:SEONGAH_ENGINE_WORKERS = "2"` |
| 전체 사용자 수 (넘으면 새 입장만 막음) | 500명 | `$env:SEONGAH_MAX_USERS = "200"` |
| 새 입장 (서버 전체) | 한 시간에 60명 | - |
| 새 입장 (접속지별, 접속지를 알 수 있을 때) | 한 시간에 10명 | - |
| 친선전 방 (서버 전체) | 100개 | - |
| 아무 활동이 없는 친선전 방 정리 | 30분 | - |
| 틀린 방 코드 입력 | 사용자별 10분에 10번 | - |

새 입장 제한은 쿠키를 지워 가며 사용자를 계속 만드는 남용을 막는다. 이미 입장한 브라우저는 제한과 상관없이 들어온다. Funnel은
원래 접속지를 서버에 넘기지 않을 수 있어서(모두 `127.0.0.1`로 보임), 그때는 접속지별 제한 대신 서버 전체 제한만 적용된다.

노트북이 느려지면 `SEONGAH_MAX_GAMES`와 `SEONGAH_ENGINE_WORKERS`를 줄인다.

## 7. 데이터

모두 프로젝트 폴더의 `server-data/`에 있다 (git에 올라가지 않는다).

- `server-data/sessions.json`: 입장한 브라우저 목록(토큰은 해시로만 저장).
- `server-data/users/<사용자 id>/custom-ai/`, `.../replays/`: 사람별 CustomAI와 리플레이.
- 백업은 서버를 끈 상태에서 `server-data` 폴더를 통째로 복사한다.
- 로컬 모드(공개/비공개 설정 없이 켠 서버)의 `custom-ai/`, `replays/`는 온라인 서버에서 보이지 않는다. 내 CustomAI를 온라인에서도
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

제보하는 사람에게 로비의 "저장된 리플레이 보기"에서 그 대국을 고르고, 화면 위 막대(휴대폰은 "메뉴" 안)의 **"내려받기"**로
받은 JSON 파일을 보내 달라고 한다. 로비 대국은 대국 설정에서 "리플레이 저장"을 켜 둔 대국만 저장되고, 친선전과 AI 관전은 항상
저장된다. 이 파일로 같은 대국을 그대로 재현할 수 있다.

## 10. 문제가 생기면

- **다른 기기에서 `http://localhost:3000`으로 접속하면 안 된다**: `localhost`는 "그 기기 자신"이라는 뜻이다. 노트북 밖에서는
  반드시 Funnel 주소(`https://….ts.net`, 포트 번호 없이)로 들어온다.
- **`'tailscale' 용어가 … 인식되지 않습니다`**: Tailscale을 설치하기 전에 열어 둔 PowerShell 창이면 창을 새로 연다. 그래도
  안 되면 전체 경로로 실행한다: `& "C:\Program Files\Tailscale\tailscale.exe" funnel 3000`
  (설치 여부는 `Test-Path "C:\Program Files\Tailscale\tailscale.exe"`가 `True`인지로 확인한다).
- **`Funnel is not enabled on your tailnet.`**: 함께 나온 `https://login.tailscale.com/f/funnel?...` 링크를 브라우저로 열고,
  같은 Tailscale 계정으로 허용한 뒤 명령을 다시 실행한다(처음 한 번만).
- **HTTP ERROR 502**: Funnel까지는 닿았지만 게임 서버에 연결하지 못한 것이다. 서버 창(`npm run play:gui`)이 켜져 있는지,
  노트북에서 `http://127.0.0.1:3000`이 열리는지 확인한다.
- **휴대폰에 `dns_probe_finished_nxdomain`**: 휴대폰이 공개 등록 전에 조회한 "주소 없음" 결과를 기억하고 있는 것이다.
  비행기 모드를 껐다 켜거나 브라우저 캐시를 지운 뒤 다시 연다. 공개 등록 여부는 휴대폰에서
  `https://dns.google/query?name=<주소>&type=A`로 확인한다(100.으로 시작하지 않는 IP가 나오면 등록된 것이다). 노트북에서는
  Tailscale이 `ts.net` 조회를 가로채므로 `nslookup`으로 확인할 수 없다.
- **노트북에서는 `….ts.net`이 열리는데 휴대폰에서는 안 된다**: Tailscale이 켜진 기기는 Funnel이 꺼져 있어도 내부 경로로 열린다.
  `tailscale funnel status`에 `Funnel on`이 보이는지 확인하고, 휴대폰은 Tailscale 앱을 끄고 모바일 데이터로 시험한다.
- **주소가 열리지 않는다**: `tailscale funnel status`로 Funnel이 켜져 있는지, 서버 창이 살아 있는지 확인한다.
  처음 켠 직후라면 몇 분 기다린다.
- **입장 화면으로 계속 돌아간다**: 브라우저가 쿠키를 막고 있는지 확인한다(시크릿 창은 닫으면 입장 상태가 사라진다).
- **화면이 멈춘 채 갱신되지 않는다**: 새로고침한다. 새로고침하면 현재 결정/국 종료 화면으로 돌아온다.
- **"진행 중인 대국이 많습니다"**: 동시 대국 수 제한이다. 다른 사람이 끝내기를 기다리거나 `SEONGAH_MAX_GAMES`를 늘린다.
- **"요청이 너무 잦습니다"**: 잠시 뒤 다시 시도한다.
- **"지금은 새 입장을 받지 않습니다" / "새 입장이 몰려"**: 사용자 수 상한이나 시간당 새 입장 제한이다. 이미 입장한 사람은 그대로
  들어온다. 상한은 `SEONGAH_MAX_USERS`로 늘릴 수 있고, 오래 안 쓰는 사용자를 정리하려면 서버를 끈 상태에서
  `server-data/sessions.json`의 항목을 지운다(그 사람은 새 사용자가 된다).

## 참고: 다른 방법

- **Cloudflare 이름 있는 터널**: 본인 도메인이 있으면(유료) 가장 표준적인 방법이다. SSE가 되고 주소가 고정된다.
- **Cloudflare Quick Tunnel**(trycloudflare.com): 가입 없이 쓸 수 있지만, SSE를 지원하지 않는다는 제한이 있는 것으로 알려져
  있어 이 게임(화면 갱신에 SSE 사용)에는 권하지 않는다. 또 켤 때마다 주소가 바뀌고 가동 보장이 없다.
