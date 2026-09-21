import type { GameEvent, HandStartEvent } from "../../src/core/GameLog.js";
import { nextSeat, seatDistance } from "../../src/core/seats.js";
import type { RuleConfig } from "../../src/rules/RuleConfig.js";

export interface ReplayQaInput {
  rules: RuleConfig;
  events: readonly GameEvent[];
}

function addDeltas(scores: number[], deltas: Readonly<Record<number, number>>): void {
  for (const [seat, delta] of Object.entries(deltas)) scores[Number(seat)]! += delta;
}

function sameNumbers(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

/**
 * Replay-only consistency checks. This intentionally consumes recorded decisions and
 * deltas instead of reimplementing legality, yaku evaluation, or payment formulas.
 */
export function collectReplayInvariantViolations(input: ReplayQaInput): string[] {
  const { rules, events } = input;
  const violations: string[] = [];
  const initialTotal = rules.startingScore * rules.playerCount;
  let currentStart: HandStartEvent | null = null;
  let expectedScores: number[] | null = null;
  let expectedKyotaku = 0;
  let winDeltasOmitKyotaku = false;
  let establishedRiichi = new Set<number>();
  let chiSeats = new Set<number>();
  let kanCounts = new Map<number, number>();
  let winners: number[] = [];
  let ronWins: Array<{ player: number; from: number }> = [];
  let exhaustiveTenpai: number[] | null = null;
  let abortiveReason: string | null = null;
  let previousHandEnd: Extract<GameEvent, { type: "hand_end" }> | null = null;
  let previousStart: HandStartEvent | null = null;

  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const at = `events[${index}]`;

    if (event.type === "hand_start") {
      if (previousHandEnd && previousStart) {
        if (!sameNumbers(event.scores, previousHandEnd.scores)) violations.push(`${at}: scores do not continue from hand_end`);
        if (event.dealer !== previousHandEnd.nextDealer) violations.push(`${at}: dealer does not match hand_end.nextDealer`);
        if (event.honba !== previousHandEnd.honba) violations.push(`${at}: honba does not continue from hand_end`);
        if (event.kyotaku !== previousHandEnd.kyotaku) violations.push(`${at}: kyotaku does not continue from hand_end`);
        const dealerRepeated = event.dealer === previousStart.dealer;
        const expectedHand = dealerRepeated
          ? previousStart.roundHandNumber
          : previousStart.roundHandNumber === rules.handsPerRound
            ? 1
            : previousStart.roundHandNumber + 1;
        const expectedWind = dealerRepeated || previousStart.roundHandNumber < rules.handsPerRound
          ? previousStart.roundWind
          : previousStart.roundWind + 1;
        if (event.roundHandNumber !== expectedHand || event.roundWind !== expectedWind) {
          violations.push(`${at}: round progression is inconsistent`);
        }
      }
      if (event.scores.reduce((sum, score) => sum + score, 0) + event.kyotaku * 1000 !== initialTotal) {
        violations.push(`${at}: score plus kyotaku is not conserved`);
      }
      currentStart = event;
      expectedScores = [...event.scores];
      expectedKyotaku = event.kyotaku;
      winDeltasOmitKyotaku = false;
      establishedRiichi = new Set();
      chiSeats = new Set();
      kanCounts = new Map();
      winners = [];
      ronWins = [];
      exhaustiveTenpai = null;
      abortiveReason = null;
      continue;
    }

    if (event.type === "riichi") {
      if (!expectedScores) violations.push(`${at}: riichi outside a hand`);
      else {
        expectedScores[event.player]! -= 1000;
        expectedKyotaku++;
        establishedRiichi.add(event.player);
      }
      continue;
    }

    if (event.type === "discard") {
      if (establishedRiichi.has(event.player) && !event.tsumogiri) {
        violations.push(`${at}: established-riichi player made a non-tsumogiri discard`);
      }
      continue;
    }

    if (event.type === "call") {
      if (rules.chiForbidden && event.call === "chi") violations.push(`${at}: chi exists under chi-forbidden rules`);
      if ((event.call === "chi" || event.call === "pon" || event.call === "kan_open") && establishedRiichi.has(event.player)) {
        violations.push(`${at}: established-riichi player made an open call`);
      }
      if (event.call === "chi") {
        chiSeats.add(event.player);
        if (event.fromPlayer === undefined || event.player !== nextSeat(event.fromPlayer, rules.playerCount)) {
          violations.push(`${at}: chi caller is not next in turn order`);
        }
      }
      if (event.call === "kan_open" || event.call === "kan_closed" || event.call === "kan_added") {
        kanCounts.set(event.player, (kanCounts.get(event.player) ?? 0) + 1);
        const next = events[index + 1];
        const replacement = next?.type === "draw" && next.player === event.player && next.source === "rinshan";
        const robbedAddedKan =
          event.call === "kan_added" &&
          next?.type === "win" &&
          next.ronFrom === event.player &&
          next.yaku.some((yaku) => yaku.name === "Chankan");
        if (!replacement && !robbedAddedKan) violations.push(`${at}: kan is not followed by rinshan or legal chankan`);
      }
      continue;
    }

    if (event.type === "win") {
      winners.push(event.player);
      if (!event.isTsumo && event.ronFrom !== undefined) ronWins.push({ player: event.player, from: event.ronFrom });
      if (expectedScores) addDeltas(expectedScores, event.deltas);
      if (event.yaku.some((yaku) => yaku.name === "Toitoi") && chiSeats.has(event.player)) {
        violations.push(`${at}: Toitoi awarded to a hand with chi`);
      }
      if (event.yaku.some((yaku) => yaku.name === "Sankantsu") && (kanCounts.get(event.player) ?? 0) < 3) {
        violations.push(`${at}: Sankantsu awarded with fewer than three own kans`);
      }
      // Replay win deltas contain hand payments and honba, while the engine applies
      // kyotaku separately to the closest winner. Avoid claiming an exact per-seat
      // reconstruction when that omitted payout was non-zero.
      if (expectedKyotaku > 0) winDeltasOmitKyotaku = true;
      expectedKyotaku = 0;
      continue;
    }

    if (event.type === "exhaustive_draw") {
      exhaustiveTenpai = [...event.tenpaiPlayers];
      if (expectedScores) addDeltas(expectedScores, event.deltas);
      continue;
    }

    if (event.type === "abortive_draw") {
      abortiveReason = event.reason;
      continue;
    }

    if (event.type === "hand_end") {
      if (!currentStart || !expectedScores) violations.push(`${at}: hand_end without hand_start`);
      else {
        if (!winDeltasOmitKyotaku && !sameNumbers(event.scores, expectedScores)) {
          violations.push(`${at}: scores do not match recorded riichi/settlement deltas`);
        }
        if (event.kyotaku !== expectedKyotaku) violations.push(`${at}: kyotaku deduction/carry/payout is inconsistent`);
        if (event.scores.reduce((sum, score) => sum + score, 0) + event.kyotaku * 1000 !== initialTotal) {
          violations.push(`${at}: score plus kyotaku is not conserved`);
        }
        const dealerWon = winners.includes(currentStart.dealer) && rules.renchanOnDealerWin;
        const dealerTenpai = exhaustiveTenpai?.includes(currentStart.dealer) ?? false;
        const shouldRepeat =
          abortiveReason !== null ||
          dealerWon ||
          (exhaustiveTenpai !== null && dealerTenpai && rules.renchanOnDealerTenpaiDraw);
        const expectedDealer = shouldRepeat ? currentStart.dealer : nextSeat(currentStart.dealer, rules.playerCount);
        if (event.nextDealer !== expectedDealer) violations.push(`${at}: dealer progression is inconsistent`);
        const expectedHonba = abortiveReason !== null || exhaustiveTenpai !== null || dealerWon ? currentStart.honba + 1 : 0;
        if (event.honba !== expectedHonba) violations.push(`${at}: honba progression is inconsistent`);
        if (ronWins.length > 1) {
          const source = ronWins[0]!.from;
          const ordered = ronWins.every((win, winIndex) =>
            win.from === source &&
            (winIndex === 0 ||
              seatDistance(source, ronWins[winIndex - 1]!.player, rules.playerCount) <
                seatDistance(source, win.player, rules.playerCount))
          );
          if (!ordered) violations.push(`${at}: multi-ron winners are not in turn order`);
        }
      }
      let totalKans = 0;
      for (const [seat, count] of kanCounts) {
        totalKans += count;
        if (count > rules.maxKans) violations.push(`${at}: seat ${seat} exceeded maxKans`);
      }
      if (totalKans > rules.maxKans) violations.push(`${at}: hand exceeded maxKans`);
      previousHandEnd = event;
      previousStart = currentStart;
      currentStart = null;
      expectedScores = null;
      continue;
    }

    if (event.type === "game_end") {
      if (event.finalScores.reduce((sum, score) => sum + score, 0) !== initialTotal) {
        violations.push(`${at}: final score is not conserved after kyotaku sweep`);
      }
    }
  }
  return violations;
}
