/* GUI 진입점: `npm run play:gui [-- <seed>] [-- --mode yonma] [-- --save-replays]`. 실제 서버 로직은
 * createGuiServer.ts, 판 구성은 gameSetup.ts에 있다. 브라우저는 모드(산마/4마)를 고르는 허브부터 열리고, 모드를 고르면
 * 대국 설정 화면으로 간다. 명령줄 인자 중 시드/리플레이 저장은 설정 화면의 초기값이 되고, 모드는 항상 로비에서 고른다
 * (--mode는 받기만 하며 모드 선택을 건너뛰지 않는다). seat 0이 사람이며, 게임이 끝나면
 * 마지막 모드의 설정 화면으로 돌아가 새 대국을 할 수 있다.
 *
 * 온라인 입장 게이트 (accessGate.ts, 세션은 server-data/sessions.json):
 * - 공개 모드: `--public`(또는 환경 변수 SEONGAH_PUBLIC=1). 누구나 닉네임만 정해 입장해 AI와 대국한다.
 * - 비공개 모드: `--invite-code <코드>`(또는 SEONGAH_INVITE_CODE). 그 코드를 아는 사람만 입장한다(공개 모드보다 우선).
 * 둘 다 없으면 입장 없이 로비 하나를 쓰는 로컬 모드다. 사용자 수 상한은 SEONGAH_MAX_USERS(기본 500).
 *
 * 대국과 리플레이 재현은 엔진 worker 풀에서 돌린다 (engineWorkerPool.ts). worker 수는 환경 변수 SEONGAH_ENGINE_WORKERS로 바꿀 수 있다
 * (기본: CPU 수 - 1, 1~4개).
 *
 * 공개/비공개 모드 서버는 사용자별로 server-data/users/<사용자 id>/에 CustomAI와 리플레이를 저장하고, 자원 제한(ONLINE_LIMITS)을 둔다. */
import { parseGameArgs } from "./gameSetup.js";
import { ONLINE_LIMITS, createGuiLobbyServer } from "./createGuiServer.js";
import { AccessGate } from "./accessGate.js";
import { EngineWorkerPool, defaultEngineWorkerCount } from "./engineWorkerPool.js";

const PORT = Number(process.env.PORT) || 3000;
const allArgs = process.argv.slice(2);
const publicFlag = allArgs.includes("--public") || ["1", "true"].includes((process.env.SEONGAH_PUBLIC ?? "").toLowerCase());
const args = allArgs.filter((a) => a !== "--public");
const inviteIndex = args.indexOf("--invite-code");
if (inviteIndex >= 0 && !args[inviteIndex + 1]) throw new Error("--invite-code 뒤에 초대 코드를 적어 주세요");
const inviteCode = inviteIndex >= 0 ? args[inviteIndex + 1]! : process.env.SEONGAH_INVITE_CODE;
const parsed = parseGameArgs(inviteIndex >= 0 ? args.filter((_, i) => i !== inviteIndex && i !== inviteIndex + 1) : args);
const maxUsers = process.env.SEONGAH_MAX_USERS ? Number(process.env.SEONGAH_MAX_USERS) : undefined;
const access = inviteCode || publicFlag ? new AccessGate({ ...(inviteCode ? { inviteCode } : {}), ...(maxUsers !== undefined ? { maxUsers } : {}) }) : undefined;
const engine = new EngineWorkerPool(process.env.SEONGAH_ENGINE_WORKERS ? Number(process.env.SEONGAH_ENGINE_WORKERS) : defaultEngineWorkerCount());

const { server } = createGuiLobbyServer({
  defaults: { mode: parsed.mode, saveReplays: parsed.saveReplays, ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}) },
  onGameStarted: (config) => console.log(`Game started - Mode: ${config.mode}, Seed: ${config.seed}, Opponents: ${config.opponents.join(", ")}`),
  onReplaySaved: (path) => console.log(`Replay saved: ${path}`),
  // 입장 게이트가 있는 서버(공개/비공개)에만 자원 제한을 둔다. 동시 대국 수는 SEONGAH_MAX_GAMES로 바꿀 수 있다.
  ...(access
    ? { access, limits: { ...ONLINE_LIMITS, ...(process.env.SEONGAH_MAX_GAMES ? { maxOpenGames: Number(process.env.SEONGAH_MAX_GAMES) } : {}) } }
    : {}),
  engine,
});
// HOST를 지정하면 그 주소에서만 받는다 (예: 터널로만 공개할 때 127.0.0.1). 기본은 모든 주소.
const HOST = process.env.HOST || undefined;
server.listen(PORT, HOST, () => {
  const mode = !access ? "" : access.inviteRequired ? " (비공개: 초대 코드 입장)" : " (공개: 닉네임만 정해 입장)";
  console.log(`Seongah Majak GUI: http://localhost:${PORT}${HOST ? ` (${HOST}에서만 받음)` : ""}${mode}, 엔진 worker ${engine.size}개`);
});
