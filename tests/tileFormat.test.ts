import { describe, expect, it } from "vitest";
import { compareTilesForDisplay, josaEulReul, josaRo, koreanTileLabel } from "../src/cli/tileFormat.js";
import type { TileKind } from "../src/core/tiles.js";

describe("koreanTileLabel", () => {
  it("converts man/pin/sou tiles to number + suit name", () => {
    expect(koreanTileLabel("m1")).toBe("1만");
    expect(koreanTileLabel("m9")).toBe("9만");
    expect(koreanTileLabel("p1")).toBe("1통");
    expect(koreanTileLabel("p9")).toBe("9통");
    expect(koreanTileLabel("s1")).toBe("1삭");
    expect(koreanTileLabel("s9")).toBe("9삭");
  });

  it("converts honor tiles to their Korean names in East/South/West/North/Haku/Hatsu/Chun order", () => {
    expect(koreanTileLabel("z1")).toBe("동");
    expect(koreanTileLabel("z2")).toBe("남");
    expect(koreanTileLabel("z3")).toBe("서");
    expect(koreanTileLabel("z4")).toBe("북");
    expect(koreanTileLabel("z5")).toBe("백");
    expect(koreanTileLabel("z6")).toBe("발");
    expect(koreanTileLabel("z7")).toBe("중");
  });

  it("prefixes a red five with 적, and only a red five", () => {
    expect(koreanTileLabel("m5", true)).toBe("적5만");
    expect(koreanTileLabel("p5", true)).toBe("적5통");
    expect(koreanTileLabel("s5", true)).toBe("적5삭");
    expect(koreanTileLabel("m5", false)).toBe("5만");
    expect(koreanTileLabel("m5")).toBe("5만");
    // isRed is meaningless for honors, but must never crash or add the prefix.
    expect(koreanTileLabel("z4", true)).toBe("북");
  });
});

describe("compareTilesForDisplay", () => {
  it("orders suits man -> pin -> sou -> honors", () => {
    const kinds: TileKind[] = ["z1", "s1", "p1", "m1"];
    const sorted = [...kinds].map((kind) => ({ kind })).sort(compareTilesForDisplay).map((t) => t.kind);
    expect(sorted).toEqual(["m1", "p1", "s1", "z1"]);
  });

  it("orders ranks ascending within a suit", () => {
    const kinds: TileKind[] = ["p9", "p1", "p5", "p3"];
    const sorted = [...kinds].map((kind) => ({ kind })).sort(compareTilesForDisplay).map((t) => t.kind);
    expect(sorted).toEqual(["p1", "p3", "p5", "p9"]);
  });

  it("orders honors East->South->West->North->Haku->Hatsu->Chun", () => {
    const kinds: TileKind[] = ["z7", "z1", "z5", "z4", "z2", "z6", "z3"];
    const sorted = [...kinds].map((kind) => ({ kind })).sort(compareTilesForDisplay).map((t) => t.kind);
    expect(sorted).toEqual(["z1", "z2", "z3", "z4", "z5", "z6", "z7"]);
  });

  it("produces the full canonical order for a mixed hand", () => {
    const kinds: TileKind[] = ["z6", "s8", "m9", "p2", "z1", "m1", "s1", "p7"];
    const sorted = [...kinds].map((kind) => ({ kind })).sort(compareTilesForDisplay).map((t) => t.kind);
    expect(sorted).toEqual(["m1", "m9", "p2", "p7", "s1", "s8", "z1", "z6"]);
  });

  it("is stable for identical kinds (does not reorder distinct tiles of the same kind)", () => {
    const tiles = [
      { kind: "p5" as TileKind, id: 1 },
      { kind: "p5" as TileKind, id: 2 },
    ];
    const sorted = [...tiles].sort(compareTilesForDisplay);
    expect(sorted.map((t) => t.id)).toEqual([1, 2]);
  });
});

describe("Korean particle helpers (josa)", () => {
  it("josaEulReul picks 을 after a batchim-final tile name, 를 otherwise", () => {
    expect(josaEulReul("북")).toBe("을"); // ㄱ batchim
    expect(josaEulReul("1만")).toBe("을"); // ㄴ batchim
    expect(josaEulReul("1통")).toBe("을"); // ㅇ batchim
    expect(josaEulReul("1삭")).toBe("을"); // ㄱ batchim
    expect(josaEulReul("서")).toBe("를"); // no batchim
  });

  it("josaRo picks 로 after no batchim or ㄹ batchim, 으로 otherwise", () => {
    expect(josaRo("서")).toBe("로"); // no batchim
    expect(josaRo("발")).toBe("로"); // ㄹ batchim
    expect(josaRo("북")).toBe("으로"); // ㄱ batchim
    expect(josaRo("1만")).toBe("으로"); // ㄴ batchim
  });
});
