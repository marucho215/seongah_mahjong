import type { GameState } from "../core/GameState.js";
import type { CallDecisionRequest, ChiDecisionRequest, DecisionRequest, DecisionResponse, DiscardDecisionRequest, NineTerminalsDecisionRequest, RonDecisionRequest, TsumoDecisionRequest } from "../core/decisions.js";
import type { PlayerView } from "../core/playerView.js";
import type { TileRef, MeldSnapshot, GameEvent } from "../core/GameLog.js";
import { parseKind } from "../core/tiles.js";
import { compareTilesForDisplay, josaEulReul, josaRo, koreanTileLabel } from "./tileFormat.js";
import type { CliIO } from "./cliIO.js";

function formatTileRef(t: TileRef): string {
  return koreanTileLabel(t.kind, t.red);
}

function formatMeld(m: MeldSnapshot): string {
  return `${m.type}(${m.tiles.map(formatTileRef).join(" ")})`;
}

/**
 * Renders a row of `[index]label` entries with a wider gap between suit groups (m -> p -> s
 * -> z) so the hand's structure reads at a glance instead of as one undifferentiated run of
 * numbers - purely cosmetic, computed from the same already-sorted `tiles` array the caller
 * used to assign indices.
 */
function renderIndexedTileRow(tiles: readonly TileRef[]): string {
  const groups: string[][] = [];
  let currentSuit: string | null = null;
  for (const [i, t] of tiles.entries()) {
    const suit = parseKind(t.kind).suit;
    if (suit !== currentSuit) {
      groups.push([]);
      currentSuit = suit;
    }
    groups[groups.length - 1]!.push(`[${i}]${formatTileRef(t)}`);
  }
  return groups.map((g) => g.join(" ")).join("   ");
}

const ROUND_WIND_NAMES = ["", "East", "South", "West", "North"];

function renderView(io: CliIO, view: PlayerView): void {
  io.print(
    `=== ${ROUND_WIND_NAMES[view.roundWind] ?? view.roundWind} ${view.roundHandNumber}, Dealer: seat ${view.dealerSeat}, Honba ${view.honba}, Kyotaku ${view.kyotaku} ===`
  );
  io.print(`Scores: ${view.scores.map((s, i) => `seat${i}=${s}`).join("  ")}`);
  io.print(`Dora indicators: ${view.doraIndicators.length > 0 ? view.doraIndicators.map(formatTileRef).join(" ") : "(none)"}`);
  io.print(`--- Your hand (seat ${view.seat}) ---`);
  // Display-only sort: never mutates view.concealedTiles or the engine's Hand.concealed -
  // this is a fresh sorted copy, used only to decide what index means what tile below.
  const sortedHand = [...view.concealedTiles].sort(compareTilesForDisplay);
  io.print(`Concealed: ${renderIndexedTileRow(sortedHand)}`);
  io.print(`Melds: ${view.melds.length > 0 ? view.melds.map(formatMeld).join(" ") : "(none)"}`);
  io.print(`Kita: ${view.kitaTiles.length > 0 ? view.kitaTiles.map(formatTileRef).join(" ") : "(none)"}`);
  io.print(`Riichi: ${view.riichi ? "yes" : "no"}`);
  if (view.furiten.active) {
    const causes = [view.furiten.selfDiscard && "own discard", view.furiten.temporary && "temporary", view.furiten.riichi && "riichi miss"].filter(Boolean);
    io.print(`Furiten: yes (${causes.join(", ")}) - you cannot ron right now`);
  }
  io.print(`--- Opponents ---`);
  for (const opponent of view.opponents) {
    io.print(
      `Seat ${opponent.seat}: discards=[${opponent.discards.map((k) => koreanTileLabel(k)).join(",")}] ` +
        `melds=[${opponent.melds.map(formatMeld).join(",")}] riichi=${opponent.riichi ? "yes" : "no"} kitaCount=${opponent.kitaCount}`
    );
  }
}

function parseYesNo(input: string): boolean | undefined {
  const normalized = input.trim().toLowerCase();
  if (["y", "yes"].includes(normalized)) return true;
  if (["n", "no"].includes(normalized)) return false;
  return undefined;
}

