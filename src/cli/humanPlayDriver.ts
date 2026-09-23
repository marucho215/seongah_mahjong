import type { GameState } from "../core/GameState.js";
import type { CallDecisionRequest, DecisionRequest, DecisionResponse, DiscardDecisionRequest, NineTerminalsDecisionRequest, RonDecisionRequest } from "../core/decisions.js";
import type { PlayerView } from "../core/playerView.js";
import type { TileRef, MeldSnapshot } from "../core/GameLog.js";
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
    const response = await resolveRequest(step.value, io);
    step = session.next(response);
  }
}
