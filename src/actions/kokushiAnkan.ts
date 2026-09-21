import type { FullWinResult } from "../yaku/evaluate.js";

/** Mahjong Soul permits robbing a concealed kan only when that tile completes Kokushi. */
export function isKokushiAnkanRon(result: FullWinResult | null): result is FullWinResult {
  if (!result || result.yakumanUnits <= 0) return false;
  return result.yaku.some(
    (hit) => hit.name === "Kokushi Musou" || hit.name === "Kokushi Musou (13-wait)"
  );
}