const CALL_VERB: Record<CallDecisionRequest["type"], string> = {
  call_pon: "퐁",
  call_daiminkan: "대명깡",
  ankan: "암깡",
  kakan: "가깡",
  kita: "",
};

async function askCallDecision(request: CallDecisionRequest, io: CliIO): Promise<DecisionResponse> {
  const prompt = buildCallPrompt(request);
  while (true) {
    const input = await io.ask(prompt);
    const declare = parseYesNo(input);
    if (declare === undefined) {
      io.print(`Please answer "y" or "n".`);
      continue;
    }
    return { type: request.type, declare };
  }
}

function buildCallPrompt(request: CallDecisionRequest): string {
  if (request.type === "kita") {
    return `북을 빼시겠습니까? [y/n] `;
  }
  const tileName = koreanTileLabel(request.tileKind);
  const verb = CALL_VERB[request.type];
  const fromClause = request.fromPlayer !== undefined ? ` (seat ${request.fromPlayer} 버림패)` : "";
  if (request.type === "call_pon" || request.type === "call_daiminkan") {
    return `${tileName}${josaEulReul(tileName)} ${verb} 하시겠습니까?${fromClause} [y/n] `;
  }
  return `${tileName}${josaRo(tileName)} ${verb} 하시겠습니까? [y/n] `;
}

async function askDiscardDecision(request: DiscardDecisionRequest, io: CliIO): Promise<DecisionResponse> {
  const { legalTileIds, riichiLegalTileIds } = request;
  // Same display-only sort as renderView - the index the user types below is resolved
  // against this exact array, so it always matches what was just printed on screen.
  const displayTiles = [...request.view.concealedTiles].sort(compareTilesForDisplay);
  const riichiIndices = displayTiles
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => riichiLegalTileIds.includes(t.id))
    .map(({ i }) => i);
  io.print(
    riichiIndices.length > 0
      ? `Riichi-legal indices: [${riichiIndices.join(", ")}]`
      : `(no discard here can declare riichi)`
  );
  while (true) {
    const input = (await io.ask(`Discard which tile? Enter an index, or "r <index>" to riichi-discard it: `)).trim();
    const riichiMatch = /^(r|riichi)\s+(\d+)$/i.exec(input);
    const plainMatch = /^(\d+)$/.exec(input);
    const declareRiichi = riichiMatch !== null;
    const indexStr = riichiMatch ? riichiMatch[2] : plainMatch ? plainMatch[1] : undefined;
    if (indexStr === undefined) {
      io.print(`Please enter a tile index (e.g. "2"), or "r 2" to riichi-discard index 2.`);
      continue;
    }
    const index = Number(indexStr);
    const tile = displayTiles[index];
    if (!tile) {
      io.print(`No tile at index ${index}. Valid indices are 0-${displayTiles.length - 1}.`);
      continue;
    }
    if (!legalTileIds.includes(tile.id)) {
      io.print(`${formatTileRef(tile)}${josaEulReul(formatTileRef(tile))} 지금 버릴 수 없습니다 (예: 쿠이카에). 다른 패를 선택하세요.`);
      continue;
    }
    if (declareRiichi && !riichiLegalTileIds.includes(tile.id)) {
      io.print(`${formatTileRef(tile)}${josaEulReul(formatTileRef(tile))} 버려도 텐파이가 되지 않거나 리치가 불가능합니다.`);
      continue;
    }
    return { type: "discard", tileId: tile.id, declareRiichi };
  }
}

const RON_CONTEXT_LABEL: Record<RonDecisionRequest["context"], string> = {
  discard: "버림패",
  riichi_discard: "리치 선언패",
  kita: "북 뽑기",
  chankan: "창깡",
  kokushi_ankan: "국사무쌍 암깡",
};

async function askRonDecision(request: RonDecisionRequest, io: CliIO): Promise<DecisionResponse> {
  const { preview } = request;
  const tileName = formatTileRef(request.winningTile);
  io.print(
    `론 가능! seat ${request.fromSeat}의 ${RON_CONTEXT_LABEL[request.context]} ${tileName}` +
      ` - ${preview.yakumanUnits > 0 ? `역만 x${preview.yakumanUnits}` : `${preview.han}판 ${preview.fu}부`}, ${preview.totalPoints}점`
  );
  io.print(`  역: ${preview.yaku.map((y) => `${y.name} ${y.han}`).join(", ")}`);
  while (true) {
    const declare = parseYesNo(await io.ask(`론 하시겠습니까? (패스하면 후리텐이 됩니다) [y/n] `));
    if (declare === undefined) {
      io.print(`Please answer "y" or "n".`);
      continue;
    }
    return { type: "ron", declare };
  }
}

