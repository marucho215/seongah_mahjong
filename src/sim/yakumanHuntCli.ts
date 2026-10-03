/* 역만 찾기 CLI: `npm run sim:yakuman -- --players <id1,id2,id3[,id4]> [--max-games <n>] [--seed <시드>] [--no-replay]`
 * 3명이면 산마, 4명이면 4마. 역만이 나온 판에서 멈추고 그 판의 리플레이를 replays/에 저장한다(로비의 "저장된 리플레이 보기"로 연다).
 * 찾으면 종료 코드 0, 최대 판 수까지 없으면 1. 로직은 yakumanHunt.ts. */
import { getCharacterProfile } from "../ai/characterProfiles.js";
import { huntYakuman } from "./yakumanHunt.js";

const DEFAULT_MAX_GAMES = 1000;
const WIND = ["", "동", "남", "서", "북"];
const SEAT_LABEL: Record<number, string[]> = { 3: ["동가", "남가", "서가"], 4: ["동가", "남가", "서가", "북가"] };

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const playersValue = optionValue(argv, "--players");
if (!playersValue) {
  console.error("사용법: npm run sim:yakuman -- --players <캐릭터1,캐릭터2,캐릭터3[,캐릭터4]> [--max-games <판 수, 기본 1000>] [--seed <시드>] [--no-replay]");
  console.error("  3명이면 산마, 4명이면 4마. 첫 캐릭터가 처음 친(동가)이다.");
  process.exit(2);
}
const players = playersValue.split(",").map((s) => s.trim()).filter(Boolean);
const maxGames = Number(optionValue(argv, "--max-games") ?? DEFAULT_MAX_GAMES);
const seed = optionValue(argv, "--seed") ?? `yk-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
const names = (() => {
  try {
    return players.map((id) => getCharacterProfile(id).displayName);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
})();

console.log(`${players.length === 3 ? "산마" : "4마"} · ${names.join(" / ")} · 최대 ${maxGames}판 · 시드 ${seed}`);
const started = Date.now();
const result = huntYakuman({
  players,
  seed,
  maxGames,
  ...(argv.includes("--no-replay") ? {} : { replayDir: "replays" }),
  onGame: (n) => {
    if (n % 10 === 0) process.stderr.write(`  ${n}판 진행 (${Math.round((Date.now() - started) / 1000)}초)\n`);
  },
});

if (!result.found) {
  console.log(`${result.gamesPlayed}판 안에 역만이 나오지 않았습니다.`);
  process.exit(1);
}
const { found } = result;
const seatName = (seat: number) => `${SEAT_LABEL[players.length]![seat]} ${names[seat]}`;
console.log(`${found.gameIndex + 1}판째에 역만이 나왔습니다 (판 시드 ${found.gameSeed}).`);
for (const w of found.wins) {
  const how = w.isTsumo ? "쯔모" : `론 (${seatName(w.ronFrom!)} 방총)`;
  const units = w.yakumanUnits > 1 ? `${w.yakumanUnits}배 역만` : "역만";
  console.log(`  ${WIND[w.roundWind]}${w.roundHandNumber}국 ${w.honba}본장 · ${seatName(w.seat)} · ${how} · ${units} ${w.points.toLocaleString("en-US")}점`);
  console.log(`    역: ${w.yaku.map((y) => y.name).join(", ")}`);
}
if (found.replayPath) console.log(`리플레이: ${found.replayPath}`);
console.log(`같은 판 다시 돌리기: npm run sim:yakuman -- --players ${playersValue} --seed ${seed} --max-games ${found.gameIndex + 1}`);
