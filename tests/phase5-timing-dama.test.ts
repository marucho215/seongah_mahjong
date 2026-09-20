import { describe, expect, it } from "vitest";
import { resolveRonBeforeInterruption } from "../src/core/GameState.js";
import { scanAllDamaWaits } from "../src/ai/characterAI.js";
import type { TileKind } from "../src/core/tiles.js";

describe("Phase 5 ippatsu interruption timing", () => {
  it("keeps ippatsu live while an extracted kita tile is offered for ron", () => {
    let ippatsu = true;
    const winners = resolveRonBeforeInterruption(
      () => {
        expect(ippatsu).toBe(true);
        return ["ron"];
      },
      () => {
        ippatsu = false;
      }
    );

    expect(winners).toEqual(["ron"]);
    expect(ippatsu).toBe(true);
  });

  it("keeps ippatsu live during the shouminkan chankan window", () => {
    let ippatsu = true;
    const winners = resolveRonBeforeInterruption(
      () => {
        expect(ippatsu).toBe(true);
        return ["chankan"];
      },
      () => {
        ippatsu = false;
      }
    );

    expect(winners).toEqual(["chankan"]);
    expect(ippatsu).toBe(true);
  });

  it("cancels ippatsu exactly once when kan/kita survives ron and the hand continues", () => {
    let ippatsu = true;
    let cancellations = 0;
    const winners = resolveRonBeforeInterruption(
      () => {
        expect(ippatsu).toBe(true);
        return [];
      },
      () => {
        cancellations++;
        ippatsu = false;
      }
    );

    expect(winners).toEqual([]);
    expect(ippatsu).toBe(false);
    expect(cancellations).toBe(1);
  });
});

describe("Phase 5 dama wait scan", () => {
  it("finds a valid dama win on the fourth wait instead of scanning only three", () => {
    const waits: TileKind[] = ["p1", "p4", "p7", "s9", "z1"];
    const inspected: TileKind[] = [];

    const viable = scanAllDamaWaits(waits, (kind) => {
      inspected.push(kind);
      return kind === "s9";
    });

    expect(viable).toBe(true);
    expect(inspected).toEqual(["p1", "p4", "p7", "s9"]);
  });
});