/** 치 후보는 엔진이 준 options를 그대로 보여준다 (조합 계산은 하지 않는다). 번호 = options 배열 순서, p = 패스. */
export async function askChiDecision(request: ChiDecisionRequest, io: CliIO): Promise<DecisionResponse> {
  const called = formatTileRef(request.discardedTile);
  io.print(`${called}${josaEulReul(called)} 치할 수 있습니다. (seat ${request.fromSeat}의 버림패)`);
  request.options.forEach((option, index) => {
    const own = option.sequence.filter((kind, i) => {
      const firstCalled = option.sequence.indexOf(request.discardedTile.kind);
      return i !== firstCalled;
    });
    io.print(`  [${index}] ${own.map((kind) => koreanTileLabel(kind)).join(" ")} + ${called}`);
  });
  io.print("  [p] 패스");
  while (true) {
    const input = (await io.ask("치 조합 번호를 선택하세요 (p = 패스): ")).trim().toLowerCase();
    if (input === "p" || input === "pass") return { type: "chi", optionId: null };
    if (/^\d+$/.test(input)) {
      const option = request.options[Number(input)];
      if (option) return { type: "chi", optionId: option.id };
    }
    io.print(`0-${request.options.length - 1} 사이의 번호나 p(패스)를 입력하세요.`);
  }
}

function formatPreviewScore(preview: TsumoDecisionRequest["preview"]): string {
  return preview.yakumanUnits > 0 ? `역만 x${preview.yakumanUnits}` : `${preview.han}판 ${preview.fu}부`;
}

async function askTsumoDecision(request: TsumoDecisionRequest, io: CliIO): Promise<DecisionResponse> {
  const { preview } = request;
  io.print(`쯔모 화료가 가능합니다! ${formatTileRef(request.winningTile)} - ${formatPreviewScore(preview)}, ${preview.totalPoints}점`);
  io.print(`  역: ${preview.yaku.map((y) => `${y.name} ${y.han}`).join(", ")}`);
  while (true) {
    const declare = parseYesNo(await io.ask("쯔모하시겠습니까? (n이면 화료하지 않고 계속 진행) [y/n] "));
    if (declare === undefined) {
      io.print(`Please answer "y" or "n".`);
      continue;
    }
    return { type: "tsumo", declare };
  }
}

async function askNineTerminalsDecision(request: NineTerminalsDecisionRequest, io: CliIO): Promise<DecisionResponse> {
  io.print(`구종구패: 요구패(1·9·자패)가 ${request.distinctTerminalKinds}종 있습니다. 유국을 선언할 수 있습니다.`);
  while (true) {
    const declare = parseYesNo(await io.ask(`구종구패로 유국을 선언하시겠습니까? (n이면 계속 진행) [y/n] `));
    if (declare === undefined) {
      io.print(`Please answer "y" or "n".`);
      continue;
    }
    return { type: "nine_terminals", declare };
  }
}

async function resolveRequest(request: DecisionRequest, io: CliIO): Promise<DecisionResponse> {
  renderView(io, request.view);
  if (request.type === "discard") return askDiscardDecision(request, io);
  if (request.type === "ron") return askRonDecision(request, io);
  if (request.type === "nine_terminals") return askNineTerminalsDecision(request, io);
  if (request.type === "chi") return askChiDecision(request, io);
  if (request.type === "tsumo") return askTsumoDecision(request, io);
  return askCallDecision(request, io);
}

/**
 * Drives one hand to completion, asking `io` for every human decision along the way.
 * Works identically against a real terminal (nodeIO.ts) or scripted test input
 * (scriptedIO.ts) - the driver itself never touches stdin/stdout directly. Only ever
 * called for a hand where at least one seat is human-controlled; an all-AI hand should use
 * `gs.playHand()` directly instead.
 */
