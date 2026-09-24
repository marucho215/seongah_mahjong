/* GUI 진입점: `npm run play:gui [-- <seed>] [-- --mode yonma]`. 실제 서버 로직은 createGuiServer.ts,
 * 판 구성은 gameSetup.ts에 있고, 이 파일은 인자를 읽어 서버를 시작하고 주소를 출력할 뿐이다.
 * seat 0이 사람이며 한 프로세스에서 한 게임(여러 국)을 진행한다. */
import { createGuiGame, parseGameArgs } from "./gameSetup.js";
import { createGuiServer } from "./createGuiServer.js";

const PORT = Number(process.env.PORT) || 3000;
const parsed = parseGameArgs(process.argv.slice(2));
const mode = parsed.mode;
const seed = parsed.seed ?? `gui-${Date.now()}`;

const game = createGuiGame(mode, seed);

const { server } = createGuiServer(game, {
  ...(parsed.saveReplays
    ? { replay: { label: `human-${mode}-${seed}`, onSaved: (path: string) => console.log(`Replay saved: ${path}`) } }
    : {}),
});
server.listen(PORT, () => {
  console.log(`Mode: ${mode}, Seed: ${seed}`);
  console.log(`Seongah Majak GUI: http://localhost:${PORT}`);
});
