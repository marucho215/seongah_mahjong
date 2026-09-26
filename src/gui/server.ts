/* GUI 진입점: `npm run play:gui [-- <seed>] [-- --mode yonma] [-- --save-replays]`. 실제 서버 로직은
 * createGuiServer.ts, 판 구성은 gameSetup.ts에 있다. 브라우저는 모드(산마/4마)를 고르는 허브부터 열리고, 모드를 고르면
 * 대국 설정 화면으로 간다. 명령줄 인자 중 시드/리플레이 저장은 설정 화면의 초기값이 되고, 모드는 항상 로비에서 고른다
 * (--mode는 받기만 하며 모드 선택을 건너뛰지 않는다). seat 0이 사람이며, 게임이 끝나면
 * 마지막 모드의 설정 화면으로 돌아가 새 대국을 할 수 있다. */
import { parseGameArgs } from "./gameSetup.js";
import { createGuiLobbyServer } from "./createGuiServer.js";

const PORT = Number(process.env.PORT) || 3000;
const parsed = parseGameArgs(process.argv.slice(2));

const { server } = createGuiLobbyServer({
  defaults: { mode: parsed.mode, saveReplays: parsed.saveReplays, ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}) },
  onGameStarted: (config) => console.log(`Game started - Mode: ${config.mode}, Seed: ${config.seed}, Opponents: ${config.opponents.join(", ")}`),
  onReplaySaved: (path) => console.log(`Replay saved: ${path}`),
});
server.listen(PORT, () => {
  console.log(`Seongah Majak GUI: http://localhost:${PORT}`);
});