export async function runInteractiveHand(gs: GameState, io: CliIO): Promise<void> {
  const session = gs.playHandInteractive();
  let step = session.next();
  while (!step.done) {
    const request = step.value;
    // 여러 사람에게 동시에 묻는 요청은 사람이 2명 이상인 대국에서만 나온다. CLI는 사람 한 명 전용이다.
    if (request.type === "multi") throw new Error("CLI는 사람이 한 명인 대국만 둘 수 있습니다");
    const response = await resolveRequest(request, io);
    gs.recordHumanDecision(request, response);
    step = session.next(response);
  }
}

const ABORTIVE_DRAW_LABEL: Record<string, string> = { nine_terminals: "구종구패", four_winds: "사풍자화", four_riichi: "사가입리", four_kans: "사깡산라" };

/** 한 국의 결과를 터미널용 한국어 줄들로 (엔진이 기록한 hand_end.result를 그대로 읽는다). 결과가 없는 옛 기록이면 점수만. */
export function formatHandResult(event: Extract<GameEvent, { type: "hand_end" }>, seatName: (seat: number) => string = (s) => `seat ${s}`): string[] {
  const result = event.result;
  if (!result) return [`국 종료. 점수: ${event.scores.join(", ")}`];
  const lines: string[] = [];
  if (result.kind === "agari") {
    for (const win of result.winners) {
      const how = win.method === "tsumo" ? "쯔모" : `론 (${seatName(win.loserSeat!)} 방총)`;
      const size = win.yakumanUnits > 0 ? `역만 x${win.yakumanUnits}` : `${win.han}판 ${win.fu}부`;
      lines.push(`화료! ${seatName(win.winnerSeat)} ${how} - ${size}, ${win.totalPoints}점`);
      lines.push(`  역: ${win.yaku.map((y) => `${y.name} ${y.han}`).join(", ")}`);
    }
  } else if (result.kind === "exhaustive_draw") {
    lines.push(`유국 (황패) - 텐파이: ${result.tenpaiSeats.map(seatName).join(", ") || "없음"}`);
    if (result.nagashiManganSeats.length > 0) lines.push(`유국만관: ${result.nagashiManganSeats.map(seatName).join(", ")}`);
  } else {
    lines.push(`유국: ${ABORTIVE_DRAW_LABEL[result.reason] ?? result.reason}`);
  }
  const deltas = result.scoresAfterSettlement.map((after, seat) => {
    const delta = after - result.scoresBeforeSettlement[seat]!;
    return `${seatName(seat)} ${after}${delta === 0 ? "" : ` (${delta > 0 ? "+" : ""}${delta})`}`;
  });
  lines.push(`점수: ${deltas.join("  ")}`);
  return lines;
}

/**
 * 사람 한 명과 AI로 게임 전체(모든 국)를 진행한다. 국마다 `runInteractiveHand`를 부르고, 국이 끝나면 결과를 보여 준 뒤
 * GuiSession과 같은 순서(국 종료 후 연장/종료 판단 -> 끝났으면 finalizeGame)로 다음 국이나 최종 결과로 간다.
 * 끝난 게임의 최종 순위를 돌려준다.
 */
export async function runInteractiveGame(gs: GameState, io: CliIO, seatName: (seat: number) => string = (s) => `seat ${s}`): Promise<ReturnType<GameState["computeFinalStandings"]>> {
  for (;;) {
    await runInteractiveHand(gs, io);
    const handEnd = [...gs.log].reverse().find((e): e is Extract<GameEvent, { type: "hand_end" }> => e.type === "hand_end");
    io.print("");
    io.print("=== 국 결과 ===");
    if (handEnd) for (const line of formatHandResult(handEnd, seatName)) io.print(line);
    gs.updateGameContinuationStateAfterHand();
    if (gs.isGameOver()) {
      const end = gs.finalizeGame();
      const standings = gs.computeFinalStandings();
      io.print("");
      io.print("=== 게임 종료 ===");
      for (const s of standings) io.print(`${s.placement}위 ${seatName(s.player)}: ${s.rawScore}점`);
      void end;
      return standings;
    }
    io.print("--- 다음 국으로 넘어갑니다 ---");
  }
}
