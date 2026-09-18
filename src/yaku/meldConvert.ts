import type { Meld } from "../core/Hand.js";
import type { Group } from "./types.js";

export function meldToGroup(m: Meld): Group {
  if (m.type === "pon") {
    return { type: "triplet", kind: m.tiles[0]!.kind, concealed: false, calledFrom: m.calledFrom };
  }
  if (m.type === "kan_closed") {
    return { type: "quad", kind: m.tiles[0]!.kind, concealed: true };
  }
  return { type: "quad", kind: m.tiles[0]!.kind, concealed: false, calledFrom: m.calledFrom };
}

export function meldsToGroups(melds: Meld[]): Group[] {
  return melds.map(meldToGroup);
}
